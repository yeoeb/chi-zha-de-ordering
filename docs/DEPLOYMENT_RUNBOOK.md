# Production deployment and Pilot runbook

Every remote mutation requires its own explicit Gate authorization. This runbook defines commands and evidence; it grants no authority to run them. Never infer migration, secret, upload, deployment, traffic, Store, Order, Push, Access, DNS, restore, or cleanup authority from this document.

Pilot status is **NO-GO** until every GO criterion is evidenced and the Business Owner explicitly authorizes Store Resume.

## Identity and roles

Store Safety reviewed application source:

```text
4027f0cb302ad24f4439a32a459db5f934af3005
```

The Production evidence must record two distinct commits:

- **Git source commit:** the reviewed application source used to build/upload the Worker.
- **Docs commit:** the docs-only commit containing this runbook.

Never use `latest`, an unpinned branch, the docs commit, or a locally rebuilt unrecorded artifact as the Worker identity.

Required named roles:

- **Release Operator:** confirms candidate identity; executes only the exact authorized commands; captures PRE/POST evidence, timestamps, and IDs; operates the rollout/Pilot clock; executes an authorized rollback.
- **Technical Reviewer:** independently accepts or blocks migration, binding, smoke, invariants, and rollback-readiness evidence.
- **Business Owner / Store Owner:** confirms onsite capacity and business readiness; owns Pilot GO/NO-GO and the decision to Resume real ordering.

One person may temporarily fill multiple roles, but each role and approval must be recorded separately. Technical success never authorizes the Release Operator to Resume the Store.

## Production preflight contract

Before the first Production mutation, capture a single timestamped PRE package. Stop if any value is missing, ambiguous, or unexpected.

### Local release identity

Confirm and record:

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
git show --format=fuller --stat 4027f0cb302ad24f4439a32a459db5f934af3005
```

The release process must prove that the upload artifact was built from reviewed source `4027f0cb302ad24f4439a32a459db5f934af3005`. If the docs commit is checked out instead, use an approved clean worktree/export of the reviewed source and record its path and artifact hash. Do not silently upload the docs commit as though it were the reviewed source.

### Remote read-only baseline

Command shapes below are read-only but still belong in the authorized Production preflight Gate:

```powershell
npm.cmd exec wrangler -- versions list --json --config wrangler.json
npm.cmd exec wrangler -- deployments list --json --config wrangler.json
npm.cmd exec wrangler -- deployments status --json --config wrangler.json
npm.cmd exec wrangler -- d1 migrations list DB --remote --config wrangler.json
npm.cmd exec wrangler -- d1 time-travel info DB --remote --config wrangler.json
npm.cmd exec wrangler -- d1 execute DB --remote --json --config wrangler.json --command "PRAGMA quick_check"
```

Also use bounded read-only SELECT/PRAGMA statements to record:

- Production D1 identity and expected `DB` binding.
- Store accepting state and current `state_version` if the column exists.
- Store/Menu/Order counts and the known test Order status.
- Push subscription, Web Push delivery, and historical delivery counts without selecting endpoint, `p256dh`, `auth`, payload, Customer phone, or lookup token.
- Existing tables/indexes required by migrations 0001–0009.

Record current Worker version, version tag/message, Deployment ID, traffic allocation, and candidate-independent asset identity. The existing Worker must remain authoritative and the Store must be paused (`is_accepting_orders = false`).

Confirm these boundaries without changing them:

- Cloudflare Access still protects `/merchant*` and `/api/merchant/*`.
- Public Customer routes remain public.
- Production local-dev bypass is absent.
- VAPID public/subject/private binding names are present and the public fingerprint matches the approved value; never read the private value.
- A plan exists to prove `AUDIT_ACTOR_HASH_KEY` presence/runtime behavior after provisioning; never read its value.

## Migration 0010 Production SOP

Migration 0010 is a prerequisite for the Store Safety Worker. Migration and Worker rollout must be separate evidence steps.

### PRE

Capture before applying:

- D1 database identity and binding.
- Full migration tracker result showing exactly the expected pending migration.
- D1 Time Travel bookmark/recovery reference and timestamp.
- `PRAGMA quick_check = ok`.
- Store row, accepting state, and whether `state_version` is absent as expected before 0010.
- Existence of Store, Orders, Order items/modifiers, Push subscription, Web Push delivery, and retained LINE-era tables.
- Operational row counts and non-sensitive integrity summaries for comparison after apply.

Do not apply if any unexpected migration is pending, the Store is accepting, quick check is not `ok`, or recovery evidence is unavailable.

### APPLY

Run exactly once only in the separately authorized migration Gate:

```powershell
npm.cmd exec wrangler -- d1 migrations apply DB --remote --config wrangler.json
```

Do not retry an ambiguous response. First read the migration tracker and schema to determine whether 0010 committed.

Reviewed migration contract:

- Additive-only.
- DROP = 0.
- RENAME = 0.
- DELETE = 0.
- UPDATE = 0.
- Fixture INSERT = 0.
- Existing Store row receives `state_version = 0` from the column default.
- Historical migrations 0001–0009 remain byte-for-byte unchanged.

### POST

Before any Worker upload or rollout, verify and record:

- Migration tracker shows 0010 applied exactly once and no pending migration.
- `PRAGMA quick_check = ok`.
- `store_settings.state_version` exists with expected constraints.
- `typeof(state_version) = 'integer'` and the preserved Store row has `state_version = 0`.
- `store_state_events` exists with its uniqueness, transition, revision, and created-at index constraints.
- No migration-created `store_state_events` fixture exists.
- Store display/settings and paused state are preserved.
- Orders, item/modifier snapshots, Push subscriptions, Web Push deliveries, and historical delivery rows/counts are preserved.
- Historical LINE-era tables intentionally retained by migrations remain present.
- POST Time Travel bookmark and timestamp are captured.
- Every verification SELECT/PRAGMA reports no write metadata where Wrangler exposes it.

### Migration failure handling

If POST verification fails:

1. STOP; do not upload or promote the Worker.
2. Keep the Store paused and verify that state read-only.
3. Preserve command output, timestamps, bookmark, migration tracker, and schema evidence.
4. Do not issue corrective SQL, rerun the migration, or restore automatically.
5. Obtain a separate recovery decision. Evaluate D1 Time Travel restore only against the PRE recovery reference and only with destructive-recovery authorization.

## `AUDIT_ACTOR_HASH_KEY` SOP

Secret name: `AUDIT_ACTOR_HASH_KEY`.

Generation and custody requirements:

- Generate with an approved cryptographically secure random source.
- Keep the value outside Git, `.dev.vars.example`, docs, chat, D1, evidence, command history, and terminal output.
- Never echo the value or pass it as a visible command-line argument.
- Do not reuse `VAPID_PRIVATE_KEY`, an Access token, or any other key.
- Treat rotation as an audit-identity continuity event: rotation changes future actor pseudonyms and therefore requires an explicit plan, evidence boundary, and approval.

Preferred provisioning boundary is the single non-active candidate upload using an ACL-restricted external secrets file. That file must contain the complete intended version secret set, including `AUDIT_ACTOR_HASH_KEY` and the already-approved VAPID private secret, without being placed in the repository:

```powershell
npm.cmd exec wrangler -- versions upload --strict --config wrangler.json --secrets-file "<ABSOLUTE_EXTERNAL_RESTRICTED_SECRETS_FILE>" --tag "<IMMUTABLE_TAG>" --message "Store Safety source 4027f0cb302ad24f4439a32a459db5f934af3005"
```

Wrangler `--secrets-file` is additive; omitted historical secret binding names may remain inherited. Do not delete inherited secrets in this rollout.

If a separately approved secret-only workflow is selected, its command shape is:

```powershell
npm.cmd exec wrangler -- versions secret put AUDIT_ACTOR_HASH_KEY --config wrangler.json
```

Do not run both provisioning paths without a new plan, because each remote secret/version mutation needs unique evidence. Never use unversioned secret cleanup as part of this Gate.

Verification must prove presence and runtime behavior rather than read back the value:

- Candidate version view lists the secret binding name but no value.
- A separately authorized same-origin Store operation succeeds only when the binding is usable.
- Sanitized Audit verification may check `length(actor_subject_hash) = 64` without selecting the hash.
- Public and Merchant responses contain no actor hash, raw subject, request fingerprint, or secret.
- Missing/invalid binding must fail closed without Store or Audit writes.

## Staged Worker rollout SOP

### Phase A — Upload / candidate creation

Preconditions: migration 0010 POST PASS, Store paused, Audit secret input ready, existing Worker/Deployment/traffic recorded, rollback version fixed, reviewed source/artifact identity proven.

1. Execute exactly one authorized non-active version upload.
2. Record source commit, artifact identity, version ID, tag, message, timestamp, and binding names.
3. Confirm Production Deployment and traffic are unchanged.
4. Confirm the candidate has the expected D1, rate limiter, Access, asset, VAPID, and `AUDIT_ACTOR_HASH_KEY` bindings without exposing secret values.
5. Confirm no unknown bypass, route, version, or inherited configuration is active.

An ambiguous upload must not be retried. Use read-only version list/view and the fixed tag/message/time to determine whether it committed.

### Phase B — 0% and version-override verification

Under a separate Deployment authorization, create one Deployment using explicit immutable IDs:

```powershell
npm.cmd exec wrangler -- versions deploy "<CURRENT_VERSION_ID>@100%" "<CANDIDATE_VERSION_ID>@0%" --yes --config wrangler.json --message "Stage Store Safety candidate at 0%"
```

Verify normal traffic remains on the old Worker. Then use the exact candidate version-override header only in the authorized smoke Gate.

Required read-only candidate smoke:

- `GET /` plus candidate-specific asset URL/hash.
- `GET /api/health`.
- `GET /api/store`, including a safe integer `stateVersion`.
- `GET /api/menu`.
- Manifest and Service Worker hash/behavior.
- Authenticated Merchant PWA and read-only Orders/notification/public-key surfaces.
- Store paused state and migration compatibility.
- Access boundary for unauthenticated Merchant requests.

HTTP 200 alone is not candidate identity evidence. Use asset/hash or another candidate-specific artifact identity.

Store mutation smoke is not part of read-only override smoke. It requires separate explicit authorization and must prove CAS, immutable Audit, same-origin protection, sanitized response, operation lookup/replay, and authoritative post-state while returning the Store to paused.

### Phase C — promotion

Promotion requires all of the following:

- Migration 0010 PASS.
- Audit secret presence/runtime PASS.
- Candidate binding and artifact identity PASS.
- 0% candidate smoke PASS.
- Normal-traffic control unchanged.
- Rollback version and command reviewed.
- Store authoritatively paused.
- Technical Reviewer explicitly approves the exact candidate.

Command shape:

```powershell
npm.cmd exec wrangler -- versions deploy "<CANDIDATE_VERSION_ID>@100%" --yes --config wrangler.json --message "Promote Store Safety source 4027f0cb302ad24f4439a32a459db5f934af3005"
```

After read-back, verify exact 100% allocation with no unknown split, public/Access smoke, candidate assets, Store paused, D1 health, and no unintended Store/Audit/Order/Push changes.

```text
NO AUTO-RESUME
```

Worker promotion must not Resume the Store. Store Resume is a later, explicit Business Owner decision within an approved Pilot gate.

## Rollback matrix

| Failure class | Required action | Prohibited shortcut | Exit condition |
| --- | --- | --- | --- |
| Worker problem; migration healthy | Keep Store paused; deploy the fixed last-known-good Worker version under rollback authorization; verify version/traffic/public state. Leave additive 0010 in place. | Do not restore D1 or reverse 0010 merely because application code rolled back. | Old Worker is exactly 100%, Store paused, D1 healthy. |
| Migration verification fails before Worker rollout | STOP rollout; keep Store paused; preserve PRE/POST evidence; request a D1 recovery decision using the PRE reference. | Do not upload Worker, rerun migration, issue corrective SQL, or restore automatically. | Recovery gate explicitly decides forward repair or restore. |
| Audit secret missing or invalid | STOP; keep current Worker authoritative and Store paused. Correct only through a separately authorized secret/version gate. | No unhashed/raw actor fallback and no unsafe candidate rollout. | Candidate proves binding presence and fail-closed/runtime behavior. |
| Candidate HTTP/identity smoke fails | Keep existing Worker authoritative, candidate at 0%, Store paused, and preserve Ray/timestamp/version evidence. | No promotion based only on partial HTTP 200 results. | New candidate or evidence gate resolves the failure. |
| Post-promotion application failure | Pause Store if state is uncertain; capture evidence; execute fixed Worker rollback once when authorized. | Do not Resume until authoritative state is verified; do not mutate D1 as an application rollback. | Rollback Worker 100%, Store paused, D1 healthy. |
| Ambiguous Store mutation | Use the same operation ID lookup, authoritative Store read, and at most the bounded same-ID replay defined below. | Never create a new operation ID as a retry and never blind-repeat the action. | Authoritative state and operation outcome are uniquely determined, or Gate stops BLOCKED. |

The preflight must replace `<FIXED_ROLLBACK_VERSION_ID>` with the recorded last-known-good immutable ID before approval. The authorized rollback command shape is:

```powershell
npm.cmd exec wrangler -- versions deploy "<FIXED_ROLLBACK_VERSION_ID>@100%" --yes --config wrangler.json --message "Rollback Store Safety candidate"
```

Never resolve the rollback target from `latest`, a tag that may move, or an unrecorded dashboard selection.

Application rollback and D1 recovery are independent. Any D1 Time Travel restore is a destructive Production mutation requiring its own explicit recovery Gate.

## Ambiguous Store mutation procedure

For an ambiguous Pause/Resume response:

1. Preserve the original operation ID, action, expected accepting state, expected revision, start time, and response/error evidence.
2. Use authenticated `GET /api/merchant/store/operations/<SAME_OPERATION_ID>`.
3. Read authoritative `GET /api/store`; an operation lookup alone does not prove current Store state.
4. For emergency Pause only: if lookup is 404 and authoritative Store remains accepting, replay the exact original Pause body once with the same operation ID.
5. Read authoritative Store again. Success requires `is_accepting_orders = false` and a valid safe revision.
6. A 403 is conclusive denial and must not be replayed. A conflict, invalid revision, still-accepting result, or unknown state stops the Gate.

Do not generate a new operation ID, perform a second replay, use direct SQL, or report success from historical operation state.

## Pilot SOP

### Default state

Pilot is **NO-GO**. Tests, docs, migration success, secret provisioning, upload, and technical deployment do not independently change it to GO.

### GO checklist

The Pilot Gate must record all of these as PASS:

- Migration 0010 Production verification.
- `AUDIT_ACTOR_HASH_KEY` provisioned and verified without value disclosure.
- Store Safety Worker candidate identity, staged smoke, and promotion.
- Public read-only and authenticated Merchant smoke.
- Cloudflare Access and Merchant mutation Origin guard.
- Resume confirmation/fresh read, CAS, one immutable sanitized Audit event, operation lookup, and emergency Pause behavior.
- Push health and five-second polling fallback.
- Fixed rollback Worker version/command and D1 recovery reference.
- Store initially paused and authoritative revision recorded.
- Named Release Operator, Technical Reviewer, and Business Owner present.
- Business Owner confirms onsite capacity and explicitly approves Resume.
- Explicit maximum accepting window and maximum real Order count entered in evidence.
- Abort procedure reviewed aloud by the active Operator and Business Owner.

### Controlled Pilot operation

1. Confirm Merchant device is authenticated, online, displaying the Order queue, polling successfully, and able to receive the expected notification path.
2. Confirm Store paused and record its authoritative revision immediately before opening.
3. Start a visible stopwatch before Resume.
4. Business Owner authorizes Resume; Release Operator performs the confirmed Resume once and records operation ID/result.
5. Verify authoritative Store accepting state/revision and the single applied Audit event without selecting actor identity.
6. Continuously watch Merchant queue, Store status, polling health, Push behavior, elapsed time, and accepted Order count.
7. Pause before either approved limit is reached; do not extend the window to wait for Push.
8. Verify authoritative paused state/revision and Pause Audit event.
9. Preserve evidence and obtain Technical Reviewer/Business Owner closeout.

The Merchant UI must stay visible on the designated device. Polling is the source of truth when Push is delayed or unavailable.

### Abort criteria

Immediately abort on any one condition:

- Store state cannot be determined authoritatively.
- Revision is invalid or jumps unexpectedly.
- Operation replay changes Store again or produces a duplicate Audit event.
- Origin guard or Cloudflare Access protection regresses.
- An unauthorized Merchant mutation succeeds.
- D1 integrity/migration state fails.
- Worker source/version/deployment identity is uncertain.
- Push produces an unexpected duplicate or polling fallback fails.
- Merchant UI shows success while authoritative Store state disagrees.
- Rollback or emergency Pause path is unavailable.
- Named operational coverage is lost.
- Approved Order or time limit is reached.

Abort procedure:

1. Pause Store using one operation ID.
2. Verify authoritative Store state and revision.
3. Stop new Customer Orders and keep the Merchant queue visible.
4. Preserve logs, operation IDs, timestamps, Worker versions, Deployment, and traffic evidence without credentials or PII.
5. Do not issue a blind second mutation or new operation ID.
6. Follow the rollback matrix and stop BLOCKED if state cannot be uniquely determined.

## Production evidence template

```text
Gate:
Date:
Operator:
Reviewer:
Business Owner:
Git source commit:
Docs commit:
Release artifact identity/hash:
Migration:
PRE bookmark:
POST bookmark:
Previous Worker Version:
Candidate Worker Version:
Previous Deployment:
Candidate Deployment:
Traffic before:
Traffic after:
Store state before:
Store state after:
Store state_version before:
Store state_version after:
D1 quick_check:
Migration tracker:
Audit verification:
Access verification:
Smoke results:
Rollback readiness:
Pilot maximum Orders:
Pilot maximum accepting window:
Pilot status:
Findings:
Final recommendation:
```

Never save JWT, Cookie, Cloudflare Access token, VAPID private key, `AUDIT_ACTOR_HASH_KEY`, raw Access subject, raw actor identifier/hash, Push endpoint/keys, Customer phone, or public lookup token in this evidence.

## Post-gate closeout

Every Production gate must finish by recording:

- Exact mutations performed and their count.
- Read-only verification and write metadata.
- Final Store state and revision.
- Final Worker/Deployment/traffic allocation.
- Whether rollback ran.
- Repository status and whether any push occurred.
- Remaining unverified boundaries.

If the evidence cannot prove a unique final state, classify the Gate BLOCKED. Do not repair or continue outside its authorization.
