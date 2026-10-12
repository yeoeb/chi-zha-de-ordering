# Order Submission / On-site Fix QA

ORDER SUBMISSION / ONSITE FIX: PASS

本輪僅修復 Customer 送單 500 與 On-site 缺貨偏好，不繼續 Production Release。

## 工作樹保護

- Branch: `fix/v0.1.1-mobile-ux`
- HEAD: `0a587028f455c97f20cc19089fc07ddb48d42acd`
- 開始時有 119 個 modified/untracked 實際檔案。
- 本輪修改 14 個程式/測試檔案，另新增本交付文件。
- 初始其餘 106 個檔案 SHA-256 未改變，沒有遺失原有檔案。
- 未 stage、commit、reset、revert、checkout、push、deploy、upload 或操作 Remote D1。
- 既有 5173 開發伺服器保留；本輪隔離 QA 5174 伺服器及 QA 分頁已關閉。

## 500 ROOT CAUSE

1. Failing endpoint: `POST http://127.0.0.1:5174/api/orders`（本輪重現）；既有 5173 本機 observability 也記錄相同 SQL 錯誤。
2. Quote: `POST /api/checkout/quote` 成功，接著 10 條餐點配置送單回傳 HTTP 500。
3. Request schema:
   - `specialOrder: false`
   - `customerNote: null`
   - `packagingPreference: "together"`
   - `shortagePolicy: "continue_available"`
   - `quoteFingerprint: <實際 Quote 回傳的 64 字元 fingerprint，未揭露值>`
   - `items: Array<{menuItemId: number, quantity: 1, modifierOptionIds: number[]}>`
   - `Idempotency-Key` 有提供（不列出值）。
   - 重現商品 IDs: 2, 4, 5, 3, 6, 9, 10, 7, 8, 11；每筆使用當時 API 的有效 Modifier。
4. Safe response body: `Internal Server Error`。
5. Actual exception: `D1_ERROR: too many SQL variables at offset 10776: SQLITE_ERROR`。
6. Captured stack: `D1DatabaseSessionAlwaysPrimary._sendOrThrow` → `createOrder`（修改前 order-creation.ts:855，原子 db.batch）→ `handleCreateOrder`（index.ts:480）。
7. Root: `buildCatalogCommitGuard` 對每個餐點、Modifier 和必選群組展開獨立綁定參數；有效多品項購物車超過 D1 單 statement 綁定參數限制。不是電話、nullable note、0020 欄位缺失或 shortage enum 驗證失敗。
8. 為何漏測：既有提交／競態測試集中於少量餐點；DOM fetch mock 沒有執行真實 D1 SQL。缺少多條 Modifier 配置的原子送單案例。
9. Exact fix: 將「後端已核價」快照序列化為單一 bound JSON，由 `json_each/json_extract` 在同一 guarded INSERT 內核對現行商品名稱/價格/供應/封存/分類、Modifier 所有權/名稱/價格/啟用，以及必選群組。保留 Store/CAS/排程保護、Quote fingerprint 與同一 D1 batch；未信任前端價格，也未拆開交易。
10. Regression: 10 與 50 條（每條包含實際辣度、切法加價）成功建立正確金額、完整明細/Modifier、唯一通知；相同 Key replay 仍只有一張單。原有商品/Modifier 改價競態與 snapshot-write rollback 測試保留且通過。

## Online / On-site 契約

- Online: 保留現有缺貨區與兩個選項；預設 `continue_available`，依既有契約允許省略並由後端套用預設，不擅自新增必選限制。`cancel_entire_order` 仍由顧客明確選擇並提交。
- On-site: 缺貨 fieldset、radio、helper 與表單選擇 state 都不啟用；不讀取舊 draft 缺貨選擇，不保存/提交 `shortagePolicy`。
- 後端 `POST /api/onsite/orders` 的 allowlist 移除 `shortagePolicy`，有提供該欄位即 400 `INVALID_ORDER_REQUEST`。來源由後端 route 決定，拒絕注入 `orderSource` 或 contact fields。
- 建立、同 Key replay、公開 token lookup、Merchant snapshot 均以 `order_source='onsite'` 回傳 `shortagePolicy: null`。
- D1 舊欄位是 NOT NULL enum，沒有不適用值。本輪經使用者確認，不新增 migration；新 On-site 記錄的 `continue_available` 僅為既有欄位的相容儲存值，不是顧客選擇。
- On-site Merchant 缺貨處理不使用該 enum 決定整單取消；即使舊 On-site 記錄存 `cancel_entire_order`，部分缺貨仍依現場處理保留剩餘品項。原有「所有品項都不可供應」處理保留。
- Menu 缺貨同步售罄／business-date marker 和 daily reset 未修改。
- 未重寫既有歷史訂單、沒有新增 migration、沒有改價或改菜單。

## Duplicate / ambiguous-result safety

- 未修改 request fingerprint canonicalization、Quote fingerprint、Idempotency-Key、跨 reload pending attempt、in-flight guard 或 bounded recovery。
- 新 On-site 省略欄位與舊 default-continue attempt identity 保持一致，新增測試鎖定。
- 原有 uncertain-response／reload 同 Key 恢復測試通過；不產生新 Key 盲目重送。
- 若舊 pending On-site attempt 原本選 cancel，其不同內容仍會被既有 hash mismatch guard 擋住，不會為了省略欄位自動換 Key 建立另一張單。
- 本機 SELECT: 重現失敗請求的訂單筆數 0、孤兒明細 0、孤兒 Web Push intent 0；`PRAGMA quick_check = ok`。

## 本輪修改檔案

程式：
- `src/react-app/App.tsx`
- `src/react-app/order-status.ts`
- `src/react-app/merchant-operations.ts`
- `src/worker/order-creation.ts`
- `src/worker/customer-orders.ts`
- `src/worker/merchant-orders.ts`
- `src/worker/order-adjustments.ts`

測試：
- `test/order-creation.test.ts`
- `test/order-atomicity.test.ts`
- `test/order-adjustments.test.ts`
- `test/order-attempt.test.ts`
- `test/onsite-ordering.test.ts`
- `test/onsite-ordering.dom.test.tsx`
- `test/customer-ordering.dom.test.tsx`

文件：本檔。

## 測試與命令

| 命令 | 最終結果 |
| --- | --- |
| `npm.cmd run test:worker -- test/order-creation.test.ts test/order-concurrency.test.ts test/order-atomicity.test.ts test/onsite-ordering.test.ts test/order-adjustments.test.ts` | 5 files / 62 tests PASS |
| `npm.cmd run test:dom -- test/onsite-ordering.dom.test.tsx test/customer-ordering.dom.test.tsx test/release-order-features.dom.test.tsx test/order-attempt.test.ts` | DOM config: 3 files / 98 tests PASS；order-attempt 屬 Worker，由完整套件執行 |
| `npm.cmd run test:dom -- test/customer-ordering.dom.test.tsx -t 'maps invalid-quote indices'` | 1 PASS / 88 skipped（僅定向執行） |
| `npm.cmd test` | 32 Worker files / 345 tests + 14 DOM files / 233 tests = 578 PASS，完整執行沒有 skip |
| `npm.cmd run check` | lint + TypeScript + PWA + Worker/client build PASS |
| `npm.cmd run build` | PASS；最終 check 亦重新執行相同 build |
| `npm.cmd run db:migrate:local` | PASS: No migrations to apply |
| `npm.cmd run verify:fresh-d1` | PASS: 20 linear migrations、second apply、quick_check |
| `npm.cmd run verify:upgrade-d1` | PASS: 0011–0020 preservation、0019→0020、second apply、quick_check |
| `npm.cmd run verify:production-data` | PASS：只在隔離本機 DB 執行，沒有正式 SQL |
| `git diff --check` | PASS |

新增 6 項測試：10/50-line carts（2）、On-site storage enum 不控制客製取消（1）、On-site attempt identity 相容（1）、Online continue/cancel payload（2）。
更新 On-site DOM/Worker 的 omitted-field、null snapshot/replay、source 與拒收偏好測試；rollback 驗證明細/Modifier/通知皆為 0。

完整 DOM 首次曾因既有 1 秒零份數 TTL 在併跑負載下提前過期而失敗（單跑原測試通過）。僅在該「失效配置定位」測試控制到期等待；999/1000ms 真正 TTL 的原有測試保留且通過，未改 Cart runtime，也未刪除斷言。調整 timer mock 的 Node/DOM ambient 型別後，最終 check 與完整套件已全部重跑通過。

## Manual browser QA

使用 computer-use 技能的瀏覽器流程在隔離 127.0.0.1:5174 origin 驗收，不改使用者 5173 的 pending key / draft。

- Online: 菜單 → 10 商品 → Cart → Quote → 選 continue → Submit → 訂單狀態，總額 NT$560，薯條不辣/胡椒與甘梅地瓜不辣/梅粉保留，成功。
- On-site: `/store-order` → 薯條/甘梅地瓜 → Cart → Checkout；缺貨 group/radio count 都為 0 → Submit 成功，總額 NT$90。
- Merchant read-only GET: 同一個本機 D1 回傳 `orderSource: onsite`、`shortagePolicy: null`，薯條不辣/胡椒與甘梅地瓜不辣/梅粉各一份，金額 NT$90。
- 最後為截圖建立一份未送出的隔離 On-site 草稿，未再次建立訂單。
- 共建立 3 筆本機診斷／瀏覽器測試訂單（單品診斷、Online 10 品項、On-site 2 品項）；沒有正式訂單。
- 沒有使用手機實機；仍需店家於手機確認 On-site 缺貨區消失與送單成功狀態。不要為驗收清除結果未知的 pending attempt。

## Git diff --stat（整個既有 working tree，不是本輪新增量）

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
 scripts/verify-fresh-d1.mjs               |  90 ++-
 scripts/verify-migration-0013-upgrade.mjs |  48 +-
 scripts/verify-production-data.mjs        |  82 ++-
 scripts/verify-pwa.mjs                    |  45 +-
 seeds/development.sql                     | 132 +++--
 src/react-app/AdminView.tsx               |   2 +-
 src/react-app/App.css                     | 870 +++++++++++++++++++++++------
 src/react-app/App.tsx                     | 892 ++++++++++++++++-------------
 src/react-app/CustomerComponents.tsx      | 168 ++++--
 src/react-app/CustomerOrderStatus.tsx     | 127 +++--
 src/react-app/MerchantComponents.tsx      | 148 ++---
 src/react-app/MerchantView.tsx            | 697 +++++++++++++++++------
 src/react-app/active-customer-orders.ts   |  13 +-
 src/react-app/cart-draft.ts               |  21 +-
 src/react-app/cart.ts                     |  30 +-
 src/react-app/customer-menu.ts            |  41 +-
 src/react-app/index.css                   |   3 +-
 src/react-app/merchant-operations.ts      |  23 +-
 src/react-app/order-attempt.ts            |  13 +-
 src/react-app/order-status.ts             |  24 +-
 src/react-app/taipei-time.ts              |  16 +
 src/shared/order-source.ts                |   2 +
 src/worker/checkout-quote.ts              |   7 +-
 src/worker/customer-orders.ts             |   4 +-
 src/worker/index.ts                       | 135 ++++-
 src/worker/merchant-availability.ts       |  14 +-
 src/worker/merchant-orders.ts             |  72 ++-
 src/worker/notifications.ts               |   4 +
 src/worker/order-adjustments.ts           |  14 +-
 src/worker/order-creation.ts              | 235 ++++----
 src/worker/order-scheduling.ts            |  50 +-
 src/worker/preparation-time-policy.ts     |   5 +-
 src/worker/store-operations.ts            |   3 +-
 src/worker/store-settings.ts              |  18 +-
 src/worker/web-push.ts                    |  14 +-
 test/active-customer-orders.dom.test.tsx  |  13 +-
 test/availability-controls.test.ts        |   4 +-
 test/cart.test.ts                         |  79 ++-
 test/checkout-quote.test.ts               |  10 +-
 test/customer-ordering.dom.test.tsx       | 748 +++++++++++++++++++++----
 test/fries-order-flow.test.ts             |  21 +-
 test/merchant-operations.dom.test.tsx     | 893 ++++++++++++++++++++++++++++--
 test/merchant-orders.test.ts              |  59 +-
 test/merchant-store-safety.dom.test.tsx   |   3 +-
 test/notifications.test.ts                |  15 +-
 test/onsite-ordering.dom.test.tsx         |  28 +-
 test/onsite-ordering.test.ts              |  18 +-
 test/order-adjustments.test.ts            |  44 +-
 test/order-atomicity.test.ts              |   3 +
 test/order-attempt.test.ts                |  10 +-
 test/order-creation.test.ts               |  77 ++-
 test/order-scheduling.test.ts             |   3 +
 test/order-status.test.ts                 |  10 +-
 test/preparation-time-policy.test.ts      |  19 +
 test/release-order-features.dom.test.tsx  |  15 +-
 wrangler.json                             |   3 +
 65 files changed, 4839 insertions(+), 1367 deletions(-)
```

## Git status --short -uall（包含本交付文件）

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
 M src/worker/merchant-availability.ts
 M src/worker/merchant-orders.ts
 M src/worker/notifications.ts
 M src/worker/order-adjustments.ts
 M src/worker/order-creation.ts
 M src/worker/order-scheduling.ts
 M src/worker/preparation-time-policy.ts
 M src/worker/store-operations.ts
 M src/worker/store-settings.ts
 M src/worker/web-push.ts
 M test/active-customer-orders.dom.test.tsx
 M test/availability-controls.test.ts
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
 M test/order-adjustments.test.ts
 M test/order-atomicity.test.ts
 M test/order-attempt.test.ts
 M test/order-creation.test.ts
 M test/order-scheduling.test.ts
 M test/order-status.test.ts
 M test/preparation-time-policy.test.ts
 M test/release-order-features.dom.test.tsx
 M wrangler.json
?? docs/CART_TOMBSTONE_REGRESSION_QA.md
?? docs/CUSTOMER_NAVIGATION_MERCHANT_VISUAL_QA.md
?? docs/DAILY_SOLD_OUT_FIX_QA.md
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
?? migrations/0020_add_sold_out_business_date.sql
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
?? src/worker/business-day.ts
?? src/worker/daily-sold-out.ts
?? src/worker/merchant-revenue.ts
?? src/worker/operational-automation.ts
?? test/admin-store.dom.test.tsx
?? test/admin-store.test.ts
?? test/business-hours-fixture.ts
?? test/cart-tombstones.dom.test.tsx
?? test/daily-sold-out.test.ts
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
?? docs/ORDER_SUBMISSION_ONSITE_FIX_QA.md
```

所有修改均維持 unstaged / uncommitted。HEAD / branch 不變。

Ready to resume Release Candidate Freeze: YES
僅代表可恢復本機 RC Freeze 準備；本輪未部署，Production Release 仍保持 BLOCKED，未執行任何正式環境變更。
