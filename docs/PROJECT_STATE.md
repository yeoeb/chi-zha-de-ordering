# Project state

## Current phase

CP0 through CP7 and the customer/merchant ordering vertical slice are complete. CP8 staging infrastructure exists, but the store remains paused. The current repository contains a local-only architecture change that removes LINE from V1 and introduces Merchant Web Push; it has not been deployed and migration `0009` has not been applied remotely.

Production baseline before this local change:

- Deployed source: `ba005df66faa2771b3f6ed0ed57d3d85dc8df466`.
- Active Worker version: `4c179bcb-3dea-43d6-9aa6-9ace40df7b85` at 100%.
- Staging URL: `https://chi-zha-de-ordering.yeoeb55688.workers.dev`.
- Production D1: `chi-zha-de-db`; migrations `0001` through `0008` applied.
- Store is paused, approved Production Menu contains 3 categories and 43 items, and no Production Orders exist.
- Cloudflare Access protects `/merchant*` and `/api/merchant/*`; Customer routes remain public.

No Worker deployment, remote D1 mutation, Cloudflare secret mutation, Access change, or store resume is part of the current local task.

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
foreground   background / lock screen
```

The Merchant PWA and its authoritative API queue are the merchant's source of truth. Web Push is an advisory after-commit notification. Foreground polling continues every five seconds even when Push is enabled.

LINE is retired from the V1 product path. There is no active LINE provider, webhook, pairing API, frontend control, or runtime LINE environment requirement. Historical migration `0008` and its two D1 tables remain unchanged and unused so removal can happen only after a separately reviewed Production cleanup gate.

## Completed customer and Order behavior

- Single-store D1 settings, Menu categories/items, required single-choice modifiers, availability, and deterministic backend sorting.
- Client-only configuration-aware Cart. Browser prices are display-only and non-authoritative.
- Checkout Quote and Order Creation share current D1 validation and authoritative integer-TWD pricing.
- Order Creation stores immutable item/modifier snapshots, queue-aware absolute ETA, pending status, and a unique opaque public lookup token.
- Database-backed idempotency returns the same Order for identical retries and rejects conflicting reuse.
- Order header, items, modifiers, and notification intent are one atomic D1 batch.
- Customer status reads use snapshots, `Cache-Control: no-store`, persisted ETA, and four-second polling until completed/rejected.
- Merchant state machine permits only `pending -> accepted`, `pending -> rejected`, and `accepted -> completed`, using compare-and-set updates.
- Sold-out and store pause controls are independent. Quote and Order Creation revalidate both; existing Orders remain operable.
- Public writes have bounded request bodies and Order rate limiting. Customer lookup uses opaque tokens.

## Merchant PWA behavior

- `/merchant` is mobile-first and protected by Cloudflare Access plus the Worker JWT guard.
- Active Orders poll every five seconds while mounted and bypass caches.
- The first successful load seeds the seen-order set without alerting. A later newly discovered `pending` Order ID is highlighted and produces one foreground audible alert. Seen IDs are retained for the mounted session so the alert is not replayed every poll.
- The status panel reports Online/Offline, Push enabled/disabled, and last successful sync time.
- Notification permission is requested only after the Merchant taps the enable button.
- Feature detection covers Service Worker, PushManager, and Notifications. Unsupported devices receive Home Screen guidance without user-agent sniffing.
- Accept/reject/complete, sold-out/restore, and pause/resume behavior is preserved.

## Web Push foundation

Protected Merchant APIs:

- `GET /api/merchant/push/public-key`: returns only the VAPID public key; returns `503 WEB_PUSH_NOT_CONFIGURED` when absent.
- `POST /api/merchant/push/subscriptions`: validates and idempotently upserts the browser subscription by endpoint.
- `DELETE /api/merchant/push/subscriptions`: idempotently removes the supplied endpoint.

All three routes pass through the existing Merchant Access/JWT middleware. Subscription endpoints and keys are never returned from public APIs or notification-observability responses and must not be logged.

Runtime configuration contract:

- `VAPID_PUBLIC_KEY`: non-secret runtime configuration.
- `VAPID_PRIVATE_KEY`: production Worker Secret.
- `VAPID_SUBJECT`: non-secret `mailto:` or HTTPS runtime configuration.

No Production VAPID values have been generated or configured. Missing VAPID configuration disables Push delivery but does not prevent Worker startup or Order creation. There is no runtime Fake-provider selection; the Fake provider is directly injected only by automated tests.

The provider uses `@block65/webcrypto-web-push`, which relies on Web Crypto and is compatible with Cloudflare Workers. Each payload contains only:

```json
{
  "title": "吃炸的｜新訂單",
  "body": "新訂單 #<display number>",
  "data": { "url": "/merchant" }
}
```

It does not contain Customer PII, item details, public lookup tokens, or subscription credentials. The Merchant loads authoritative details from `/api/merchant/orders`.

Push delivery fans out to all stored Merchant subscriptions. A 404/410 response deletes that expired subscription. Other failures update its failure timestamp. The aggregate Order notification delivery is `sent` when at least one subscription succeeds and `failed` when all fail or no subscription/configuration exists.

Order commit and Push delivery remain separate: Order Creation commits first, then schedules delivery with the Worker execution context. Delivery failure cannot roll back or alter the Order.

## Service Worker

- Caches only the PWA application shell/static resources.
- Explicitly bypasses every `/api/*` request.
- Does not queue offline Order submissions or imply offline success.
- Handles `push` by displaying the minimal notification.
- Handles `notificationclick` by focusing an existing Merchant window or opening `/merchant`.
- The Badging API is not required.

## Local schema

Migrations `0001` through `0008` remain unchanged. New migration:

- `0009_create_merchant_push_subscriptions.sql`
  - Is additive because it has not been applied to Production: migrations `0001` through `0008` remain immutable.
  - Leaves historical `notification_deliveries` structure and rows untouched.
  - Creates `web_push_notification_deliveries` with `(order_id, event_type)` uniqueness, retry metadata, foreign keys, and an operational status index.
  - Creates `merchant_push_subscriptions` with unique endpoint, encrypted Push keys, timestamps, and success/failure timestamps.

Deprecated but intentionally retained:

- `line_merchant_binding`
- `line_merchant_pairing_challenge`
- Historical `notification_deliveries.channel = 'line'` rows, if any

New Orders locally create only `web_push` notification intents. Historical LINE intents are readable but cannot be retried through the active provider.

## Security and known limitations

- Merchant endpoints remain safe only behind the documented Cloudflare Access hostname/path boundary plus the fail-closed Worker JWT validation.
- The explicit development Merchant bypass is test/local-only and absent from Wrangler Production vars.
- Public Customer Order lookup still lacks Customer authentication; opaque 256-bit lookup tokens mitigate enumeration.
- Push is best effort. There is no Queue/Cron durable retry worker; Merchant polling is the fallback and source of truth.
- Audible foreground alerts can be constrained by browser autoplay policy. Web Push is the background/lock-screen path once explicitly enabled.
- Subscription material is operationally sensitive even though it is not a VAPID private key.
- Migration `0009`, VAPID provisioning, Worker version upload, rollout, and remote LINE-secret cleanup all require separate Production gates.
- Store must remain paused until the new Worker, migration, Push subscription, and smoke checks are explicitly authorized and verified.

## Verification approach

- Workers Vitest integration applies all local migrations from isolated state.
- Tests protect pricing, modifier ownership, atomic Order creation, snapshots, idempotency, ETA, state transitions, Access guard, availability controls, polling, Push subscription idempotency, terminal endpoint cleanup, and the Order/Push failure boundary.
- `scripts/verify-pwa.mjs` verifies manifest/icons, API cache bypass, Service Worker registration, and Push/click handlers.
- `scripts/verify-fresh-d1.mjs` verifies all nine migrations from an empty local D1 while retaining deprecated LINE tables.
- Wrangler deployment verification remains dry-run only for this task.

## Next gated work

1. Human review this local architecture change.
2. Review and explicitly authorize remote migration `0009` with D1 recovery evidence.
3. Generate VAPID keys outside Git/chat, configure public key/subject and version-managed private Secret, then upload a non-active Worker version.
4. Smoke the candidate with version overrides while the store remains paused.
5. Deploy only after a separate traffic-shift authorization.
6. Pair the Merchant browser by explicitly enabling notifications, verify one controlled Push, and keep polling operational.
7. Delete retired remote LINE secrets/tables only in later, separately authorized cleanup gates after the Web-only release is stable.
