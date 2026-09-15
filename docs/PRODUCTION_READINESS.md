# Production readiness

This checklist separates the last evidence-backed Production state from pending Store Safety rollout work. It is not authorization to mutate Production. Every unchecked remote action needs its own explicit gate and fresh evidence.

Pilot status: **NO-GO**.

## Identity

- [x] Store Safety reviewed application source is fixed as `4027f0cb302ad24f4439a32a459db5f934af3005`.
- [ ] Record the exact docs-only commit containing this checklist.
- [ ] Record the release artifact hash/identity produced from the reviewed application source.
- [ ] Confirm the release uses exact immutable IDs; do not use `latest` or a moving branch name.

The docs commit must never be substituted for the reviewed application source commit.

## Last verified Production baseline

These checks record earlier completed Gates and require fresh confirmation at rollout preflight:

- [x] Web Push application source `962843e503a93e1b20c96e5a183cc9d9ea0b0763` was promoted as Worker version `7f0d8e29-a219-466b-8bd8-97d4298debe5` at 100% in Deployment `9bb7d916-f92c-46d2-9ffd-6413bdddf4a2`.
- [x] Production migrations `0001` through `0009` were applied and `PRAGMA quick_check` was `ok`.
- [x] Store was paused and the approved Menu contained 3 categories and 43 items.
- [x] One E2E test Order was created, received one successful Web Push, and was subsequently rejected without duplicate Order or Delivery.
- [x] One Merchant Push subscription existed after the E2E gate.
- [x] Cloudflare Access protected `/merchant*` and `/api/merchant/*`; Customer routes remained public.
- [x] Preview URLs were disabled; workers.dev exposure remained enabled.
- [x] Five-second polling remained the operational fallback and source of truth.

## Store Safety Production preflight

- [ ] Freshly confirm Branch/reviewed source/artifact identity and clean release workspace.
- [ ] Record current Worker version, Deployment ID, traffic allocation, and candidate tag/message.
- [ ] Confirm Store is authoritatively paused through public GET and D1 SELECT.
- [ ] Confirm D1 identity, migration tracker, row counts, and `PRAGMA quick_check`.
- [ ] Capture a PRE Time Travel bookmark/recovery reference.
- [ ] Confirm Cloudflare Access still protects every Merchant surface.
- [ ] Confirm VAPID public/subject/private binding presence and known public-key fingerprint without reading private material.
- [ ] Prepare a presence/runtime verification for `AUDIT_ACTOR_HASH_KEY`; never read back its value.
- [ ] Name the Release Operator, Technical Reviewer, and Business Owner.
- [ ] Review and approve rollback commands before the first mutation.

## Migration 0010

- [x] Local independent review confirmed migration 0010 is additive-only.
- [x] Fresh `0001 -> 0010` and upgrade `0009 -> 0010` verification passed locally.
- [ ] Record Production PRE schema, Store value/revision, operational row counts, migration tracker, bookmark, and quick check.
- [ ] Apply only `0010_add_store_state_audit.sql` in a separately authorized gate.
- [ ] Confirm `state_version` uses INTEGER storage and initially equals zero on the preserved Store row.
- [ ] Confirm `store_state_events` exists with zero rollout-created fixtures.
- [ ] Confirm Orders, Order items/modifiers, Push subscriptions, Web Push deliveries, and historical LINE-era data are preserved.
- [ ] Capture POST bookmark and `PRAGMA quick_check = ok`.

If any POST migration invariant fails: STOP, keep the Store paused, do not upload/promote the Worker, and enter the recovery decision procedure.

## Audit secret and Worker candidate

- [ ] Generate `AUDIT_ACTOR_HASH_KEY` from an approved cryptographically secure source outside Git, docs, logs, D1, and shell history.
- [ ] Confirm it is independent from `VAPID_PRIVATE_KEY` and all other keys.
- [ ] Provision it through a separately authorized secret gate without exposing its value.
- [ ] Verify binding presence and fail-closed runtime behavior, not the secret value.
- [ ] Upload exactly one non-active Worker version built from reviewed source `4027f0cb302ad24f4439a32a459db5f934af3005`.
- [ ] Confirm bindings, assets, tag/message, source commit, and migration prerequisite.
- [ ] Confirm upload did not alter Deployment or traffic.

## Staged rollout

- [ ] Create one old-version 100% / candidate 0% Deployment under explicit authorization.
- [ ] Confirm normal traffic remains on the old Worker and assets are unchanged.
- [ ] Use the fixed version-override header for candidate read-only smoke.
- [ ] Verify health, public Store, Menu, assets, authenticated Merchant reads, state revision, and migration compatibility.
- [ ] Do not treat HTTP 200 alone as candidate identity evidence.
- [ ] Execute any Store mutation smoke only in a separately authorized mutation gate while initially paused.
- [ ] Verify Store CAS, immutable Audit event, Origin guard, same-ID lookup/replay, and authoritative post-state without exposing actor identity.
- [ ] Promote only the exact verified candidate after Technical Reviewer approval.
- [ ] Confirm promotion creates no new Worker version and no unknown traffic split.
- [ ] Confirm `NO AUTO-RESUME`: promotion must leave the Store paused.

## Pilot GO criteria

All boxes are mandatory before Pilot can change from NO-GO to GO:

- [ ] Migration 0010 Production gate PASS.
- [ ] `AUDIT_ACTOR_HASH_KEY` provisioned and verified by presence/runtime behavior.
- [ ] Store Safety Worker upload, 0% smoke, and 100% rollout gates PASS.
- [ ] Production public and authenticated read-only smoke PASS.
- [ ] Cloudflare Access and exact same-origin mutation guard PASS.
- [ ] Store Resume confirmation, CAS, Audit event, operation lookup, emergency Pause, and authoritative state checks PASS.
- [ ] Audit evidence is sanitized and exposes no actor identity or request fingerprint.
- [ ] Push path and five-second polling fallback are healthy.
- [ ] Rollback version/command and D1 PRE recovery reference are available.
- [ ] Store is initially paused.
- [ ] Named Release Operator is present and watching the evidence clock.
- [ ] Named Business Owner confirms the store can accept real Orders.
- [ ] Named Technical Reviewer accepts technical evidence and rollback readiness.
- [ ] Pilot maximum Order count and maximum accepting window are explicitly filled into the Gate evidence.
- [ ] Everyone knows the abort and emergency Pause procedure.

Green tests or successful deployment alone are insufficient for Pilot GO.

## Pilot NO-GO / abort criteria

Pilot remains NO-GO, or must abort immediately, if any of these is true:

- Store state cannot be determined authoritatively.
- Store revision is invalid or jumps unexpectedly.
- Same-operation replay changes Store state a second time or creates a duplicate Audit event.
- Origin or Access protection regresses, or an unauthorized Merchant mutation succeeds.
- D1 integrity or migration identity is uncertain.
- Worker source/version/deployment identity does not match approved evidence.
- Push produces an unexpected duplicate or polling is unavailable as fallback.
- Merchant UI reports success while authoritative Store state disagrees.
- Rollback or emergency Pause path is unavailable.
- The named Operator, Reviewer, or Business Owner is unavailable.
- The approved Order count or accepting window is reached.

Abort sequence: Pause Store, verify authoritative Store state, stop new Orders, preserve operation IDs/timestamps/version evidence, do not make a blind second mutation, then follow the rollback matrix.

## Ownership

- **Release Operator:** validates immutable candidate identity; executes only authorized migration/secret/upload/deployment commands; captures evidence; operates the stopwatch; executes approved rollback.
- **Technical Reviewer:** independently reviews migration/deployment invariants, sanitized Audit evidence, smoke results, and rollback readiness; accepts or blocks each technical Gate.
- **Business Owner / Store Owner:** confirms onsite capacity; decides Pilot business GO/NO-GO; alone authorizes when the Store may Resume for real Orders.

One person may temporarily fill multiple roles, but each responsibility and approval must be recorded separately. A Release Operator must not infer permission to Resume from a successful technical deployment.

## Deferred cleanup and launch work

- [ ] Review final PWA icons and intended public hostname.
- [ ] Configure a Custom Domain or explicitly accept workers.dev entry risk for the bounded Pilot.
- [ ] Establish fake/no-show Order controls appropriate to broader public operation.
- [ ] Validate a second Merchant device or document the single-subscription risk and polling fallback.
- [ ] Define alerting, retention, Customer data retention/deletion, and incident ownership before normal business launch.
- [ ] Remove inherited LINE secrets or historical tables only in separately reviewed cleanup gates after all dependencies and evidence-retention needs are resolved.

Deployment and Pilot are not approved by this checklist. See `DEPLOYMENT_RUNBOOK.md` for the executable sequence and evidence template.
