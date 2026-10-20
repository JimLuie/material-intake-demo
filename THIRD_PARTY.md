# 第三方資源

| 資源 | 用途 | 授權／來源 |
| --- | --- | --- |
| Pyodide 314.0.7 / Python / SQLite | 瀏覽器計算與資料庫 | MPL-2.0、Python授權及SQLite公有領域；https://pyodide.org |
| Tesseract.js 6.0.1 / Tesseract.js-core 6.1.2 | 本地OCR | Apache-2.0；https://github.com/naptha/tesseract.js |
| chi_tra / eng traineddata | 辨識模型 | Apache-2.0；https://github.com/naptha/tessdata |
| PDF.js 6.4.299 | PDF解析及預覽 | Apache-2.0；https://github.com/mozilla/pdf.js |
| libheif-js 1.23.5 | HEIC／HEIF解碼 | LGPL-3.0；見套件 LICENSE 及上游來源 https://github.com/catdad-experiments/libheif-js |
| UTIF 3.1.0 / pako | TIFF解碼 | MIT；https://github.com/photopea/UTIF.js |
| Barlow Condensed / IBM Plex Mono | 既有工作台字型 | SIL Open Font License；見public/fonts/OFL-*.txt |
| fflate 0.8.3 | 純 JavaScript ZIP 打包 | MIT；https://github.com/101arrowz/fflate |

所有單據圖片由虛構資料重新繪製。行情與匯率保留原官方來源連結，屬公開參考資料。

Node.js 使用內建 HTTP 服務及 fetch。依賴版本鎖定於 package-lock.json；瀏覽器執行檔與模型由 Node.js 準備，不包含在 Git 歷史。模型使用 tesseract.js-data 4.0.0_best_int，SHA-256 固定於準備腳本。字型的完整 OFL 授權隨檔保留。
