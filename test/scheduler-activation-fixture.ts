import { env } from "cloudflare:workers";
import { getSchedulerActivation, performSchedulerActivation } from "../src/worker/scheduler-activation";
export const schedulerTestVersion = "11111111-1111-4111-8111-111111111111";
export const schedulerAuditKey = "local-test-scheduler-audit-key-32-bytes";
export async function enableTestScheduler(version = schedulerTestVersion) {
 const state = await getSchedulerActivation(env.DB);
 return performSchedulerActivation({ db:env.DB,actorSubject:"local-owner",auditActorHashKey:schedulerAuditKey,workerVersion:version,
  request:{operationId:crypto.randomUUID(),expectedStateVersion:state.state_version,enabled:true,approvedVersionId:version,reason:"Local regression fixture"} });
}
