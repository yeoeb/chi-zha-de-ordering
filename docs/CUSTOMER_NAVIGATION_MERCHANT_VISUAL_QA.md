# Customer 階層返回與 Merchant 視覺整合（本機）

2026-10-07。Branch `fix/v0.1.1-mobile-ux`，HEAD `0a587028f455c97f20cc19089fc07ddb48d42acd`。
本輪未提交；此前全部工作樹修改與未追蹤檔案保留。此文件取代舊 QA 中 Customer「任何次頁直接回菜單」的預期；Merchant 原本的事件導頁契約不變。

## 根因與修正

原 Customer 與 Merchant 共用一個 root + 一個 secondary 的 history controller。Cart、Checkout、我的訂單及明細彼此 replace，而非逐層 push；Checkout 還使用 `?view=cart` URL。App 只辨識現場入口，未辨識現場子路徑。因此 Level 3 返回跳 Level 1，子路徑直接進入／刷新也可能落到 online。

新增 Customer 專用 `customer-navigation.ts`；未修改 Merchant 使用的 `return-navigation.ts`。集中 Parent Map：

| 來源 | 頁面 | 返回目的地 |
| --- | --- | --- |
| online | `/order/checkout` | `/order/cart` |
| online | `/order/cart`、`/order/orders` | `/order` |
| onsite | `/store-order/checkout` | `/store-order/cart` |
| onsite | `/store-order/cart`、`/store-order/orders` | `/store-order` |
| onsite alias | `/onsite/checkout` | `/onsite/cart` |
| onsite alias | `/onsite/cart`、`/onsite/orders` | `/onsite` |
| online alias | `/checkout` | `/cart` |
| online alias | `/cart` | `/` |
| 兩來源 | `/orders/:opaqueToken?source=…&home=…` | 對應來源的我的訂單 List |

既有 `/order`、`/store-order` 入口保留，舊 `?view=cart/orders` 連結可讀；新的子頁有獨立 URL。Order 詳情仍使用 opaque public lookup token，不新增公開 internal ID。沒有 source query 的舊明細連結，使用既有權威 Order lookup 修正來源。

直接進入深層頁會建立必要的 root／parent entries；同一 entry 刷新不重複 push。可見返回與 native Back 共用相同階層，root 再 Back 交回瀏覽器，不攔截離站。重複可見返回在 history traversal 完成前忽略；跨 Cart／Orders 分支時先回共同祖先再建立正確分支，不留下錯誤 parent。Forward 保留原生行為。舊／不一致的 surface metadata 依 URL 重建。

Cart 與 Checkout 保留同一 CustomerApp 狀態，不改 cart reducer、identity、spice、draft schema 或交易 payload。新增 hydration 完成訊號，避免深連 Checkout 在草稿還原前用空 Cart 取報價；初次／刷新／Forward 進 Checkout 均重新使用既有 quote API。備註與聯絡資料仍沿用來源分開的 session draft。新增測試驗證 zero line、Modifier、數量、備註及 onsite API 提交不變。

## 本輪修改檔案

- `src/react-app/customer-navigation.ts`（新增）：Customer URL／Parent Map／history hook。
- `src/react-app/App.tsx`：路徑辨識、parent Back、明細返回 List、Checkout hydration 與進頁報價。
- `src/react-app/MerchantComponents.tsx`：訂單 outer card 加入來源 class。
- `src/react-app/App.css`：共享 tokens、Merchant 白底／pill／中性分隔／來源框與 badge／語義按鈕。
- `test/return-navigation.dom.test.tsx`：Customer 真階層、重複返回、直接進入、刷新、Forward、root 離站、跨分支、metadata 恢復；保留 Merchant 原測試。
- `test/customer-ordering.dom.test.tsx`：新返回預期；新增四組根路徑的刷新、Cart／zero／Modifier／備註保留。
- `test/onsite-ordering.dom.test.tsx`：返回／刷新後實際提交仍為 onsite endpoint。
- `test/merchant-operations.dom.test.tsx`：網路／現場 outer source class 與 badge。
- 本 QA 文件。

未新增 migration，未修改 Worker／D1／production-data；未修改 Merchant Auto-navigation、T-10、音效、Wake Lock、Web Push、排程、ETA、狀態機與價格契約。

## Merchant 視覺

共用既有 `--brand-red`（#e60012）、`--border-subtle`、文字 tokens；新增 `--surface`、`--surface-muted`、`--radius-card`、`--radius-pill`、`--radius-control`、`--shadow-card` 及 source colors。Customer card/pill 使用相同值的 tokens，未重設 Customer layout。

Merchant 背景／header／卡片白色；三個主要 tab 保留待接單、製作中、售罄，active brand-red pill。Online 2px 藍框與「網路」淡藍 badge；onsite 2px 綠框與「現場」淡綠 badge。移除 old new-order 黃框／glow／整卡黃底，來源框不被 urgency/new-order 覆蓋。急迫度文字及 deadline 字級保留。

餐點分組改淺灰細框／中性 heading，備註保留醒目左紅線與完整換行。接單綠色，拒單淡紅／紅 outline；兩者同高 56px，同圓角／padding／字重。缺貨、售罄採輕 danger outline，恢復供應保持高對比綠色。修正 busy secondary button 原本受容器白字規則覆蓋的低對比問題（只改樣式）。

## 自動驗證

| 命令 | 最終結果 |
| --- | --- |
| npm.cmd run test:dom -- --run test/return-navigation.dom.test.tsx test/customer-ordering.dom.test.tsx test/onsite-ordering.dom.test.tsx test/merchant-operations.dom.test.tsx | PASS，162 tests／4 files |
| npm.cmd run test:dom -- --run test/onsite-ordering.dom.test.tsx | PASS，2 tests／1 file |
| npm.cmd test | PASS，Worker 311／31 files；DOM 211／11 files（總 522） |
| npm.cmd run check | PASS（最終程式再次執行 lint + build） |
| npm.cmd run build | PASS，PWA verifier + TypeScript + Vite；最終 client index-BX3wUnlh.js / index-YtPCvQic.css |
| npm.cmd run lint | PASS |
| npm.cmd run db:migrate:local | PASS，Resource location: local，No migrations to apply |
| git diff --check | PASS（無输出） |

測試更新只調整已失效的 root-return 預期與 reload 測試 helper，未弱化 quote／idempotency／Cart／spice／來源／交易斷言。初輪舊返回預期失敗及新現場測試對「已加入後仍有 + 按鈕」的誤判均已修正；最終無未通過測試。

## 瀏覽器及手機 QA

使用 computer-use 技能在本機 `127.0.0.1:5173` 檢查，不操作正式環境。

已檢查：

- 375／390／430px Merchant：document 無水平溢出；來源框／badge、deadline、分組及按鈕呈現正確。
- Desktop 1280px：網路與現場待接單卡片及三頁籤；製作中空狀態。
- 手機尺寸售罄／快速售罄：輕 danger 按鈕與完整菜單保留（未切換供應）。
- 實際 Customer 現場流程：`/onsite` → Cart → Checkout → 刷新 → Browser Back → Cart → 可見 Back → 現場 Menu；薯條 quantity 1／不辣／胡椒保留。
- 現場我的訂單 List 返回仍是 `/onsite`；Customer 原視覺保留。
- 瀏覽器 viewport override 已 reset。只操作本機瀏覽器 Cart presentation／取報價，未送單、未接／拒／完成、未調 Store 或售罄。

仍需真機：

1. iPhone Safari／PWA swipe Back，Android System Back：online/onsite 的 Checkout→Cart→Menu、Detail→List→Menu；root 再返回能正常離站。
2. 從 `/onsite/checkout`／`/cart` 深連、刷新、PWA 重開、Forward；確認 zero line、調味／切法／辣度、備註保留，最後送單來源正確。
3. 待接單／製作中兩來源的長品名、多個 Modifier 與長備註完整換行；大字模式及 iPhone safe area 不遮按鈕。
4. 實機確認接單／拒單／完成的綠／紅語義、售罄／恢復的對比；新單、T-10、聲音、Wake Lock 依既有流程正常。

目前本機實際資料無製作中訂單，也無涵蓋所有長備註的視覺案例；相關 DOM 回歸已測，但不宣稱 populated 製作中／長備註或真機驗收 PASS。

## 整體未提交 diff／status

以下包含此前保留的全部修改，非本輪新增量；`git diff --stat` 不含未追蹤檔案內容。

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
 src/react-app/App.css                     | 810 +++++++++++++++++++++------
 src/react-app/App.tsx                     | 660 +++++++++++++---------
 src/react-app/CustomerComponents.tsx      | 130 ++++-
 src/react-app/CustomerOrderStatus.tsx     |  60 +-
 src/react-app/MerchantComponents.tsx      |  77 +--
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
 test/customer-ordering.dom.test.tsx       | 643 +++++++++++++++++----
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
 60 files changed, 4162 insertions(+), 1036 deletions(-)
```

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
?? src/react-app/merchant-audio.ts
?? src/react-app/merchant-focus.ts
?? src/react-app/merchant-wake-lock.ts
?? src/react-app/return-navigation.ts
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
```

共 60 個 tracked modified、39 個 untracked files（標準 status 將 public/sounds/ 彙總一行）；全數未 staged／未 commit。HEAD／branch 不變。
