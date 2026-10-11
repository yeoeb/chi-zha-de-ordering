# Scheduler activation safety and release procedure

Base source: `79c3f92e462ee4209212df4b5cfdf55015597de3`, retaining security patch `8a9d3f77d32bda14797ee644e2f60b0e2e3bff5b`. This change is local only; no Production action is authorized by this implementation task.

## Independent activation boundary

Migration 0022 adds `scheduler_activation` and `scheduler_activation_events`. Its singleton defaults to enabled=0, approved_version_id=NULL, state_version=0, no operation or audit. Migration 0021 remains byte-for-byte unchanged. Neither migration resumes, pauses, completes, rejects or reprices existing data.

Only a valid `CF_VERSION_METADATA.id` that exactly matches an enabled approval with its corresponding applied activation audit can run the new Store scheduler. Missing metadata/state/audit, unknown versions and D1 read failures skip it. The version, activation state_version and approval audit are rechecked inside the atomic Store audit INSERT. A concurrent Disable or version reapproval cannot leave a stale read authorized to close/resume Store. Audit and Store updates remain in one D1 batch.

This boundary does not disable the existing auto-rejection or daily sold-out maintenance. Those jobs may still perform their previously authorized mutations; Candidate 0% is not a claim that all Worker activity is read-only.

## Order window while disabled

The extended 23:15 soft-close window is permitted only for the approved exact runtime version. Without authorization, Quote and new Online/On-site orders use the original configured close/last-order cutoff, including 23:15. Before cutoff, normal ordering continues. Past cutoff or at midnight, new orders fail without order children or push intent. Existing idempotent orders remain safely replayable and Merchant completion remains available.

For an extended-window order, the activation version/state/audit are also rechecked inside the authoritative order INSERT. Disable winning that race creates no order/snapshot/notification intent. Pricing, public Origin guard, rate limiting and Store CAS remain unchanged.

Activation itself never changes Store accepting, pause reason, missed count or Store state_version. Legacy paused+NULL, manual_pause, missed_orders and unknown reasons remain paused; a scheduled closure still requires its matching Store audit. Accepted work is never automatically completed.

## Cron configuration

Keep only `* * * * *`. The minute handler evaluates the 17:30 Asia/Taipei opening boundary and each minute after 23:15. It handles same-service-cycle delay/retry; a prior-cycle delivery or a delay of 24 hours or more is skipped. Configured closed days, including Monday, do not auto-open. No Trigger deployment is required for this release when Production still has that exact existing schedule.

## Authorized control surface

GET and POST `/api/admin/scheduler-activation` inherit the existing Admin Access JWT issuer/audience checks. POST also requires the existing exact same-host Origin and Sec-Fetch-Site=same-origin contract. Merchant audience, missing/invalid JWT and invalid origins are denied before D1 access. No UI, public toggle, authentication bypass, new secret or Cloudflare binding was added.

GET returns `{ state: { enabled, approved_version_id, state_version, last_operation_id, updated_at } }`. Enabled is stored/read as 0/1. POST requires exactly:

```json
{
  "operationId": "<new canonical UUID v4>",
  "expectedStateVersion": 0,
  "enabled": true,
  "approvedVersionId": "<exact Active Worker Version UUID>",
  "reason": "<Owner authorization reference>"
}
```

Do not send this example literally. Read current state_version first, generate a fresh operation ID and substitute the verified Active Version. Approval must equal the version executing the Admin request. Only use the normal authenticated Production origin, with no version override. Confirm Active 100% separately using Cloudflare metadata, and obtain fresh explicit Owner authorization before enabling.

Disable uses enabled=false, approvedVersionId=NULL, the current expectedStateVersion and a new operation ID/reason. It does not require matching the previously approved runtime version, permitting emergency disable after a version switch. Both transitions use CAS, independent version increments, HMAC actor audit and an atomic D1 batch. Replaying the same operation cannot add an audit or change state; reusing its ID for different input is a conflict. Stale CAS returns 409 and records no state transition. Never blindly retry stale input: GET and reconcile first. Missing audit credentials/state and SQL errors do not enable anything.

After an operation, require the returned state AND a separate authenticated GET to match enabled/version/state_version/last_operation_id; read the activation audit as well. No agent is authorized to invoke this Production endpoint during the local implementation task.

## Production release plan (requires later authorization)

| Step | Preconditions | Expected result | Abort criteria |
| --- | --- | --- | --- |
| 1. Backup/bookmark | Owner release authorization; current Deployment, versions, bindings, Cron and Store re-read | Usable D1 backup/bookmark; recorded rollback version | Identity or backup cannot be verified |
| 2. Migration 0021 then 0022 | Only reviewed migrations pending; old Active schema-compatible | Existing Store/prices/orders unchanged; activation disabled/NULL/version 0; quick_check=ok | Additional pending migration, inferred closure, enabled state or data drift |
| 3. Options 28/30 +35 | Exact item/group/option names and IDs match | Exactly expected affected rows; only target deltas 35; repeat writes zero | Identity mismatch, unexpected rows or other data changed |
| 4. Upload exact new source | Build frozen with SHA/digests; Gate disabled; Dashboard vars preserved with --keep-vars | New version, Candidate 0%, old Active 100%; Gate still disabled | Binding/identity/traffic or Gate mismatch |
| 5. Candidate read-only acceptance | Exact version override identity verified; normal Access authentication | GET pages/assets/APIs pass; no new Scheduler Store write even if invoked | Runtime/auth failure, Store scheduling audit or unexpected mutation |
| 6. Promotion 100% | Candidate acceptance PASS and release authorization | Exact new Active; Gate remains disabled | Gate unexpectedly enabled or runtime/auth regression |
| 7. Post-promotion checks | Gate disabled | Active/Traffic/assets/Access/Store/D1 correct; original minute Cron remains; normal hours work, cutoff safe | HTTP 500, data/Store drift, altered Cron or missing bindings |
| 8. Enable only after separate Owner authorization | New Active 100% freshly verified; healthy Store/audits; current Gate CAS read | Approved exact Active, enabled=1; one audited Gate version increment, separate GET agrees; no direct Store mutation | Authorization missing, stale CAS, wrong runtime/Active, audit/read-back mismatch |
| 9. Natural Cron verification | Approval confirmed | Eligible exact-version transitions have Store CAS audit; paused/unknown/missed states remain paused; duplicates do not replay | Unauthorized version mutation, wrong business day, missing audit or unsafe transition |

No Trigger deployment is planned. If live triggers differ from the preserved minute schedule at release time, stop and review the full set; never replace them blindly. Owner approval to promote code does not authorize Scheduler activation or manual Store Resume.

## Rollback and emergency handling

Disable the Gate via the authorized CAS operation first, verify its audit/read-back, then roll back to the recorded pre-release stable Worker. Preserve additive schemas and +35 data; Worker rollback does not revert D1. After a switch, any version differing from approved_version_id is automatically excluded from this scheduler, but disabling first prevents accidental reactivation if the approved version is later redeployed.

Use the existing authenticated Merchant CAS Pause separately if emergency Store closure is required. Gate Disable restores hard cutoff for new orders but does not itself Pause Store or alter outstanding orders. Do not drop columns, reset snapshots, clear accepted work or restore a whole database over new business data.

Do not choose an older ungated implementation (such as local-only 79c3f92e) as a rollback version. The previously read-back stable Worker was c0aa241e-b3a3-435a-98a2-317a3e000cea; verify it again at release time. That rollback restores its original old-host authorization and older public security behavior; use the old hostname and reassess security/Store audit markers before any later forward rollout.

Physical Safari/PWA testing remains excluded by Owner; the inherited strict missing-header refusal is unchanged. Production smoke, live schema/data changes and natural Cron audit verification remain future release gates.
