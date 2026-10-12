# Product blueprint: operational automation and focused UX fixes

This document covers only the current operational increment. The backend and D1 remain authoritative; React presents state and requests guarded mutations.

## ETA and busy mode

**Business rule.** A new online Order uses the later of the existing queue/capacity ETA and the current operational minimum: 15 minutes in normal mode, 30 minutes in busy mode. The final timestamp is rounded up to the existing five-minute clock boundary. Quote is a preview; Order creation recalculates atomically.

**User flow.** Merchant explicitly changes normal/busy. Entering busy extends only pending online Orders whose deadlines are earlier than the new rounded minimum. Leaving busy affects only future Orders and never accelerates existing deadlines.

**State transition.** `normal -> busy` and `busy -> normal` require an operation ID plus expected store version. `pending online` may receive a later ETA; accepted, onsite and terminal Orders do not change.

**Authority/failure/concurrency.** D1 store state is authoritative. A stale operation returns conflict and is refreshed. The ETA update includes `status='pending' AND order_source='online'`, so an accept racing the switch cannot be moved after acceptance. Existing later commitments never move earlier.

**Trade-off.** One store-wide mode is intentionally simpler than per-item capacity or a booking system. Walk-in/phone load is still not observed automatically; the Merchant uses busy mode to represent it.

**Acceptance.** Quote and created Order share the minimum; busy extends eligible pending online deadlines once; normal does not pull them forward; Customer lookup and Merchant polling expose the saved value.

## Auto reject and missed-order pause

**Business rule.** A pending Order becomes eligible at `max(created_at + 5m, estimated_ready_at - 15m)`. Only a successful `auto_rejected_unanswered` transition increments the consecutive missed counter. Accept resets the counter; manual reject, customer cancel and shortage cancellation do not. The third consecutive miss pauses new Orders and records the automatic reason.

**User flow.** Customer sees a human-readable rejection status. Merchant polling removes the Order from pending and shows why the Store paused. Manual resume remains an explicit Store operation.

**Authority/failure/concurrency.** A scheduled Worker handler calls the same server mutation boundary. A conditional `pending -> rejected` update, unique auto-rejection event and guarded counter update are one D1 batch. Accept and auto-reject race on the same status CAS; only one wins. Repeated scheduled delivery is idempotent.

**Trade-off.** Scheduled checking is sufficient for one shop. No browser timer is authoritative. Daily 17:00 reset is not implemented because no confirmed business-day calendar or daily/permanent sold-out distinction exists.

**Acceptance.** Earliest 15-minute Order is not rejected before five minutes; longer ETA uses ETA-minus-15; repeated processing counts once; accept resets; third consecutive miss pauses.

## Push notification lifecycle

**Business rule.** A new Order notification contains only “新訂單”, Taipei ETA and total item quantity. Its tag is `order:<stable-order-id>` and click opens `/merchant`. Accepted/rejected/auto-rejected Orders ask the service worker to close the matching visible notification.

**Authority/failure/concurrency.** The Order transaction stores the notification intent; sending remains after-commit. Provider failure never rolls back an Order. Dismiss/close is presentation only; five-second polling and D1 remain authoritative.

**Acceptance.** Duplicate pushes replace the same tag; click opens Merchant; terminal handling closes by tag when supported; no subscription and provider errors preserve the Order.

## Customer menu UX

**Business rules.** Category targets remain visible below sticky UI. Selected portion price is derived locally from downloaded authoritative base price plus selected modifier deltas, while Quote/Order always reprice in D1. Fries and sweet-potato no-seasoning options become inactive for new Orders, with historical snapshots untouched. Light browser chrome uses white and dark preference uses black; the Customer page itself remains light.

**Failure cases.** An inactive/unowned modifier is rejected by backend validation. An image/theme/category failure does not alter transaction authority. The specified Uber Eats page was not reliably readable, so category data is not changed.

**Acceptance.** 375/390/430 layouts keep category headings visible; small/large price updates instantly; option IDs 17/20 cannot enter new Quote/Order; micro-spice and pepper-packet clicks select actual modifier IDs.

## Merchant workflow

**Business rules.** Active items are grouped by true spice choice; pepper packet stays in item-level modifiers. History opens as an on-demand panel and is not part of the five-second poll. Accept stays on Pending; Complete stays on In Progress. Empty In Progress provides an explicit Pending link instead of auto-navigation. Customer cancel and Merchant reject share an accessible destructive-dialog presentation, never a mutation function.

**Acceptance.** History fetches only when opened and closes to the workbench; polling preserves the current tab; no pepper-packet spice group; long item identity and shortage controls remain intact.

## Core runtime boundaries

### 1. Order creation

Frontend cart -> Quote -> validation/current D1 pricing -> idempotency and quote fingerprint -> atomic Order/snapshots/push intent -> Customer lookup + Merchant polling/Push. Price/config/store changes reject without partial rows. Concurrent duplicate requests resolve through the unique key and fingerprint.

### 2. Merchant accept / complete / reject

Merchant UI -> authenticated same-origin API -> legal transition check -> status CAS (accept also resets missed count) -> D1 -> authoritative refresh and notification close hint. Another device may win; a conflict never overwrites it.

### 3. Customer cancel

Custom dialog -> opaque-token same-origin API -> eligibility/cutoff validation -> pending-state CAS -> D1 -> lookup/polling refresh. Accepted/stale Orders remain unchanged.

### 4. Shortage + auto sold-out

Merchant item snapshot selection -> authenticated validation/request fingerprint -> Order revision CAS -> one D1 batch adjusts payable snapshot quantity and the same stable menu item's availability -> Customer/Merchant polling. Atomicity prevents adjusted Orders with still-saleable inventory or the reverse.

### 5. Store pause / busy / daily reset / auto pause

Merchant operation or scheduled auto-reject -> authenticated/scheduled backend boundary -> state/version/idempotency guard -> D1 store state and audit -> public Store polling. Busy adjusts only pending online ETA. Auto pause follows exactly three consecutive committed auto rejects. Daily reset remains blocked until business days and daily sold-out semantics are confirmed; no request may repeatedly auto-open a manually paused store.
