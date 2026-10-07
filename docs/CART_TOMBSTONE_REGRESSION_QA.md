# Cart seasoning and one-second recovery regression — local candidate

Date: 2026-10-08 (Asia/Taipei). Branch: `fix/v0.1.1-mobile-ux`.
HEAD remains `0a587028f455c97f20cc19089fc07ddb48d42acd`. Existing uncommitted work is preserved.

## Findings and scope

- Seasoning `+2` was **not reproduced in the current source before implementation changes**. Both fries and sweet-potato fries pass the new StrictMode reproduction: draft pepper/plum switches leave committed quantities/configurations unchanged; each subsequent `+` increments the effective quantity by exactly one. Do not claim a proven duplicate-handler root cause or a new fix for a bug not reproduced. A stale running bundle/device remains a hypothesis, not evidence.
- Size and seasoning already use the same `getProductFolds` draft setter and `addItem` path. Draft selection only updates `productOptionIds`. Only explicit add increments the cart, with a complete canonical product/group/option identity. No debounce or seasoning-specific add path was introduced.
- Zero lines previously had no expiry timer, were serialized by `serializeCartDraft`, and were accepted on restore. This explains indefinite in-memory retention and reappearance after reload.
- Exact matching identity already reused a zero line rather than duplicating it. A stale zero line with a **different modifier configuration** could coexist with a new active line indefinitely; that is not evidence of two identical line IDs. Expiry and positive-only persistence remove the stale-line cause without changing canonical identity.

## New recovery contract

`1 → 0 → temporary tombstone → hard removal after 1000ms`.

- Each timer is keyed by canonical line ID and guarded by the entry generation plus the exact immutable line object. Never use array indices.
- At 999ms the zero line is recoverable with all options/identity preserved. Restoring the same line or menu-adding that exact configuration cancels its timer.
- `0 → 1 → 0` starts a fresh full second, including multiple mutations in one React batch. Unrelated changes and another minus on an already-zero line do not extend its deadline.
- Expiry verifies the original line is still zero before removing it from state. Removing/clearing/replacing a line cancels the old timer. Unmount clears pending timers.
- Zero lines never count toward count/total, quote/order payloads or bulk spice. These existing positive-line boundaries remain unchanged.
- Persistence now writes only positive lines. All-zero carts remove the storage key immediately, not after expiry. Startup skips legacy quantities `<= 0`; reload/PWA reopen cannot restore tombstones. No storage schema/version or backend contract change.
- Re-add before expiry restores the same identity to one; re-add after expiry creates one clean line.

## Daily sold-out reset: schema/business-rule gap (not implemented)

There is no complete daily sold-out reset runtime. Current scheduled processing handles due auto-rejections, not a sale reset.

- `menu_items.is_available` is a single boolean. Merchant availability and shortage operations write it without an availability reason, business-day identifier or per-item mutation revision. `is_archived` distinguishes archived products but does not distinguish daily sold-out from a non-archived permanent/admin disable.
- `store_settings.state_version` guards Store mutations; it is not a revision for individual availability mutations. Blind reset could overwrite a newer Merchant sold-out action.
- `getStoreBusinessDate` and `getTodayBusinessHours` use Taipei calendar date/day. They do not establish the previous operating day across midnight. Weekly open/close metadata is not an authoritative reset ledger or a confirmed opening-transition contract.
- Safely implementing reset needs confirmed cross-midnight business-day semantics, persisted daily-vs-permanent availability provenance, and a once-per-business-day atomic/CAS guard that excludes newer item mutations. Do not invent these semantics or restore every unavailable item.
- This pass adds **no migration**, no reset SQL, no new scheduled task and no active-order cleanup. Existing Store, ETA, history, notifications and availability contracts are untouched.

## Manual device acceptance still needed

1. On desktop and iPhone, add fries pepper, rapidly switch plum/pepper/plum, add once: pepper ×1 + plum ×1. Repeat on sweet-potato fries, then verify size selection behavior.
2. Reduce a line to zero and restore within one second. It must be the same configuration; waiting past one second removes it. Try rapid `0 → 1 → 0` and separate configurations simultaneously.
3. Reload/reopen PWA during the zero window: zero lines must not reappear; positive quantities/options remain. Re-add from the menu: exactly one matching line.
4. Verify all-zero cart has effective total/count zero and cannot submit. Mixed cart quote/order/bulk spice must contain only positive lines, with no unwanted seasoning/size changes.
5. JS timers are subject to browser scheduling/throttling: expiry is scheduled at 1000ms, but suspended/background devices may execute later. Persistence excludes zero immediately; returning to an active page must not keep an expired tombstone indefinitely.


## Verification results

All final commands exited 0:

- `npm.cmd run test:dom -- test/customer-ordering.dom.test.tsx -t "hard removes a zero|restores a zero line before|unmount clears tombstone|draft changes never" --reporter=verbose`: 5 passed, 82 skipped.
- `npm.cmd run test:dom -- test/customer-ordering.dom.test.tsx test/cart-tombstones.dom.test.tsx`: 93 passed in 2 files (87 Customer + 6 timer tests).
- `npm.cmd run test:worker -- test/cart.test.ts`: 18 passed.
- `npm.cmd test`: 311 Worker tests / 31 files and 227 DOM tests / 13 files; 538 total, no failures.
- `npm.cmd run check`: lint, TypeScript and build passed (rerun after final test changes).
- `npm.cmd run build`: passed, including PWA verification.
- `npm.cmd run db:migrate:local`: no pending local migrations.
- `npm.cmd run verify:test-menu`: isolated local D1 passed: 46 visible products, 45 required real-spice groups, egg has none, stable fries/sweet-potato groups/defaults, repeat safety and quick_check.
- `git diff --check`: passed.

The first added page tests exposed test-harness fake-timer waiting/spy restoration problems; these were fixed without increasing timeouts or weakening 999/1000ms assertions. Interrupted full runs were restarted; the final full run above completed successfully.

This pass changes only App cart/timer coordination, positive-only cart draft persistence, corresponding tests, and this report. No CSS, Worker, pricing, ETA, scheduling, navigation, alert, Access or D1 schema changes were made by this pass. Pre-existing changes to those files remain in the working tree.

## Complete working-tree diff stat

This is the complete integrated candidate relative to HEAD, **not just this pass**. Git diff --stat excludes untracked files.

```text
 docs/PROJECT_STATE.md                     |  14 +-
 index.html                                |   3 +-
 package.json                              |   4 +-
 production-data/add-fries-seasoning.sql   |   8 +-
 production-data/add-portion-options.sql   |   4 +-
 production-data/add-spice-options.sql     |  12 +-
 production-data/initial-store-menu.sql    |   4 +-
 public/manifest.webmanifest               |   4 +-
 public/service-worker.js                  |  16 +-
 scripts/verify-fresh-d1.mjs               |  78 ++-
 scripts/verify-migration-0013-upgrade.mjs |  26 +-
 scripts/verify-production-data.mjs        |  48 +-
 scripts/verify-pwa.mjs                    |  45 +-
 seeds/development.sql                     | 132 +++--
 src/react-app/AdminView.tsx               |   2 +-
 src/react-app/App.css                     | 870 +++++++++++++++++++++++------
 src/react-app/App.tsx                     | 701 ++++++++++++++---------
 src/react-app/CustomerComponents.tsx      | 135 ++++-
 src/react-app/CustomerOrderStatus.tsx     |  60 +-
 src/react-app/MerchantComponents.tsx      |  79 +--
 src/react-app/MerchantView.tsx            | 618 +++++++++++++++++----
 src/react-app/active-customer-orders.ts   |  13 +-
 src/react-app/cart-draft.ts               |  21 +-
 src/react-app/cart.ts                     |  30 +-
 src/react-app/customer-menu.ts            |  41 +-
 src/react-app/index.css                   |   3 +-
 src/react-app/merchant-operations.ts      |  13 +-
 src/react-app/order-attempt.ts            |  13 +-
 src/react-app/order-status.ts             |  11 +
 src/react-app/taipei-time.ts              |  16 +
 src/shared/order-source.ts                |   2 +
 src/worker/checkout-quote.ts              |   7 +-
 src/worker/customer-orders.ts             |   2 +
 src/worker/index.ts                       | 126 ++++-
 src/worker/merchant-orders.ts             |  68 ++-
 src/worker/notifications.ts               |   4 +
 src/worker/order-creation.ts              | 120 ++--
 src/worker/order-scheduling.ts            |  50 +-
 src/worker/preparation-time-policy.ts     |   5 +-
 src/worker/store-operations.ts            |   3 +-
 src/worker/store-settings.ts              |  18 +-
 src/worker/web-push.ts                    |  14 +-
 test/active-customer-orders.dom.test.tsx  |  13 +-
 test/cart.test.ts                         |  79 ++-
 test/checkout-quote.test.ts               |  10 +-
 test/customer-ordering.dom.test.tsx       | 727 ++++++++++++++++++++----
 test/fries-order-flow.test.ts             |  21 +-
 test/merchant-operations.dom.test.tsx     | 893 ++++++++++++++++++++++++++++--
 test/merchant-orders.test.ts              |  59 +-
 test/merchant-store-safety.dom.test.tsx   |   3 +-
 test/notifications.test.ts                |  15 +-
 test/onsite-ordering.dom.test.tsx         |  23 +-
 test/onsite-ordering.test.ts              |   6 +-
 test/order-attempt.test.ts                |   6 +-
 test/order-creation.test.ts               |  48 +-
 test/order-scheduling.test.ts             |   3 +
 test/order-status.test.ts                 |  10 +-
 test/preparation-time-policy.test.ts      |  19 +
 test/release-order-features.dom.test.tsx  |  15 +-
 wrangler.json                             |   3 +
 60 files changed, 4343 insertions(+), 1053 deletions(-)
```

## Complete working-tree status

`git status --short -uall` records 60 modified tracked files and 46 untracked files; no staged changes/deletions. At the start of this pass there were 60 modified tracked files and 43 untracked files. The three new files are this report, `cart-tombstones.ts` and `cart-tombstones.dom.test.tsx`. Nothing pre-existing was deleted or discarded.

```text
 M docs/PROJECT_STATE.md
 M index.html
 M package.json
 M production-data/add-fries-seasoning.sql
 M production-data/add-portion-options.sql
 M production-data/add-spice-options.sql
 M production-data/initial-store-menu.sql
 M public/manifest.webmanifest
 M public/service-worker.js
 M scripts/verify-fresh-d1.mjs
 M scripts/verify-migration-0013-upgrade.mjs
 M scripts/verify-production-data.mjs
 M scripts/verify-pwa.mjs
 M seeds/development.sql
 M src/react-app/AdminView.tsx
 M src/react-app/App.css
 M src/react-app/App.tsx
 M src/react-app/CustomerComponents.tsx
 M src/react-app/CustomerOrderStatus.tsx
 M src/react-app/MerchantComponents.tsx
 M src/react-app/MerchantView.tsx
 M src/react-app/active-customer-orders.ts
 M src/react-app/cart-draft.ts
 M src/react-app/cart.ts
 M src/react-app/customer-menu.ts
 M src/react-app/index.css
 M src/react-app/merchant-operations.ts
 M src/react-app/order-attempt.ts
 M src/react-app/order-status.ts
 M src/react-app/taipei-time.ts
 M src/shared/order-source.ts
 M src/worker/checkout-quote.ts
 M src/worker/customer-orders.ts
 M src/worker/index.ts
 M src/worker/merchant-orders.ts
 M src/worker/notifications.ts
 M src/worker/order-creation.ts
 M src/worker/order-scheduling.ts
 M src/worker/preparation-time-policy.ts
 M src/worker/store-operations.ts
 M src/worker/store-settings.ts
 M src/worker/web-push.ts
 M test/active-customer-orders.dom.test.tsx
 M test/cart.test.ts
 M test/checkout-quote.test.ts
 M test/customer-ordering.dom.test.tsx
 M test/fries-order-flow.test.ts
 M test/merchant-operations.dom.test.tsx
 M test/merchant-orders.test.ts
 M test/merchant-store-safety.dom.test.tsx
 M test/notifications.test.ts
 M test/onsite-ordering.dom.test.tsx
 M test/onsite-ordering.test.ts
 M test/order-attempt.test.ts
 M test/order-creation.test.ts
 M test/order-scheduling.test.ts
 M test/order-status.test.ts
 M test/preparation-time-policy.test.ts
 M test/release-order-features.dom.test.tsx
 M wrangler.json
?? docs/CART_TOMBSTONE_REGRESSION_QA.md
?? docs/CUSTOMER_NAVIGATION_MERCHANT_VISUAL_QA.md
?? docs/LOCAL_TEST_MENU_MATRIX.md
?? docs/MENU_OPERATIONS.md
?? docs/MERCHANT_ALERT_QA.md
?? docs/NAVIGATION_PICKUP_QA.md
?? docs/OFFICIAL_MENU_MAPPING.md
?? docs/PRODUCT_BLUEPRINT.md
?? docs/REQUIREMENTS_AUDIT.md
?? docs/UI_REGRESSION_QA.md
?? migrations/0017_add_operational_automation.sql
?? migrations/0018_add_customer_store_configuration.sql
?? migrations/0019_add_new_order_sound_setting.sql
?? production-data/apply-official-menu-v0.1.1.sql
?? public/sounds/README.md
?? public/sounds/new-order.wav
?? scripts/generate-merchant-ring.mjs
?? scripts/verify-test-menu.mjs
?? seeds/ensure-spice-modifiers.sql
?? src/react-app/AdminStoreView.tsx
?? src/react-app/DestructiveConfirmationDialog.tsx
?? src/react-app/cart-tombstones.ts
?? src/react-app/customer-navigation.ts
?? src/react-app/customer-scroll.ts
?? src/react-app/merchant-audio.ts
?? src/react-app/merchant-focus.ts
?? src/react-app/merchant-wake-lock.ts
?? src/react-app/return-navigation.ts
?? src/react-app/spice-presentation.ts
?? src/shared/business-date.ts
?? src/shared/spice.ts
?? src/worker/admin-store.ts
?? src/worker/merchant-revenue.ts
?? src/worker/operational-automation.ts
?? test/admin-store.dom.test.tsx
?? test/admin-store.test.ts
?? test/cart-tombstones.dom.test.tsx
?? test/merchant-audio.dom.test.tsx
?? test/merchant-focus.test.ts
?? test/merchant-revenue.test.ts
?? test/merchant-wake-lock.dom.test.tsx
?? test/operational-automation.test.ts
?? test/pickup-scheduling.test.ts
?? test/return-navigation.dom.test.tsx
?? test/spice-contract.test.ts
?? test/ui-style-regressions.dom.test.tsx
```

No commit, push, deployment, remote D1 query/write or production configuration mutation was performed.
