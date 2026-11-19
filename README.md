# 真如苑のお供

お施餓鬼と接心の記録をiPhoneで行うためのWebアプリ（PWA）です。

- 記録はすべて端末内（IndexedDB）に保存し、外部へ送信しません。
- 外部のスクリプトや解析ツールは読み込みません（Content-Security-Policyで制限）。
- Safariで開き「ホーム画面に追加」してお使いください。

## 同梱ライブラリ
- [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38（Apache License 2.0、`js/vendor/pdfjs/LICENSE`）— 行事予定表PDFを端末内で読み取るために使用
