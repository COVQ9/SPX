# KIẾN TRÚC HỆ THỐNG — SPX Helpers Userscript Ecosystem

**Ngày:** 2026-05-31
**Phạm vi:** 8 userscript, 2 domain `spx.shopee.vn` + `sp.spx.shopee.vn`

---

## I. TRIẾT LÝ THIẾT KẾ

Toàn bộ bộ script được xây dựng theo **layered architecture** với ba tầng rõ ràng:

- **Tầng 1 — Core:** `spx-shared` cung cấp primitives (IDB, network, DOM, audio, SPA nav)
- **Tầng 2 — Infrastructure:** `neon-sync` cung cấp persistence layer (sync IDB ↔ cloud)
- **Tầng 3 — Business:** 6 script còn lại implement nghiệp vụ, consume từ tầng 1 và 2

Các script **không import nhau trực tiếp** (không có ES module). Giao tiếp qua:
- `document.documentElement.SpxShared` — shared API object
- `unsafeWindow.NeonSync` — sync API object
- `unsafeWindow.SpxLog` — logging API object
- `document.documentElement._spxInterruptSound / _spxEnqueueSound` — audio sequencer
- `window` event `spx-nav` — SPA navigation signal

---

## II. THỨ TỰ KHỞI ĐỘNG (EXECUTION ORDER)

| # | Script | `@run-at` | Thời điểm chạy |
|---|--------|-----------|----------------|
| 1 | `spx-shared` | document-start | Trước khi HTML parse — **bắt buộc sort FIRST** |
| 2 | `neon-sync` | document-start | Ngay sau shared |
| 3 | `find-details` | document-start | Trước khi DOM render |
| 4 | `open-2-end` | document-end | Sau khi DOM parse xong |
| 5 | `log-log` | document-end | Sau open-2-end |
| 6 | `scan-job` | document-idle | Sau page fully loaded |
| 7 | `sf-keyboard` | document-idle | Sau page fully loaded |
| 8 | `Refund-NSS` | document-idle | Sau page fully loaded |

---

## III. CHI TIẾT TỪNG SCRIPT

### 1. `spx-shared` — Core Infrastructure

Vai trò trung tâm của toàn hệ thống. Export một object duy nhất tại `document.documentElement.SpxShared`.

**SPA Navigation Patch:**
Patch `history.pushState` và `history.replaceState` ngay tại document-start (trước bất kỳ framework nào chạy), đảm bảo mọi SPA navigation đều dispatch `window.spx-nav`. Đây là **signal duy nhất** cho toàn hệ thống biết người dùng chuyển trang.

```
history.pushState   ──┐
history.replaceState ─┼─→ window dispatch "spx-nav"
window popstate    ───┘
```

**API surface:**

```
SpxShared.idb
  .open(dbName, version, storeName)
  .get(dbName, version, storeName, key)
  .put(dbName, version, storeName, key, val)
  .getAll(dbName, version, storeName)
  .session(dbName, version, storeName)   ← cached long-lived connection

SpxShared.gmReq(opts)                    ← Promise wrapper quanh GM_xmlhttpRequest
SpxShared.addUnloadCleanup(fn)           ← đăng ký cleanup trên pagehide

SpxShared.pollFor(check, cb, opts)       ← poll cho đến khi check() truthy
SpxShared.watchEl(selector, onAdded)     ← MutationObserver-based element watcher
SpxShared.isVisible(el)
SpxShared.debounce(fn, ms)
SpxShared.toast(msg, opts)

SpxShared.getExtraChar(date)             ← month suffix: Oct→'A', Nov→'B', Dec→'C'
SpxShared.fmtShorthand(n)               ← 250000→"250k", 1250000→"1tr250k"
SpxShared.fmtDate(date)                 ← "07MAY2026"
SpxShared.makeKvAuth(getToken, setToken, baseUrl)

SpxShared.loadAudio(key, url, audioEl)  ← ETag stale-while-revalidate, cache vào IDB
```

**Audio Sequencer** (3 globals trên `document.documentElement`):
- `_spxInterruptSound(audio)` — dừng âm thanh hiện tại, phát ngay (priority cao nhất)
- `_spxEnqueueSound(playFn)` — xếp hàng, phát tuần tự
- `_spxAudioQueue` — promise chain nội bộ

**`watchEl` — cơ chế hoạt động:**
```
watchEl(selector, onAdded, {root, subtree=true})
  → tạo MutationObserver trên root (default: document.body)
  → mỗi khi DOM thay đổi: scan tất cả phần tử khớp selector
  → nếu phần tử chưa có dataset._spxWatched → gọi onAdded(el), đánh dấu _spxWatched='1'
  → trả về hàm disconnect()
  → scan() chạy ngay lần đầu để catch các phần tử đã có sẵn
```

---

### 2. `neon-sync` — Cloud Sync Infrastructure

Sync hai chiều giữa IndexedDB của tất cả script ↔ Neon PostgreSQL (free tier, PostgREST API).

**Auth flow:**
```
GM_setValue("neon_svc_pass")
  → Better Auth sign-in (POST /auth/sign-in)
  → HttpOnly session cookie (không đọc được từ JS)
  → GET /auth/token đổi cookie → JWT EdDSA ngắn hạn
  → JWT dùng cho PostgREST Authorization: Bearer
```

Dùng `unsafeWindow.fetch` (không phải `GM_xmlhttpRequest`) vì cần chia sẻ cookie jar thật của browser. GM_xmlhttpRequest có isolated cookie jar, không chia sẻ session.

**Sync strategy theo từng table:**

| Mode | Hoạt động | Tables |
|------|-----------|--------|
| `upsert` | Push mỗi write, pull khi load | spx_events, spx_tasks, spx_receipts, spx_hv_shipments, spx_hv_tasks, spx_refund_state |
| `cold` | Sync một lần (fingerprint-based) | spx_audio_cache, spx_tokens, spx_scripts |

**Push pipeline:**
```
IDB write xảy ra
  → dirty queue (Set per table)
  → debounce 2s (DRAIN_DEBOUNCE_MS)
  → drain sau min 30s (DRAIN_MIN_MS, adaptive)
  → batch push lên Neon REST
  → budget check: max 1.500 drain calls/ngày (PUSH_BUDGET_DAILY)
```

**Pull:** Một lần duy nhất tại `setTimeout(..., 3000)` sau page load, kéo toàn bộ data về IDB. Sau khi xong, gọi tất cả callbacks đã đăng ký qua `NeonSync.onPullComplete(cb)`.

**Circuit breaker auth:** Nếu auth fail liên tiếp, tăng backoff exponential, không spam Neon.

**Quota monitor:** Dùng Neon Management API (Personal Access Token riêng, khác service account) để track compute/storage/transfer. Refresh 6h/lần, cache vào GM_setValue.

**Quota limits (free tier):**
- Compute: 100 CU-hrs/tháng (reset hàng tháng)
- Storage: 512 MB (tích lũy, giảm khi cleanup)
- Transfer: 5 GB/tháng (reset hàng tháng)

**Retention cleanup:** Xóa records cũ hơn 100 ngày. Chạy sau mỗi pull, tối đa 1 lần/ngày.

**Sidebar indicator:** Inject `#_neon_ind` (cloud icon + "Neon Sync" label + metrics accordion) vào left sidebar phía trên menu item "Help".

**Public API tại `unsafeWindow.NeonSync`:**
```
NeonSync.push(table, record)
NeonSync.coldSync(table)
NeonSync.pullAll()
NeonSync.register(config)          ← extend với custom table
NeonSync.onPullComplete(cb)        ← cb gọi ngay nếu pull đã xong
NeonSync.status()                  ← debug snapshot
NeonSync.flushNow()
NeonSync.clearAuth()
NeonSync.resetAuthBackoff()
NeonSync.refreshUsage()
```

---

### 3. `find-details` — AWB Research & HV Detection

Chạy `document-start` để kịp intercept network requests từ đầu.

**Tính năng chính:**
- **Paste+Clear:** paste AWB vào ô tìm kiếm → auto clear clipboard
- **Eye preview:** click icon eye trên row → fetch PDF nhãn → render PNG overlay tại chỗ, không mở tab mới
- **AWB dual panel:** hiển thị 2 AWB song song để so sánh
- **HV detection:** quét danh sách shipments, phát hiện đơn Hàng Vip, phát âm thanh alert
- **Token capture:** intercept `fetch` + XHR để bắt Bearer token → lưu vào IDB `spx_fd_hv/token`
- **Ticket badge:** hiển thị số ticket đang mở trên menu item Ticket Center

**Cross-script integration:**
- Expose `document.documentElement._spxHVSound` getter → `open-2-end` gọi khi kết phiên
- Dùng `SpxShared.idb` để persist HV state và Bearer token
- Lắng nghe `spx-nav` để cleanup panels và re-scan HV

**IDB:** `spx_fd_hv` v3
- `shipments` — HV shipment records
- `tasks` — HV task state
- `token` — Bearer token capture
- `scripts` — pdf.js main + worker (cache tránh re-download)

---

### 4. `open-2-end` — Inbound Flow Orchestrator

Script nặng nhất, điều phối toàn bộ flow nhận hàng tại điểm gửi.

**Tính năng chính:**
- **Login QR:** inject QR code lên sidebar để scan đăng nhập nhanh
- **Mở phiên tự động:** double Ctrl hoặc scan barcode bất kỳ (khi không trong phiên) → navigate tới Receive Task → mở phiên mới
- **Kết phiên tự động:** scan QR đặc biệt hoặc double Ctrl (khi đang trong phiên) → Collect Payment → Complete
- **Tiền cước sound:** phát âm thanh khi Total Collection thay đổi (dùng `_spxInterruptSound`)
- **ensureSpacer:** inject `#spx-spacer` (height 250px) ở TOP sidebar để QR float đúng vị trí
- **Operator name:** detect từ session, cache stale-while-revalidate vào IDB

**Cross-script integration:**
- Đọc `unsafeWindow.SpxLog.getCurrentCod()` từ log-log
- Gọi `unsafeWindow.SpxLog.markVoucherDone()` sau khi hoàn tất phiên
- Gọi `document.documentElement._spxHVSound?.()` khi kết phiên (provided by find-details)
- Dùng `_spxEnqueueSound` và `_spxInterruptSound` (provided by spx-shared)

**SPA:** Lắng nghe `spx-nav` để xử lý redirect sau khi tạo phiên mới.

---

### 5. `log-log` — Activity Logger & KiotVit Bridge

**Tính năng chính:**
- Poll task list mỗi 2s, detect thay đổi COD/status → log vào IDB `spx_log`
- Inject button TM/CK vào Cash Collection UI → user bấm để xác nhận phiếu thu KiotVit
- Annotate danh sách NSS (list view) với trạng thái xử lý
- Expose `unsafeWindow.SpxLog` để các script khác query/mutate voucher state

**Cross-script integration:**
- Gọi `NeonSync.push('spx_events', ...)` sau mỗi logEvent → cloud backup tự động
- Là "source of truth" cho voucher state: open-2-end và Refund-NSS đều consume

**IDB:**
- `spx_log` v1: `events` (append-only), `tasks` (upsert)
- `spx_cf_receipts` v1: `drt` — per-DRT phiếu thu state (TM/CK slot, SSoT cho voucher persistence)

**Public API tại `unsafeWindow.SpxLog`:**
```
SpxLog.logEvent(type, data)
SpxLog.getDrtId()
SpxLog.getCurrentCod()
SpxLog.markVoucherDone(slot)
SpxLog.isVoucherDone(slot)
```

---

### 6. `scan-job` — Scan Page Controller

**Tính năng chính:**
- Error sounds khi scan sai (phân biệt theo loại lỗi)
- Auto-focus input field sau mỗi scan
- Head-n-tail typing: nhận barcode reader input, strip prefix/suffix
- Fire2: tự động trigger action thứ hai khi vào phiên mới
- R4 overflow guard: cảnh báo khi phiên sắp đầy
- Alt+P shortcut in nhãn nhanh
- Welcome/Rok voice theo `operator_suffix` (cache 24h trong IDB)

**Cross-script integration:**
- Dùng `_spxEnqueueSound` cho sound sequencing tuần tự
- Lắng nghe `spx-nav` để reset fire2 flag và clear input cache
- Đọc `SpxShared.idb` cho operator suffix

---

### 7. `sf-keyboard` — Touch Input & Voice

**Tính năng chính:**
- Numpad touch UI cho thiết bị không có bàn phím vật lý
- Function keys (F1–F12) on-screen
- Voice recognition → parse AWB từ giọng nói
- ABC popup cho ký tự đặc biệt

**Cross-script integration:**
- Dùng `SpxShared.getExtraChar`, `SpxShared.isVisible`
- Lắng nghe `spx-nav` để update keyboard visibility

---

### 8. `Refund-NSS` — Hoàn Hàng & Cash Flow

**Tính năng chính:**
- Build QR code VietQR/EMVCo cho từng đơn hoàn
- Auto-upload ảnh proof lên Dropbox (refresh token tự động, không cần thao tác thủ công)
- Backup lên GoFile nếu Dropbox fail
- OCR.space extract thông tin từ ảnh chụp
- Sync trạng thái cash-flow verification với KiotVit
- Persist refund state qua Neon (đồng bộ giữa thiết bị)

**Cross-script integration:**
- Đọc `unsafeWindow.NeonSync` để push/pull `spx_refund_state`
- Dùng `SpxShared.gmReq` cho network requests
- `NeonSync.onPullComplete(cb)` để load refund state sau khi sync xong

---

## IV. DATA LAYER — INDEXEDDB STORES

| Database | Version | Stores | Chủ sở hữu | Nội dung |
|----------|---------|--------|------------|----------|
| `spx_audio` | 1 | `mp3` | spx-shared | MP3 cache (ETag SWR), operator names, HV.mp3 |
| `spx_log` | 1 | `events`, `tasks` | log-log | Activity log, task status history |
| `spx_cf_receipts` | 1 | `drt` | log-log | Voucher state per DRT (TM/CK slots) |
| `spx_fd_hv` | 3 | `shipments`, `tasks`, `token`, `scripts` | find-details | HV state, Bearer token, pdf.js cache |
| `spx_refund_state` | 1 | `cfkeys` | Refund-NSS | Cash-flow verification state |

**Neon PostgreSQL tables** (managed bởi neon-sync):

| Table | Mode | Nguồn dữ liệu |
|-------|------|---------------|
| `spx_events` | upsert | log-log |
| `spx_tasks` | upsert | log-log |
| `spx_receipts` | upsert | log-log |
| `spx_hv_shipments` | upsert | find-details |
| `spx_hv_tasks` | upsert | find-details |
| `spx_audio_cache` | cold | spx-shared |
| `spx_tokens` | cold | find-details |
| `spx_scripts` | cold | find-details (pdf.js) |
| `spx_refund_state` | upsert | Refund-NSS |

---

## V. LUỒNG SPA NAVIGATION

Xảy ra mỗi khi user chuyển trang trong app Vue:

```
User click menu item
  → Vue Router → history.pushState() [đã bị patch bởi spx-shared]
  → window dispatch "spx-nav"
        ↓
  ┌──────────────────────────────────────────────────────┐
  │ Listeners của "spx-nav":                             │
  │                                                      │
  │  open-2-end   → xử lý redirect DRT nếu pending      │
  │  find-details → cleanup panels, re-scan HV tasks     │
  │  log-log      → reset lastFirstTask, wipeAnnotations │
  │  scan-job     → reset fire2 flag, clear input cache  │
  │  sf-keyboard  → setTimeout(updateVisibility, 60ms)   │
  └──────────────────────────────────────────────────────┘
        ↓
  Vue teardown + rebuild sidebar DOM
        ↓
  watchEl MutationObserver fire (spx-shared)
        ↓
  neon-sync detect ".sub-menu-title" = "Help" (node mới)
        ↓
  setTimeout(_injectIndicator, 100ms)
        ↓
  Neon Sync indicator re-inject vào sidebar
```

---

## VI. DEPENDENCY GRAPH

```
spx-shared  (không phụ thuộc ai)
  └── cung cấp cho: TẤT CẢ scripts còn lại

neon-sync
  ├── consume: SpxShared.watchEl, unsafeWindow.fetch
  ├── cung cấp: unsafeWindow.NeonSync
  └── consume bởi: log-log, Refund-NSS

find-details
  ├── consume: SpxShared.idb, SpxShared.loadAudio
  ├── cung cấp: _spxHVSound getter
  └── consume bởi: open-2-end

open-2-end
  ├── consume: SpxShared.*, _spxHVSound (find-details), SpxLog (log-log)
  └── consume: _spxEnqueueSound, _spxInterruptSound (spx-shared)

log-log
  ├── consume: SpxShared.fmtShorthand, NeonSync.push
  ├── cung cấp: unsafeWindow.SpxLog
  └── consume bởi: open-2-end, Refund-NSS

scan-job
  ├── consume: SpxShared.idb, SpxShared.loadAudio, _spxEnqueueSound
  └── không export public API

sf-keyboard
  ├── consume: SpxShared.getExtraChar, SpxShared.isVisible
  └── không export public API

Refund-NSS
  ├── consume: NeonSync.push/onPullComplete, SpxShared.gmReq
  └── không export public API
```

---

## VII. SIDEBAR INJECTION MAP

Hai script inject vào left sidebar, theo thứ tự:

| Script | Element ID | Vị trí | Thời điểm |
|--------|-----------|--------|-----------|
| `open-2-end` | `#spx-spacer` | TOP của sidebar parent | document-end, MutationObserver |
| `neon-sync` | `#_neon_ind` | Trước menu item "Help" | Post-DOMContentLoaded, watchEl |

`open-2-end` cũng inject QR image (`#spx-qr`) và label (`#spx-qr-label`) với `position: fixed` overlay lên trên sidebar — không nằm trong DOM sidebar.

---

## VIII. DEBUGGING INSIGHTS

### Nguyên tắc cốt lõi

Lỗi trong hệ thống multi-script có thể đến từ **một script đơn lẻ**, hoặc từ **sự xung đột giữa nhiều scripts**. Hai loại này có triệu chứng giống nhau nhưng cách fix hoàn toàn khác. Không phân biệt được → debug sai hướng.

### Các dạng xung đột giữa scripts

**1. Tranh chấp DOM injection**
Nhiều script inject vào cùng một vùng DOM. Script này có thể overwrite, dịch chuyển, hoặc xóa element của script kia. Điển hình trong repo: `open-2-end` inject `#spx-spacer` bằng `prepend()` ở TOP sidebar; `neon-sync` inject `#_neon_ind` cũng bằng `prepend()` vào cùng parent. Thứ tự chạy và timing quyết định kết quả cuối cùng.

**2. Tranh chấp event listener**
Nhiều script cùng lắng nghe `spx-nav`, `DOMContentLoaded`, hoặc `MutationObserver` trên cùng node. Callback của script này kích hoạt trước và thay đổi state mà script kia chưa kịp đọc — gây ra kết quả không deterministic tùy theo tốc độ render của từng trang.

**3. Shared global bị ghi đè hoặc chưa sẵn sàng**
Scripts giao tiếp qua `document.documentElement.*` và `unsafeWindow.*`. Nếu script A ghi đè global mà script B đang dùng, hoặc B chạy trước khi A khởi tạo xong global, cả hai đều lỗi theo cách khó trace.

**4. Sort order sai trong Tampermonkey dashboard**
`document-start` scripts chạy theo thứ tự sort thủ công — không được enforce tự động. `spx-shared` **phải** là script đầu tiên. Nếu sort order sai, `SpxShared` chưa tồn tại khi script khác gọi đến, gây `TypeError` âm thầm.

**5. IDB version conflict**
Nhiều script mở cùng một IndexedDB với version khác nhau → version upgrade race → một script bị block không mở được connection.

### Quy trình dò lỗi

```
Bước 1 — Reproduce ổn định trước khi phân tích
  → Xác định điều kiện cụ thể: trang nào, hành động nào, lần thứ mấy
  → Dùng evaluate_script + list_console_messages capture state tại thời điểm lỗi

Bước 2 — Isolate: 1 script hay nhiều script?
  → Disable từng script trong Tampermonkey, reload, kiểm tra lỗi còn không
  → Lỗi mất khi disable X → X là nguyên nhân hoặc trigger
  → Lỗi chỉ mất khi disable đồng thời X + Y → xung đột X và Y

Bước 3 — Trace timing
  → Log timestamp tại các điểm injection
  → So sánh với timing của scripts khác đang thao tác cùng vùng DOM hoặc cùng event

Bước 4 — Kiểm tra shared state
  → evaluate_script check các global: SpxShared, NeonSync, SpxLog
  → Kiểm tra DOM: element có bị overwrite không, className/style có bị thay đổi không

Bước 5 — Không kết luận từ code tĩnh một mình
  → Code đọc tĩnh chỉ cho thấy intent, không cho thấy runtime behavior
  → Mọi kết luận phải được confirm bằng live smoke test trên browser thật qua Edge DevTools MCP
```
