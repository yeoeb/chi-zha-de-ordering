# Local Candidate UI regression verification

Date: 2026-10-07 / Asia/Taipei. No production operations.
Branch: `fix/v0.1.1-mobile-ux`.
HEAD: `0a587028f455c97f20cc19089fc07ddb48d42acd`.
All pre-existing tracked and untracked work was retained.

## Root causes

1. Merchant retained `spice-*` classes, but the semantic border/background rules had been replaced by neutral group styles. Customer bulk/inline controls lacked spice classes; generic selected-control styling painted every selected level the same red.
2. Accept inherited green from `.merchant-actions button`. Source classes existed on the order/badge, not the accept action.
3. The previous neutral/source card cleanup retained only a 2px outer border and removed the thick left source accent.
4. Category click scrolling used viewport header bottom + nav height + only 12px, while active-category detection used a different 24px threshold and the nav sticky top remained a fixed 5.25rem. Fractional browser pixel rounding could also select the previous category after scrolling.

## Scope and implementation

- `src/react-app/spice-presentation.ts`: presentation-only level/class mapping.
- `src/react-app/CustomerComponents.tsx`: semantic classes on bulk spice buttons, line fold summaries and inline choices. No modifier state/API changes.
- `src/react-app/App.tsx`: quote group classes; one measured sticky offset for clicks/active category; 2px rounding tolerance. No checkout transaction changes.
- `src/react-app/customer-scroll.ts`: measures intrinsic header/nav heights and writes page-scoped CSS variables, never cumulative viewport positions.
- `src/react-app/MerchantComponents.tsx`: accept action has the order-source class.
- `src/react-app/App.css`: independent spice tokens; source-colored accept; 2px outer/6px left rounded border, border-box sizing; category offset calculation.
- `test/customer-ordering.dom.test.tsx`: verifies click offset with measured heights and fractional target rounding.
- `test/ui-style-regressions.dom.test.tsx`: five tests (including two source cases) for source/class/token mapping, independent spice severity, inline/bulk semantics and drift-free sticky offsets.

Spice backgrounds: 不辣 `#ffffff`, 微辣 `#fff5f5`, 小辣 `#fee2e2`, 中辣 `#fca5a5`, 大辣 `#dc2626`.
Selected controls retain their intensity and add an inset selection outline; no new `!important`.
Online token `#2563eb`; onsite token `#15803d`; reject stays danger red.
The left border uses native border-radius/overflow clipping, not glow/pseudo overlays; card outer width remains unchanged.

Sticky contract:
`scroll-margin-top: calc(var(--customer-header-height) + var(--customer-category-nav-height) + var(--category-scroll-gap))`.
Gap is 24px; `ResizeObserver` updates actual heights; nav `top` uses the same measured header variable.
Smooth scroll still respects reduced motion. No root-global sticky measurements or accumulating offsets.

## Browser QA (computer-use, local only)

Verified all five categories: 人氣精選、招牌炸物、串類小品、蔬菜、雞排類.
Verified repeated sequence 蔬菜 → 串類小品 → 雞排類 → 人氣精選 from different existing scroll positions.

| Viewport | Customer heading gap below nav | Active target / overflow |
| --- | --- | --- |
| 375 × 812 | approximately 23.6–24.4px | correct / no horizontal overflow |
| 390 × 844 | approximately 23.6–24.4px | correct / no horizontal overflow |
| 430 × 932 | approximately 23.6–24.4px | correct / no horizontal overflow |
| 1280 × 900 | approximately 23.6–24.4px | correct / no horizontal overflow |

No cumulative scroll offset or observed sticky jitter. At 375/390px measured stack was about 157.1px; at 430/1280px about 161.7px. The offset adapted without breakpoint-specific heights.
Merchant pending cards at these four widths showed blue online accept/border and green onsite accept/border; rounded thick left accents remained intact. Browser fractional border quantization reported 5.6px left / 1.6px outer for CSS 6px/2px.
Merchant medium spice heading rendered `rgb(252,165,165)`, non-spicy heading white, independently of source.
Customer cart at 375px: all bulk and expanded line choices used matching increasing tints; selected non-spicy remained white/dark border. Cart quantity, seasoning and price unchanged.
No orders, accept/reject/complete, Store controls, availability or notification settings were mutated during browser QA. Temporary viewport override reset afterwards.

## Exact verification results

- Targeted Customer/Merchant/style DOM: 146 tests / 3 files passed.
- Targeted Customer/style after rounding fix: 87 tests / 2 files passed.
- New semantic style tests: 5 tests / 1 file passed.
- Final `npm.cmd test`: Worker 311 tests / 31 files; DOM 216 tests / 12 files; total 527 passed.
- `npm.cmd run check`: PASS (lint, PWA verification, TypeScript, build).
- `npm.cmd run build`: PASS. Final assets: `index-0lHm9uIy.js`, `index-E_sLy8pj.css`.
- `npm.cmd run lint`: PASS after final test assertions.
- `npm.cmd run db:migrate:local`: PASS, local only, no migrations to apply.
- `git diff --check`: PASS.
- Initial check caught an unsupported `exact` option in a new Testing Library assertion; corrected without weakening the assertion. Subsequent check/build passed.

## Real-phone follow-up

- iPhone Safari/PWA and Android: category sequence at real zoom/text sizes, rapid successive taps, active-pill horizontal scrolling, and image on/off.
- Confirm 24px visual gap, no header/nav wobble, long content wrapping and cart safe-area clearance.
- Confirm source accent/accept/reject contrast, large-text Merchant mode, long modifiers/notes, and no accidental action overlay.
- Real-device ring/Push/Wake Lock and operational navigation remain manual checks; DOM PASS is not a physical-device guarantee.

No Worker, D1 contract, source-role authorization, cart reducer, notification or navigation business logic was changed in this regression pass. No commit, push, deployment or production D1 mutation.

## Full working-tree output

The following captures include pre-existing uncommitted work, not only this regression pass. `git diff --stat` excludes untracked file contents.

### git diff --stat

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
 src/react-app/App.tsx                     | 675 +++++++++++++---------
 src/react-app/CustomerComponents.tsx      | 135 ++++-
 src/react-app/CustomerOrderStatus.tsx     |  60 +-
 src/react-app/MerchantComponents.tsx      |  79 +--
 src/react-app/MerchantView.tsx            | 618 +++++++++++++++++----
 src/react-app/active-customer-orders.ts   |  13 +-
 src/react-app/cart-draft.ts               |  19 +-
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
 test/cart.test.ts                         |  75 ++-
 test/checkout-quote.test.ts               |  10 +-
 test/customer-ordering.dom.test.tsx       | 650 ++++++++++++++++++----
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
 60 files changed, 4240 insertions(+), 1047 deletions(-)
```

### git status --short

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
?? public/sounds/
?? scripts/generate-merchant-ring.mjs
?? scripts/verify-test-menu.mjs
?? seeds/ensure-spice-modifiers.sql
?? src/react-app/AdminStoreView.tsx
?? src/react-app/DestructiveConfirmationDialog.tsx
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
