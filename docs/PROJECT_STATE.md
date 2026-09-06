# Project state

## Current phase

CP5 — Production Security Foundation complete and verified locally. Deployment is still not approved.

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

## Implemented features

- React SPA served by Vite with the Cloudflare Vite plugin.
- Hono Worker API with explicit Worker-first routing for `/api/*`.
- Local D1 binding named `DB`; no remote Cloudflare resource ID is configured.
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

SQLite boolean fields use constrained `0`/`1` values. No inventory, stock quantity, image, combo, promotion, coupon, payment, delivery, account, or generic workflow schema exists.

## Current API

- `GET /api/health`: health response.
- `GET /api/store`: single-store settings.
- `GET /api/menu`: active categories and items with nested active modifier groups/options. The backend controls all relationships and ordering. Unavailable menu items remain present with `isAvailable: false`.
- `POST /api/checkout/quote`: accepts only menu item IDs, quantities, and modifier option IDs. It validates current D1 data and returns normalized items, authoritative integer prices, total, lead minutes, and an absolute `estimatedReadyAt` timestamp. It does not create an Order.
- `POST /api/orders`: accepts customer details, special-order state, and identity-only item selections with an `Idempotency-Key` header. It reuses authoritative validation/pricing, calculates queue-aware ETA, atomically stores snapshots, and returns a customer-safe representation containing the public lookup token but not the internal Order ID.
- `GET /api/orders/by-token/:token`: returns a customer-safe historical Order projection from persisted snapshots with current status and committed ETA. The old internal-ID route is not a public lookup contract. Every response uses `Cache-Control: no-store`.
- `GET /api/merchant/orders`: returns only actionable `pending` and `accepted` Orders, oldest first, using stored item/modifier snapshots.
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
- Static asset fallback remains SPA-based while `/api/*` always reaches the Worker first.
- Merchant authorization is one small middleware boundary. In production it requires the exact configured Merchant hostname and cryptographically validates `Cf-Access-Jwt-Assertion` against the configured Cloudflare Access issuer, rotating JWK set, and audience. It does not trust a header without signature validation.
- Public request-body parsing is bounded before JSON/domain validation. The Order rate limiter is isolated from idempotency and other correctness rules.

## Known V1 concurrency limitation

- Queue counting and authoritative menu reads occur before the atomic snapshot write. Concurrent first-time submissions can observe the same queue counts, and a concurrent menu update could occur between validation and insertion.
- The database uniqueness constraint still prevents duplicate idempotency keys, and the write batch prevents partial Orders. Distributed locking or a generic workflow system is intentionally deferred.
- Conditional transition updates prevent competing actions on one Order from both succeeding. They do not change the existing Order-creation queue snapshot limitation.
- Store/item availability is read before the atomic Order snapshot batch. A simultaneous Merchant availability mutation can race within this small read-to-write window in V1; no distributed lock or reservation system is claimed or implemented.

## Production security foundation

- Customer status lookup is possession-based through an immutable random 256-bit token. Internal Order IDs remain Merchant-side identifiers and are neither returned by public Order creation/status responses nor accepted by a public read route. This is not a Customer account system; anyone who obtains a token can read that Order's customer-safe status.
- Production Merchant traffic must use a dedicated hostname protected by Cloudflare Access. The Worker additionally checks that exact hostname and validates the Access application JWT signature, issuer, and audience. Missing hostname/config/token, an invalid token, or an alternate `workers.dev`/preview/customer hostname fails closed with `403 MERCHANT_ACCESS_DENIED`.
- Local Merchant access is enabled only when `MERCHANT_DEV_BYPASS=true` is intentionally set in an uncommitted `.dev.vars`; `.dev.vars.example` documents the setup. This binding must never be configured in production.
- Because this Worker also serves public customer routes, Worker-wide Access must not block the whole app. Production routing must protect the Merchant hostname/path and must separately disable or protect alternate `workers.dev`, preview, custom-domain, and customer-host Merchant paths. The application guard protects Merchant APIs; Access must also protect the Merchant UI surface.
- `POST /api/orders` uses the `ORDER_RATE_LIMITER` binding at 20 requests per 60 seconds per Cloudflare location and client-address key. Local/test may explicitly bypass it. This is permissive, eventually consistent abuse control—not globally exact accounting, authorization, idempotency, or a correctness mechanism. Shared client addresses can share a limit.
- Both public POST endpoints reject non-JSON/malformed bodies and bodies over 32 KiB. Domain bounds remain 50 cart lines, quantity 1–99, 50 modifier options per line, customer name 1–50 characters, customer phone 1–30 characters, and idempotency key up to 128 characters.
- Application code has no request/PII logging. Full phone numbers, Access JWTs/authorization headers, public lookup tokens, and credentials must not be logged or sent to analytics. Merchant and customer dynamic Order responses use `Cache-Control: no-store`.
- Production Cloudflare Access applications, hostnames, D1 resources, environment values, and exposure rules have not been configured because deployment is not approved.

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
- CP5 verification passes 12 Vitest files and 86 tests, plus lint, TypeScript/build checks, local D1 migration/backfill checks, and curl smoke for token lookup, idempotent Order creation, Merchant transitions, availability controls, cache policy, and invalid/oversized requests.
- Browser end-to-end tooling remains intentionally deferred; verification uses focused integration/unit tests and local HTTP smoke checks.

## Next feature

Subject to Supervisor review: CP6 — Notification + PWA Preparation. Start with a notification delivery/interface decision and installability/offline-boundary plan; do not deploy or add payment/inventory as part of that checkpoint.
