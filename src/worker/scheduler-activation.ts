import { hashAuditActor } from "./store-operations";
import { MAX_STORE_STATE_VERSION } from "./store-settings";

const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type SchedulerActivation = {
 enabled: 0 | 1; approved_version_id: string | null; state_version: number;
 last_operation_id: string | null; updated_at: string | null;
};
type ActivationEvent = { id: string; operation_id: string; request_fingerprint: string; outcome: string; to_state_version: number };
export class SchedulerActivationError extends Error {
 constructor(readonly status: 400 | 409 | 500, readonly code: string) { super(code); }
}
export async function getSchedulerActivation(db: D1Database) {
 const row = await db.prepare("SELECT enabled,approved_version_id,state_version,last_operation_id,updated_at FROM scheduler_activation WHERE id=1").first<SchedulerActivation>();
 if (!row || ![0,1].includes(row.enabled) || !Number.isSafeInteger(row.state_version) || row.state_version < 0 ||
  (row.enabled === 0 ? row.approved_version_id !== null : !row.approved_version_id || !VERSION_ID.test(row.approved_version_id) || !row.last_operation_id)) {
  throw new SchedulerActivationError(500, "SCHEDULER_ACTIVATION_UNAVAILABLE");
 }
 return row;
}
// Missing metadata/state/audit or D1 errors disable only the new Scheduler.
export async function getAuthorizedSchedulerActivation(db: D1Database, workerVersion?: string) {
 if (!workerVersion || !VERSION_ID.test(workerVersion)) return null;
 try {
  const state = await getSchedulerActivation(db);
  if (state.enabled !== 1 || state.approved_version_id !== workerVersion) return null;
  const event = await db.prepare(`SELECT operation_id FROM scheduler_activation_events WHERE operation_id=?
   AND outcome='applied' AND to_enabled=1 AND to_approved_version_id=? AND to_state_version=?`)
   .bind(state.last_operation_id, workerVersion, state.state_version).first();
  return event ? state : null;
 } catch { return null; }
}
// Rechecked inside Store / Order atomic writes, so a concurrent Disable wins.
export const SCHEDULER_ACTIVATION_GUARD_SQL = `EXISTS (SELECT 1 FROM scheduler_activation a
 JOIN scheduler_activation_events e ON e.operation_id=a.last_operation_id
 WHERE a.id=1 AND a.enabled=1 AND a.approved_version_id=? AND a.state_version=?
 AND e.outcome='applied' AND e.to_enabled=1 AND e.to_approved_version_id=a.approved_version_id
 AND e.to_state_version=a.state_version)`;

export type SchedulerActivationRequest = {
 operationId: string; expectedStateVersion: number; enabled: boolean;
 approvedVersionId: string | null; reason: string;
};
export function parseSchedulerActivationRequest(value: unknown): SchedulerActivationRequest {
 if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SchedulerActivationError(400,"INVALID_SCHEDULER_ACTIVATION");
 const v = value as Record<string,unknown>;
 if (Object.keys(v).some(k=>!["operationId","expectedStateVersion","enabled","approvedVersionId","reason"].includes(k)) ||
  typeof v.operationId!=="string" || !OPERATION_ID.test(v.operationId) ||
  !Number.isSafeInteger(v.expectedStateVersion) || (v.expectedStateVersion as number)<0 ||
  typeof v.enabled!=="boolean" || typeof v.reason!=="string" || !v.reason.trim() || v.reason.trim().length>200 ||
  (v.enabled ? typeof v.approvedVersionId!=="string" || !VERSION_ID.test(v.approvedVersionId) : v.approvedVersionId!==null)) {
  throw new SchedulerActivationError(400,"INVALID_SCHEDULER_ACTIVATION");
 }
 return { operationId:v.operationId,expectedStateVersion:v.expectedStateVersion as number,enabled:v.enabled,approvedVersionId:v.approvedVersionId as string|null,reason:v.reason.trim() };
}
export async function performSchedulerActivation(input: {
 db: D1Database; request: SchedulerActivationRequest; actorSubject: string;
 auditActorHashKey?: string; workerVersion?: string; now?: Date;
}) {
 const { db,actorSubject,auditActorHashKey,workerVersion,now=new Date() } = input;
 const request=parseSchedulerActivationRequest(input.request);
 if (!Number.isFinite(now.getTime())) throw new SchedulerActivationError(500,"SCHEDULER_ACTIVATION_UNAVAILABLE");
 // Approval is for the exact version executing this authenticated Admin action.
 if (request.enabled && request.approvedVersionId !== workerVersion) throw new SchedulerActivationError(409,"SCHEDULER_VERSION_MISMATCH");
 const actorHash=await hashAuditActor(actorSubject,auditActorHashKey);
 const fingerprint=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(request))))].map(b=>b.toString(16).padStart(2,"0")).join("");
 const existing=await db.prepare("SELECT id,operation_id,request_fingerprint,outcome,to_state_version FROM scheduler_activation_events WHERE operation_id=?").bind(request.operationId).first<ActivationEvent>();
 if (existing) {
  if (existing.request_fingerprint!==fingerprint) throw new SchedulerActivationError(409,"OPERATION_ID_CONFLICT");
  return { outcome:"IDEMPOTENT_REPLAY",operation:existing,state:await getSchedulerActivation(db) };
 }
 const eventId=crypto.randomUUID(),target=request.enabled?1:0;
 const results=await db.batch([
  db.prepare(`INSERT INTO scheduler_activation_events (
   id,operation_id,request_fingerprint,expected_state_version,from_enabled,to_enabled,
   from_approved_version_id,to_approved_version_id,from_state_version,to_state_version,
   outcome,actor_subject_hash,reason,worker_version,created_at)
   SELECT ?,?,?,?,enabled,CASE WHEN outcome='stale' THEN enabled ELSE ? END,
   approved_version_id,CASE WHEN outcome='stale' THEN approved_version_id ELSE ? END,
   state_version,CASE WHEN outcome='applied' THEN state_version+1 ELSE state_version END,
   outcome,?,?,?,? FROM (
    SELECT *,CASE WHEN state_version<>? OR state_version>=? THEN 'stale'
     WHEN enabled=? AND approved_version_id IS ? THEN 'already_target' ELSE 'applied' END AS outcome
    FROM scheduler_activation WHERE id=1) WHERE 1
   ON CONFLICT(operation_id) DO NOTHING`)
   .bind(eventId,request.operationId,fingerprint,request.expectedStateVersion,target,request.approvedVersionId,
    actorHash,request.reason,workerVersion??null,now.toISOString(),request.expectedStateVersion,MAX_STORE_STATE_VERSION,target,request.approvedVersionId),
  db.prepare(`UPDATE scheduler_activation SET enabled=?,approved_version_id=?,state_version=state_version+1,last_operation_id=?,updated_at=?
   WHERE id=1 AND EXISTS (SELECT 1 FROM scheduler_activation_events WHERE id=? AND outcome='applied' AND from_state_version=scheduler_activation.state_version)`)
   .bind(target,request.approvedVersionId,request.operationId,now.toISOString(),eventId),
  db.prepare("SELECT id,operation_id,request_fingerprint,outcome,to_state_version FROM scheduler_activation_events WHERE operation_id=?").bind(request.operationId),
  db.prepare("SELECT enabled,approved_version_id,state_version,last_operation_id,updated_at FROM scheduler_activation WHERE id=1"),
 ]);
 const event=results[2].results[0] as ActivationEvent|undefined;
 if (!event || event.request_fingerprint!==fingerprint) throw new SchedulerActivationError(event?409:500,event?"OPERATION_ID_CONFLICT":"SCHEDULER_ACTIVATION_UNAVAILABLE");
 const state=results[3].results[0] as SchedulerActivation|undefined;
 const expectedChanges=event.id===eventId && event.outcome==='applied'?1:0;
 if (!state || results[1].meta.changes!==expectedChanges || (expectedChanges===1 &&
  (state.state_version!==event.to_state_version || state.enabled!==target || state.approved_version_id!==request.approvedVersionId || state.last_operation_id!==request.operationId))) {
  throw new SchedulerActivationError(500,"SCHEDULER_ACTIVATION_UNAVAILABLE");
 }
 return { outcome:event.id === eventId ? event.outcome.toUpperCase() : "IDEMPOTENT_REPLAY",operation:event,state };
}
