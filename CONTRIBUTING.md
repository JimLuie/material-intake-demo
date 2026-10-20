# 開發指南

一般啟動只需要 Node.js。修改計算規則或執行完整測試時，再安裝 Python 3.11 以上。

```sh
npm ci
npm run prepare:demo
npm test
npm run test:core
npm run test:wasm
npm run test:smoke
npm run audit:release
```

原生 Python 測試不需要額外 pip 套件。若系統有多個 Python，可用 `PYTHON` 環境變數指定可執行檔；測試工具也會自動尋找 python3、python 或 Windows 的 py。

## 修改邊界

- public 下的工作台與 Worker 保留既有資料介接及備份格式。
- server 下的 Node.js 程式僅提供公開資產與固定公開行情，不能新增單據上傳或伺服器帳本保存。
- scripts 的啟動與準備流程必須保持純 Node.js，不可依賴 Bash、Python、Mac OCR 或雲端帳號。
- 不要提交執行產物、模型、node_modules、SQLite、備份、真實文件或聯絡資訊。

## 重製虛構單據

預先繪製的素材已包含在專案中，正常安裝不會重新製圖。只有修改虛構樣本時，才需要 Pillow 與支援繁體中文的字型。

```sh
python -m pip install Pillow
python tools/generate_demo.py --font /path/to/CJK-font.ttc
```

產生器只讀取程式內的虛構資料及隨附公開行情快取。請逐張檢查新圖片、表單與 OCR 座標，更新範本欄位說明並通過計算測試，再更新素材雜湊允許清單：

```sh
node scripts/update-asset-manifest.mjs
npm run audit:release
```

新增測試應使用虛構素材與暫存目錄。行情代理測試使用固定的 fetch 回應，不能依賴官方來源當天是否可用。完整瀏覽器驗收需要另外保留實際結果，不以 HTTP 測試替代人工介面驗證。
