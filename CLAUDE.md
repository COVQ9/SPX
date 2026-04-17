# SPX Helpers — Workflow

Userscripts được edit tại local (`c:/Projects/SPX Helpers/*.user.js`), push lên GitHub, và Tampermonkey load code từ raw GitHub URL qua `@require`.

Remote: https://github.com/COVQ9/SPX (branch `main`)

## File layout

- `*.user.js` — source code userscript (được commit)
- `*.options.json`, `*.storage.json` — local state của Tampermonkey, **không commit** (đã ignore)

## Tampermonkey stub (dán trong tab editor của Tampermonkey)

Mỗi userscript có 1 stub metadata block trỏ `@require` về raw GitHub. Ví dụ `Open-End flows`:

```
// ==UserScript==
// @name         Open-End flows
// @namespace    http://tampermonkey.net/
// @version      3.4
// @match        https://spx.shopee.vn/*
// @match        https://sp.spx.shopee.vn/*
// @grant        none
// @require      https://raw.githubusercontent.com/COVQ9/SPX/main/Open-End%20flows.user.js
// @run-at       document-end
// ==/UserScript==

// Keep this area empty. All code lives in the @require file.
```

Tên file có dấu cách → encode thành `%20` trong URL.

## Checklist mỗi lần update 1 userscript

1. Sửa code trong `*.user.js` (VS Code).
2. `git add <file> && git commit -m "..." && git push`.
3. Mở Tampermonkey → tab editor của script đó → **bump `@version`** (vd 3.4 → 3.5) → Save.
   - Bump version là BẮT BUỘC để Tampermonkey re-fetch `@require` (nó cache rất aggressive).
4. Reload trang để test.

## Nếu code mới không apply

- Kiểm tra đã bump `@version` chưa.
- Tampermonkey → Settings → **Config mode: Advanced** → mục **Externals**:
  - `Update interval`: đặt ngắn (vd 0 = always).
  - `Update on external scripts`: Always.
- Hoặc tạm chuyển `@require` sang jsDelivr để bypass raw.githubusercontent cache:
  `https://cdn.jsdelivr.net/gh/COVQ9/SPX@main/<filename>.user.js`
  (jsDelivr cũng cache ~12h với `@main`; pin commit SHA `@<sha>` nếu cần chắc.)

## Quy tắc commit

- Chỉ commit `.user.js` và `.gitignore`. Không commit `.options.json` / `.storage.json`.
- Message ngắn gọn, mô tả thay đổi chức năng (không mô tả nội dung kỹ thuật file).
