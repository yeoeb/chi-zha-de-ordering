# 新單鈴聲

`new-order.wav` 是本專案原創合成的 2.4 秒電話鈴聲（440/480 Hz、20 Hz 振幅調變、淡入淡出），沒有使用第三方錄音或素材。

來源：`scripts/generate-merchant-ring.mjs`。使用 `node scripts/generate-merchant-ring.mjs` 可確定性重建。

本原創音訊與產生腳本以 CC0 1.0 Universal 提供；可用於本專案與商業用途。不是從網路下載的錄音，無外部音訊 URL 或執行時授權依賴。

Merchant 使用同來源 `/sounds/new-order.wav`，每個 AudioContext 解碼一次。下載或解碼失敗時使用本機合成提示鈴，不影響輪詢／接單。前景才播放，背景與鎖屏交由原有 Web Push／作業系統通知。
