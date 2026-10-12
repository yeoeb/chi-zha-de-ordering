# 客戶交付與品質保障｜吃炸的

> 文件類型：**Client delivery / Quality Assurance / Operational readiness**。本文件為已實作機制的證據索引與待驗收清單，**不是已簽署的保固、SLA、商業委託或驗收證明**。來源以 GitHub `main` 的程式碼及既有本機測試為主；Production 狀態需以最新操作證據重新核對。

## 交付定位

本專案依台灣一間實體炸物店的實際營業流程設計，目標是減少尖峰漏單、人工核對餐點、截止時間混亂，以及售罄商品仍被購買等問題。它是**真實商家情境導向的單店系統案例**，不是為展示而虛構的 SaaS。

對外描述應使用「為真實店家需求設計／開發」、「已有正式環境與獨立部署流程」等可驗證表述；除非有證據，不應宣稱「客戶已付費簽收」、「穩定營運 X 個月」、「99.9% SLA」、「零故障」或「數千筆正式訂單」。

## 驗收證據分級

| 等級 | 意義 | 面試或對外交付可如何敘述 |
| --- | --- | --- |
| **CODE+TEST** | 主分支具備程式與對應本機回歸測試；未在本文件重跑 | 已實作與具備自動化測試；不等於實機或 Production PASS |
| **RUNBOOK** | 已有操作流程、權限或回滾設計 | 有 SOP，不代表實際演練成功 |
| **VERIFY-LIVE** | 需要最新時間戳的 Production 版本、Access、設定與監控證據 | 未取得前不可宣稱正式環境已驗收 |
| **UAT-PENDING** | 需店家在真實手機／繁忙時段確認 | 不能以模擬測試代替 |
| **OPEN** | 尚未看到足夠證據、政策或實作 | 應列入待辦與風險 |
| **AGREEMENT** | 須與店家書面約定費用、責任、支持窗口 | 不是程式庫內的技術承諾 |

## A. 功能與資料正確性驗收

| 驗收需求 | 目前證據 | 狀態 | 完成驗收需要什麼 |
| --- | --- | --- | --- |
| 顧客選商品、份量、辣度與結帳 | `src/react-app`、`test/customer-ordering.dom.test.tsx`、`test/fries-order-flow.test.ts` | CODE+TEST | 店家核對實際菜單、價格、份量與每項選項，避免本機 Seed 代替 Production 價格 |
| 防止重複送單／重試造成兩張訂單 | `src/worker/order-creation.ts`、`test/order-concurrency.test.ts`、`test/order-atomicity.test.ts` | CODE+TEST | 模擬超時、重試、同時送單與返回頁面 |
| 價格與快照一致、修改價格後不錯價 | `src/worker/order-creation.ts`、`test/order-creation.test.ts` | CODE+TEST | 驗證 Quote Change、售罄／改價競態均無不完整訂單 |
| 兩台 Merchant 不會互相覆蓋接單 | `src/worker/merchant-orders.ts`、`test/merchant-orders.test.ts` | CODE+TEST + UAT-PENDING | 兩支真實已授權手機同時接單／完成 |
| 暫停接單、生意繁忙、缺貨、取消 | `src/worker/store-operations.ts`、`test/store-operations.test.ts`、`test/order-adjustments.test.ts` | CODE+TEST + UAT-PENDING | 店家逐項走流程並確認顧客看到一致狀態 |
| 取餐截止時間與現場 QR 流程 | `test/order-scheduling.test.ts`、`test/onsite-ordering.test.ts` | CODE+TEST + UAT-PENDING | 不使用 Production 假訂單；在隔離環境演練時間碰撞、取消與報到 |
| Merchant 提醒與斷線降級 | Web Push 相關程式、Service Worker、Merchant 五秒輪詢；見 [Product Blueprint](PRODUCT_BLUEPRINT.md) | CODE+TEST + UAT-PENDING | 測試 iPhone／Android 實機鎖屏、靜音、斷網、恢復連線、提示音可聽度 |
| 指定營業日與柔性收店 | `src/worker/store-schedule.ts`、`src/worker/scheduler-activation.ts`、`test/scheduler-activation.test.ts` | CODE+TEST + VERIFY-LIVE | 查明實際 Active Version、Activation Gate、自然 Cron Audit；檢查星期一公休與人工暫停不被覆蓋 |

### 不接受的驗收捷徑

- 只看到 HTTP 200 不代表訂單正確；須檢查 D1 訂單／品項／狀態與客戶端一致。
- 只看到單元測試 PASS 不代表 iOS 背景通知、商家聽得到鈴聲或實際停電後可正常操作。
- 只完成 Worker Promotion 不代表 Scheduler Activation 已啟用或已在實際營業時間驗收。
- 不建立 Production 假訂單、不自動完成既有 Accepted 訂單、不為 Demo 強制 Resume 店家。

## B. 安全、個資、部署與復原

| 項目 | 目前可指向的證據 | 需補或確認 |
| --- | --- | --- |
| 授權與角色分離 | `src/worker/security.ts`、`test/security-foundation.test.ts` | 每次發版重新驗證正式 Access Audience、Routes 與環境變數；Merchant／Admin 不可共用特權 |
| 公開 Mutation 防護 | `src/worker/public-origin.ts`、`test/public-origin-guard.test.ts` | 嚴格檢查非法 Origin、Fetch Metadata、輸入、頻率限制，並確認實機相容性 |
| 併發／重試安全 | D1 transaction、CAS、Operation ID、Idempotency；見 [Product Blueprint](PRODUCT_BLUEPRINT.md) | 正式演練網路重試、設備重複操作與失敗補償 |
| 安全的版本發布 | [Deployment Runbook](DEPLOYMENT_RUNBOOK.md)、[Main Policy](MAIN_DEVELOPMENT_POLICY.md) | 最新 Release SHA／D1 migration／Traffic／Rollback 版本，與回滾後 API 相容性 |
| D1 備份與資料復原 | Cloudflare D1 **Time Travel** 功能及 Runbook 的 Bookmark 機制 | 另建隔離資料庫演練復原；釐清復原點、可容忍資料遺失（RPO）、復原時間（RTO）；**不可直接回復正在營業的整個 Production DB** |
| 正式監控與告警 | 有 UI 斷線提示與局部操作 Audit 設計 | 尚未從本倉庫確認完整外部 Uptime Monitoring、API 錯誤率／延遲、失敗通知、事故升級通知與監測責任人 |
| 個資處理 | 訂單電話／備註有格式與存取控制、公開 Order Lookup 使用不透明 Token | 由店家確認個資蒐集告知、用途、保存期限、刪除／查詢窗口、日誌遮罩與事故通報程序；不可宣稱已完整法律合規 |
| 依賴與弱點 | `npm run check`、多套 Vitest 測試、程式 Security Guard | 增加 `npm audit`／依賴掃描、Git Secret Scan；目前沒有在倉庫樹中看到 `.github/workflows/`，不能宣稱 CI 自動運行 |
| 行動與無障礙 | React Responsive／DOM 測試 | 手機實機、不同螢幕及文字縮放、鍵盤焦點、對比度、螢幕閱讀器；可參考 WCAG 2.2 AA，但未執行完整符合性驗證 |
| 尖峰流量與容量 | 有同步競態／併發邏輯測試 | 缺實際尖峰壓測與基準指標；應在隔離環境記錄 Quote、Order API 成功率與 P95 延遲 |

參考規範／平台文件：

- [OWASP ASVS 5.0](https://github.com/OWASP/ASVS/tree/master/5.0)：Access Control、Validation、Logging、Data Protection
- [Google SRE — Implementing SLOs](https://sre.google/workbook/implementing-slos/)：明確且可量測的服務目標
- [Cloudflare D1 — Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)：資料恢復能力及限制
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)：行動與無障礙介面
- [台灣個人資料保護法](https://law.moj.gov.tw/LawClass/LawAll.aspx?Pcode=I0050021)：包含第 8 條個資蒐集告知事項

## C. 營運保障：除了程式碼，店家要有的 SOP

### 開店前（日常操作）

1. 店家確認商品與正式價格、售罄狀態、營業日與 Store 接單狀態。
2. Merchant 已登入，手機有網路，工作台資料與最後同步時間正常。
3. 提醒音／Push 已測，**不能只靠音量與背景通知**；輪詢與畫面仍是核對依據。
4. 商家知道遇到故障如何**人工暫停接單**，以及怎麼記錄紙本／電話替代流程。

### 事故分級與處置（建議範本，非目前已有 SLA）

| 等級 | 例子 | 第一動作 |
| --- | --- | --- |
| **P0：訂單金額錯誤、重複收單、資料洩露、店家無法控制接單** | 真實營業風險 | 立即通知負責人；必要時透過既有授權流程暫停接單；保留證據，停止進一步部署 |
| **P1：商家通知失效、部分客戶無法送單、單一角色大量 5xx** | 核對 D1 正確性 | 啟用人工接單備援；診斷 Access／API／網路；評估經核准回滾 |
| **P2：排版、圖片、非交易性 UI 錯誤** | 不阻止安全下單 | 排期修復，不在尖峰時間任意更動 Production |

事故處置至少要紀錄：開始／發現／恢復時間、影響範圍、事件版本、Store 是否仍接單、D1 是否有變動、誰做了什麼操作。日誌不能外洩真實顧客個資與 Secret。

### 可以討論的服務目標，但不應先承諾

- **SLI**：成功建單率、API 可用率、API P95 延遲、Merchant 取到新單的時間、通知成功率。
- **SLO**：與店家討論營業時段與合理指標，至少有持續量測、告警、檢討的方法。
- **SLA**：只有在雙方明確同意監測方式、服務時間、例外與補救責任後才是正式承諾；不要直接宣稱 99.9%。
- **RPO／RTO**：先演練再依實際能力設定。D1 提供 Time Travel，不代表能無損還原到現在，也不代表已達零停機。

## D. 給店家的正式交付物

交付時至少要能提供：

| 交付物 | 標準 |
| --- | --- |
| 功能說明及操作手冊 | 顧客／Merchant／Admin 的流程、開店／關店、售罄、接單、取消、短缺、緊急暫停 |
| 完整程式碼與版本記錄 | GitHub Commit／Release Tag、依賴鎖版、可再建置與本機啟動 |
| 部署／回滾 SOP | 網域、Worker、D1 migrations、Access、Secrets 的位置與操作角色；**絕不交出真實密鑰於 Public Git** |
| 測試與驗收報告 | 需求 → Test Case → PASS／FAIL → 測試日期／版本／執行人；真實設備 UAT 獨立記錄 |
| 資料管理與復原 | 備份方法、隔離還原演練、資料保留／清除／匯出程序與權限 |
| 營運監控及異常聯絡 | 監測位置、警報接收者、事故電話或訊息窗口、尖峰時間人工備援 |
| 權責歸屬 | 店家與開發者／維護者對網域、Cloudflare、金鑰、付款方式、程式碼使用權、資料所有權的約定 |
| 保固與後續維護 | 哪些是既有功能缺陷、哪些是需求變更；處理時間、維護費用、第三方平台故障與服務終止方式，雙方書面確認 |

**保固範例（僅供洽談，非已承諾）**：可協議驗收後一定期間內無償修復可重現、屬原驗收範圍的程式錯誤；需求擴充、額外設備、第三方服務費與平台停機另議。實際期間、窗口及費用必須經雙方同意。

## E. 店家 UAT 簽收紀錄範本（尚未簽收）

- 店家代表／驗收日期：**待填**
- 本次驗收的 Release Commit SHA／Worker Version：**待填**
- 正式菜單價格與售罄規則核對：**待驗收**
- 顧客網路訂單／現場 QR／取消／缺貨：**待驗收**
- Merchant 兩台真實手機、提醒音、斷線恢復：**待驗收**
- Admin 權限與價格更新：**待驗收**
- 營業時間與 Scheduler 自然觸發：**待驗收**
- Backup／Restore 演練、Rollback 演練：**待驗收**
- 故障時人工操作、維護窗口與個資告知：**待確認**
- 驗收結論：**PASS / CONDITIONAL PASS / BLOCKED（由店家代表確認）**

本表不可先填 PASS 或冒用店家簽名。Source 層面已實作的測試，不等同客戶完成簽收。

## F. 當前值得優先處理的缺口（按風險排序）

**P0 — 商家上線保障（先做）**

1. 核對最新正式部署與已核准版號、Store 接單／Scheduler Activation 狀態，避免舊文件當成現況。
2. 完整人工接單備援、暫停接單 SOP、誰有 Cloudflare／Access 權限及緊急聯絡方式。
3. Uptime／5xx／建單失敗／Merchant 斷線可觀測與通知；避免只靠店家發現。
4. 隔離資料庫 D1 復原與 Worker Rollback 演練，不碰正式訂單。
5. iPhone／Android 真機通知與兩台 Merchant 並發 UAT。

**P1 — 正式交付完整度**

6. 隱私告知、資料保存／刪除政策及店家責任人。
7. 尖峰容量、操作延遲／錯誤率實測，確定營業範圍內的 SLO。
8. CI、自動依賴／Secret Scan；目前主分支未看到 `.github/workflows/`。
9. 對齊 GitHub 工程文件的歷史／當前狀態：`PROJECT_STATE.md` 和舊 `PRODUCTION_READINESS.md` 含過去的 NO-GO／版本／價格描述，不可直接當最新現況。
10. 真實、已去識別化的網站截圖、功能演示與客戶操作指南。

### 對面試官的正確說法

> 這是依實際炸物店營運需求設計的單店系統。我不只做下單畫面，也針對重複送單、錯價、兩台設備同時接單、身份權限、營業自動化與失敗回復設計 Backend Boundary 和自動化測試。對於真實手機通知、Production Monitoring、災難復原與店家 UAT，我會把證據和待驗收事項分開記錄，不拿單元測試代替營運保證。

更新本文件時須附新 Commit、測試、正式操作或店家驗收證據；不能僅把表格狀態改成 PASS。
