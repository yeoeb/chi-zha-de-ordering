# Requirement audit

Audited against branch `fix/v0.1.1-mobile-ux` at `0a587028f455c97f20cc19089fc07ddb48d42acd`. Code, migrations and automated tests are the evidence boundary; earlier summaries are not treated as proof.

Status meanings: `IMPLEMENTED`, `PARTIAL`, `MISSING`, `BUG`, `INTENTIONALLY_DEFERRED`, `BLOCKED_BY_BUSINESS_DATA`.

## Customer

| Requirement | Status | Implementation evidence | Test evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| Online ordering | IMPLEMENTED | `App.tsx`, `/api/checkout/quote`, `/api/orders`, atomic snapshots in `order-creation.ts` | quote/order/atomicity/concurrency suites | Real-phone production smoke remains operational acceptance. |
| Onsite `/onsite` ordering | IMPLEMENTED | Dedicated route/source, shared pricing/state machine | `onsite-ordering*.test*` | Printed QR and shop-device acceptance. |
| Onsite does not require name/phone | IMPLEMENTED | Server assigns onsite source and accepts no contact fields | onsite Worker/DOM tests | None in code. |
| Customer chooses online/onsite before submit | IMPLEMENTED | Checkout switches the authoritative endpoint/source contract; contact fields are required only for online and pending-attempt keys remain source-scoped | customer and onsite DOM tests | Real-phone wording acceptance. |
| My Orders; Active/History split | IMPLEMENTED | Bounded token indexes and separate views in `App.tsx` | `active-customer-orders.dom.test.tsx`, release DOM tests | Browser storage is device-local by design. |
| Reorder the same items | IMPLEMENTED | Rebuilds cart against current menu/modifier authority; never submits automatically | release DOM tests | Stale/removed selections require user correction. |
| Lookup-token recovery | IMPLEMENTED | Public reads use opaque token only; pending attempt recovery avoids PII in long-lived storage | customer-order/order-attempt tests | Session-storage behavior on iOS remains manual acceptance. |
| ETA display and countdown | IMPLEMENTED | Quote preview and stored Order ETA; Taipei rendering and visibility refresh | scheduling/status/DOM tests | ETA excludes unrecorded phone/walk-in work. |
| Pending cancellation | IMPLEMENTED | Token + same-origin API with CAS and ETA rule; shared accessible destructive dialog | customer-order and cancellation-dialog DOM tests | Real-phone dialog layout remains manual acceptance. |
| Online cancellation cutoff / onsite pending cancel | IMPLEMENTED | Online cutoff is ETA minus 10 minutes; onsite has no ten-minute gate | customer-order tests | None in state contract. |
| Shortage policy, total reminder, unread badge | IMPLEMENTED | No policy is preselected; Customer must explicitly choose. The immutable saved policy drives atomic adjustment and revision acknowledgement. | adjustment and customer/release DOM tests | Cash/refund SOP is outside system state. |
| White page, store lamp, cart icon | IMPLEMENTED | Customer styles/header/cart bar | customer DOM tests | Device visual acceptance only. |
| Note 120 chars + injection boundary; no textarea resize | IMPLEMENTED | Shared validation, persisted snapshot, CSS `resize: none` | order/security/DOM tests | Notes remain plain text; no paid-option bypass. |

## Menu and modifiers

| Requirement | Status | Implementation evidence | Test evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| 鹹酥雞/魷魚 small 60, large 100 | IMPLEMENTED | Versioned `add-portion-options.sql` with +40 delta; card derives display price from downloaded modifier delta while Quote/Order reprice | portion/cart/quote and click-level DOM tests | Historical snapshots remain unchanged by design. |
| Traditional chicken cut; other cutlets do not inherit | IMPLEMENTED | Stable item ownership for cut group; backend ownership validation | portion and ownership tests | Shop must confirm future cutlet variants. |
| 起士／香蔥／泡菜／泡菜起士雞排 | BLOCKED_BY_BUSINESS_DATA | No confirmed production IDs, prices, images or modifier applicability | Absence verified in seeds/production-data | Do not invent records. |
| Sold-out, archive, image URL | IMPLEMENTED | Authoritative fields and allowlisted Admin/merchant APIs | availability/admin/menu tests | Image binary upload intentionally absent. |
| Popular and quick sold-out metadata | IMPLEMENTED | `is_popular`, `is_quick_sold_out`; same menu row reused | Admin/customer/merchant tests | Shop controls actual flags. |
| Category navigation | IMPLEMENTED | Sticky navigation uses measured header/tab height plus 12px and `scroll-margin-top` | Customer DOM offset/active-category coverage | 375/390/430 visual acceptance remains. |
| Uber Eats category mapping | BLOCKED_BY_BUSINESS_DATA | Exact supplied page could not be read reliably; no alternate store/source was used | N/A | Need screenshot/text from that exact store page. Current IDs/categories remain unchanged. |
| Fries default 胡椒 / sweet potato default 梅粉 | IMPLEMENTED | Stable item/group/option mapping: 9/5/16 and 10/6/18 | fries flow and customer DOM tests | None for defaults. |
| Fries/sweet-potato `不加調味` removal | IMPLEMENTED | Options 17/20 remain stored but inactive in migration, seed and repeat-safe production data | menu/quote/production-data tests reject new use | Existing historical snapshots remain readable. |
| Spice | IMPLEMENTED | Real modifier IDs, unique input IDs, per-line/cart paths and backend ownership checks | click-level 微辣/辣粉另包, cart and quote tests | No frontend-only spice state. |
| Special requests / note | IMPLEMENTED | API-backed modifiers plus checkout note | modifier and order tests | No UI-only selectable option should be added. |
| 辣粉另包 operational visibility | IMPLEMENTED | Real owned spice Modifier remains on its Cart line and submit mirrors the request once into validated `customer_note` | customer DOM and order snapshot tests | None in the persistence contract. |

## Merchant

| Requirement | Status | Implementation evidence | Test evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| Pending / accepted / sold-out workspaces | IMPLEMENTED | `MerchantView.tsx`, narrow availability routes | Merchant DOM/Worker tests | Phone acceptance remains. |
| History | IMPLEMENTED | Full snapshots load through a separate on-demand endpoint and closeable panel | Merchant Worker/DOM fetch/open/close tests | History is not part of five-second polling. |
| Operational card privacy | IMPLEMENTED | Active and history cards prioritize deadline/source/items/modifiers/note; Customer name, phone and visible internal Order number are omitted | Merchant DOM tests | Internal IDs remain backend/API identifiers only. |
| Accept / complete / reject | IMPLEMENTED | Status-conditional D1 updates; custom reject dialog | merchant/concurrency/DOM tests | Customer cancellation dialog should share presentation component only. |
| Shortage + synchronized sold-out | IMPLEMENTED | One D1 batch, request fingerprint/idempotency/revision CAS | order-adjustment tests | None in backend contract. |
| Shortage native quantity selector | IMPLEMENTED | `<select>` only when remaining quantity > 1 | Merchant DOM tests | Manual mobile picker acceptance. |
| Pause/resume and grey state | IMPLEMENTED | Store state CAS, operation IDs and audit events | store-operation/safety DOM tests | None in existing contract. |
| Online/onsite badge and authoritative accepted total | IMPLEMENTED | Snapshot source/total displayed in cards | Merchant DOM tests | None. |
| True spice grouping | IMPLEMENTED | One bordered container per spice choice; pepper packet remains item-level requirement | Merchant grouping/packet DOM tests | Color is supplemented by textual headings. |
| Web Push + polling + new-order notification | IMPLEMENTED | Durable intent, VAPID retry, stable order tag, minimal ETA/quantity payload, SW click/close handling; polling authoritative | notification, polling and PWA verifier | OS/browser controls final delivery, sound and vibration behavior. |
| Store CAS/audit | IMPLEMENTED | `store_state_events`, state version and operation replay | store tests | Busy mode needs its own guarded operational transition. |
| Busy mode | IMPLEMENTED | D1 state, idempotent/versioned Merchant mutation, pending-online extension and UI | operational D1 and Merchant DOM tests | Accepted/onsite/terminal Orders are intentionally untouched. |
| History/navigation stability | IMPLEMENTED | Accept/complete preserve current workflow; empty accepted view offers explicit navigation; history does not poll | Merchant DOM tests | No automatic tab switch on polling. |

## Scheduling and automation

| Requirement | Status | Implementation evidence | Test evidence | Remaining gap |
| --- | --- | --- | --- | --- |
| Authoritative `estimated_ready_at` | IMPLEMENTED | Quote recalculates; final Order persists SQL-authoritative ETA | quote/order/concurrency tests | New minimum policy must be shared. |
| 5-minute clock rounding | IMPLEMENTED | Scheduling utilities and atomic Order SQL | preparation/scheduling tests | Preserve at all new boundaries. |
| Onsite gap scheduling | IMPLEMENTED | Finds earliest capacity gap | onsite/scheduling tests | None. |
| Online deadlines not delayed by onsite; accepted fixed; pending onsite may advance | IMPLEMENTED | `planPendingOnsiteAdvances` fixed/movable split | scheduling tests | Busy extension must touch pending online only. |
| Scheduling concurrency guard | IMPLEMENTED | Schedule fingerprint and conditional update | scheduling/concurrency tests | Busy and auto-reject add explicit CAS. |
| Online minimum 15 minutes | IMPLEMENTED | Explicit Quote policy and atomic Order SQL guard use normal minimum | preparation/quote/order tests | Onsite retains the earlier scheduling policy. |
| Busy minimum 30 and pending extension | IMPLEMENTED | Busy state changes future Quote/Order minimum and guarded batch extends only short pending online Orders | operational automation tests | Leaving busy never retracts commitments. |
| Auto reject unanswered pending | IMPLEMENTED | Scheduled backend evaluates `max(created+5m, ETA-15m)` and performs pending CAS with unique audit event | timing/idempotency/race tests | Cron latency may add up to one minute. |
| Three consecutive auto rejects pause Store | IMPLEMENTED | Server counter increments only committed unique auto rejects; accept resets; third pauses with reason | operational automation tests | Manual resume remains required after auto pause. |
| Daily 17:00 business-day reset | BLOCKED_BY_BUSINESS_DATA | No weekly business-day/schedule setting exists | N/A | Need confirmed weekly business days and permanent-vs-daily unavailability model before automation. No cron auto-open in this scope. |

## Explicitly deferred

`INTENTIONALLY_DEFERRED`: Ollama/AI mutations, custom domain, R2 uploader, SMS/phone history, membership, payments/refunds, full dark mode, incognito detection, inventory, multi-store and a generic modifier builder. These do not solve the present single-store release need or lack a confirmed business contract.
