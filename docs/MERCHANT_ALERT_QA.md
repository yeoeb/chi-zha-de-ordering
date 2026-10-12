# Merchant 新單提醒：本機驗證與 iPhone 驗收

本文件僅記錄本機修復與驗收方式，不授權部署、遠端遷移、正式測試訂單或正式 Push 訂閱。

最新契約見 [Merchant Audio UI cleanup](MERCHANT_AUDIO_RELEASE_QA.md)：專用啟用／測試音設定區已移除，以第一次正常工作臺互動解鎖。本文保留既往驗證紀錄；舊啟用按鈕、聲音狀態提示及測試音操作不再適用。電話鈴／Wake Lock／事件導覽契約仍保留。

## 根因與分工

- `origin/main` 的舊實作在輪詢發現訂單時建立 AudioContext，非使用者手勢下可能遭 autoplay 阻擋，且錯誤被忽略。
- 本輪開始時的本機 HEAD／工作樹已沒有音訊呼叫，只有新訂單視覺標記。
- 原本通知控制項整區隱藏，使用者無法從工作台啟用 Push；本輪顯示訂閱控制，配送紀錄仍維持低頻／隱藏設計。
- 前景：五秒輪詢為權威來源；使用者點擊解鎖一個 session AudioContext；每批真正新 pending 訂單啟動／延長一個重複鈴聲 session（詳見下方 60 秒 delta）。
- 背景／鎖屏：既有 after-commit Web Push 與 OS 通知；不承諾背景網頁音訊或繞過靜音。

## 前次短音本機瀏覽器證據（2026/10/06，Asia/Taipei，歷史紀錄）

使用 `http://127.0.0.1:5173/merchant`，透過真實 UI 操作，不在頁面注入音訊 mock。

| 步驟 | 音訊狀態 | 成功排程新單提醒累計 |
| --- | --- | --- |
| 重新載入，有一筆既存 pending | needs-activation | 0 |
| 點擊啟用接單提示音 | ready（驗證 AudioContext.running） | 0 |
| 點擊測試提示音 | ready | 0 |
| Customer UI 成功建立本機新單 1，Merchant 輪詢發現 | ready | 1 |
| 後续輪詢相同訂單 | ready | 1 |
| Customer UI 成功建立本機新單 2，Merchant 輪詢發現 | ready | 2 |
| 後續輪詢相同訂單 | ready | 2 |

啟用／測試成功排程累計為 2；新單提醒與測試音分開計數。音訊使用 740Hz／988Hz 雙音，約 0.64 秒，不使用外部音檔。

上述證明瀏覽器 running 與音訊排程次數，不能證明實體喇叭音量或耳朵實際聽到。兩筆訂單僅在本機 D1 建立，沒有送出個資。

## iPhone 真機：尚待驗收

請使用已另行授權的 HTTPS 測試環境；本輪不在正式環境執行以下寫入步驟。

1. iOS/iPadOS 16.4 以上：Safari 開啟測試網址，加入主畫面，關閉 Safari 分頁，再從主畫面圖示開啟 Merchant。
2. 確認初始既存訂單不響；點擊「啟用接單提示音」，實際聽見測試音；再點「測試提示音」。記錄裝置／OS／靜音／音量與實聽結果。
3. 由另一裝置建立一筆測試訂單，確認前景重複響鈴；等待下一輪，確認相同訂單不重新啟動／延長期限。按「停止提示音」立即停止；再建立第二筆，確認可再次響鈴。同時兩張新單應只有一個 session；響鈴中新單延至最新發現後 60 秒。
4. 重載後重新啟用；確認既存訂單不響，再驗證下一筆新單。切到背景再返回，確認恢復或出現可重啟控制，而非錯誤顯示已啟用。
5. 獨立點擊「開啟通知」；確認系統 permission prompt。允許後須有實際 PushSubscription 並成功存入伺服器，UI 才能顯示已開啟；只允許權限不足以通過。
6. 背景／鎖屏後建立測試訂單，記錄 OS 通知是否送達。點擊通知應固定開啟 `/merchant`。
7. 到「設定 > 通知」實際確認 Web App 是否出現；記錄結果，不由前景提示音推論 Push 成功。
8. 測試拒絕權限、訂閱儲存失敗與停用通知；確認錯誤可見，停用先移除伺服器訂閱，再取消裝置訂閱。

WebKit 官方平台說明：https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/

## 安全與資料契約

- `0019_add_new_order_sound_setting.sql` 僅新增 `store_settings.new_order_sound_enabled`（0/1，預設 1）。本輪只套用本機。
- Admin 設定控制是否發聲，Merchant 手勢控制該裝置 session 是否已解鎖；不保存永久 audio-unlocked 旗標。
- 音訊錯誤／恢復逾時會顯示重新啟用，不阻塞輪詢或訂單操作。
- 未改動 Merchant／Admin 授權、Origin guard、Store CAS、Order idempotency、權威價格與 Push after-commit 契約。
- 本機 Vite 不註冊正式 Service Worker，故其 Push unsupported 診斷不代表正式 iPhone Push 驗收結果。

部署、遠端 D1、正式 Push 訂閱、正式測試訂單、Store 恢復、Access、Secrets、Traffic、commit、push：均未執行。

## 60 秒重複鈴聲 delta（2026/10/07，Asia/Taipei）

根因是既有 `playAlert()` 僅排程一次約 0.64 秒雙音；新單偵測與 session AudioContext 解鎖已存在，不需重新設計。

- 保留短音作為啟用／測試音。只有 `findNewPendingOrderIds` 發現真正新 pending 批次才呼叫 `startRing(ids)`。
- 持續使用同一個已解鎖 AudioContext。約 0.8 秒雙音、停 0.4 秒、0.8 秒雙音、停 1 秒的 cadence，只有一個鈴聲 timeout，不為每張單建立 timer/context。
- 新批次到達時合併需注意的訂單 ID，期限重設為最新批次發現後 60 秒；不另起脈衝／並行 session。同單後續 polling 不呼叫 startRing，也不延長期限。
- 已確認處理成功或權威 GET 顯示 alerted pending 均離開待接單時停止；同批仍有未處理新單則繼續。403／失敗操作不能假裝處理成功而消音。
- 「🔕 停止提示音」清理當次 timer／oscillator／gain，保留解鎖及未來提醒、Web Push。此按鈕在歷史／營業額等 Merchant 次頁仍可用。
- 最晚期限自動停止、頁面隱藏或 Merchant unmount 均停止並清理。音節自然結束也會 disconnect；離開時關閉 session context，pending resume 的逾時等待也取消。
- 背景／鎖屏交給原有 Web Push／OS 通知；不保證背景 60 秒響鈴，不繞過靜音／Focus／音量。

本輪修改檔案：`src/react-app/merchant-audio.ts`、`src/react-app/MerchantView.tsx`、`test/merchant-audio.dom.test.tsx`（新增）、`test/merchant-operations.dom.test.tsx`、本文件。無 Worker/API/D1 schema 變更。

自動驗證：

- 受影響 audio／Merchant／Store safety DOM：69 項通過。
- 完整 `npm test`：Worker 302 項／30 檔，DOM 183 項／10 檔通過；包含既有 Web Push 回歸。
- `npm run check`：ESLint、TypeScript、PWA、build 通過。
- `npm run db:migrate:local`：無待套用 migration。
- 新增 8 個音訊控制器與 4 個 Merchant 整合測試，涵蓋 cadence、精確 60 秒、期限延長、單 timer/context、手動停止及再觸發、同批逐一處理、接受失敗不消音、輪詢權威移除、自然結束 disconnect、unmount／延遲 resume 不復活。

本輪實際本機桌面瀏覽器：使用真實解鎖 UI、真實 Customer Quote/Create API（localhost、無電話個資）建立兩張測試單。初始既存單不響；新單 1 `ready / ringing=true / batch=1`；手動停止 `ready / ringing=false`；新單 2 `ringing=true / batch=2`。同單後續輪詢不增加 batch。測試單只存在本機並保留，沒有刪除／重置資料。

第二個 session 未按停止，到期後實際頁面回到 `ready / ringing=false / batch=2`，停止按鈕消失；相同 pending 訂單仍在，不會因輪詢重新觸發。精確 60,000ms 由 fake-timer 測試驗證；桌面檢查是實際到期狀態，不宣稱人工碼錶實聽。

工具能核對 running 狀態、UI、音訊排程單元測試，但無法聽見實體喇叭；桌面實聽及 iPhone 前景 PWA 重複鈴聲／停止／再觸發仍需人工驗收，不標記 iPhone 或背景響鈴 PASS。

## 電話鈴／Wake Lock／事件導覽整合（2026/10/07，Asia/Taipei）

### 根因與修正範圍

- 舊前景鈴聲仍是短雙音，不是餐飲接單電話鈴；沒有 Wake Lock。
- 接單成功只更新訂單與快捷入口，仍留在待接單；新單在製作中仍有訂單時不會拉回待接單。
- 舊空頁籤 effect 只處理製作中清空，沒有 T-10 一次性事件，容易把計數變化與使用者焦點混在一起。
- 舊輪詢只有取消 effect 的保護，未完整阻止 mutation 前發出的 GET 晚回來覆蓋已確認結果。
- notificationclick 只 focus 已開視窗，沒有要求該視窗同步最新資料。

此次只修改 Merchant presentation／device controller、通知點擊整合與本機測試。未修改 Worker 訂單狀態機、Customer、API 授權、Store safety、D1 schema 或 production-data。

### 鈴聲與 Wake Lock

- 本專案原創 `public/sounds/new-order.wav`，2.4 秒 440/480Hz 電話鈴；短停 0.6 秒後重播。來源／CC0 說明在 `public/sounds/README.md`，可用產生腳本重建，無第三方音訊網址。
- 使用既有單一手勢解鎖 AudioContext；同來源 WAV 解碼一次。失敗／兩秒逾時回退本機合成音，不阻塞接單。
- 同批多單只有一個 session／cadence timer；不同新批次延至最新發現後最多 60 秒。同一 pending 的後續 poll 不延長。
- 接單經 API 或後續權威讀取確認成功，立即停止整個鈴聲，即使同批另有 pending。拒單成功只移除該單，直到所有 alerted pending 已處理才停止。
- 手動停止不關閉 AudioContext、不影響下一批提醒或 Web Push。hidden／unmount 停止；音源自然結束亦 disconnect。
- Screen Wake Lock feature detection；前景 best-effort request，hidden／unmount release，visible 再申請。失敗不影響訂單。晚到的 lock 在卸載後立即 release。
- 鎖屏／背景依原有 Web Push 與 iOS 通知行為，不保證自訂鈴聲 60 秒持續播放，也不保證 OS 一定允許 Wake Lock。

### UI 焦點事件（與業務狀態完全分離）

1. 真正新 pending → 待接單；即使在製作中／售罄亦然。初始載入既存 pending 不當成新提醒；scheduled／accepted 不當 pending。
2. 接單確認成功 → 製作中。403／409／422／500／網路錯誤不假裝成功；未知結果保留既有權威查詢，只有查回 expected status 才可視為確認成功。
3. accepted 首次跨入 T-10 → 製作中。同 ID＋當前 deadline 只觸發一次；初始 snapshot 已近截止者 seed 不重播歷史事件。合法 deadline 改動重新 arm；terminal／移出 active 的追蹤被回收。
4. 同一更新周期：新 pending 優先於 T-10；T-10 優先於空頁籤 fallback。被高優先序事件遮蔽的 T-10 不在下一 poll 重播。
5. 空頁籤：pending=0、accepted>0 → 製作中；accepted=0 → 待接單（含兩者0）；兩者皆非0不按 count 切換。售罄／歷史／營業額／確認中不參與 fallback。
6. visibilitychange／pageshow 只刷新 GET，不 accept；Push 點擊對既有 Merchant client 發送固定同步訊息，切回 `/merchant` 並取最新 active orders，不使用 payload 舊快照。

五秒 poll 保持不變。共用 request sequence＋order epoch＋abort guard 阻止舊 GET 覆蓋新資料；mutation／恢復查詢期間 poll 不搶寫。焦點讀 current ref，穩定 callback 不因 tab 變化重建輪詢。已觀察 IDs 的記憶以1000為清理門檻，保留仍 pending 的 IDs；deadline 追蹤只保留當前 accepted。

### 新增／更新測試

- 音訊：一次下載／解碼、buffer 播放與停止 disconnect、下載失敗回退、單 session／timer、同批多單、延長、精確60秒、手動停止、晚 resume、卸載。
- 焦點：11→9分鐘只一次、9→8→7不重複、合法改 ETA 再 arm、優先序、三種空頁籤、售罄不 fallback、scheduled 不觸發。
- Merchant DOM：接單成功立即製作中且整批停鈴、拒單逐筆處理、403／409／422／500／網路錯誤不假切頁、新單打斷製作中一次、T-10 打斷售罄一次、通知點擊／resume只有GET、延遲 GET 不逆轉接單。
- Wake Lock：前景去重、隱藏釋放／返回重取、不支援與拒絕可容錯、卸載後晚回應不復活。
- PWA verifier 保留 API cache bypass／固定同來源路徑／通知清理，增加既有 client 必須收到同步訊息。
- Store safety 的拒單 mock 補上實際 API 已提供的完整 order snapshot／ID；不刪除、不放鬆 Store DOM／CAS／恢復斷言。

### 手機待驗收（本輪未以 DOM PASS 代替真機結果）

1. 已授權 HTTPS 測試環境，iPhone 主畫面 PWA、375／390／430px：啟用／測試電話鈴，確認實際音量、不過度刺耳。
2. 已有製作中訂單，另一裝置建立新單：切待接單、單 session 重複鈴；同單多次輪詢不反覆跳頁。手動改回製作中仍可保留。
3. 同批兩張新單：接一張成功立即停全部鈴並切製作中；拒一張則剩另一張仍響，最後拒單才停。403／離線不得假成功。
4. 等60秒自動停止；第30秒再有真正新單，只延到最新批次後60秒，不能疊音；手動停止後的新批次仍可響。
5. 製作中11分鐘跨入10分鐘，從待接單／售罄只拉回一次；再手動切換後不每5秒搶焦點。相同周期有新單先顯示待接單。
6. 支援裝置前景 Wake Lock，背景釋放，返回同步並重新申請；無支援／省電拒絕仍可接單。
7. 鎖屏：只驗證 Web Push／OS 通知；點擊通知取最新資料。unlock／resume 本身不能接單。不宣稱鎖屏會播放自訂60秒鈴聲。
8. 返回／Swipe、歷史、售罄、Store 暫停／恢復、Push 訂閱控制仍可操作；長訂單不裁切。不要在正式環境建立測試單，除非另獲授權。

本輪沒有新增或修改 migration。既存0017／0018／0019與其他未提交功能完整保留。沒有 commit、push、deploy、遠端 D1、正式 Store／售罄／Access／Secrets／Traffic 修改。

### 本輪最終驗證結果

- 受影響 DOM（audio／wake-lock／Merchant／Store safety）：87／87 通過。
- 焦點事件測試：9／9 通過；最後單獨 Merchant DOM：59／59 通過。
- 最終完整 `npm.cmd test`：Worker 311／311（31檔），DOM 201／201（11檔），全部通過。
- `npm.cmd run check`：ESLint 無錯誤／警告、TypeScript、PWA verifier 與 build 全部通過。
- `npm.cmd run build`：通過，鈴聲已複製到 client build。
- `npm.cmd run db:migrate:local`：通過，No migrations to apply（只使用 --local）。
- `git diff --check`：exit 0。
- 本輪新增27個測試（9個焦點事件＋18個DOM），保留原有回歸；完整測試初次發現的 Store mock 缺少ID已修正，不放鬆 assertion。
- WAV 原檔與 build 檔 SHA256 相同：`78F7F537E95181531D0E0A677A379D70F99A9DE551E85CF3AE3FAA68C2B4E8BC`。
- 本輪未做真機實聽／Wake Lock／背景Push驗收，以上手機清單仍待人工完成。

本輪實際編輯／新增檔案（不是下面全工作樹歷史修改清單）：

- `src/react-app/MerchantView.tsx`
- `src/react-app/merchant-audio.ts`
- `src/react-app/merchant-focus.ts`
- `src/react-app/merchant-wake-lock.ts`
- `public/service-worker.js`
- `public/sounds/new-order.wav`
- `public/sounds/README.md`
- `scripts/generate-merchant-ring.mjs`
- `scripts/verify-pwa.mjs`
- `test/merchant-audio.dom.test.tsx`
- `test/merchant-focus.test.ts`
- `test/merchant-wake-lock.dom.test.tsx`
- `test/merchant-operations.dom.test.tsx`
- `test/merchant-store-safety.dom.test.tsx`（只補回應mock）
- `docs/MERCHANT_ALERT_QA.md`

### 完整工作樹快照

下列依序為 `git diff --stat`、`git status --short`、`git rev-parse HEAD`、`git branch --show-current`。包含所有先前保留修改，不代表本輪重做60個檔案；標準 diff --stat 不包含 untracked 檔案。狀態為60個 modified、37個 untracked 檔案（標準 status 把 sounds 兩檔合併為一個目錄列）。

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
 src/react-app/App.css                     | 607 ++++++++++++++++++--
 src/react-app/App.tsx                     | 642 ++++++++++++---------
 src/react-app/CustomerComponents.tsx      | 130 ++++-
 src/react-app/CustomerOrderStatus.tsx     |  60 +-
 src/react-app/MerchantComponents.tsx      |  75 ++-
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
 test/customer-ordering.dom.test.tsx       | 592 ++++++++++++++++----
 test/fries-order-flow.test.ts             |  21 +-
 test/merchant-operations.dom.test.tsx     | 889 ++++++++++++++++++++++++++++--
 test/merchant-orders.test.ts              |  59 +-
 test/merchant-store-safety.dom.test.tsx   |   3 +-
 test/notifications.test.ts                |  15 +-
 test/onsite-ordering.dom.test.tsx         |   7 +-
 test/onsite-ordering.test.ts              |   6 +-
 test/order-attempt.test.ts                |   6 +-
 test/order-creation.test.ts               |  48 +-
 test/order-scheduling.test.ts             |   3 +
 test/order-status.test.ts                 |  10 +-
 test/preparation-time-policy.test.ts      |  19 +
 test/release-order-features.dom.test.tsx  |  15 +-
 wrangler.json                             |   3 +
 60 files changed, 3975 insertions(+), 929 deletions(-)
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
0a587028f455c97f20cc19089fc07ddb48d42acd
fix/v0.1.1-mobile-ux
```
