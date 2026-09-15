# Project state

## Status and evidence boundary

This document records the state known when Gate 16C-D2 was authored. Gate 16C-D2 is documentation-only: it does not re-read or mutate Production. Every Production gate must capture a fresh remote snapshot instead of treating this file as current evidence.

Pilot status: **NO-GO**.

Two Git identities must remain separate:

- Store Safety reviewed application source: `4027f0cb302ad24f4439a32a459db5f934af3005`.
- Documentation commit: the docs-only commit containing this revision; record its exact SHA in the Production gate evidence after it is created.

The documentation commit is not the Store Safety implementation identity. Production artifacts must identify the reviewed application source explicitly and must never use `latest`, a moving branch name, or the docs commit as a substitute.

## Last evidence-backed Production snapshot

The following is the last completed Gate evidence, not a live D2 query:

- Deployed application source: `962843e503a93e1b20c96e5a183cc9d9ea0b0763`.
- Active Worker version: `7f0d8e29-a219-466b-8bd8-97d4298debe5` at 100%.
- Active Deployment: `9bb7d916-f92c-46d2-9ffd-6413bdddf4a2`.
- Production D1 migrations `0001` through `0009` were applied; migration `0010` was not applied.
- Store was paused.
- Production contained one deliberately identified E2E test Order, `CZ-20260913-49DE0863`, preserved as `rejected`.
- One Merchant Push subscription existed.
- One Web Push `new_order` delivery existed and was `sent`; historical LINE delivery count was zero.
- Cloudflare Access protected `/merchant*` and `/api/merchant/*`; Customer routes remained public.
- Production Web Push delivery and five-second Merchant polling were both exercised successfully.

The Store Safety candidate has passed local implementation review and independent re-review, but the following Production work is still pending:

- Apply additive migration `0010_add_store_state_audit.sql`.
- Provision `AUDIT_ACTOR_HASH_KEY` without exposing its value.
- Upload and verify a Worker version built from reviewed application source `4027f0cb302ad24f4439a32a459db5f934af3005`.
- Complete the staged rollout and rollback-readiness gates.
- Obtain named Technical Reviewer and Business Owner approval before any Pilot.

No document completion, successful build, or technical deployment may change Pilot from NO-GO by itself.

## Product architecture

```text
Customer Web/PWA
        |
        v
Cloudflare Workers + D1
        |
        v
Merchant PWA
   |          |
5s polling   Web Push
authoritative advisory
```

The Worker and D1 are the source of truth. The Merchant PWA polls the authoritative Order queue every five seconds. Web Push is a best-effort after-commit signal and does not replace polling.

LINE is retired from the V1 runtime. Historical migration `0008`, its tables, and any retained historical evidence remain untouched until a separately authorized cleanup gate. Inherited legacy secret binding names, if still present, do not mean LINE runtime is active and must not be removed during Store Safety rollout.

## Store Safety candidate

Reviewed application source `4027f0cb302ad24f4439a32a459db5f934af3005` adds:

- `store_settings.state_version` with integer and JavaScript-safe revision constraints.
- Immutable `store_state_events` with unique operation IDs and pseudonymous actor hashes.
- Explicit `POST /api/merchant/store/resume` and `POST /api/merchant/store/pause` operations; there is no toggle endpoint.
- Compare-and-set on both accepting state and revision.
- Same-operation replay and conflict detection.
- Authenticated read-only operation lookup.
- Exact same-origin `Origin` and `Sec-Fetch-Site` protection for all Merchant mutations.
- Resume confirmation after a fresh authoritative read.
- One-click emergency Pause with bounded same-ID recovery.
- Poll revision/epoch protection so stale reads do not overwrite newer Store state or health metadata.

The candidate fails closed when the Store revision is invalid, cannot be incremented safely, the audit secret is missing/invalid, the operation is stale, or the mutation boundary is not same-origin.

## Order and notification invariants

- Client prices are display-only. Quote and Order Creation recalculate authoritative integer-TWD prices from D1.
- Order Creation atomically stores the Order, snapshots, opaque public lookup token, and Web Push delivery intent.
- Public Order lookup exposes only the opaque token contract, never the internal Order ID.
- Idempotency returns the same Order for identical retries and rejects conflicting reuse.
- Allowed Order transitions are `pending -> accepted`, `pending -> rejected`, and `accepted -> completed`.
- Store pause/resume is independent from Order accept/reject/complete and menu availability operations.
- Web Push runs after Order commit. Provider failure cannot roll back or alter the Order.
- Notification payloads contain no Customer name, phone, item details, public lookup token, subscription credentials, or actor identity.
- A Push 404/410 may remove only the expired subscription. Other failures remain observable; there is no automatic durable retry worker.
- Service Worker fetch handling bypasses all `/api/*` requests and never queues offline Orders.

## Security boundary

- Production Merchant paths require Cloudflare Access and fail-closed Worker JWT validation.
- Production must not contain the local Merchant bypass.
- Merchant mutation requests additionally require exact configured HTTPS Origin and `Sec-Fetch-Site: same-origin`.
- Access authentication does not replace mutation-origin protection.
- `AUDIT_ACTOR_HASH_KEY` is a dedicated HMAC secret. It must not be VAPID key material and must never be placed in Git, docs, D1, logs, or responses.
- Audit rows store only an HMAC-derived actor pseudonym; they do not store Access subject, email, JWT, Cookie, or full User-Agent.
- VAPID private material and Push subscription endpoint/key material remain sensitive and must never appear in evidence.

## Migration state

- Migrations `0001` through `0009` are historical and immutable.
- Migration `0010_add_store_state_audit.sql` is reviewed locally but pending Production.
- Migration 0010 is additive-only: it adds `state_version` and `store_state_events`; it contains no DROP, RENAME, DELETE, historical UPDATE, table rebuild, or fixture INSERT.
- Existing Store data receives `state_version = 0` through the column default.
- Application rollback does not normally require reversing additive migration 0010.
- D1 restore is an independent destructive recovery action requiring explicit authorization and a recorded PRE recovery reference.

## Verification state

Gate 16C-D1R independently verified the cumulative Store Safety candidate:

- Critical findings: 0.
- High findings: 0.
- Medium findings: 0.
- Low findings: 0.
- Worker tests: 165 passed.
- Merchant DOM tests: 13 passed.
- Lint, TypeScript, PWA verification, and production build passed.
- Fresh D1 `0001 -> 0010`, `0009 -> 0010`, second apply, revision attack probes, data preservation, and `PRAGMA quick_check` passed locally.

These are Local Candidate results. They do not prove that migration 0010, the audit secret, or Store Safety Worker is present in Production.

## Next gated work

1. Capture a fresh Production preflight while the Store is paused.
2. Apply and verify migration 0010 in its separately authorized Production migration gate.
3. Provision and verify the presence/runtime behavior of `AUDIT_ACTOR_HASH_KEY` without reading it back.
4. Upload one non-active Worker version tied to reviewed source `4027f0cb302ad24f4439a32a459db5f934af3005`.
5. Complete 0% version-override smoke and separately approved mutation verification.
6. Promote only after explicit Technical Reviewer approval; promotion must not Resume the Store.
7. Keep Pilot NO-GO until every criterion in `PRODUCTION_READINESS.md` is evidenced and the Business Owner explicitly authorizes Resume.
