# Merchant Audio UI cleanup / release gate evidence

## 本輪範圍與根因

原本 `MerchantView` 的 `activateForegroundAudio` 只能由「啟用接單提示音」按鈕解鎖；刪除設定區而未替換手勢入口會讓前景鈴聲永遠沒有 AudioContext。

本輪只修改 MerchantView、merchant-audio、ui-copy、Merchant DOM 測試及本驗證文件：
- Merchant 根 main 的 click/touchend capture，首次正常互動同步呼叫既有控制器的 activate(false)。
- 每個 mount 僅一次嘗試；touchend 及隨後 click 不會重複，鍵盤按鈕 click 同路徑。
- 無測試音、無專用解鎖按鈕、無音訊設定區或假隱藏空容器。
- 解鎖失敗不 crash；輪詢只有 controller ready 才 startRing，不能因新單重試 resume。
- 原控制器與資產、單 timer/session、60 秒截止、新批次延長、接受成功止鈴、手動止鈴均保留。
- Web Push、Service Worker、Wake Lock、訂單自動導覽與交易程式本輪未修改。工作樹內先前已完成的相關修改保留。
- 已移除 8 個僅供設定區使用的 copy key；響鈴狀態／停止提示音／通知可及性文案保留。
- 前景音訊無手勢時可能被瀏覽器阻擋，OS/Web Push 為原有 fallback；不承諾靜音／鎖屏／背景自訂鈴聲。

## 本機驗證（2026/10/08 Asia/Taipei）

- 定向 DOM：93/93（5 檔）。初次有 4 個舊 UI 測試互動失效，未凍結／未部署；更新為正常工作臺互動後全數通過，業務斷言保留。
- 完整 npm test：Worker 345/345（32 檔）、DOM 235/235（14 檔），合計 580。
- npm run check、npm run build：PASS。
- npm run db:migrate:local：無待套用 migration。
- verify:fresh-d1：20 線性 migrations、新庫／第二次 apply／quick_check PASS。
- verify:upgrade-d1：0011–0020、尤其 0019→0020 資料保存／第二次 apply／quick_check PASS。
- verify:production-data：隔離本機腳本重複安全、ID 關係、0019→0020 invariant PASS。沒有遠端 SQL。
- git diff --check：PASS。
- build 資產：index-DyOWT31U.js / index-E_sLy8pj.css。
- 桌面本機瀏覽器 127.0.0.1:5174：移除設定區；點待接單後，使用本站 On-site UI 建立一張備註「本機 Audio QA 測試單」的薯條測試單（NT$40，不辣／胡椒）；五秒輪詢顯示新單鈴響，成功接單後止鈴並轉製作中。無 console error/warn。
- 本次只建立／接下該張本機測試單，保留資料，不刪除、恢復或重置。既有 5173 使用者程序未停止。
- screenshot 證據保存在 repository 外的 visualization 目錄，不 staging。
- 瀏覽器 UI 證據不代表實體喇叭音量；桌面實聽及 iPhone/PWA 前景鈴聲／60 秒／同批不疊音／背景 Push 仍需真機驗收。

## RC staging review

原始 121 個 dirty/untracked 檔案全部保留；本輪新增本文件，共 122 個 RC 路徑。沒有路徑刪除。
`public/sounds/new-order.wav` 是正式鈴聲資產，不是測試截圖或 build artifact。
`.dev.vars`、dist、.wrangler、本機資料庫、log、screenshots、temp 不在 RC 清單。
`.dev.vars.example` 只有本機 bypass 範例與 placeholder；正式 bypass 不可生效。
已檢查 credentials/JWT/private-key/token pattern，無 production secret value；wrangler 內 Access AUD／VAPID_PUBLIC_KEY 為既有公開識別，不是 private secret。

以下為明確 staging 清單分類（跨角色檔案只列一次）：

### customer

- `index.html`
- `public/manifest.webmanifest`
- `public/sounds/README.md`
- `public/sounds/new-order.wav`
- `src/react-app/App.css`
- `src/react-app/App.tsx`
- `src/react-app/CustomerComponents.tsx`
- `src/react-app/CustomerOrderStatus.tsx`
- `src/react-app/DestructiveConfirmationDialog.tsx`
- `src/react-app/active-customer-orders.ts`
- `src/react-app/cart-draft.ts`
- `src/react-app/cart-tombstones.ts`
- `src/react-app/cart.ts`
- `src/react-app/customer-menu.ts`
- `src/react-app/customer-navigation.ts`
- `src/react-app/customer-scroll.ts`
- `src/react-app/index.css`
- `src/react-app/order-attempt.ts`
- `src/react-app/order-status.ts`
- `src/react-app/return-navigation.ts`
- `src/react-app/spice-presentation.ts`
- `src/react-app/taipei-time.ts`
- `src/react-app/ui-copy.ts`

### merchant

- `src/react-app/MerchantComponents.tsx`
- `src/react-app/MerchantView.tsx`
- `src/react-app/merchant-audio.ts`
- `src/react-app/merchant-focus.ts`
- `src/react-app/merchant-operations.ts`
- `src/react-app/merchant-wake-lock.ts`
- `src/worker/business-day.ts`
- `src/worker/daily-sold-out.ts`
- `src/worker/merchant-availability.ts`
- `src/worker/merchant-orders.ts`
- `src/worker/merchant-revenue.ts`
- `src/worker/notifications.ts`
- `src/worker/operational-automation.ts`
- `src/worker/store-operations.ts`
- `src/worker/web-push.ts`

### admin

- `src/react-app/AdminStoreView.tsx`
- `src/react-app/AdminView.tsx`
- `src/worker/admin-store.ts`

### data

- `migrations/0017_add_operational_automation.sql`
- `migrations/0018_add_customer_store_configuration.sql`
- `migrations/0019_add_new_order_sound_setting.sql`
- `migrations/0020_add_sold_out_business_date.sql`
- `production-data/add-fries-seasoning.sql`
- `production-data/add-portion-options.sql`
- `production-data/add-spice-options.sql`
- `production-data/apply-official-menu-v0.1.1.sql`
- `production-data/initial-store-menu.sql`
- `seeds/development.sql`
- `seeds/ensure-spice-modifiers.sql`

### tooling

- `docs/CART_TOMBSTONE_REGRESSION_QA.md`
- `docs/CUSTOMER_NAVIGATION_MERCHANT_VISUAL_QA.md`
- `docs/DAILY_SOLD_OUT_FIX_QA.md`
- `docs/LOCAL_TEST_MENU_MATRIX.md`
- `docs/MENU_OPERATIONS.md`
- `docs/MERCHANT_ALERT_QA.md`
- `docs/NAVIGATION_PICKUP_QA.md`
- `docs/OFFICIAL_MENU_MAPPING.md`
- `docs/ORDER_SUBMISSION_ONSITE_FIX_QA.md`
- `docs/PRODUCT_BLUEPRINT.md`
- `docs/PROJECT_STATE.md`
- `docs/REQUIREMENTS_AUDIT.md`
- `docs/UI_COPY_REFACTOR_QA.md`
- `docs/UI_REGRESSION_QA.md`
- `package.json`
- `scripts/generate-merchant-ring.mjs`
- `scripts/verify-fresh-d1.mjs`
- `scripts/verify-migration-0013-upgrade.mjs`
- `scripts/verify-production-data.mjs`
- `scripts/verify-pwa.mjs`
- `scripts/verify-test-menu.mjs`
- `test/active-customer-orders.dom.test.tsx`
- `test/admin-store.dom.test.tsx`
- `test/admin-store.test.ts`
- `test/availability-controls.test.ts`
- `test/business-hours-fixture.ts`
- `test/cart-tombstones.dom.test.tsx`
- `test/cart.test.ts`
- `test/checkout-quote.test.ts`
- `test/customer-ordering.dom.test.tsx`
- `test/daily-sold-out.test.ts`
- `test/fries-order-flow.test.ts`
- `test/merchant-audio.dom.test.tsx`
- `test/merchant-focus.test.ts`
- `test/merchant-operations.dom.test.tsx`
- `test/merchant-orders.test.ts`
- `test/merchant-revenue.test.ts`
- `test/merchant-store-safety.dom.test.tsx`
- `test/merchant-wake-lock.dom.test.tsx`
- `test/notifications.test.ts`
- `test/onsite-ordering.dom.test.tsx`
- `test/onsite-ordering.test.ts`
- `test/operational-automation.test.ts`
- `test/order-adjustments.test.ts`
- `test/order-atomicity.test.ts`
- `test/order-attempt.test.ts`
- `test/order-creation.test.ts`
- `test/order-scheduling.test.ts`
- `test/order-status.test.ts`
- `test/pickup-scheduling.test.ts`
- `test/preparation-time-policy.test.ts`
- `test/release-order-features.dom.test.tsx`
- `test/return-navigation.dom.test.tsx`
- `test/spice-contract.test.ts`
- `test/ui-copy.dom.test.tsx`
- `test/ui-style-regressions.dom.test.tsx`

### shared

- `public/service-worker.js`
- `src/shared/business-date.ts`
- `src/shared/order-source.ts`
- `src/shared/spice.ts`
- `src/worker/checkout-quote.ts`
- `src/worker/customer-orders.ts`
- `src/worker/index.ts`
- `src/worker/order-adjustments.ts`
- `src/worker/order-creation.ts`
- `src/worker/order-scheduling.ts`
- `src/worker/preparation-time-policy.ts`
- `src/worker/store-settings.ts`
- `wrangler.json`

## 凍結後釋出限制

以上為 commit 前證據；必須以取得的 RELEASE_SHA 再跑完整測試/build/D1 verifier，才可進正式 read-only preflight。
不得以本文件的本機 PASS 取代正式 account/version/traffic/Access/secret names/D1/bookmark/invariant 檢查。
0020 只有 nullable ADD COLUMN，不 backfill；Production 若有其他未預期 migration 或任何 invariant FAIL，停止。
Candidate upload / 0-traffic override / promotion 必須同一 SHA、同一 build、同一 version。
禁止建立正式測試單或修改 Production business data。技術釋出不能自動恢復 Store 接單。
