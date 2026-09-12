# Production readiness

This checklist separates verified infrastructure from pending Web Push rollout work. Checked items are evidence-backed; actions requiring remote access remain unchecked until their own explicit gate.

## Existing verified baseline

- [x] Production D1 `chi-zha-de-db` exists and binding `DB` is configured.
- [x] Remote migrations `0001` through `0008` were applied and `PRAGMA quick_check` returned `ok`.
- [x] Approved Production Store/Menu data contains 3 categories and 43 items.
- [x] Store is paused (`is_accepting_orders = 0`).
- [x] Cloudflare Access protects `/merchant*` and `/api/merchant/*`.
- [x] Worker Merchant JWT guard matches the protected hostname, Access issuer, and audience.
- [x] Customer routes remain public.
- [x] Preview URLs are disabled; the temporary workers.dev staging hostname remains enabled.
- [x] `ORDER_RATE_LIMITER` is configured at 20 requests per 60 seconds.
- [x] PWA manifest, 192/512 placeholder icons, static shell caching, and API cache bypass were verified.
- [x] Current deployed Worker release is recorded in `docs/PROJECT_STATE.md`.

## Local Web-only candidate

- [x] Active source no longer contains a LINE provider, webhook, pairing API, or LINE runtime environment requirement.
- [x] Historical migration `0008` remains unchanged; its deprecated tables are retained.
- [x] Migration `0009` is additive: it adds separate Web Push intent/subscription tables and leaves historical LINE notification structure and rows untouched.
- [x] Merchant subscription routes remain behind Access/JWT middleware.
- [x] Notification permission requires an explicit Merchant gesture.
- [x] Foreground five-second polling remains active independently of Push.
- [x] Service Worker handles Push and notification clicks while bypassing all APIs.
- [x] Push failure cannot roll back Order creation.
- [x] Expired 404/410 subscriptions are removed safely.
- [x] No Fake provider can be selected through Production configuration.

## Remote Web Push rollout — pending

- [ ] Review migration `0009_create_merchant_push_subscriptions.sql` and capture a D1 Time Travel bookmark.
- [ ] Apply migration `0009` remotely and verify Store/Menu/Order state is unchanged.
- [ ] Generate a Production VAPID key pair outside Git, chat, and shell history.
- [ ] Configure `VAPID_PUBLIC_KEY` as a non-secret Worker variable.
- [ ] Configure `VAPID_SUBJECT` as a non-secret Worker variable.
- [ ] Configure `VAPID_PRIVATE_KEY` as a version-managed Cloudflare Secret.
- [ ] Upload a non-active Worker version containing code, bindings, assets, and the VAPID Secret.
- [ ] Verify candidate routes and assets through a version override while the store remains paused.
- [ ] Deploy the reviewed candidate through a separately approved traffic gate.
- [ ] Merchant installs/opens the protected PWA and explicitly enables notifications.
- [ ] Confirm exactly one idempotent subscription row without exposing endpoint/key material.
- [ ] Perform one controlled Push smoke and verify Merchant receipt.
- [ ] Verify foreground polling still discovers Orders when Push is unavailable.
- [ ] Verify 404/410 subscription cleanup with a controlled test boundary.

## Retired LINE cleanup — deliberately deferred

- [x] LINE is removed from the local V1 product path.
- [ ] Verify the Web-only Worker is stable before altering any remote LINE configuration.
- [ ] Remove obsolete LINE webhook configuration in LINE Developers, if present.
- [ ] Delete obsolete remote LINE Worker secrets through a separately authorized versioned-secret gate.
- [ ] Decide whether deprecated `line_merchant_binding` and `line_merchant_pairing_challenge` tables should be removed in a later migration.
- [ ] Confirm no historical delivery evidence is needed before any destructive schema cleanup.

## General launch checks

- [ ] Final PWA icons reviewed.
- [ ] Manifest and Service Worker verified over the intended HTTPS hostname.
- [ ] Dynamic Customer, Order, and Merchant API responses verified uncached.
- [ ] Merchant install/login behavior verified on the intended phone.
- [ ] Production runtime smoke completed.
- [ ] Real prices and item availability re-reviewed immediately before opening.
- [ ] Rollback and D1 recovery procedures reviewed by the operator.
- [ ] Custom Customer/Merchant domains configured, or workers.dev staging risk explicitly accepted.
- [ ] workers.dev and alternate-route exposure reviewed before final Production launch.
- [ ] Store resume separately authorized only after all blocking checks pass.

## Secret and privacy rules

- `VAPID_PRIVATE_KEY` is a Worker Secret and must never appear in Git, docs, logs, chat, or committed environment files.
- `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` are non-secret configuration.
- Push endpoints, `p256dh`, and `auth` values are sensitive operational data: store only in D1, never log them, and never expose them through public APIs.
- Customer phone numbers, names, full Orders, lookup tokens, and payment data must never appear in Push payloads.
- Remote LINE secrets are intentionally untouched by this local task and remain a later cleanup concern.

Deployment is not approved by this checklist.
