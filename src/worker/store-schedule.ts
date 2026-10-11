import { decodeWeeklyBusinessHours } from "./admin-store";
import { getOpeningBusinessDay } from "./business-day";
import { getStoreSettings, MAX_STORE_STATE_VERSION, type StoreSettingsRow } from "./store-settings";
import { hashAuditActor } from "./store-operations";
import { getAuthorizedSchedulerActivation, SCHEDULER_ACTIVATION_GUARD_SQL } from "./scheduler-activation";

const DAY = 86400000;
// Only the approved 17:30 / 23:15 schedule gets a soft extension.
export function scheduledServiceCycle(store: Pick<StoreSettingsRow, "weekly_business_hours" | "last_order_time">, now: Date) {
 const schedule = decodeWeeklyBusinessHours(store.weekly_business_hours);
 const date = getOpeningBusinessDay(now, schedule);
 if (!date || !schedule) return null;
 const hours = schedule[String(new Date(date + "T00:00:00Z").getUTCDay())]!;
 if (hours.openAt !== "17:30" || hours.closeAt !== "23:15" || ![null, "23:15"].includes(store.last_order_time)) return null;
 const opening = Date.parse(date + "T17:30:00+08:00");
 if (now.getTime() >= opening + DAY) return null;
 return { date, opening, earliestClose: Date.parse(date + "T23:15:00+08:00") };
}

async function operationId(action: string, day: string) {
 const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("store-schedule-v1:" + action + ":" + day)));
 digest[6] = (digest[6]! & 15) | 64; digest[8] = (digest[8]! & 63) | 128;
 const hex = [...digest.slice(0,16)].map(b => b.toString(16).padStart(2,"0")).join("");
 return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
}

export async function runScheduledStoreCycle(input: {
 db: D1Database; auditActorHashKey?: string; workerVersion?: string; now?: Date;
 scheduledTime?: number;
}) {
 const { db, auditActorHashKey, workerVersion, now = new Date() } = input;
 if (!Number.isFinite(now.getTime())) throw new RangeError("now must be valid");
 const activation = await getAuthorizedSchedulerActivation(db, workerVersion);
 if (!activation) return { outcome: "SKIPPED" };
 if (input.scheduledTime !== undefined && (!Number.isFinite(input.scheduledTime) || input.scheduledTime > now.getTime() || now.getTime()-input.scheduledTime >= DAY)) return { outcome: "SKIPPED" };
 const store = await getStoreSettings(db);
 if (!store) return { outcome: "SKIPPED" };
 let cycle;
 try { cycle = scheduledServiceCycle(store, now); } catch { return { outcome: "SKIPPED" }; }
 if (!cycle) return { outcome: "SKIPPED" };
 if (input.scheduledTime !== undefined) {
  let scheduledCycle;
  try { scheduledCycle = scheduledServiceCycle(store, new Date(input.scheduledTime)); } catch { return { outcome: "SKIPPED" }; }
  if (scheduledCycle?.date !== cycle.date) return { outcome: "SKIPPED" };
 }
 const close = now.getTime() >= cycle.earliestClose;
 const action = close ? "pause" : "resume";
 const expected = close ? 1 : 0;
 const target = close ? 0 : 1;
 if (store.is_accepting_orders !== expected || store.auto_pause_reason !== null || store.missed_order_count !== 0 ||
  (close ? store.pause_reason !== null : store.pause_reason !== "scheduled_closed") ||
  (!close && (!store.scheduled_closed_business_date || !/^\d{4}-\d{2}-\d{2}$/.test(store.scheduled_closed_business_date) || store.scheduled_closed_business_date >= cycle.date)) ||
  store.state_version >= MAX_STORE_STATE_VERSION) return { outcome: "SKIPPED" };
 const id = await operationId(action, cycle.date);
 const closeId = !close ? await operationId("pause", store.scheduled_closed_business_date!) : null;
 const eventId = crypto.randomUUID();
 const actorHash = await hashAuditActor("cron:" + action, auditActorHashKey);
 const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([action,cycle.date]))))].map(b=>b.toString(16).padStart(2,"0")).join("");
 const timestamp = now.toISOString();
 // accepted remains outstanding after estimated_ready_at. Never use the
 // presentation/kitchen queue to infer physical completion.
 const closeGuard = `NOT EXISTS (SELECT 1 FROM orders WHERE
  status IN ('pending','accepted') AND cancelled_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM orders WHERE datetime(created_at) IS NULL
   OR julianday(created_at) > julianday(?, '-5 minutes'))
  AND NOT EXISTS (SELECT 1 FROM orders WHERE datetime(created_at) >= datetime(?)
   AND status='completed' AND (completed_at IS NULL OR datetime(completed_at) IS NULL))`;
 // A manual Pause recorded while already closed is an emergency hold too.
 const resumeGuard = `pause_reason='scheduled_closed' AND scheduled_closed_business_date IS ?
  AND EXISTS (SELECT 1 FROM store_state_events WHERE operation_id=? AND action='pause' AND outcome='applied' AND to_state_version<=store_settings.state_version)
  AND NOT EXISTS (SELECT 1 FROM store_state_events WHERE action='pause'
   AND outcome='already_target' AND to_state_version >= (SELECT to_state_version FROM store_state_events WHERE operation_id=?))`;
 const results = await db.batch([
  db.prepare(`INSERT INTO store_state_events (
   id,operation_id,request_fingerprint,action,expected_accepting,expected_state_version,
   from_accepting,to_accepting,from_state_version,to_state_version,outcome,actor_subject_hash,worker_version,created_at
  ) SELECT ?,?,?,?, ?,state_version,is_accepting_orders,?,state_version,state_version+1,'applied',?,?,?
   FROM store_settings WHERE id=1 AND is_accepting_orders=? AND state_version=?
   AND typeof(state_version)='integer' AND state_version BETWEEN 0 AND ?
   AND auto_pause_reason IS NULL AND missed_order_count=0
   AND weekly_business_hours IS ? AND last_order_time IS ?
   AND ${SCHEDULER_ACTIVATION_GUARD_SQL}
   AND ${close ? "pause_reason IS NULL AND " + closeGuard : resumeGuard}
   ON CONFLICT(operation_id) DO NOTHING`)
   .bind(eventId,id,fingerprint,action,expected,target,actorHash,workerVersion ?? null,timestamp,
    expected,store.state_version,MAX_STORE_STATE_VERSION-1,store.weekly_business_hours,store.last_order_time,workerVersion!,activation.state_version,
    ...(close ? [timestamp,new Date(cycle.opening).toISOString()] : [store.scheduled_closed_business_date,closeId,closeId])),
  db.prepare(`UPDATE store_settings SET is_accepting_orders=?,state_version=state_version+1,
   pause_reason=?,scheduled_closed_business_date=?
   WHERE id=1 AND EXISTS (SELECT 1 FROM store_state_events WHERE id=?
    AND outcome='applied' AND from_state_version=store_settings.state_version
    AND from_accepting=store_settings.is_accepting_orders)`)
   .bind(target,close ? "scheduled_closed" : null,close ? cycle.date : null,eventId),
 ]);
 return { outcome: results[1].meta.changes === 1 ? "APPLIED" : "SKIPPED", action, operationId: id };
}
