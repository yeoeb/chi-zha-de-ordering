# Deterministic return and pickup schedule QA

## Scope and source

- Local uncommitted candidate on `fix/v0.1.1-mobile-ux`, based on `0a587028f455c97f20cc19089fc07ddb48d42acd`.
- Existing dirty files are retained. No commit, push, deployment, remote D1 query or production configuration mutation was performed.
- This change adds no migration and does not rewrite historical order snapshots.

Files edited in this task (other dirty files predate it):

- Customer/navigation: `src/react-app/return-navigation.ts` (new), `App.tsx`, `CustomerOrderStatus.tsx`.
- Merchant: `src/react-app/MerchantView.tsx`, `MerchantComponents.tsx`.
- Worker: `src/worker/index.ts`, `order-creation.ts`, `order-scheduling.ts`, `operational-automation.ts` (previously untracked work retained).
- Tests: `test/return-navigation.dom.test.tsx` and `test/pickup-scheduling.test.ts` (new); `customer-ordering.dom.test.tsx`, `merchant-operations.dom.test.tsx`, `checkout-quote.test.ts`, `order-creation.test.ts`, `order-scheduling.test.ts`.
- This QA record: `docs/NAVIGATION_PICKUP_QA.md` (new).

## Return contract

`src/react-app/return-navigation.ts` owns one canonical history entry and at most one secondary entry per entry flow. Secondary switches replace that entry instead of accumulating intermediate views. An entry nonce distinguishes owned state from external browser history.

- Online Customer root: `/order`.
- Onsite Customer root: `/store-order`.
- Merchant root: `/merchant`, pending workbench.
- The same controller handles visible Return and browser `popstate`. A visible Return traverses only the owned root/secondary pair; it never assumes an unrelated previous URL is safe. Duplicate clicks during that traversal are ignored.
- At canonical root the next Back follows ordinary browser history, including leaving the site. No forward loop or repeated push trap is used.
- Direct secondary entry establishes a root sentinel. Refresh reuses owned markers. Status deep links resolve authoritative `orderSource`; onsite status returns to onsite ordering.
- Merchant accepted/sold-out switches reuse one workbench secondary entry. History, revenue, reject confirmation and shortage details return to pending. Returning closes secondary details; polling alone does not reset the workbench.
- Future secondary screens must use this controller, not introduce a separate button-only Back implementation.

## Authoritative pickup scheduling

The existing operational pickup queue is `pending`, plus non-cancelled `accepted` whose saved ETA is still in the future. Merchant reads already use this projection. Quote and creation now agree with it. Expired accepted records remain accepted historical records, not invented completed transitions.

- Quotes do not reserve slots. Creation uses the current queue and saves its authoritative ETA.
- Both online and onsite creation use the existing capacity scheduler, preparation buffer and five-minute rounding. Online retains queue-derived and busy-mode minimum lead time.
- A D1 atomic creation batch checks the queue fingerprint and absence of the chosen UTC-minute slot, in addition to existing Store/catalog/confirmed-price guards. A competing change causes bounded recalculation; no orphan items or notification intent are inserted by a losing attempt.
- The fingerprint conservatively covers all stored non-cancelled pending/accepted records, including expired accepted history. Scheduling excludes those historical records; their old timestamps and snapshots are not rewritten.
- Idempotent replay returns the existing order and saved time without allocating another slot.
- Cancellation, rejection and manual completion release effective queue capacity. Existing unanswered-order automation rejects due pending orders; it does not forge completion of accepted orders.
- Existing forward compaction affects only pending onsite orders. It now respects the original preparation floor, fixed reservations and five-minute boundaries. Online and accepted orders are not advanced by this operation.
- Busy-mode extension assigns separate guarded capacity slots instead of assigning all pending online orders the same minimum ETA. Queue changes produce the existing stale-state conflict rather than an unguarded overwrite.

Local data inspection found old duplicated pending timestamps from the previous busy-mode update and duplicated expired accepted timestamps in history. The pending pair was separated through the normal guarded LOCAL busy-mode operation, then normal mode restored. Historical accepted timestamps were left untouched. This is not an automatic repair of arbitrary legacy data: before a later production release, inspect effective active conflicts separately. This task neither queried nor changed production.

## Automated verification (2026-10-07 Asia/Taipei)

| Command | Result |
| --- | --- |
| Targeted quote/create/scheduling/automation Worker tests | 72 passed, 5 files |
| `npm test` | Worker 302 passed / 30 files; DOM 171 passed / 9 files |
| `npm run check` | PASS: ESLint, TypeScript, PWA checks, Vite builds |
| `npm run build` | PASS |
| `npm run db:migrate:local` | PASS; no pending local migration |
| `npm run verify:fresh-d1` | PASS; 19 sequential migrations, seed, second apply, quick_check |
| `npm run verify:upgrade-d1` | PASS; pre-0011 history preserved through 0019, second apply, quick_check |
| `git diff --check` | PASS; only existing LF/CRLF conversion warnings |

Added tests cover owned history, external entry, first/second Back, repeated visible Return, refresh, onsite source, actual React popstate, Merchant history/revenue/tabs/dialogs, concurrent online/onsite/mixed creates, replay, terminal slot release, compaction, busy-mode races, legacy unaligned ETA and expired accepted history.

A full-run failure exposed old fixed September accepted-order fixtures that had become history. Only fixture dates were updated to relative future times; the original queue lead-time assertions were retained. Store operation UUID-count assertions also exposed navigation nonce coupling, resolved by using a separate random-byte nonce instead of consuming operation UUIDs.

## Actual local browser QA

The Codex in-app desktop browser was exercised, not a physical iPhone or Android device.

- Unrelated external page -> online menu -> checkout -> visible/system Back -> `/order`; next Back can leave to the external page.
- My Orders, success/status and recently completed local order -> Back -> menu; refresh remains menu.
- Onsite checkout, cancellation detail and deep-linked status (including refresh) -> Back -> `/store-order`.
- Merchant history/revenue from accepted/sold-out -> visible/system Back -> `/merchant` pending.
- Merchant revenue/history refresh -> system Back -> pending; root's next Back may leave to the external page.
- Customer 375/390/430px and Merchant 375/390/430px views checked. Tested views had no horizontal overflow; Merchant large-text mode was also exercised. Original font preference and viewport override were restored afterward.
- Local UI orders retained fries `不辣 / 胡椒` through Customer and Merchant. One was cancelled and one accepted/completed through existing local APIs/UI; recent completion stayed readable.
- Local onsite slot-release sequence: earlier order rejected, following order advanced from 04:00 to 03:55, new order allocated 04:00. Customer and Merchant reads agreed on saved ETA.
- Final local effective queue: 5 orders, 5 distinct pickup minutes, no duplicate groups; `PRAGMA quick_check = ok`.
- Local QA records are retained as history; no database reset or test-order hard deletion was performed. Acceptance remained true. The local busy-mode toggle incremented Store version through its existing CAS contract and was restored to normal.

## Still required on actual devices

- iPhone Safari: external entry -> checkout/My Orders/status/recent completion -> left-edge swipe returns to correct source root; second swipe may leave normally.
- iPhone Home Screen PWA: launch, deep link, refresh and available Back behavior; onsite QR source; safe-area and long-order scrolling.
- Android: system Back/gesture from Customer and Merchant secondary screens, then normal root exit.
- Physical 375/390/430-ish phones: long notes/modifiers, large-text Merchant and fixed/sticky UI.

These physical-device paths are NOT recorded as PASS by DOM tests or desktop viewport emulation.
