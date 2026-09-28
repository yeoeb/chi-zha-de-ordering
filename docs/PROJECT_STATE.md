# Project state and operational truth

## Evidence boundary

This is the repository's current feature truth table. Update this file when a business rule or implementation changes; do not create a parallel source of truth.

- Product: single-store fried-food ordering system 吃炸的.
- Audited branch: `fix/v0.1.1-mobile-ux`.
- Original audited HEAD: `ad63f99ab0467e743027e70f8a2e37ff39cb45b8`.
- This audit adds local, uncommitted reliability fixes on top of that HEAD. Use `git status` and the final handoff report for the exact diff.
- Last user-confirmed Production source: `e7ab12d7cd1abba80ca5833a545a6d3808da8a30` / Worker version `52b1aecd-69a6-4e75-8d44-f12483a9e894`. Production was not queried or changed during this audit.
- Local schema ends at additive migration `0016_add_shortage_request_fingerprint.sql`. Historical migrations are immutable.

Local tests prove deterministic code and database behavior only. Real iPhone layout, two physical Merchant devices, Cloudflare Access configuration, Push delivery, production load, and recovery drills require separate human evidence.

## Feature truth table

| Business purpose / failure case | Implementation and evidence | State | Priority | Remaining acceptance or action |
| --- | --- | --- | --- | --- |
| Same Order request is retried after timeout | `orders.idempotency_key` is unique; `src/worker/order-creation.ts` fingerprints normalized content and replays only an identical request. `test/order-creation.test.ts`, `test/order-concurrency.test.ts`. | Implemented with evidence | P0 | Production load/latency remains a manual observation. |
| Same key is reused for different content | Server returns `IDEMPOTENCY_KEY_CONFLICT`; concurrent conflict is tested with an actual interleaved D1 write. | Implemented with evidence | P0 | None in code. |
| Customer confirms a Quote, then current item/modifier pricing changes | Quote returns a SHA-256 fingerprint over line identity, names, base prices, modifier ownership/names/deltas, quantities, line totals and total. Order Creation re-prices from D1, compares this component-level fingerprint, and returns `QUOTE_CHANGED` without writing parent, snapshots or Push intent. The atomic catalog guard closes the validation/write window. A refreshed quote can be retried without an old rejected key blocking it. | Implemented with evidence | P0 | Real slow-network price-change UX needs phone acceptance. |
| Response is lost and Customer reloads | `src/react-app/order-attempt.ts` keeps only request hash, key and timestamp in 24-hour `localStorage`; the contact/note draft is separate 24-hour `sessionStorage`, so reload recovery does not require retyping and long-lived storage has no PII. `App.tsx` reuses the same key until success or a confirmed rejection. DOM recovery test covers a 200 replay after remount. | Implemented with evidence | P0 | Verify iOS Safari/PWA session-storage behavior on a real device. |
| Double click submits twice | `App.tsx` uses a synchronous in-flight guard before the async state update; the server idempotency boundary remains authoritative. | Implemented with evidence | P0 | Real slow-network tap test. |
| Store pauses while an Order is being created | The parent Order insert checks accepting state and exact `state_version` in the same D1 batch; a miss writes no children and retries from fresh state. Interleaving test proves no Order is created. | Implemented with evidence | P0 | None in code. |
| Merchant sells out, Admin changes price, or modifier config changes during Order creation | `buildCatalogCommitGuard` checks item availability/archive/category, authoritative base price, selected modifier ownership/name/price/active state, and required groups inside the atomic parent insert. Interleaving tests cover sold-out, item-price and modifier-price changes; ownership tests remain. | Implemented with evidence | P0 | Add broader modifier-structure interleavings if modifier editing is introduced; current Admin modifier view is read-only. |
| Quote and concurrent Orders receive queue-aware ETAs | Quote includes the current pending/accepted online and onsite queue as a preview. Final online Order ETA is calculated again by SQL inside the same D1 transaction; concurrent distinct-order tests receive successive deadlines. UI states that an online preview is not guaranteed and excludes unrecorded phone orders. | Implemented with evidence | P1 | Phone orders remain unrepresented; store decision required. |
| Fixed-QR onsite ordering and safe capacity gaps | `/onsite` shares the authoritative menu, quote, Order state machine and lookup-token recovery. `/api/onsite/orders` assigns source server-side, accepts no contact/source fields, and uses an exact active-schedule fingerprint before reserving a five-minute capacity slot. Online deadlines and accepted/completed Orders are immutable; only pending onsite deadlines may advance after completion/rejection frees capacity. | Implemented with local evidence | P1 | The model uses store-level per-order preparation settings, not item-level cook times or proof that the scanner is physically onsite. Validate workflow and printed QR on shop phones. |
| Parent Order succeeds but snapshots or notification intent fail | Order, item snapshots, modifier snapshots and `web_push_notification_deliveries` intent are one D1 `batch`; batch failure rolls the transaction back. `test/order-atomicity.test.ts`. | Implemented with evidence | P0 | None in code. |
| Customer submits an oversized/chunked body or floods public writes | `src/worker/request-body.ts` stops streaming at 32 KiB; Order and Quote use bounded JSON and the same configured public write rate limiter with separate keys. Security tests cover 413 and 429. | Implemented with evidence | P1 | Rate-limit values and false positives must be monitored in real traffic. Large-order business policy is still undecided. |
| Invalid contact input or lookup-token probing | Server trims contact data, rejects control characters and invalid phone format, and rejects malformed non-64-hex lookup tokens with the same 404 contract. Security/customer-order tests cover this. | Implemented with evidence | P1 | Phone is format-validated only; there is no ownership/OTP verification. |
| Two Merchant devices accept/reject/complete the same Order | `src/worker/merchant-orders.ts` uses status-conditional updates. Concurrent tests prove only one conflicting transition wins and a second completion cannot succeed. UI refreshes authoritative state after mutations. | Implemented with evidence | P0 | Exercise on two real authenticated phones. |
| Two Merchant devices toggle the same sold-out item | Narrow availability endpoint changes only `is_available`; same-target concurrent calls are idempotent and tested. Customer Quote/Order validation remains authoritative. Opposite stale actions are currently last-write-wins because menu items have no availability revision. | Partially implemented / requires shop decision | P1 | Decide whether the latest deliberate action should win or stale opposite actions must be rejected; the latter needs an additive item availability revision/CAS contract. Also verify the pinned presentation on the shop phone. |
| Stale Store pause/resume overwrites newer state | Explicit pause/resume, operation ID, state-version CAS, immutable audit events and stale-response guards live in `store-operations.ts`, `MerchantView.tsx` and Store Safety tests. | Implemented with evidence | P0 | Production Access/secret/config must always be checked per release; not re-read here. |
| Customer/Merchant/Admin privilege separation | `security.ts` validates separate Cloudflare Access audiences; Merchant mutations also require same-origin. Admin routes use a separate middleware and allowlisted mutation fields. Local bypass bindings must remain absent from Production. | Implemented with evidence | P0 | Cloudflare policy and bindings require manual release-gate verification. |
| Push is missed or provider fails | The notification intent is committed with the Order; Push is an after-commit `waitUntil` side effect. Merchant five-second polling is authoritative. Failed/pending deliveries are visible and can be retried with guarded writes. | Partially implemented | P1 | There is no scheduled durable auto-retry or external alert. Decide whether manual retry plus polling is sufficient. |
| Merchant loses network, locks phone, or reopens | Polling reloads active Orders; UI exposes disconnected/last-sync state and never treats Push as truth. Polling and DOM tests cover stale/failure behavior. | Implemented with evidence | P1 | Real lock-screen/background/PWA tests are required. |
| Quick spice, fries seasoning, per-line spice/cut and cart identity | Customer options use real `modifierOptionIds`; stable menu configuration controls defaults. Bulk spice reports uniform/mixed/partial support, changes only each line's spice group, preserves other modifiers, and merges only when the full quantity remains within the backend line limit of 99. Existing modifier/cart/DOM and fries-to-Merchant integration tests cover defaults and payloads. | Implemented with evidence | P0 | Four chicken-cutlet variants still require the shop to confirm which should have the cut group and the operational default. |
| Cart draft, Undo, category highlight, note and packaging UX | Local HEAD contains Cart draft recovery, Undo, category tracking and checkout-only note. Customer submissions intentionally fix packaging to `together`; the historical schema column remains for compatibility. Existing DOM/Worker tests cover these paths. | Implemented, device unverified | P1 | Verify at 375/390/430 px and iPhone safe areas with long text and keyboard open. |
| Customer chooses how a later shortage is handled | Checkout saves immutable `shortage_policy` as `continue_available` (default) or `cancel_entire_order`; it participates in the Order request fingerprint. Old Orders receive the continue default. | Implemented with local evidence | P0 | Phone acceptance of the Checkout wording remains manual. |
| Merchant reports a partial shortage | The authenticated same-origin Merchant endpoint accepts stable Order-item snapshot IDs and positive unavailable quantities. A revision CAS, request fingerprint and idempotency record prevent stale or duplicate deductions. Money is deducted from stored snapshot prices, never current menu prices; original snapshots remain intact. The same D1 atomic batch also marks each targeted snapshot's authoritative Menu Item sold out; there is no second frontend availability mutation. | Implemented with local evidence | P0 | Test each per-item control on the shop phone and define the manual cash-difference SOP; this system does not claim a refund occurred. |
| Customer sees a shortage adjustment | Customer polling returns current payable total, original total, unavailable quantities and cancellation reason. The prominent alert has a separate local acknowledgement revision; the permanent detail remains visible. The persistent My Orders entry shows an unread badge and remains available when only local history exists. | Implemented with local evidence | P1 | Real-device visibility and polling timing remain manual acceptance. |
| Customer cancels an Order | Public cancellation requires the opaque lookup token, same-origin POST and an exact confirmation body. Online pending Orders are cancellable through ETA minus ten minutes; onsite pending Orders have no ten-minute gate. Accepted/completed Orders remain server-blocked. Atomic status CAS wins races with Merchant actions. | Implemented with local evidence | P0 | Shop must decide whether a future Merchant-confirmed cancellation flow is needed after acceptance. |
| Customer ETA reminder | Online Order status derives the countdown from persisted `estimated_ready_at`, refreshes after visibility changes and never equates ETA arrival with completion. Onsite remains completion-driven. | Implemented, device unverified | P2 | Browser background timers are not guaranteed; no Push/SMS reminder was added. |
| Local Order history and reorder | Active and terminal lookup tokens use separate bounded indexes (10 active / 20 history), with no name, phone or line details in storage. Historical details load only when My Orders is opened. Reorder reconstructs a cart against current menu/modifier authority and never submits automatically. | Implemented with local evidence | P1 | Clearing browser data or changing device loses local history by design. |
| Confirmed portion sizes | Production-data config adds required `份量` groups to stable production item 4 `鹹酥雞` and item 3 `魷魚`: existing NT$60 small and NT$100 large through a +40 modifier delta. Cart identity, Quote, snapshot and Merchant display use the real modifier option IDs. | Implemented locally; production data unapplied | P1 | Requires a separately authorized production-data gate. Local development seed can prove 鹽酥雞 size behavior but has no safe local 魷魚 row because ID 3 is occupied by a different fixture item. |
| Quick sold-out pinned list | `is_quick_sold_out` is a stable presentation field; Merchant uses the same item record/source of truth. | Implemented, shop unverified | P2 | Shop must confirm the pinned items and phone ergonomics. |
| Four additional chicken-cutlet records and real prices | Production data contains only stable item 1 `香雞排` with the owned cut group and default `不切`. The requested 起士、香蔥、泡菜、泡菜起士 variants have no confirmed stable IDs/prices in repository data. | Requires shop decision | P1 | Confirm exact stable IDs, current prices, images, sort order and spice applicability. They remain absent rather than being opened with guessed prices. Backend modifier ownership already rejects attaching item 1's cut option to unrelated products. |
| Busy-mode ETA extension, large Orders, phone Orders, exception hours | No confirmed business rules or capacity model exist. | Requires shop decision | P1/P2 | Prefer one manual busy-time control or clear SOP only after the shop defines semantics. Do not invent automation. |
| Accepted then out-of-stock, Customer cancellation/refund, no-show/wrong pickup | Current state machine has whole-Order accept/reject/complete only; completed means preparation complete, not separately “picked up.” | Confirmed gap / requires shop decision | P1 | Define operational meaning and permissions before adding states. Until then use Merchant note/phone SOP, not hidden state. |
| Reporting, payment reconciliation and data retention | No payment model, daily revenue reconciliation, retention rule or export workflow exists. | Requires shop decision | P2 | Decide cash/payment and legal/operational retention needs first. |
| Concurrent Admin edits to the same product/category | Admin mutations are allowlisted and authoritative, but do not carry an edit revision; two valid saves are last-write-wins. | Confirmed gap / requires owner decision | P2 | For a single owner, refresh-before-edit may be sufficient. Add optimistic revision/CAS only if simultaneous Admin editing is real. |

## Confirmed business and technical rules

- D1 and the Worker are authoritative for current price, availability, required modifiers, quote and Order creation. React totals are display-only.
- Public Order reads use only the 256-bit opaque lookup token and never expose internal Order IDs or Customer phone numbers.
- Cart lines with different persisted modifier option sets are different lines. Spice, seasoning, cut and special options are independent modifier dimensions.
- `辣粉另包` uses the existing owned per-line spice modifier option. New Customer submissions use `packagingPreference = together`; the legacy value remains readable for historical Orders and never implies per-person packing.
- Historical Order item/modifier names and prices are snapshots. Menu edits, archives and category renames do not rewrite them.
- Merchant may accept/reject/complete whole Orders and toggle availability only. Admin configuration remains separate; modifier editing is read-only.
- Store pause/resume is separate from availability and Order transitions. Existing CAS/audit/recovery semantics must not be simplified.
- Web Push is advisory and after-commit. Five-second Merchant polling is the operational source of truth.
- Service Worker requests under `/api/*` bypass offline caching. Offline Order submission is never queued or reported as successful.
- No note means normal combined packaging. The system does not infer bag splitting from mixed spice choices.

## Operational lifecycle gaps

### Open preparation

- Implemented: Store acceptance state, individual availability, Merchant connectivity state, Push subscription status/polling fallback.
- Manual acceptance: confirm yesterday's sold-out reset process, phone network, notifications and audio/PWA behavior before opening.
- Decision needed: whether sold-out items reset automatically each day. Current system deliberately preserves state.

### Receiving and preparation

- Implemented: authoritative validation, atomic snapshots, modifiers and notes visible to Merchant, deadline ordering, concurrency-safe whole-Order transitions.
- Gap: no acknowledgement escalation if a pending Order is ignored for a long time; polling still retains it.
- Decision needed: policy for mistaken/duplicate Customer Orders, accepted-then-unavailable items, phone Orders, large Orders and busy-time ETA.

### Pickup and close

- Implemented: completed/rejected Orders retain immutable snapshots and Customer lookup status.
- Gap: “prepared” and “picked up” are one `completed` state; no dedicated no-show, wrong-pickup or missing-item workflow.
- Decision needed: end-of-day handling for unresolved Orders and sold-out flags, and how long staff need searchable history.

## Failure, recovery and observability

- Ambiguous Customer responses recover by reusing the same idempotency key for the same request; 5xx, timeout, network loss and malformed responses remain explicitly unknown. Confirmed 4xx rejection and 429 clear the attempt; 429 honors `Retry-After`. The Customer must not invent a new key for an unknown outcome.
- A Worker interruption after commit cannot remove the Order. The Push delivery intent remains `pending`; polling still exposes the Order. Manual retry exists, but unattended retry/alerting is a remaining gap.
- D1 batch rollback protects Order/snapshot consistency. D1 overload/timeouts return failure; Customer and Merchant UIs keep drafts/current authoritative state instead of claiming success.
- Current code has UI health indicators and Cloudflare runtime logs, but no separately configured alert for sustained 500s, polling failure or notification backlog. This is P2 until the shop chooses an alert channel and responsibility.
- Deployment rollback should use the previously verified Worker version. Migrations 0010-0016 are additive, so rollback normally does not down-migrate D1.
- D1 Time Travel restore is destructive and requires a fresh bookmark and explicit gate. Do not restore the whole database merely to undo a menu mistake because doing so could erase newer real Orders; use an audited targeted correction after capturing a backup.
- A Cloudflare/shop-network outage needs a written paper/phone-order fallback and reconciliation procedure. It cannot be truthfully validated in local tests.

## Superseded or explicitly out of scope

- LINE notification runtime is retired; migration 0008 tables remain historical until a separately authorized cleanup.
- There is no Merchant menu editor. Price/name/category/image/modifier/lifecycle changes belong to Admin.
- No UI-only selectable customization is allowed. Unsupported options remain hidden.
- Inventory quantities, payments, automatic refunds, maps, analytics, native apps, offline Order queues, bundles, multi-store and automatic bag assignment are not current features.

## Verification and release impact

- Required local commands: `npm test`, `npm run check`, `npm run build`, `npm run db:migrate:local`, `npm run verify:fresh-d1`, `npm run verify:upgrade-d1`, `npm run verify:production-data`, `npm audit`, and `git diff --check`.
- This local work adds additive migration 0014 for authoritative `online`/`onsite` order source, additive migration 0015 for shortage/cancellation metadata and ledgers, and additive migration 0016 for shortage-request payload fingerprints. `production-data/add-portion-options.sql` contains only guarded, repeatable portion data for stable production items 3 and 4; it has not been run remotely. The work changes Worker/Customer/Merchant source, printable onsite QR assets, tests, this existing truth document and development dependencies.
- Production remains unchanged until a separately authorized commit/review/deployment. Before release, verify the exact source SHA, Admin/Merchant Access bindings, D1 migration state and backward compatibility through the existing release gates.
- Manual acceptance still required: real iPhone 375/390/430 layouts, slow/failed network and reload, two Merchant phones racing the same Order/item, lock-screen Push plus polling recovery, and a non-destructive recovery tabletop drill.
