# Project state

## Current phase

CP3 Verification complete — the customer ordering, Merchant processing, and customer status polling vertical slice is verified locally.

- CP0 — Initial Local Baseline: complete.
- CP1 — Menu + Modifier + Client Cart: complete and verified.
- CP2 — Checkout Quote + Order Creation: complete and verified.
- CP2A — Checkout Quote + ETA Policy: complete.
- CP2B — Order Creation + Snapshot + Idempotency: complete.
- CP2 Verification: complete.
- CP3A — Merchant Order Handling: complete.
- CP3B — Customer Order Status Polling: complete.
- CP3 Verification: complete.

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
- Pure preparation-time policy with a UTC ISO-8601 absolute ready timestamp.
- Reusable schema migrations are separate from replaceable local development fixtures.

## Current schema

- `store_settings`: the single row for store identity, accepting-orders state, and preparation timing settings.
- `menu_categories`: category name, deterministic sort order, and active state.
- `menu_items`: category foreign key, name, description, integer TWD price, deterministic sort order, and availability.
- `modifier_groups`: menu item foreign key, name, `single` selection type, required state, deterministic sort order, and active state.
- `modifier_options`: modifier group foreign key, name, integer TWD price delta, deterministic sort order, and active state.
- `orders`: text ID, unique order number, constrained V1 status, authoritative integer total, absolute ETA/created/status timestamps, customer details, special-order flag, unique idempotency key, and request fingerprint.
- `order_items`: Order/menu references plus immutable item name, unit price, quantity, line total, and deterministic snapshot order.
- `order_item_modifiers`: Order-item/modifier references plus immutable group name, option name, price delta, and deterministic snapshot order.

SQLite boolean fields use constrained `0`/`1` values. No inventory, stock quantity, image, combo, promotion, coupon, payment, delivery, account, or generic workflow schema exists.

## Current API

- `GET /api/health`: health response.
- `GET /api/store`: single-store settings.
- `GET /api/menu`: active categories and items with nested active modifier groups/options. The backend controls all relationships and ordering. Unavailable menu items remain present with `isAvailable: false`.
- `POST /api/checkout/quote`: accepts only menu item IDs, quantities, and modifier option IDs. It validates current D1 data and returns normalized items, authoritative integer prices, total, lead minutes, and an absolute `estimatedReadyAt` timestamp. It does not create an Order.
- `POST /api/orders`: accepts customer details, special-order state, and identity-only item selections with an `Idempotency-Key` header. It reuses authoritative validation/pricing, calculates queue-aware ETA, atomically stores snapshots, and returns the stored Order representation.
- `GET /api/orders/:id`: returns a customer-safe historical Order projection from persisted snapshots with current status and committed ETA. Every response uses `Cache-Control: no-store`.
- `GET /api/merchant/orders`: returns only actionable `pending` and `accepted` Orders, oldest first, using stored item/modifier snapshots.
- `POST /api/merchant/orders/:id/accept`: transitions `pending` to `accepted`.
- `POST /api/merchant/orders/:id/reject`: transitions `pending` to `rejected`.
- `POST /api/merchant/orders/:id/complete`: transitions `accepted` to `completed`.

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

- After Order creation, the customer is moved to `/orders/:id`; the opaque UUID route can also reopen the Order after a page reload.
- The customer response contains Order ID/number, current status, customer name, creation time, persisted ETA, authoritative total, and snapshot items/modifiers. It excludes phone, idempotency data, special-order state, and internal transition timestamps.
- Customer wording is explicit: `pending` = 訂單已送出 / 等待店家確認, `accepted` = 店家已接受, `completed` = 訂單已完成, and `rejected` = 店家目前無法接單.
- Pending and accepted views poll every 4 seconds. Completed and rejected views stop polling. The single chained timeout and active request are cleared/aborted when the component unmounts or the customer leaves the view.
- A temporary request failure preserves the last successful Order and retries on the normal interval. A 404 displays a clear not-found message and stops polling.
- `Cache-Control: no-store` is explicit on successful and not-found customer Order responses.
- The UI displays the persisted absolute `estimated_ready_at` value in customer-local time; it never recalculates ETA from the browser or current queue.
- Customer Order presentation uses immutable Order snapshots and remains independent of current Menu names and prices.

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
- Static asset fallback remains SPA-based while `/api/*` always reaches the Worker first.

## Known V1 concurrency limitation

- Queue counting and authoritative menu reads occur before the atomic snapshot write. Concurrent first-time submissions can observe the same queue counts, and a concurrent menu update could occur between validation and insertion.
- The database uniqueness constraint still prevents duplicate idempotency keys, and the write batch prevents partial Orders. Distributed locking or a generic workflow system is intentionally deferred.
- Conditional transition updates prevent competing actions on one Order from both succeeding. They do not change the existing Order-creation queue snapshot limitation.

## Security limitation

- Merchant API endpoints and `/merchant` currently have no authentication or authorization. They are local-development-only and must not be exposed in production until merchant access control is implemented.
- Customer Order lookup is also unauthenticated. UUID Order IDs are acceptable as opaque Local V1 lookup values, but production requires an explicit customer access-control or secure lookup-token boundary before public exposure.

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
- CP3 Verification passes 10 Vitest files and 69 tests, plus lint, TypeScript/build checks, and a local curl flow covering Quote, idempotent Order creation, Merchant accept/complete/reject, customer status reads, no-store caching, and CP0–CP3 regressions.
- Browser end-to-end tooling remains intentionally deferred; verification uses focused integration/unit tests and local HTTP smoke checks.

## Next feature

CP4 — Merchant Availability Controls: add explicit controls for item sold-out state and pausing Order acceptance, with backend enforcement and focused customer/Menu regressions. Keep authentication, notifications, payment, and deployment out of scope unless a later task explicitly adds them.
