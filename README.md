# 台股盤前早報網站

這是一個手機優先的單頁早報網站；網頁本身不會在讀者開啟時向資料商抓取資料。GitHub Actions 會在台灣時間每個交易日 04:50 執行資料更新，產生 `public/data/latest.json`，網站只讀取該份已驗證的快照，因此同一份數字能被重現與稽核。

## 資料原則

- 台股價量、法人、注意／處置與休市日優先使用 TWSE OpenAPI；上櫃報價使用 TPEx OpenAPI。
- 美股與宏觀報價採用結構化 chart endpoint，並將原始 URL 一起寫入快照。此 endpoint 並非 Yahoo 公開支援的 API；若要作正式生產使用，請在 `scripts/build-report.mjs` 改接授權資料商。
- 不使用搜尋引擎或媒體交叉比對來補數字。沒有 API 或未能驗證的欄位會明確顯示「無法查證」，絕不補造。
- 每個前端數字均帶有原始來源連結；資料抓取失敗會保留來源與錯誤，而不是沿用舊數字冒充當日資料。

## 本機預覽

需要 Node.js 20+。

```bash
node scripts/build-report.mjs
cd public && python3 -m http.server 4173
```

開啟 `http://localhost:4173`。更新器會寫入 `public/data/latest.json`（此檔已被 git 忽略，避免誤提交每日市場快照）。

## 部署與排程

GitHub Pages 可直接將 Pages 的來源設為 GitHub Actions。工作流程在 UTC 20:50（日到四）執行，等於台灣時間週一到週五 04:50。首次部署前請在 GitHub 專案設定中啟用 Pages，來源選 **GitHub Actions**。排程本身不需要 API 金鑰。

若要部署到其他靜態主機，只要在更新工作完成後上傳整個 `public/` 目錄即可。若要改為私有網站或上傳至 Google Drive，需要由網站主機／Google 帳戶授權；本專案不會把任何憑證寫進版本庫。

## 有意識保留的限制

「新聞原因」、「法說實際 vs 市場共識」與 DRAM 現貨／合約價沒有可信、可免費且可重散布的通用公開 API。這些欄位目前會誠實標為無法查證。接入有授權的新聞／共識／報價 API 後，再在 `SOURCE_REGISTRY` 與對應資料轉換器中加入即可；不要用爬網或模型推測替代。
