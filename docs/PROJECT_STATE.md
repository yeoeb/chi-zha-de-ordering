# Project state

## Current phase

CP8 Gate 15A — the secure LINE Merchant pairing foundation is implemented and verified locally. Migration `0008`, the new Worker code, and secrets have not been applied or deployed remotely; the workers.dev store remains paused.

- CP0 — Initial Local Baseline: complete.
- CP1 — Menu + Modifier + Client Cart: complete and verified.
- CP2 — Checkout Quote + Order Creation: complete and verified.
- CP2A — Checkout Quote + ETA Policy: complete.
- CP2B — Order Creation + Snapshot + Idempotency: complete.
- CP2 Verification: complete.
- CP3A — Merchant Order Handling: complete.
- CP3B — Customer Order Status Polling: complete.
- CP3 Verification: complete.
- CP3 — Merchant Processing + Customer Status: complete and verified.
- CP4 — Merchant Availability Controls: complete and verified.
- CP5 — Production Security Foundation: complete and verified.
- CP6 — PWA + Merchant Notification Foundation: complete and verified.
- CP7 — Notification Reliability + Deployment Readiness Verification: complete and verified.
- CP8 Gates 0–11 — production data, Access boundary, staging configuration, and final pre-deploy verification: complete.
- CP8 Gate 12F — first Worker bootstrap deployment and public/unauthenticated smoke verification: complete.
- CP8 Gate 13 — Access-authenticated Merchant read-only smoke verification: complete.
- CP8 Gate 14 — real LINE verification preparation: complete; external delivery remains separately gated.
- CP8 Gate 15A — secure LINE Merchant pairing foundation: implemented and verified locally only.

## Implemented features

- React SPA served by Vite with the Cloudflare Vite plugin.
- Hono Worker API with explicit Worker-first routing for `/api/*`.
- D1 binding `DB` targets the production `chi-zha-de-db` database. All seven migrations and the human-approved Store/Menu configuration are applied remotely; the store remains paused.
- Single-store settings stored in D1 and exposed through the API.
- Active menu categories, items, modifier groups, and modifier options are grouped and deterministically sorted by the backend.
- Mobile-first menu with sold-out handling and required single-choice item configuration.
- In-memory client cart with configuration-aware line identity, quantity changes, removal, item count, subtotals, and total.
- Backend-authoritative checkout quote with current D1 names, availability, modifier relationships, integer prices, line totals, and cart total.
- Order creation revalidates current D1 menu data, persists immutable item/modifier price and name snapshots, and always starts in `pending`.
- Database-backed idempotency returns the original snapshot for an identical retry and rejects conflicting content for the same key.
- Minimal Checkout/Review flow collects customer name and phone, submits with an idempotency key, and shows a pending confirmation without implying merchant acceptance.
- Mobile-friendly Merchant active queue at `/merchant`, with explicit Accept, Reject, and Complete actions.
- Explicit V1 Order state transitions guarded atomically by the expected current status in D1.
- Customer Order status view can be reopened at `/orders/:id` and observes Merchant changes through bounded polling.
- Merchant can independently mark customer-visible items sold out/available and pause/resume all new ordering.
- Customer Order status uses a backend-generated opaque public lookup token rather than the internal Order ID.
- Merchant APIs have a fail-closed Cloudflare Access JWT boundary with an explicit local-only bypass.
- Public Order creation has a Cloudflare Workers Rate Limiting binding and bounded JSON request bodies.
- Installable PWA shell with a manifest, documented placeholder icons, and a Service Worker that bypasses every API request.
- Merchant active Orders refresh on a bounded five-second chained poll while the Merchant view is mounted.
- Every new logical Order atomically stores one LINE notification intent; a provider attempt runs after durable Order creation and records `sent` or `failed` without changing the Order result.
- Merchant notification observability lists recent failed/pending deliveries first and provides a guarded explicit retry without exposing Customer PII or provider credentials.
- Authenticated Merchant pairing creates one cryptographically random ten-minute code whose SHA-256 hash is stored in D1. A valid signed LINE webhook plus the one-time code can bind or rebind the singleton Merchant recipient without exposing the LINE user ID through APIs.
- Pure preparation-time policy with a UTC ISO-8601 absolute ready timestamp.
- Reusable schema migrations are separate from replaceable local development fixtures.

## Current schema

- `store_settings`: the single row for store identity, accepting-orders state, and preparation timing settings.
- `menu_categories`: category name, deterministic sort order, and active state.
- `menu_items`: category foreign key, name, description, integer TWD price, deterministic sort order, and availability.
- `modifier_groups`: menu item foreign key, name, `single` selection type, required state, deterministic sort order, and active state.
- `modifier_options`: modifier group foreign key, name, integer TWD price delta, deterministic sort order, and active state.
- `orders`: internal text ID, immutable unique 256-bit public lookup token, unique order number, constrained V1 status, authoritative integer total, absolute ETA/created/status timestamps, customer details, special-order flag, unique idempotency key, and request fingerprint.
- `order_items`: Order/menu references plus immutable item name, unit price, quantity, line total, and deterministic snapshot order.
- `order_item_modifiers`: Order-item/modifier references plus immutable group name, option name, price delta, and deterministic snapshot order.
- `notification_deliveries`: one unique `new_order`/`line` delivery per Order, status (`pending`, `sent`, or `failed`), attempt count, last-attempt time, sanitized last error, creation time, and optional sent time.
- `line_merchant_binding`: singleton D1 record containing the validated LINE recipient user ID and pairing timestamps. It is never projected through Customer or Merchant APIs.
- `line_merchant_pairing_challenge`: singleton one-time challenge containing only the code hash, ten-minute expiry, creation time, and optional consumed time. Creating another challenge atomically replaces the prior one.

SQLite boolean fields use constrained `0`/`1` values. No inventory, stock quantity, image, combo, promotion, coupon, payment, delivery, account, or generic workflow schema exists.

## Current API

- `GET /api/health`: health response.
- `GET /api/store`: single-store settings.
- `GET /api/menu`: active categories and items with nested active modifier groups/options. The backend controls all relationships and ordering. Unavailable menu items remain present with `isAvailable: false`.
- `POST /api/checkout/quote`: accepts only menu item IDs, quantities, and modifier option IDs. It validates current D1 data and returns normalized items, authoritative integer prices, total, lead minutes, and an absolute `estimatedReadyAt` timestamp. It does not create an Order.
- `POST /api/orders`: accepts customer details, special-order state, and identity-only item selections with an `Idempotency-Key` header. It reuses authoritative validation/pricing, calculates queue-aware ETA, atomically stores snapshots, and returns a customer-safe representation containing the public lookup token but not the internal Order ID.
- `GET /api/orders/by-token/:token`: returns a customer-safe historical Order projection from persisted snapshots with current status and committed ETA. The old internal-ID route is not a public lookup contract. Every response uses `Cache-Control: no-store`.
- `GET /api/merchant/orders`: returns only actionable `pending` and `accepted` Orders, oldest first, using stored item/modifier snapshots.
- `GET /api/merchant/notifications`: returns at most 50 recent operational delivery records, ordering failed then pending before sent, without phone numbers, public tokens, or credentials.
- `POST /api/line/webhook`: public LINE callback boundary. It verifies `x-line-signature` over the exact raw body before JSON parsing, accepts empty verification events, and processes only a valid `綁定 <code>` user message.
- `POST /api/merchant/line/pairing`: protected Merchant action that replaces any prior challenge and returns a random one-time code once with its expiry. Plaintext is never stored.
- `GET /api/merchant/line/status`: protected Merchant projection returning only paired state and optional pairing time, never the recipient user ID.
- `POST /api/merchant/notifications/:id/retry`: retries a failed, never-attempted, or stale-pending delivery through the configured provider. Sent and actively in-progress deliveries return a conflict; missing deliveries return 404.
- `POST /api/merchant/orders/:id/accept`: transitions `pending` to `accepted`.
- `POST /api/merchant/orders/:id/reject`: transitions `pending` to `rejected`.
- `POST /api/merchant/orders/:id/complete`: transitions `accepted` to `completed`.
- `POST /api/merchant/menu-items/:id/sold-out`: idempotently marks an item unavailable.
- `POST /api/merchant/menu-items/:id/restore`: idempotently restores an item to available.
- `POST /api/merchant/store/pause`: idempotently pauses new Checkout Quotes and Orders.
- `POST /api/merchant/store/resume`: idempotently resumes new ordering without changing item availability.

## Cart and pricing

- Cart state is held only in React memory; it is not stored in D1 or localStorage.
- A cart line ID is derived deterministically from the menu item ID and sorted selected modifier group/option IDs.
- Identical configurations merge by increasing quantity; different configurations remain separate lines.
- Client unit prices equal the menu item price plus selected modifier price deltas. Subtotals and cart totals are calculated locally for immediate display only.
- Client cart prices are non-authoritative and must never be trusted when creating an Order.
- Checkout Quote reloads current menu/modifier data from D1 and recalculates authoritative prices through `validateAndPriceCart`.
- Order creation reuses `validateAndPriceCart`; there is no second pricing algorithm.
- Historical Order display must use `order_items` and `order_item_modifiers` snapshots rather than current menu labels or prices.

## Order creation and idempotency

- New Orders always use `pending`, meaning submitted to the system but not accepted by the merchant.
- `Idempotency-Key` is unique in D1. The canonical identity-only request is hashed with SHA-256 and stored as `request_fingerprint`.
- An identical retry returns the same stored Order and does not revalidate changed menu data or create another Order.
- Reusing a key with conflicting request content returns `409 IDEMPOTENCY_KEY_CONFLICT`.
- Item and modifier snapshot writes are prepared with generated IDs and committed with the Order in one D1 transactional batch; any failed statement rolls back the sequence.
- The same D1 batch stores the initial notification intent. External provider delivery is not part of the transaction and cannot roll back a durable Order.
- Order creation generates 32 cryptographically random bytes encoded as 64 lowercase hexadecimal characters. D1 enforces token uniqueness, validates new token shape, and prevents token mutation. Migration `0005` backfills historical local Orders.

## Merchant Order handling

- Legal V1 transitions are `pending -> accepted`, `pending -> rejected`, and `accepted -> completed`; every other transition is rejected with `409 ILLEGAL_ORDER_TRANSITION`.
- Each action uses an explicit conditional update containing both the Order ID and expected current status. Zero affected rows are resolved to `404 ORDER_NOT_FOUND` or an illegal-transition conflict. This prevents two competing merchant actions from both succeeding without distributed locking.
- Accept sets `accepted_at`, reject sets `rejected_at`, and complete sets `completed_at`. Transition timestamps are absolute UTC ISO-8601 values and are never overwritten by a later legal action.
- Merchant active queue ordering is deterministic: `created_at ASC`, then Order ID, with snapshot items and modifiers in stored sort order.
- Completed and rejected Orders are excluded from the primary Merchant queue.
- Merchant display reads `order_items` and `order_item_modifiers` snapshots; it never reconstructs historical presentation from current menu rows.
- `estimated_ready_at` is a customer-facing commitment. Accept, reject, and complete actions leave it unchanged; automatic or manual ETA adjustment is intentionally absent.
- `pending` means submitted and waiting for merchant confirmation, not accepted. Merchant UI wording preserves this distinction.

## Customer Order status

- After Order creation, the customer is moved to `/orders/:publicLookupToken`; the polling API reads `/api/orders/by-token/:token` and can reopen the Order after a page reload.
- The customer response contains the public lookup token, Order number, current status, customer name, creation time, persisted ETA, authoritative total, and snapshot items/modifiers. It excludes the internal Order ID, phone, idempotency data, special-order state, and internal transition timestamps.
- Customer wording is explicit: `pending` = 訂單已送出 / 等待店家確認, `accepted` = 店家已接受, `completed` = 訂單已完成, and `rejected` = 店家目前無法接單.
- Pending and accepted views poll every 4 seconds. Completed and rejected views stop polling. The single chained timeout and active request are cleared/aborted when the component unmounts or the customer leaves the view.
- A temporary request failure preserves the last successful Order and retries on the normal interval. A 404 displays a clear not-found message and stops polling.
- `Cache-Control: no-store` is explicit on successful and not-found customer Order responses.
- The UI displays the persisted absolute `estimated_ready_at` value in customer-local time; it never recalculates ETA from the browser or current queue.
- Customer Order presentation uses immutable Order snapshots and remains independent of current Menu names and prices.

## Merchant availability controls

- Item availability and store accepting-orders state are independent operational controls. Pausing/resuming the store never changes `menu_items.is_available`, and restoring store ordering never restores a sold-out item.
- `menu_items.is_available = 0` keeps the item visible through `/api/menu` with `isAvailable: false`, prevents customer configuration in the current UI, and causes Checkout Quote and Order creation to reject selections containing it.
- `store_settings.is_accepting_orders = 0` leaves the Menu readable but disables new Checkout in the customer UI. Both Checkout Quote and Order creation reject with `409 STORE_NOT_ACCEPTING_ORDERS`.
- Checkout Quote reads current store state before pricing and revalidates current item availability. Order creation independently reloads current store/menu/modifier data and authoritative prices rather than treating an earlier Quote as authorization.
- Existing pending/accepted Orders, customer polling, stored snapshots, and committed ETAs are unaffected by later sold-out or pause actions. Merchant accept/reject/complete actions continue while the store is paused.
- Sold-out, restore, pause, and resume are idempotent operational actions: repeated requests return successful current state. Unknown Menu Item actions return `404 MENU_ITEM_NOT_FOUND`.
- Availability is a manual boolean decision only. There is no stock quantity, automatic decrement, ingredient model, threshold, or inventory system.

## Preparation time policy

- V1 formula: `leadMinutes = basePrepMinutes + ordersAhead * normalOrderMinutes + specialOrdersAhead * specialExtraMinutes`.
- A special Order contributes both the normal amount and the special extra amount.
- `specialOrdersAhead` must not exceed `ordersAhead`, and lead time cannot be less than `basePrepMinutes`.
- `estimatedReadyAt` is returned as an absolute UTC ISO-8601 timestamp calculated from an injected/current `now` value.
- Checkout Quote continues to use `ordersAhead = 0` and `specialOrdersAhead = 0` because it is only a preview.
- Order creation counts existing `pending` and `accepted` Orders as ahead; `completed` and `rejected` Orders are excluded. Active special Orders contribute `specialExtraMinutes`.
- Queue counts are read before the new Order is inserted, so an Order never counts as ahead of itself.

## Architectural decisions

- The Worker remains a single Hono route file; current complexity still does not justify repository, service, or controller layers.
- `/api/menu` uses one ordered query and performs grouping in the Worker, avoiding per-item requests and N+1 behavior.
- Modifier selection currently supports only `single`; multi-choice and nested modifier abstractions are intentionally absent.
- Cart transitions and display-price calculations are isolated in a small pure reducer/helper module without a state library.
- Required single-choice modifier validation is a small pure frontend-domain helper used by React; one option ID can be retained per group.
- Authoritative validation and pricing live in a reusable Worker module, separate from the Hono route, so Checkout Quote and future Order creation share one trust boundary.
- Preparation-time calculation is pure logic separate from React, routing, and persistence.
- Order creation is a focused application boundary that composes pricing, store settings, queue policy, snapshots, and an atomic D1 batch without repository/controller layers.
- Merchant state rules are three explicit guarded updates in a small Worker module; no generic workflow engine, repository layer, or arbitrary status endpoint was introduced.
- The Merchant UI uses the existing React/Vite application at `/merchant`, without a router, UI framework, analytics, or dashboard abstractions.
- Customer polling uses React hooks and one bounded 4-second chained timeout. A small pure helper owns the active-versus-terminal polling decision; no polling or state library was added.
- Availability mutations are four explicit action endpoints using prepared D1 statements; no generic field-patch or inventory abstraction was introduced.
- The Merchant UI reuses `/api/store` and `/api/menu` for a touch-friendly operational section, while backend Quote/Order checks remain authoritative.
- Merchant refresh uses a non-overlapping five-second chained timeout with `no-store` fetches. Cleanup aborts the active request and clears the timeout when the view unmounts.
- Static asset fallback remains SPA-based while `/api/*` always reaches the Worker first.
- The PWA Service Worker caches only the application shell and same-origin static assets. It explicitly does not intercept any `/api/*` request, so Menu, Store, Checkout, Customer Order status, Merchant state, and Order writes always go to the live Worker.
- `NotificationProvider` is the small external side-effect boundary. Fake/local and LINE implementations share `notifyNewOrder`; pricing, validation, and snapshot code have no LINE dependency.
- Merchant authorization is one small middleware boundary. In production it requires the exact configured Merchant hostname and cryptographically validates `Cf-Access-Jwt-Assertion` against the configured Cloudflare Access issuer, rotating JWK set, and audience. It does not trust a header without signature validation.
- Public request-body parsing is bounded before JSON/domain validation. The Order rate limiter is isolated from idempotency and other correctness rules.

## Known V1 concurrency limitation

- Queue counting and authoritative menu reads occur before the atomic snapshot write. Concurrent first-time submissions can observe the same queue counts, and a concurrent menu update could occur between validation and insertion.
- The database uniqueness constraint still prevents duplicate idempotency keys, and the write batch prevents partial Orders. Distributed locking or a generic workflow system is intentionally deferred.
- Conditional transition updates prevent competing actions on one Order from both succeeding. They do not change the existing Order-creation queue snapshot limitation.
- Store/item availability is read before the atomic Order snapshot batch. A simultaneous Merchant availability mutation can race within this small read-to-write window in V1; no distributed lock or reservation system is claimed or implemented.
- Notification delivery uses one best-effort `waitUntil` attempt. A crash after intent persistence or a failed provider call leaves an observable pending/failed row, but automated retry/recovery is intentionally deferred.

## PWA and merchant notifications

- `manifest.webmanifest` defines the 吃炸的 standalone app shell with `/merchant` as the operational home-screen start URL, theme/background colors, and generated 192/512 px placeholder icons. Final artwork review remains a production-readiness item.
- Production builds register a minimal Service Worker. Navigation uses network-first with an application-shell fallback; same-origin static assets are cached. All API paths are excluded, and there is no offline Checkout or Order replay.
- The Merchant PWA remains a live operational view and polls every five seconds only while mounted. LINE is a convenience alert, never the authoritative Order queue.
- Order creation atomically persists exactly one pending `line`/`new_order` intent with the Order snapshots. The unique `(order_id, channel, event_type)` constraint and DB-backed Order idempotency prevent a retry from creating or sending a second logical notification.
- Delivery claims an eligible intent with a conditional D1 update before calling the provider, increments `attempt_count`, and records `last_attempt_at`. Success records `sent` and `sent_at`; failure records `failed` and a bounded sanitized reason. In either case the Order remains unchanged and the Customer's successful Order response is independent of delivery.
- Manual retry accepts `failed`, never-attempted `pending`, or `pending` whose prior claim is at least 60 seconds old. This makes abandoned best-effort work recoverable while rejecting an active attempt. A `sent` delivery is never eligible again.
- Local development can use the Fake provider only with the explicit Merchant development bypass. The deployed staging release remains `NOTIFICATION_PROVIDER=disabled`. The target LINE design uses `NOTIFICATION_PROVIDER=line`, secret `LINE_CHANNEL_ACCESS_TOKEN`, secret `LINE_CHANNEL_SECRET`, and the authoritative recipient from `line_merchant_binding`; `LINE_MERCHANT_RECIPIENT_ID` is removed.
- The LINE provider uses the Messaging API push endpoint with a bounded text body, Bearer authorization, and a five-second timeout. Its message includes only the customer-safe Order number, item names/quantities, total, and ready time—never phone, lookup token, internal ID, or credentials.
- When LINE mode has no paired recipient, delivery fails closed with `LINE_RECIPIENT_NOT_PAIRED`; it never falls back to Fake. Pairing/rebinding requires a fresh code generated behind the Merchant Access/JWT boundary. Signature verification alone never authorizes a LINE user.
- `waitUntil` extends the best-effort initial attempt but is not a durable retry system. Failed/stale records can be retried explicitly by the Merchant; automated scheduling, Queues/Cron, delivery dashboards, and quota recovery remain deferred.

## Deployment readiness verification

- `npm run verify:fresh-d1` creates isolated temporary local persistence, applies migrations `0001` through `0008` from an empty state, applies only the replaceable development seed in that isolated database, and verifies the Store/Menu, Order/notification constraints, retry timestamp, and LINE pairing tables. Temporary persistence is validated and removed afterward.
- Schema/data classification: migration `0001` includes the required single-store `吃炸的` configuration; migrations `0002`–`0008` are reusable schema/evolution; `seeds/development.sql` is destructive, replaceable local Menu fixture data and must never run in production. Migration `0008` remains unapplied remotely pending an explicit migration gate.
- `npm run verify:deploy-dry-run` executes installed Wrangler with `deploy --dry-run --outdir` into a validated temporary directory, checks the emitted Worker bundle and source deployment configuration, checks built PWA assets, and removes dry-run output. No upload or remote resource operation occurs.
- Production design uses a public Customer hostname and a separate Merchant hostname covered by a self-hosted Cloudflare Access application. The existing application guard additionally requires the exact Merchant hostname and cryptographically validates the Access assertion issuer, audience, and signature.
- The Access-looking request header alone is never trusted. `workers.dev`, previews, old routes, alternate Custom Domains, and `/merchant` on the Customer hostname must be disabled, Access-protected, or explicitly blocked/redirected and tested before launch.
- Production D1 `chi-zha-de-db`, its remote schema/data, the Rate Limiting binding, workers.dev staging hostname, path-scoped Access application, and Merchant guard variables are configured and verified. LINE and Custom Domains remain intentionally absent.
- LINE staging verification requires a later explicit authorization for exactly one controlled external send, followed by a simulated failure/retry and duplicate check. No real LINE call was made in CP7.
- PWA production verification must occur over HTTPS and cover manifest/icons, installation, Merchant start-up, live API behavior, and proof that offline Order submission remains impossible.
- Application rollback uses a recorded prior Worker version and `wrangler rollback` only after D1-schema compatibility review. Worker rollback does not revert D1. D1 recovery is separately approved and bookmark-aware; forward corrective migrations are preferred.

## CP8 staging release evidence

- Deployed candidate Git SHA: `20bc8f2d21f0fb2c9956571da5e1e3a7fcd54919`.
- Worker version: `89762920-85ab-42f4-8ef9-e693a1d80180`.
- Deployment: `4e04d117-0ef0-4c8d-901a-467eddb4779f`, active at 100% on the workers.dev staging surface.
- Staging URL: `https://chi-zha-de-ordering.yeoeb55688.workers.dev`.
- Gate 12F verified the public Customer shell, health, paused Store, approved 3-category/43-item Menu, manifest, Service Worker, and 192/512 icons over HTTPS. Unauthenticated Merchant UI/API requests were intercepted by Cloudflare Access.
- Gate 13 manually authenticated through Cloudflare Access with the approved Merchant identity. The Merchant UI loaded and `GET /api/merchant/orders` returned `200`; the UI also loads `GET /api/merchant/notifications` through the same protected Worker middleware boundary.
- A successful Merchant API response requires both the path-scoped Access policy and the Worker guard: exact hostname match plus cryptographic validation of the signed `Cf-Access-Jwt-Assertion` against `https://yeoeb.cloudflareaccess.com` and audience `0b41555c46401f25d421053db77ca92f2ee8e57e91a32f647b2aa6fdd08928b4`.
- `MERCHANT_DEV_BYPASS` and `PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS` are absent from deployed configuration. Notifications remain explicitly disabled; no LINE credential/action is configured.
- Gate 13 made no Merchant mutation and created no Order. A read-only D1 check after the smoke confirmed `is_accepting_orders = 0`, zero Orders, and zero notification deliveries.

## Gate 14 LINE verification preparation

- LINE delivery is implemented in `src/worker/notifications.ts` behind `NotificationProvider.notifyNewOrder`. Order creation stores the unique `line`/`new_order` intent in the Order's atomic D1 batch, then invokes delivery through `waitUntil` only after durable creation. Provider failure records `failed` and never rolls back or changes the Order.
- Gate 14 identified that the original LINE provider required both an access token and environment-supplied recipient. Gate 15A supersedes that target design with a D1-paired recipient while preserving fail-closed disabled/Fake behavior.
- The provider posts one bounded text message to `https://api.line.me/v2/bot/message/push` with Bearer authorization, JSON content, a five-second timeout, and sanitized failure codes. Neither credential is returned or logged.
- Gate 14 classified LINE configuration as sensitive and established the version-only secret workflow. Gate 15A now requires only `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` as Worker Secrets; the recipient identifier is captured into D1 and never copied through configuration.
- Gate 14 identified the absence of a webhook, signature validation, and recipient capture. Gate 15A closes those gaps locally through the public signed webhook plus Access-authenticated one-time-code pairing; none of that code or schema is deployed yet.
- The planned one-send diagnostic text is: `吃炸的系統測試通知\n店家通知功能連線成功。\n此訊息為上線前測試，無須處理。` The current transport emits LINE text messages, but the public/application interface is intentionally new-Order-specific. A later source-change gate must expose a non-public provider-level diagnostic seam or use an equivalent controlled local invocation; no temporary public endpoint or fake Order should be created.
- Notification status uses `pending`, `sent`, and `failed`. Claims increment `attempt_count` and set `last_attempt_at`; successful delivery sets `sent_at`, while sanitized failure remains retryable. Sent deliveries cannot be resent, and D1 uniqueness on `(order_id, channel, event_type)` prevents a second logical intent.
- Retry is idempotently guarded at the D1 intent/claim boundary, but external exactly-once delivery is not guaranteed: the current LINE push request has no provider retry key, so an accepted request followed by a lost response could be retried and delivered twice. This must be considered during the controlled LINE verification and later reliability review.
- The Merchant banner saying the page is local-only and unauthenticated is stale now that staging uses Cloudflare Access plus the Worker JWT guard. It is recorded for a later small UI source-change gate and was not changed during Gate 14 preparation.

## Gate 15A secure LINE pairing foundation

- `LINE_CHANNEL_SECRET` is a new Worker Secret used only to verify LINE webhook HMAC-SHA256 signatures. The exact raw UTF-8 request bytes are verified with Web Crypto before JSON parsing; raw bodies, signatures, pairing codes, and LINE user IDs are never logged.
- Authenticated Merchant challenge creation uses eight unbiased characters from a 32-character alphabet (`XXXX-XXXX`, 40 bits), a ten-minute TTL, and one singleton row. Only SHA-256 of the normalized code is stored; issuing a new challenge invalidates the previous one.
- A valid webhook can bind only `source.type = user`, a `U` plus 32-hex-character user ID, a text message exactly matching `綁定 <code>`, and an unexpired/unconsumed hash match. Binding and challenge consumption use one conditional D1 batch. Redelivery and consumed-code replay are harmless.
- Rebinding is allowed only after an authenticated Merchant issues a fresh challenge. Normal webhook traffic and a valid LINE signature alone cannot overwrite the singleton recipient.
- LINE delivery resolves the recipient exclusively from D1. Missing binding produces bounded `LINE_RECIPIENT_NOT_PAIRED`; `LINE_MERCHANT_RECIPIENT_ID` is no longer a binding or fallback.
- The Merchant security notice now says `店家管理頁已啟用身分驗證。` without exposing Access implementation details.
- Local verification passes 14 Vitest files and 117 tests, `npm run check`, the production build/PWA checks, and an isolated empty-D1 application of all eight migrations. No remote migration, deployment, secret, LINE message, Order, Access change, or store resume occurred.

## Production security foundation

- Customer status lookup is possession-based through an immutable random 256-bit token. Internal Order IDs remain Merchant-side identifiers and are neither returned by public Order creation/status responses nor accepted by a public read route. This is not a Customer account system; anyone who obtains a token can read that Order's customer-safe status.
- Production Merchant traffic must use a dedicated hostname protected by Cloudflare Access. The Worker additionally checks that exact hostname and validates the Access application JWT signature, issuer, and audience. Missing hostname/config/token, an invalid token, or an alternate `workers.dev`/preview/customer hostname fails closed with `403 MERCHANT_ACCESS_DENIED`.
- Local Merchant access is enabled only when `MERCHANT_DEV_BYPASS=true` is intentionally set in an uncommitted `.dev.vars`; `.dev.vars.example` documents the setup. This binding must never be configured in production.
- Because this Worker also serves public customer routes, Worker-wide Access must not block the whole app. Production routing must protect the Merchant hostname/path and must separately disable or protect alternate `workers.dev`, preview, custom-domain, and customer-host Merchant paths. The application guard protects Merchant APIs; Access must also protect the Merchant UI surface.
- `POST /api/orders` uses the `ORDER_RATE_LIMITER` binding at 20 requests per 60 seconds per Cloudflare location and client-address key. Local/test may explicitly bypass it. This is permissive, eventually consistent abuse control—not globally exact accounting, authorization, idempotency, or a correctness mechanism. Shared client addresses can share a limit.
- Both public POST endpoints reject non-JSON/malformed bodies and bodies over 32 KiB. Domain bounds remain 50 cart lines, quantity 1–99, 50 modifier options per line, customer name 1–50 characters, customer phone 1–30 characters, and idempotency key up to 128 characters.
- Application code has no request/PII logging. Full phone numbers, Access JWTs/authorization headers, public lookup tokens, and credentials must not be logged or sent to analytics. Merchant and customer dynamic Order responses use `Cache-Control: no-store`.
- The workers.dev staging Access application protects only `/merchant*` and `/api/merchant/*`; Customer routes remain public. The Worker guard is configured for the exact hostname, issuer, and audience. Preview URLs are disabled and no Custom Domain exists yet.

## Test approach

- Vitest runs through the official `@cloudflare/vitest-plugin` Workers integration.
- Worker API tests apply the real migrations to an isolated local D1 database and insert deterministic test-only fixtures.
- API coverage verifies active filtering, unavailable-item visibility, backend relationships and ordering, CP0 endpoint regressions, and Worker 404 behavior.
- Pure tests cover required single-choice validation, configuration-aware cart identity and merging, quantity transitions/removal, and integer price calculations.
- Checkout tests use isolated D1 fixtures to cover authoritative pricing, request trust boundaries, item/modifier validity, required/single-choice rules, duplicate options, and quantity bounds.
- Preparation-time tests pass a fixed clock and cover zero/non-zero queues, invalid queue relationships, minimum lead time, and exact absolute timestamps.
- Order tests cover immutable snapshots, price and availability changes after Quote, modifier invalidation after Quote, pending status, DB-backed idempotency/retry/conflict, active queue rules, totals, and forced transactional rollback.
- Merchant tests cover every legal and required illegal transition, repeated/competing actions, transition timestamps, unchanged ETA, missing Orders, snapshot reads, active filtering, and deterministic oldest-first ordering.
- Customer status tests cover all four statuses, snapshot isolation from Menu changes, persisted ETA, no-store cache headers, 404 behavior, Merchant transition visibility, and active/terminal polling decisions.
- Availability integration tests cover idempotent sold-out/restore/pause/resume, Menu visibility, Quote/Order enforcement, stale Quote submissions, control independence, historical snapshots, and existing-Order transitions while paused.
- CP5 verification passed 12 Vitest files and 86 tests, plus lint, TypeScript/build checks, local D1 migration/backfill checks, and curl smoke for token lookup, idempotent Order creation, Merchant transitions, availability controls, cache policy, and invalid/oversized requests.
- CP6 adds focused notification tests for intent persistence, fake success/failure, Order survival, idempotent duplicate protection, LINE request shape, and credential-safe failures. The build performs a lightweight manifest/icon/Service Worker boundary verification.
- CP6 verification passed 13 Vitest files and 92 tests. `npm run check` and the explicit production build passed, including PWA artifact verification; local curl smoke covered Order create/retry/status, Merchant accept/complete/reject, availability controls, and fake notification delivery records.
- CP7 adds retry/observability tests for success and repeated failure, monotonic attempts/timestamps, sent/missing conflicts, DB-backed uniqueness, safe Merchant fields, the protected retry boundary, and the explicit local/test bypass. Fresh migration and Wrangler dry-run verification are executable repository scripts.
- CP7 verification plus the Fake-provider production guard passes 13 Vitest files and 101 tests. Gate 11 reconfirms the full suite, lint/build/PWA checks, the remote paused Store and empty Order queue, and a Wrangler 4.127.0 dry-run with D1, Rate Limiting, Access variables, disabled notifications, and ten static assets without upload.
- Browser end-to-end tooling remains intentionally deferred; verification uses focused integration/unit tests and local HTTP smoke checks.

## Next feature

CP8 Gate 15B — review migration `0008` and the two-secret deployment boundary, then prepare (without executing) the remote migration, version-only secret upload, and staging pairing verification sequence. Any remote D1 migration, secret version, deployment, webhook configuration, or LINE action requires its own explicit approval.
