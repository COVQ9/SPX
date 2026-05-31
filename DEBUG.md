# DEBUG BROWSER — SPX Helpers Live Smoke Test

## Tổng quan

Edge DevTools MCP cho phép Claude Code tương tác trực tiếp với trình duyệt đang chạy — chụp screenshot, evaluate JS, inspect DOM, navigate trang — không cần thao tác thủ công. Đây là cách duy nhất để smoke test userscript trên trang SPX thật.

---

## Tại sao port 9222 hầu như luôn bật

KiotVit phải được mở mỗi ngày để làm việc. Cả hai launcher đều hardcode `--remote-debugging-port=9222` khi khởi động Edge:

**`vit.bat` (line 37):**
```bat
start "" "!EDGE!" --app=http://localhost:9009/ --profile-directory="Main Profile" --kiosk-printing --no-first-run --no-default-browser-check --remote-debugging-port=9222
```

**`vit.ps1` (line 133):**
```powershell
Start-Process $edgeExe -ArgumentList '--app=http://localhost:9009/', '--profile-directory="Main Profile"', '--kiosk-printing', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9222'
```

**Flow mỗi ngày:**
```
Mở máy
  → chạy `vit` (shortcut hoặc terminal)
  → oxmgr apply oxfile.toml → KiotVit server start trên port 9009
  → vit.ps1 đọc thơ Kiều trong khi chờ server healthy
  → server OK → Launch-Edge với --remote-debugging-port=9222
  → Edge mở ở chế độ --app (PWA-like, không address bar)
  → port 9222 bật, sẵn sàng nhận MCP connection
```

**Kết luận:** Trong giờ làm việc, port 9222 **gần như chắc chắn đang bật** vì KiotVit chạy cả ngày.

---

## Điều kiện để MCP hoạt động

### 1. Edge phải được mở qua `vit`

Edge mở thường (không qua `vit`) **không có** `--remote-debugging-port=9222` → MCP không kết nối được.

Kiểm tra port có đang listen không:
```powershell
netstat -ano | Select-String ":9222"
```
Nếu không có output → Edge chưa ở debug mode. Giải pháp: chạy lại `vit`.

### 2. File `.mcp.json` phải đúng vị trí

MCP server chỉ load theo cwd lúc khởi động Claude Code session. Đã có sẵn:
- `C:\Projects\.mcp.json`
- `C:\Projects\SPX Helpers\.mcp.json`

Cả hai khai báo:
```json
{
  "mcpServers": {
    "edge-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"]
    }
  }
}
```

### 3. Restart Claude Code sau khi sửa `.mcp.json`

MCP không hot-reload. Thêm/sửa `.mcp.json` → phải restart Claude Code và đồng ý trust project MCP server.

---

## Hai app riêng biệt — cùng Edge process

Có **2 standalone app riêng biệt**, mỗi cái có window và taskbar icon riêng:

| App | URL | display-mode | Title |
|-----|-----|---|---|
| **SPX Service Point** | `https://sp.spx.shopee.vn/` | **`minimal-ui`** | "SPX Service Point" |
| **KiotVit** | `http://localhost:9009/` | `standalone` | "Kiot Vịt" |

Cả hai dùng chung Edge profile "Main Profile" → chạy trong cùng Edge process → cùng accessible qua `--remote-debugging-port=9222` do `vit.bat` bật.

**Ưu tiên smoke test trong SPX Service Point window** — userscripts chạy ở đây. Cách xác định đúng page khi `list_pages`:
- URL chứa `sp.spx.shopee.vn` **VÀ** `display-mode: minimal-ui` = `true` → đúng SPX PWA
- URL `localhost:9009` / `display-mode: standalone` = `true` → KiotVit, bỏ qua

## SPX Service Point — Installed PWA

- **App name:** SPX Service Point
- **Publisher:** sp.spx.shopee.vn
- **Edge App ID:** `jmgekjppcolbnhclcefojbgmjofdcjnn`
- **Display mode:** `minimal-ui` — xác nhận bằng `window.matchMedia('(display-mode: minimal-ui)').matches`
- **Auto-start on login:** bật
- **App detail URL:** `edge://apps/details/sp.spx.shopee.vn/jmgekjppcolbnhclcefojbgmjofdcjnn`

## Các tab SPX thường có sẵn

Khi KiotVit chạy và người dùng đang làm việc, các tab SPX thường đã mở sẵn:
- `https://sp.spx.shopee.vn/inbound-management/receive-task` — Receive Task list
- `https://sp.spx.shopee.vn/order-management/drop-off` — Drop-off
- `https://sp.spx.shopee.vn/finance-management/cash-collection` — Cash Collection

`list_pages` sẽ show tất cả các tab đang mở, bao gồm cả `http://localhost:9009/` (KiotVit).

---

## Workflow smoke test userscript

```
1. Kiểm tra port 9222 đang listen
   → netstat -ano | Select-String ":9222"

2. list_pages → xác định tab SPX cần test

3. select_page (pageId theo số thứ tự trong list)

4. take_screenshot → xem trạng thái hiện tại

5. evaluate_script → inspect DOM, check element tồn tại, đọc attribute

6. navigate_page (type: url) → chuyển trang để test SPA navigation

7. navigate_page (type: reload) → test full page reload

8. Sửa file .user.js → navigate_page reload → Tampermonkey nạp lại file local
   (chỉ hoạt động nếu script dùng @require file:///...)
```

---

## Công cụ MCP hay dùng

| Tool | Dùng khi nào |
|------|-------------|
| `list_pages` | Xem các tab đang mở |
| `select_page` | Chọn tab cần làm việc (dùng pageId số) |
| `take_screenshot` | Chụp màn hình xem trạng thái visual |
| `evaluate_script` | Chạy JS trong tab — inspect DOM, check state |
| `navigate_page` | Navigate URL / reload / back / forward |
| `new_page` | Mở tab mới với URL |
| `get_console_message` | Đọc console log cụ thể |
| `list_console_messages` | Xem toàn bộ console log |

---

## Nguyên tắc dò lỗi trong hệ thống multi-script

Đây là điểm quan trọng nhất khi debug SPX Helpers: **lỗi có thể đến từ một script độc lập, hoặc từ sự xung đột giữa nhiều scripts với nhau.**

### Lỗi từ một script đơn lẻ
Script tự gây ra lỗi do logic nội tại — race condition, null check thiếu, timing sai, DOM selector không khớp. Dễ reproduce và isolate bằng cách disable các script khác trong Tampermonkey.

### Lỗi do xung đột giữa nhiều scripts

Phức tạp hơn nhiều. Xảy ra khi:

**1. Tranh chấp DOM:**
Hai script cùng inject vào một vùng DOM — một script có thể overwrite, dịch chuyển, hoặc xóa element của script kia. Ví dụ điển hình trong repo này: `open-2-end` inject `#spx-spacer` ở TOP sidebar; `neon-sync` inject `#_neon_ind` bằng `prepend()` vào cùng parent. Thứ tự chạy và timing quyết định ai thắng.

**2. Tranh chấp event listener:**
Nhiều script cùng lắng nghe `spx-nav`, `DOMContentLoaded`, `MutationObserver` — callback của script này có thể kích hoạt sớm hơn script kia và thay đổi state mà script kia chưa kịp đọc.

**3. Shared global bị ghi đè:**
Các script giao tiếp qua `document.documentElement.*` và `unsafeWindow.*`. Nếu một script ghi đè một global mà script khác đang dùng, hoặc ghi đè trước khi script kia khởi tạo xong, cả hai đều lỗi theo cách khó trace.

**4. Thứ tự khởi động không đảm bảo:**
`document-start` scripts chạy theo sort order trong Tampermonkey dashboard — thứ tự này **do người dùng set thủ công**, không được enforce tự động. Nếu sort order sai, `SpxShared` có thể chưa tồn tại khi script khác gọi đến.

**5. IDB conflict:**
Nhiều script mở cùng một IDB database với version khác nhau → version upgrade race → một script bị block không mở được connection.

### Quy trình dò lỗi đúng

```
Bước 1 — Reproduce ổn định lỗi trước
  → Xác định điều kiện cụ thể gây lỗi (trang nào, hành động nào, lần nào)
  → Dùng evaluate_script + list_console_messages để capture state tại thời điểm lỗi

Bước 2 — Isolate: lỗi từ 1 script hay nhiều script?
  → Disable từng script trong Tampermonkey, reload, kiểm tra lỗi còn không
  → Nếu lỗi mất khi disable script X → X là nguyên nhân hoặc là trigger
  → Nếu lỗi chỉ mất khi disable đồng thời X + Y → xung đột giữa X và Y

Bước 3 — Trace timing
  → Console log timestamp khi injection xảy ra
  → So sánh với timing của các script khác đang thao tác cùng vùng DOM

Bước 4 — Kiểm tra shared state
  → evaluate_script kiểm tra các global (SpxShared, NeonSync, SpxLog)
  → Kiểm tra DOM tại thời điểm lỗi: element có bị overwrite không, className có bị thay đổi không

Bước 5 — Không kết luận từ code tĩnh một mình
  → Code đọc một mình chỉ cho thấy intent, không cho thấy runtime behavior
  → Phải confirm bằng live smoke test trên browser thật
```

---

## Quy trình fix bug & deploy

### Cấu trúc project

```
SPX Helpers/
  ├── *.stub.user.js      ← stub ngắn, paste vào TM Dashboard (8 file)
  ├── src/
  │   └── *.user.js       ← code thật, TM load qua @require file:///
  ├── sounds/
  ├── spx icons/
  └── apps-script/
```

### Nguyên tắc fix

- **Chỉ dùng industrial technique** — không vá víu tạm bợ (duct tape fixes). Nếu cần refactor để fix đúng bản chất, hãy refactor.
- **Bump version ở 2 chỗ** sau mỗi fix:
  1. Header `// @version X.Y` trong `// ==UserScript==` của `src/*.user.js`
  2. `console.log('[ScriptName] vX.Y — mô tả thay đổi ✓')` ở cuối script (trước `})();`)
- **Stub version tự động sync** — pre-commit hook tại `.git/hooks/pre-commit` tự update `@version` trong stub tương ứng mỗi khi commit source file.

### Deploy flow (file:// workflow — desktop)

```
Sửa src/*.user.js
  → Bump @version + console.log (2 chỗ)
  → git commit (hook tự sync stub version)
  → git push (optional, để backup GitHub)
  → Reload tab SPX → TM đọc file mới ngay lập tức ✓
  → Kiểm tra console: phải thấy version mới
  → Live smoke test
```

### Setup file:// workflow (1 lần per machine)

1. Edge → `edge://extensions` → Tampermonkey → Details → **"Allow access to file URLs"** → ON
2. TM Dashboard → Settings → Externals → **Update Interval: Always**
3. Với mỗi script trong TM Dashboard: edit → Ctrl+A → paste stub tương ứng từ `*.stub.user.js` → Ctrl+S
4. **Sort order** trong TM: SPX Shared phải đứng **đầu tiên** (document-start, load trước mọi script khác)

### Pre-commit hook (tạo lại nếu clone mới)

Hook không được commit vào repo. Nếu cần tạo lại:

```bash
# Tạo file .git/hooks/pre-commit rồi chmod +x
# Nội dung: đọc @version từ src/*.user.js → update stub tương ứng → git add stub
```

File hook mẫu tại `.git/hooks/pre-commit` trên desktop — copy sang máy mới nếu cần.

### Version — source of truth

- **Console log** `[SPX] ScriptName vX.Y — ...` = version code đang thật sự chạy
- **TM Dashboard version** = version của stub (tự động sync qua hook, chỉ để tham khảo)

---

## Lưu ý quan trọng

- **`evaluate_script` không có `unsafeWindow`** — đây là page context thông thường, không phải Tampermonkey sandbox. Không gọi được `GM_*` hay các API Tampermonkey.
- **`NeonSync` có thể access được** qua `window.NeonSync` (vì script expose qua `unsafeWindow` = `window` trong page context).
- **Edge process bị kill khi chạy `vit` lần mới** — `vit.ps1` kill toàn bộ msedge trước khi relaunch. Các tab SPX đang mở sẽ mất, phải mở lại thủ công hoặc qua `new_page`.
- **Port 9222 không có authentication** — chỉ accessible từ localhost, không expose ra ngoài mạng.
