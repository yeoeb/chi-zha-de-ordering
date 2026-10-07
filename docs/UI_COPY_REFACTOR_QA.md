# UI Copy Refactor — local candidate

Result: **PASS**. Date: 2026-10-08, Asia/Taipei.

Branch: `fix/v0.1.1-mobile-ux`; unchanged HEAD: `0a587028f455c97f20cc19089fc07ddb48d42acd`.
All pre-existing uncommitted changes and untracked files were preserved.

## Files changed by this pass

- New `src/react-app/ui-copy.ts`.
- `src/react-app/App.tsx`.
- `src/react-app/CustomerComponents.tsx`.
- `src/react-app/CustomerOrderStatus.tsx`.
- `src/react-app/MerchantComponents.tsx`.
- `src/react-app/MerchantView.tsx`.
- `src/react-app/order-status.ts`.
- `src/react-app/merchant-operations.ts` (deadline labels only; calculations unchanged).
- `src/react-app/DestructiveConfirmationDialog.tsx` (existing processing label only).
- New `test/ui-copy.dom.test.tsx` (4 regression cases).
- This report.

## Copy module

`uiCopy` is a pure, import-free, ASCII-keyed `as const` data object:

- `common`: 20 shared labels (brand fallback, return, close, processing, notes, historical packaging display, missing-time labels and units).
- `customer`: 182 labels/message fragments (header, cart, checkout, My Orders, status, validation, quote/order errors, recovery feedback, placeholders and accessibility labels).
- `onsite`: 5 distinct onsite title/instruction/status/quote-disclaimer strings. Onsite keeps the existing shared Customer implementation and source detection.
- `merchant`: 170 labels/message fragments (tabs/actions, source badges, complete/reject dialogs, sold-out controls, empty states, connectivity, Store safety presentation, alerts, notification status, history, revenue and urgency labels).

Dynamic quantities, item names, authoritative prices, timestamps and error codes remain in their existing expressions. Static prefix/suffix strings are data constants, not formatter functions or a new interpolation/i18n framework. The fixed text, whitespace and punctuation are unchanged.

Components depend on copy; copy imports no React, cart, API, route or domain module. No Context, runtime mutation, storage, locale routing or translation dependency was added.

## Deliberately not centralized

- API/D1 product names, categories, prices, descriptions, images, origin disclosure text, customer data, modifier group/option names and IDs.
- Spice values/group identifiers, sorting/validation mappings and the `辣度` caption currently also used by the existing semantic-style discriminator. No modifier identity, CSS token or gradient was changed.
- `辣粉另包` matching and persisted note composition remain domain/fulfillment behavior, not editable UI copy. Only its displayed helper text was moved.
- Menu presentation/config data, including the synthetic popular category, remains in the menu configuration boundary.
- Existing date-format helper text remains in its formatter; no business-day/time/ETA helper was refactored.
- Admin-specific copy was not broadly migrated. The shared confirmation component only consumes `common.processing` for its unchanged label.

Daily sold-out reset remains at the prior documented schema/business-boundary gap. This text-only pass neither implements nor changes it.

## Preservation evidence

- Captured the exact seven main component/status files before this pass. Reversing copy references (including template fragments and JSX attributes/children) reproduces their original source exactly after newline normalization. This checks both literal values and the unchanged underlying handlers/conditions, and caught a currency-symbol extraction issue before final verification.
- Merchant urgency edits change only missing/remaining/overdue label construction. Thresholds, minute arithmetic and class mapping are unchanged.
- No CSS, cart reducer/draft/tombstone, source detection, back navigation, focus, audio/ring, Push, Wake Lock, scheduling, order state, Worker, schema or data file was edited by this pass. Pre-existing changes in those files remain untouched.
- Existing tests still use their independent literal accessible-name/text expectations. No pre-existing test needed a selector or expectation change.
- New tests verify required role labels, ASCII string-only groups, Online/Onsite header text, API-supplied Store name, My Orders/cart accessible names, Merchant tab counts/current state and existing navigation class.

## Exact final verification

All commands exited 0:

- `npm.cmd run test:dom -- test/ui-copy.dom.test.tsx test/ui-style-regressions.dom.test.tsx test/cart-tombstones.dom.test.tsx`: **15 passed / 3 files**.
- `npm.cmd run test:dom -- test/customer-ordering.dom.test.tsx test/merchant-operations.dom.test.tsx test/ui-copy.dom.test.tsx`: **150 passed / 3 files**.
- `npm.cmd run test:worker -- test/cart.test.ts test/order-status.test.ts test/merchant-focus.test.ts`: **32 passed / 3 files**.
- `npm.cmd test`: **311 Worker tests / 31 files + 231 DOM tests / 14 files = 542 passed**.
- `npm.cmd run check`: lint, TypeScript, PWA verification and build passed.
- `npm.cmd run build`: separate final build passed.
- `npm.cmd run db:migrate:local`: **no pending local migrations**; no new migration.
- `git diff --check`: passed.

Worker build remains 259.66 kB; client CSS asset remains `index-E_sLy8pj.css`. No visual style changes were made. The JS asset changes because the constants are now bundled as a shared module.

## Manual acceptance

No new browser/phone visual QA was performed in this pass; DOM results are not real-device proof. On the existing local candidate, compare Customer cart/checkout/status and onsite labels, Merchant source badges/actions/empty states, long dynamic error messages, and screen-reader names. Expected visual behavior and wording are unchanged.

No commit, push, deployment, remote D1 operation or production-setting mutation was performed.

## Final complete working-tree inventory

The following diff/stat and status include **all existing candidate changes**, not only this text refactor. `git diff --stat` excludes untracked files.

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
 src/react-app/App.tsx                     | 886 +++++++++++++++++------------
 src/react-app/CustomerComponents.tsx      | 168 ++++--
 src/react-app/CustomerOrderStatus.tsx     | 127 +++--
 src/react-app/MerchantComponents.tsx      | 148 ++---
 src/react-app/MerchantView.tsx            | 697 +++++++++++++++++------
 src/react-app/active-customer-orders.ts   |  13 +-
 src/react-app/cart-draft.ts               |  21 +-
 src/react-app/cart.ts                     |  30 +-
 src/react-app/customer-menu.ts            |  41 +-
 src/react-app/index.css                   |   3 +-
 src/react-app/merchant-operations.ts      |  21 +-
 src/react-app/order-attempt.ts            |  13 +-
 src/react-app/order-status.ts             |  22 +-
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
 60 files changed, 4573 insertions(+), 1275 deletions(-)
```

`git status --short -uall`: 60 modified tracked files, 49 untracked files, all unstaged. The new files added this pass are `ui-copy.ts`, `ui-copy.dom.test.tsx` and this report. No pre-existing file was removed.

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
?? docs/UI_COPY_REFACTOR_QA.md
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
?? src/react-app/ui-copy.ts
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
?? test/ui-copy.dom.test.tsx
?? test/ui-style-regressions.dom.test.tsx
```
