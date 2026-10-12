# Daily sold-out Fix Cycle — local QA

DAILY SOLD-OUT FIX: PASS

Ready to restart Production Release Gate: YES（只表示可重新開始 Gate，本輪未執行 Gate，亦未授權正式部署）。

## 基準與範圍

- Branch: `fix/v0.1.1-mobile-ux`
- HEAD: `0a587028f455c97f20cc19089fc07ddb48d42acd`，保持不變。
- 開始：60 modified / 49 untracked（109 個實際檔案）；完成：64 modified / 55 untracked，全部未 staged。
- 不修改 Customer/Merchant UI、文案、ETA、Pickup、Ring、Navigation、Web Push、安全驗證及訂單建立交易；不實作 active-order cleanup。
- 開始時 109 個 dirty 檔案皆存在。SHA-256 比對：105 個完全未變；僅原先已 dirty 的三支 D1 verifier 與 Worker index 有本輪必要修改。另修改 4 個原本 clean 的售罄／缺貨程式與測試，新增 6 個 scoped 檔案。
- UI JS/CSS identifiers 與本輪前相同：`index-BP_l5KhM.js` / `index-E_sLy8pj.css`。
- 未新增 credentials 或追蹤 generated artifacts；正常 build 輸出仍在 ignored dist。未讀取／記錄 JWT、電話、Access secrets 等敏感資料。

## Current Contract 與根因

原先 `menu_items.is_available` 同時表達今日售罄及 legacy/administrative unavailable，沒有 reset ownership marker。
Merchant sold-out/restore 原先只寫 availability；訂單缺貨在既有 D1 batch 內也只寫 availability。
Admin 欄位 allowlist 不允許 availability 任意修改；archive 由 `is_archived` 表達。
Menu／Merchant 售罄畫面讀既有 Menu API，Quote 重核 availability/archive，Order 建立亦有權威 SQL availability/archive guard。
原 Scheduler 只執行 `processDueAutoRejections`，不存在每日售罄 maintenance。

既有 schedule source 是 `store_settings.weekly_business_hours`（0018），沿用 Admin 的 decode/validation，沒有另建時段資料。
本機唯讀確認：每週有效時段已存在，週一休息，其他天 17:30–23:15。這是既有資料，不是 helper 的硬編碼，也未修改此設定。
歷史日期／營收篩選既有 calendar helper 保持原契約；本輪新增的 opening-cycle helper 專用於 daily sold-out，不偷偷改變其他 domain。

## Schema 與安全升級

`0020_add_sold_out_business_date.sql` 是 0001–0019 後的下一個 linear migration，唯一 statement：

```sql
ALTER TABLE menu_items ADD COLUMN sold_out_business_date TEXT DEFAULT NULL;
```

沒有 rebuild、DROP、DELETE、backfill、額外 reset ledger。
既有 `is_available=0` 資料仍為 0、marker 為 NULL；不得推測它是今日售罄，也不得自動恢復。
Archive rows、menu prices、history/order snapshots 不變。

## Business Day 與寫入契約

`getOpeningBusinessDay(now, schedule)` 是 pure helper，可注入 now，不讀 DB、不 mutation。
Asia/Taipei 使用現行固定 UTC+8（無 DST），從本地當天向前最多七天，選最新一個 `isOpen=true` 且 opening <= now 的 cycle date。
包含往前第七天以支援一週只開一天、今天尚未開店的情況。
關店不終止 cycle；00:00、凌晨、開店前維持上一個有效 cycle。
休息日沒有新 cycle，直到下次真實 opening 才切換。跨午夜 close 亦不造成午夜 reset。
closeAt/lastOrderTime 不冒充 opening；不新增 holiday engine。

Merchant sold-out：backend 讀 schedule，計算 current opening-cycle day；同一 SQL 原子寫 `is_available=0` 與 marker。
Client 的 businessDate 不被信任；測試送假日期仍使用 backend day。
Shortage：保留既有 batch/CAS/replay，marker 與 availability 同一 guarded SQL 寫入；若 paired write 失敗整個 batch rollback。
Shortage replay 在下一營業日 reset 後只回既有結果，不再次停售。
Manual restore：同一 SQL 寫 `is_available=1, sold_out_business_date=NULL`；缺少 schedule 時仍可 restore。
NULL、無效、全休息或不存在的 schedule：maintenance skipped，不猜時間；新 Merchant sold-out/shortage 在任何 mutation 前以 409 `BUSINESS_SCHEDULE_UNAVAILABLE` 明確拒絕。

## Reset / 冪等 / Race

```sql
UPDATE menu_items SET is_available = 1, sold_out_business_date = NULL
WHERE is_available = 0 AND is_archived = 0
  AND sold_out_business_date IS NOT NULL
  AND sold_out_business_date < ?;
```

使用嚴格「早於」而非單純不同：除保護 current-day marker，也保護 delayed old-day tick 遇到 newer-day Merchant marker。
WHERE 在 DB UPDATE 執行時檢查，不是 read-then-overwrite。
Reset-first、Merchant-first、並行兩者皆測試：最後保持 current-day sold-out。
第一次 reset 清 marker，重跑 0 additional changes；available/NULL/archived/current/future marker 均不被誤恢復。

Scheduler 沿用既有每分鐘 tick（沒有改 wrangler cron）。
`scheduled` 以兩個獨立 waitUntil 執行原 auto-rejection 與新 sold-out maintenance。
故障注入測試 actual entrypoint：任何一項 SQL failure 都不阻擋另一項；不綁成大 domain function、不新增前日訂單 cleanup。

## Refresh 與 Checkout

Reset 真正更新 D1 的同一 availability 欄位。Merchant 既有五秒 polling 重新 fetch Menu，Customer 既有 menu fetch/reload 取得最新權威資料；沒有 client reset array 或 localStorage reset state。
已開啟的 Customer 頁面須依既有 fetch/reload 更新顯示；本輪沒有新增背景 polling。
Quote 與 Order 還是權威重驗 availability/price/archive。測試證明 reset 前 Quote 拒絕、reset 後正常 Quote/Menu/Order 成立且使用 D1 price。
沒有修改已成立訂單快照。

## 本輪修改檔案（僅本 Fix）

- `migrations/0020_add_sold_out_business_date.sql`
- `src/worker/business-day.ts`
- `src/worker/daily-sold-out.ts`
- `src/worker/merchant-availability.ts`
- `src/worker/order-adjustments.ts`
- `src/worker/index.ts`
- `test/business-hours-fixture.ts`
- `test/daily-sold-out.test.ts`
- `test/availability-controls.test.ts`
- `test/order-adjustments.test.ts`
- `scripts/verify-fresh-d1.mjs`
- `scripts/verify-migration-0013-upgrade.mjs`
- `scripts/verify-production-data.mjs`
- `docs/DAILY_SOLD_OUT_FIX_QA.md`

## Tests 與實際命令結果

- 受影響 Worker：`npm.cmd run test:worker -- test/daily-sold-out.test.ts test/order-adjustments.test.ts test/availability-controls.test.ts test/operational-automation.test.ts test/security-foundation.test.ts` — 101 PASS / 5 files。
- 新增 daily-sold-out：28 tests；shortage 增加 2 tests，另擴充既有 marker/rollback assertions。共增加 30，原 suite 沒有減少。
- 完整 `npm.cmd test` — Worker **341 PASS / 32 files**；DOM **231 PASS / 14 files**；總計 **572 PASS**（baseline 542）。
- `npm.cmd run check` — PASS（lint、TypeScript、PWA verifier、build）。
- `npm.cmd run build` — PASS。
- `npm.cmd run verify:fresh-d1` — PASS：20 sequential migrations、nullable TEXT DEFAULT NULL、ADD COLUMN only、無 marker backfill、second apply、quick_check。
- `npm.cmd run verify:upgrade-d1` — PASS：原 pre-0011 path 保留；另真正執行 0019→0020，舊 unavailable／archived rows、價格、快照與 table counts 不變；second apply、quick_check。
- `npm.cmd run verify:production-data` — PASS：獨立 local temp DB，approved production-like fixtures 先套到 0019，才升級 0020；完整 menu/count/price/category/availability/archive/history/Store baseline 不變、markers 全 NULL、second apply、quick_check。
- `npm.cmd run db:migrate:local` — PASS：只有 0020 pending 並已本機 apply。
- `git diff --check` — PASS。
- 首次 targeted run 有兩筆新測試 fixture 缺少既有必填 public token；修正 fixture 後 PASS。首次 check 有新增測試 callback implicit-any；加上明確型別後完整 check PASS。未削弱既有測試或 DB constraints。

本機 persistent D1 before/after 0020：items 46、SUM(price) 2315、SUM(is_available) 46、archived 1、orders 34；after marker count 0，quick_check=ok。未建立 persistent D1 測試訂單；新測試在 isolated test DB 執行。

## 手機待驗收 / Release 注意事項

- 在測試環境讓 Merchant 售罄後，跨 midnight／休息日不得恢復；下一次有效 opening + 既有 tick 後 fetch 顯示可售。
- 同一時間 Merchant 再售罄新營業日商品，輪詢後仍停售；手動 restore 顯示可售。
- 重新取得 Customer Menu 後可售、Quote 正常；不要將 local unit/DOM PASS 宣稱 production cron 或真機 PASS。
- 新欄位未套用到 Production，Production schedule 也未在本輪遠端讀取。後續 Release Gate 應核對有效營業設定並按正式授權做 migration/部署。
- 沒有 pending/preparing previous-day cleanup；它仍是另一个未授權 contract。
- 本輪沒有 commit、stage、push、deploy、versions upload、remote D1 SQL、Access/secrets/traffic/Store mutation。Production mutation = NONE。

## 開始時 File Manifest（SHA-256）

保存開始 109 個 dirty 檔案。除三支 verifier 與 Worker index，其餘 105 個 hashes 在結束檢查完全相同，零遺失。

```text
eda9397d4d940837068d13a67595fafa5113df29af5519855dee07b74c84eeda  docs/CART_TOMBSTONE_REGRESSION_QA.md
32f0d6f42563fb5322b8cb865c58d6ce9826aa01af40d56892e803d7730c873d  docs/CUSTOMER_NAVIGATION_MERCHANT_VISUAL_QA.md
7ca4c17b4f551c393ffa62ba1e453256e1de0c72d18b39a2219d03e289b75b3f  docs/LOCAL_TEST_MENU_MATRIX.md
e3e7cf704a5d4ee57b9f6ac13b0bd00f53a2b617f1f44eece8828bbbd15e0846  docs/MENU_OPERATIONS.md
dd55151556bd176fb6a2010fa5896674df08645caa7a45cfd8e5ffd49dcecc19  docs/MERCHANT_ALERT_QA.md
4be96a1816d43f48821c8dff0bdc02db1bc8c01997fdb80948f483b5f6867f3e  docs/NAVIGATION_PICKUP_QA.md
ff950fbe782083385a30eb2375bb97caea8f69e954c701607191e5523c672f93  docs/OFFICIAL_MENU_MAPPING.md
7b65b6e495364d855dd9e263b828186d916510e0153ce65439f6060f2cbc8a00  docs/PRODUCT_BLUEPRINT.md
ca482871ed1aaa836a940b800cc730becfd1bd16b94d158beb38fcf36ca41f1d  docs/REQUIREMENTS_AUDIT.md
c8749f6fe239974f27e567fc0d9d2a1cee9d56f1cafa0c873832174dbb8af085  docs/UI_COPY_REFACTOR_QA.md
163de546b6a95a419e9128cbc43b8f2c9771ecaffb7cc06b711935670a91abb4  docs/UI_REGRESSION_QA.md
7fa02f1befa6c1b2eb008c18887e8a1c736b5b6e30da548f922b770e450aede5  migrations/0017_add_operational_automation.sql
3eb4954297a313b95a624fae439568eaf0cf3e5c3bc31e9204379ad109a95a2b  migrations/0018_add_customer_store_configuration.sql
b30459bbf2da667fbc32525e377506a5e14f73891e5fedf940dfb940cae12f21  migrations/0019_add_new_order_sound_setting.sql
a42bf7e6cfa049344c2e48b0f59fb5cc87d12f779adbbb5fc7cca2bf0e69daba  production-data/apply-official-menu-v0.1.1.sql
60a33cb8a2f4dd199f1cdf890e9f8c131490314463737bc02d4ba8e53f521162  public/sounds/README.md
78f7f537e95181531d0e0a677a379d70f99a9de551e85cf3ae3faa68c2b4e8bc  public/sounds/new-order.wav
c1dee50260100b12456fd2679dd99a24196b171e208facfd16f38ce3f123f163  scripts/generate-merchant-ring.mjs
c61835c09ccb84237cc4d533dc12b6dc61db593032379ff4b63c90c3209dc3bb  scripts/verify-test-menu.mjs
aa3abc3ec83578076505c80e357e50762e8935de43e23174fc45460dc8478269  seeds/ensure-spice-modifiers.sql
12ef93ff3b5035221be0fc355b2cad7cd1ca433e72aebf4238cc88e858319f44  src/react-app/AdminStoreView.tsx
26234720b8a04dec52e0af7351c7368ec12289837224b446f9db0d0ddbf18063  src/react-app/DestructiveConfirmationDialog.tsx
c40b772b2790132cc67f1098b706da67377dcfb49dc5425221c03cbe0b6ace1d  src/react-app/cart-tombstones.ts
f5fff6c507619ec7b4fcfd45b3e4faaba5daf60345f38b8e4b9366325e7c25fd  src/react-app/customer-navigation.ts
051c5caf0dc186af5a5d6dfe1f34919e9eab5fba2c4403c37519f039201aaffb  src/react-app/customer-scroll.ts
68e1cd47cb6d738e063465d52d288efb4ca0bed3b170243478668e9ae10c01e7  src/react-app/merchant-audio.ts
1dd871cac74e458321d5fa6f22101e065498afabf459af6eff1a7f6c36dceac5  src/react-app/merchant-focus.ts
83e63a4fe15deb93583f2bc2f84e0c5f82ff6a8094889fcf30524752f1a08d71  src/react-app/merchant-wake-lock.ts
6bd33c51eef7f08bc5b6cb3711f9c68cf73ea80f69d8aed5ac5ebefb6683ef32  src/react-app/return-navigation.ts
10ba750793cbfa790f7835a0d0ebd6748c3189c7f35877fe9c1f99d0be10bc62  src/react-app/spice-presentation.ts
b3f74c223b4f2eab720fbfe9568376f77826e3773fd2c15c10489e7536b17ca2  src/react-app/ui-copy.ts
700b883ea9cdc2f21e2d5daa26d73e391976a33ebd47fa41b8378c23d1743c67  src/shared/business-date.ts
7d0f34909e9bb8505741a08c62b4e72e061e8848813134bf4474d2f75c862dd2  src/shared/spice.ts
ee525e64108caa3d45f914d826b46015b4db9ec6193a3a43c485cc28533934ea  src/worker/admin-store.ts
6227b08d74d8c77c9c5b190a8b7f4355493f29b9e4a484d76a049c4e038e7f3e  src/worker/merchant-revenue.ts
cdcd204e0c4d4763494636ab4fd7b0b4d54178b06f7808fb812ab89ef1c3c850  src/worker/operational-automation.ts
9e405062be2cb09025a4ae9ba3486d20cc36245d9c2000871a03158f96adf1dd  test/admin-store.dom.test.tsx
96b451deca495c9a1c1680d94e2254c1e988b3bac3c9ecf4cb5173a27936d46c  test/admin-store.test.ts
c1d5a37a807828b2b776327e325ea6f3f309bfe1eff10141d323dbbd7af41a60  test/cart-tombstones.dom.test.tsx
243609ce976484fc317e697308e91505a05fa79b299ceb7f2e684720d31532c9  test/merchant-audio.dom.test.tsx
1df9682a74398a66d15033e2d6da2d499c032663fe79291eba35a2774513197f  test/merchant-focus.test.ts
64c9d03197c26490c96c5282c7bccf40a1720ee1bfbcb12e750663e158f5d26d  test/merchant-revenue.test.ts
1e17a17370b20f14eed36fde94db817f69e47a614ab3a040d7db8e6a311c0dbe  test/merchant-wake-lock.dom.test.tsx
a4b306ef6b49c6d62309ac0217711b5b2de5eb4d876e618247c4589fe4895ee4  test/operational-automation.test.ts
f0ec06e58d0ee274c8fc0b1ae5c97ffef60ab70ef2862043e8103e0a9523cca5  test/pickup-scheduling.test.ts
b6605287315ae21bfd93e1cbb4180a08e17c745672a277edfe308e7da6a01b5c  test/return-navigation.dom.test.tsx
5261d096063af9bfe43c122bb59e957593d00370300dfda76cfff1efb93cac15  test/spice-contract.test.ts
904b7fff85538f0bf709c8e1161a12518138cbe59a90e03cc2125e95582c8c16  test/ui-copy.dom.test.tsx
618be7958f256b9abae426b53dee5e050f138f2153e1416af7afe5bd10d063c3  test/ui-style-regressions.dom.test.tsx
2fd53456e28b4bdd8febefd91ac0d0b1ab4bf5d2099ffb2534c7235d8bd7a715  docs/PROJECT_STATE.md
c8b28a910dc1a3f5cb54cf40794dbe81f0a8707675d0b1b1ce99a9834eb81fcb  index.html
b3b040c72df5051a990ed58e72f79b9efac3be6cf00631f8fe474310b9cf6602  package.json
cbd777cf7b65ad29839fd98f4cafbf682c8c9e86a6bb908e49b3ccbf1024c1d1  production-data/add-fries-seasoning.sql
43527a4a498970a9b9f2356b49430720c6b1ac15241931fc4bb0fbf12deddc52  production-data/add-portion-options.sql
a1ff62f40e47a35a8d02221d75f7830e49c1aa0120604bd541daf3ed4b2d1681  production-data/add-spice-options.sql
b44568494965e91b5cb8f811e2ec4e97150f5ce4d9f9da427e965006a4bcfb06  production-data/initial-store-menu.sql
959dc6333c8cbdd51511739e06d9246fcaf5e0a9b5dac2747fee7074fcf2ee7f  public/manifest.webmanifest
b4f76e0f3f19eebc9725b1df4b9bf50a56412f1f756e552ebcfbb427f7ad1a2a  public/service-worker.js
d98a3b81868e9c988276df71fd0db4d6b7f19c9d71194cfcc0876b203fc08feb  scripts/verify-fresh-d1.mjs
6e734c2a017c75495709522f1422dc0552e74b11bc35d32ca47e0f2fbb116008  scripts/verify-migration-0013-upgrade.mjs
6606606384b19ea4e5a38761fc1268185f51c14d170c65d9d776475889002e68  scripts/verify-production-data.mjs
6d087ea4565a7dbc6a226b9eb77b382b3a8f39554fb16b0ea858f6db7c62bb4a  scripts/verify-pwa.mjs
df0db923ee60d99b04c6b8223e633c188724c3748325cfcf866faaa08e597343  seeds/development.sql
b324767ee10ee281f4f674cf900a409221b70448a05004a15d3d4a9804e35665  src/react-app/AdminView.tsx
fcdc62776cf25e94cc015dacfa2d00505ae4c74beca78a45deb63e901a037182  src/react-app/App.css
291a4fb41823b000e692ef0d4804dd6f62532c51479eea135fa7679c86a0f800  src/react-app/App.tsx
23ace65470807f53accf4d3e2208a6c6af3e58325d45f1a436ea7beffec08dad  src/react-app/CustomerComponents.tsx
26733626eed632e05767e67348902c57ca6bf5b6c5162762b50540a5f17dde99  src/react-app/CustomerOrderStatus.tsx
d3c7db00aebe94e65b70ad20e3aad5b2d45bc73298c71795fed5ec9e22ce149f  src/react-app/MerchantComponents.tsx
7efb84a20dd1ce8b7616f35be117a0e362561053c56b8e22d56b7847c7a3a14e  src/react-app/MerchantView.tsx
ff0de365528e483edc90f28c980d90fa1083e810785eae29be7d0960b49428ab  src/react-app/active-customer-orders.ts
d89c05020a3151ed952b76e9d8a94f1974d0b9f7408ec19de44952fa51e3f31f  src/react-app/cart-draft.ts
9e853c77ac4c3599191a19179526355038634f38950dbdf42f45f703f8c3629d  src/react-app/cart.ts
b922ef4628cc23d7bbaae73e14e9a0dea8b4861d73bbbed1e23c317f5413edd3  src/react-app/customer-menu.ts
75c4257041b557ac73170a611d0802ece5af3430c9221c46cd116a9e9dce0366  src/react-app/index.css
1841c6d76627b4fb03f010c8f6125698fb6dcde69ee8564d3bb4de8542255ddb  src/react-app/merchant-operations.ts
59410a66527f693715e772259c23bfabc852c9f5d1dbcf4d6538c03cbba0bab5  src/react-app/order-attempt.ts
2763432ebcd965fe9101fdf200bfe2ce1421e8c79ae939282e24507c24dd3530  src/react-app/order-status.ts
4aa15ae84fee08b7189a554afe7d8bad59297b0be2a09838c8984d921eef901f  src/react-app/taipei-time.ts
75f1af5479f863ae1d5e57a526c0bdf516e1a026bea01970a828829bea6b5579  src/shared/order-source.ts
69745d256adc8dafddff1a1c13b724b3c9320b037713ea7208d8fbddf2020863  src/worker/checkout-quote.ts
bc9362674eba012f651aa045c5bb55c15bca01f5aeed17c5d7b29f97d1ba06df  src/worker/customer-orders.ts
dbd20d5bd972e9943e9e23dbd8def444a507e9b57cbea959c89da97668291c25  src/worker/index.ts
6876cddc25718ddaeeeec80906d456dfa0f05584de1e1c0d24d1eb48d572153e  src/worker/merchant-orders.ts
e3b39d688cc044676a0f2c7fc294b901d4b8166d6406ee660cadb8c571c0b5a0  src/worker/notifications.ts
b80f4691ac4ebba9e6d3125482ae4fdfb778b32dd79908cc4927d338e30604a5  src/worker/order-creation.ts
2c0708494d2697b38f4d4048f694138f22916cab499e3093960e939628d8af20  src/worker/order-scheduling.ts
ed35272e9a3806f44c8c744497d89acbab7f5c9fe19c44ecd2918e2392fd0782  src/worker/preparation-time-policy.ts
324ee1e418fd0a0d6b76a2c6d9e04f51ef4cf4eac0802b5253a13015f5abee20  src/worker/store-operations.ts
bbdb5d013ecb2f3e2317269fc1e96385b7e088a9bbf360f380d81b080295fcc8  src/worker/store-settings.ts
f122ac439dd05f57e0ed7ba482640f927b6111d20d72167032dec31b119deb27  src/worker/web-push.ts
253752a9e526ac3575b38c3f6f8c5ae48c60767be6a6c780219fd304188d9984  test/active-customer-orders.dom.test.tsx
f5d85a23d7daaefc3b51eff6995eef79b73a2f1c7f67834c44163248d4dae21f  test/cart.test.ts
14ffd4ceab6f9e474d3bab299c066b30e33890e1bb50e0daa42b6884a02f7c46  test/checkout-quote.test.ts
74b78dc8f61d529c88d6137b35acf3336fe4f8528fab5d7a26f36442e2a7d4ff  test/customer-ordering.dom.test.tsx
b66f674702e7bdb0ed88d62fe4d66315e5f666bab0e091d16e56e3af21d3b430  test/fries-order-flow.test.ts
4001350c922b68b7ab751cd4bfe3dc94bb2fe2cb0f9afc7660f3d334f022f150  test/merchant-operations.dom.test.tsx
68f6af42d927ed095b2bfa1ed47cd0356b2cdbf8314841c36c6c2edf06679bfb  test/merchant-orders.test.ts
ee0e873451d2b1535160b0b32bd3b58cdacd7bea089ec8b94b84ac69ec21f70b  test/merchant-store-safety.dom.test.tsx
17fc3bcbf8ac3a2f0c121349b4bd60ba382d212a12696d98575a84acf46a9b61  test/notifications.test.ts
3391482fefef70c580f458b5e2aa70c1be24ad35819d0800b95b15d1e73ca412  test/onsite-ordering.dom.test.tsx
7ecdd7eac10e4ba5d3fb25e2da8172e9910012df188689e3dc06f53698de4920  test/onsite-ordering.test.ts
47f547dfdb0d746b2a2a5299bb5d99624b9a53c7708cea165f6fcf48b9455dd8  test/order-attempt.test.ts
90292ec06f2491a91f0328fd1c3e976c9dea5882928dc715c3843eaa07b906fd  test/order-creation.test.ts
2b36c81cf3a4caa3f74716c658f16685e021c419c780b86987b68fddfdaf6498  test/order-scheduling.test.ts
569d5e35777f2b7c3753de25b13ff72bde5372e67df58fd615c3d0db6be953dd  test/order-status.test.ts
c3e111f1c6f80491e94fa89888dbe95c6ad3783657304808ca3a6ec801dc6db3  test/preparation-time-policy.test.ts
cf66f2344456cb1f60303301280019d271e98b2c6c2bca38087afa9b340f76aa  test/release-order-features.dom.test.tsx
b1ec9bf047b6161c66abef668a96957747271cba80a963f7a6983ed1e6398257  wrangler.json
```

## git diff --stat（整個 Candidate，包含先前修改，不包含 untracked）

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
 src/worker/index.ts                       | 135 ++++-
 src/worker/merchant-availability.ts       |  14 +-
 src/worker/merchant-orders.ts             |  68 ++-
 src/worker/notifications.ts               |   4 +
 src/worker/order-adjustments.ts           |   6 +-
 src/worker/order-creation.ts              | 120 ++--
 src/worker/order-scheduling.ts            |  50 +-
 src/worker/preparation-time-policy.ts     |   5 +-
 src/worker/store-operations.ts            |   3 +-
 src/worker/store-settings.ts              |  18 +-
 src/worker/web-push.ts                    |  14 +-
 test/active-customer-orders.dom.test.tsx  |  13 +-
 test/availability-controls.test.ts        |   4 +-
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
 test/order-adjustments.test.ts            |  30 +-
 test/order-attempt.test.ts                |   6 +-
 test/order-creation.test.ts               |  48 +-
 test/order-scheduling.test.ts             |   3 +
 test/order-status.test.ts                 |  10 +-
 test/preparation-time-policy.test.ts      |  19 +
 test/release-order-features.dom.test.tsx  |  15 +-
 wrangler.json                             |   3 +
 64 files changed, 4694 insertions(+), 1285 deletions(-)
```

## git status --short -uall（整個 Candidate）

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
```
