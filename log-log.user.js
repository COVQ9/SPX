// ==UserScript==
// @name         SPX Log-Log (audit history + KiotVit cash flow)
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  Log SPX task activity (Receive Task ID, COD, status, voucher) vào IndexedDB cho audit. Render 2 button "Lập phiếu thu TM/CK" trên task detail (active + Done review) ghi phiếu thu COD vào sổ quỹ KiotVit qua Tailscale; rcptDB persistence per-DRT, done state hiện badge compact. Annotate cột NSS list view với COD shorthand. SSoT cho cross-script (open-2-end gọi qua unsafeWindow.SpxLog).
// @match        https://spx.shopee.vn/*
// @match        https://sp.spx.shopee.vn/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';

// Skip inside iframes. find-details opens a hidden iframe for eye-preview; if
// log-log runs in it, it duplicates IDB writes (events store grows 2× per
// scan), spawns duplicate intervals + observer, and exposes another SpxLog on
// unsafeWindow. Top-frame only.
if (window.top !== window) return;

/* ═══════════════════════════════════════════════
   INDEXEDDB SCHEMA
   DB: spx_log (v1)
   Stores:
     events       — append-only event log, key=auto-increment
       schema: { ts, type, task_id, data, url }
       types:
         task_seen      — task ID xuất hiện trên page
         cod_change     — Total Collection thay đổi
         status_change  — task status (Created/Doing/Completed/...)
         voucher        — phiếu thu/chi đã ghi (open-2-end / Refund-NSS)
         scan           — endtask scan code
     tasks        — projection theo task_id, key=task_id
       schema: { task_id, first_seen, last_seen, max_cod, last_status, voucher_tm?, voucher_ck? }
═══════════════════════════════════════════════ */

const DB_NAME = 'spx_log';
const DB_VERSION = 1;
const ST_EVENTS = 'events';
const ST_TASKS  = 'tasks';

// Single long-lived connection. Previous code opened a fresh handle for every
// CRUD op and closed it on completion → handshake cost on every pollTick log.
// We invalidate on `versionchange` (another tab upgrading the schema).
let _db = null;
let _dbPromise = null;
function idbOpen() {
    if (_db) return Promise.resolve(_db);
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((res, rej) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(ST_EVENTS)) {
                const s = db.createObjectStore(ST_EVENTS, { keyPath: 'id', autoIncrement: true });
                s.createIndex('task_id', 'task_id', { unique: false });
                s.createIndex('type', 'type', { unique: false });
                s.createIndex('ts', 'ts', { unique: false });
            }
            if (!db.objectStoreNames.contains(ST_TASKS)) {
                db.createObjectStore(ST_TASKS, { keyPath: 'task_id' });
            }
        };
        req.onsuccess = () => {
            _db = req.result;
            _db.onversionchange = () => { try { _db.close(); } catch {} _db = null; _dbPromise = null; };
            _dbPromise = null;
            res(_db);
        };
        req.onerror = () => { _dbPromise = null; rej(req.error); };
    });
    return _dbPromise;
}

function idbAdd(store, value) {
    return idbOpen().then(db => new Promise((res, rej) => {
        const req = db.transaction(store, 'readwrite').objectStore(store).add(value);
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
    }));
}
function idbPut(store, value) {
    return idbOpen().then(db => new Promise((res, rej) => {
        const req = db.transaction(store, 'readwrite').objectStore(store).put(value);
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
    }));
}
function idbGet(store, key) {
    return idbOpen().then(db => new Promise((res, rej) => {
        const req = db.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
    }));
}
function idbAll(store, indexName, keyRange) {
    return idbOpen().then(db => new Promise((res, rej) => {
        const tx = db.transaction(store, 'readonly');
        const src = indexName ? tx.objectStore(store).index(indexName) : tx.objectStore(store);
        const req = src.getAll(keyRange);
        req.onsuccess = () => res(req.result || []);
        req.onerror   = () => rej(req.error);
    }));
}

/* ═══════════════════════════════════════════════
   PAGE EXTRACTION HELPERS — task ID, status, COD, page-mode detection.
   Single regex DRT_RE (lax) — ID có thể có hoặc không có 8-digit date prefix.
   Single getDrtId() — URL ưu tiên, fallback DOM span (heading).
═══════════════════════════════════════════════ */
const DRT_RE = /DRT[A-Z0-9]+/;

/** Extract task ID. URL pathname (active hoặc detail/create) ưu tiên,
 *  fallback DOM `span.task-info-task-id` (heading task page).
 *  KHÔNG fallback page-wide textContent — list view có nhiều DRT trong rows
 *  → trả random ID gây log polluted. */
function getDrtId() {
    const fromUrl = (location.pathname.match(DRT_RE) || [])[0] || null;
    const span    = document.querySelector('span.task-info-task-id');
    const fromDom = (span?.textContent.match(DRT_RE) || [])[0] || null;
    if (fromUrl && fromDom && fromUrl !== fromDom) {
        console.warn('[SPX-LOG] DRT ID mismatch — URL:', fromUrl, 'DOM:', fromDom, '— prefer DOM');
    }
    return fromDom || fromUrl || null;
}

function getCurrentStatus() {
    const el = document.querySelector('section.task-info-task-status');
    return el ? el.textContent.trim() : null;
}

function getCurrentCod() {
    const sec = [...document.querySelectorAll('section.task-info-amount-item')]
        .find(s => s.textContent.includes('Total Collection'));
    if (!sec) return null;
    const raw = sec.querySelector('p')?.textContent.trim();
    if (!raw || raw === '–' || raw === '') return 0;
    const v = parseFloat(raw.replace(/,/g, ''));
    return isNaN(v) ? null : v;
}

/** Page mode — phân biệt task detail (có heading task-info-task-id)
 *  vs list view / khác (không có). */
function isOnTaskDetailPage() {
    return !!document.querySelector('span.task-info-task-id');
}

/** Format VND shorthand: 0 → "0k", 250000 → "250k", 1250000 → "1tr250k", 1000000 → "1tr". */
function fmtShorthand(n) {
    if (n === 0) return '0k';
    if (n < 1000) return String(n);
    const tr = Math.floor(n / 1_000_000);
    const k  = (n % 1_000_000) / 1000;
    if (tr === 0) return `${k}k`;
    if (k === 0)  return `${tr}tr`;
    return `${tr}tr${k}k`;
}

/* ═══════════════════════════════════════════════
   EVENT LOGGER
═══════════════════════════════════════════════ */
async function logEvent(type, data = null, taskIdOverride = null) {
    const taskId = taskIdOverride ?? getDrtId();
    const ev = {
        ts: Date.now(),
        type,
        task_id: taskId,
        data,
        url: location.pathname
    };
    // Single transaction: append event + update task projection atomically.
    // Tránh race lost-update khi 2 logEvent concurrent (cod_change + voucher).
    try {
        const db = await idbOpen();
        await new Promise((res, rej) => {
            const stores = taskId ? [ST_EVENTS, ST_TASKS] : [ST_EVENTS];
            const tx = db.transaction(stores, 'readwrite');
            tx.objectStore(ST_EVENTS).add(ev);
            if (taskId) {
                const tStore = tx.objectStore(ST_TASKS);
                const getReq = tStore.get(taskId);
                getReq.onsuccess = () => {
                    const prev = getReq.result || null;
                    const t = prev || {
                        task_id: taskId, first_seen: ev.ts,
                        max_cod: 0, last_cod: 0, last_status: null
                    };
                    t.last_seen = ev.ts;
                    if (type === 'cod_change') {
                        // last_cod = giá trị hiện tại (có thể giảm khi user gỡ đơn).
                        // max_cod = historical max (chỉ tăng) — giữ cho audit.
                        t.last_cod = data?.amount ?? 0;
                        if (data?.amount > (t.max_cod || 0)) t.max_cod = data.amount;
                    }
                    if (type === 'status_change' && data?.status) t.last_status = data.status;
                    if (type === 'voucher' && data?.method === 'cash') t.voucher_tm = { amount: data.amount, code: data.code, ts: ev.ts };
                    if (type === 'voucher' && data?.method === 'bank') t.voucher_ck = { amount: data.amount, code: data.code, ts: ev.ts };
                    tStore.put(t);
                };
            }
            // KHÔNG db.close(): db là connection dùng chung sống lâu (_db).
            // Đóng sau mỗi logEvent sẽ giết connection của toàn script.
            tx.oncomplete = () => res();
            tx.onerror    = () => rej(tx.error);
        });
        console.log('[SPX-LOG]', type, taskId || '(no-task)', data ?? '');
    } catch (e) {
        console.warn('[SPX-LOG] logEvent failed', type, e);
    }
    return ev;
}

/* ═══════════════════════════════════════════════
   POLLING — track lifecycle changes mỗi 2s.
   Diff cache vs current → log only on change để tránh duplicate noise.
═══════════════════════════════════════════════ */
let lastTaskId = null;
let lastStatus = null;
let lastCod    = null;

function pollTick() {
    // Cheap-bail when tab is backgrounded — no point logging COD changes the
    // user isn't watching, and Chrome throttles 1Hz anyway. Resume when visible.
    if (document.hidden) return;
    if (!location.pathname.startsWith('/inbound-management')) return;

    // List view không có task heading → bail (tránh log polluted với DRT trong rows).
    // Chỉ log khi đang ở trang task detail (active hoặc Done review).
    if (!isOnTaskDetailPage()) {
        ensureCfIncomeBtns();   // vẫn cleanup buttons nếu navigate sang list
        return;
    }

    const taskId = getDrtId();
    if (taskId && taskId !== lastTaskId) {
        lastTaskId = taskId;
        lastStatus = null; lastCod = null;
        logEvent('task_seen', null, taskId);
    }
    if (!taskId) return;

    const status = getCurrentStatus();
    if (status && status !== lastStatus) {
        lastStatus = status;
        logEvent('status_change', { status }, taskId);
    }

    const cod = getCurrentCod();
    if (cod !== null && cod !== lastCod) {
        lastCod = cod;
        logEvent('cod_change', { amount: cod }, taskId);
    }

    // Render/refresh KiotVit cash flow buttons hoặc badges.
    ensureCfIncomeBtns();
}
setInterval(pollTick, 2000);

/* ═══════════════════════════════════════════════
   PUBLIC API — exposed on unsafeWindow.SpxLog (cross-script: open-2-end gọi).
   Voucher state read sync qua rcptCache (preloaded từ rcptDB ở section dưới).
═══════════════════════════════════════════════ */

/** Voucher slot lookup — sync via rcptCache. */
function getVoucherSlot(taskId, method) {
    const rec = rcptCache.get(taskId);
    if (!rec) return null;
    return method === 'cash' ? (rec.tm || null) : (rec.ck || null);
}
function isVoucherDoneSync(taskId, method) {
    return !!getVoucherSlot(taskId, method);
}

const SpxLog = {
    // Detection
    getCurrentTaskId: getDrtId,    // alias backward-compat
    getDrtId,
    getCurrentStatus,
    getCurrentCod,

    // Event logging
    logEvent,

    // Voucher helpers (cross-script — sync read, async write)
    isVoucherDone: isVoucherDoneSync,
    markVoucherDone,           // async (taskId, method, amount, code, extras?)
    getVoucherSlot,

    // Query
    async listTasks() { return idbAll(ST_TASKS); },
    async listReceipts() {
        // Snapshot of rcptDB
        return [...rcptCache.values()];
    },
    async listEvents(filter) {
        if (!filter) return idbAll(ST_EVENTS);
        if (filter.task_id) return idbAll(ST_EVENTS, 'task_id', IDBKeyRange.only(filter.task_id));
        if (filter.type)    return idbAll(ST_EVENTS, 'type', IDBKeyRange.only(filter.type));
        if (filter.since)   return idbAll(ST_EVENTS, 'ts', IDBKeyRange.lowerBound(filter.since));
        return idbAll(ST_EVENTS);
    },
    async exportJson() {
        const [tasks, events] = await Promise.all([idbAll(ST_TASKS), idbAll(ST_EVENTS)]);
        const receipts = [...rcptCache.values()];
        return JSON.stringify({ exported_at: Date.now(), tasks, events, receipts }, null, 2);
    },
    /** Clear cả 2 DB (spx_log + spx_cf_receipts) + in-memory cache. Debug-only.
     *  Requires confirmation token to prevent malicious/buggy page JS (which
     *  also sees unsafeWindow.SpxLog) from wiping audit history. To run from
     *  DevTools: `await SpxLog.clearAll('CONFIRM_WIPE_SPX_LOG')`.
     *  Old signature `clearAll()` (no arg) is now a no-op that throws. */
    async clearAll(token) {
        if (token !== 'CONFIRM_WIPE_SPX_LOG') {
            throw new Error('SpxLog.clearAll requires confirmation token (see source)');
        }
        const db1 = await idbOpen();
        await new Promise((res, rej) => {
            const tx = db1.transaction([ST_EVENTS, ST_TASKS], 'readwrite');
            tx.objectStore(ST_EVENTS).clear();
            tx.objectStore(ST_TASKS).clear();
            tx.oncomplete = res;
            tx.onerror    = () => rej(tx.error);
        });
        const db2 = await rcptOpen();
        await new Promise((res, rej) => {
            const tx = db2.transaction(RCPT_STORE, 'readwrite');
            tx.objectStore(RCPT_STORE).clear();
            tx.oncomplete = res;
            tx.onerror    = () => rej(tx.error);
        });
        rcptCache.clear();
        lastTaskId = null; lastStatus = null; lastCod = null;
    }
};

// Expose qua unsafeWindow để cross-script access (open-2-end gọi).
unsafeWindow.SpxLog = SpxLog;

/* ═══════════════════════════════════════════════
   RECEIPT LEDGER (IndexedDB) — persistent per-DRT phiếu thu memory.
   DB `spx_cf_receipts` v1, store `drt`, key = DRT_ID.
   Source-of-truth duy nhất cho idempotency phiếu thu — survive reload, tab close,
   browser restart. Cho phép trang Detail review hiện trạng thái "đã thu".
═══════════════════════════════════════════════ */
const RCPT_DB    = 'spx_cf_receipts';
const RCPT_STORE = 'drt';
const rcptCache = new Map();   // drt → record (sync access cho ensureCfIncomeBtns)

// Single long-lived rcpt connection. Same rationale as idbOpen above.
let _rcptDb = null;
let _rcptPromise = null;
function rcptOpen() {
    if (_rcptDb) return Promise.resolve(_rcptDb);
    if (_rcptPromise) return _rcptPromise;
    _rcptPromise = new Promise((res, rej) => {
        const req = indexedDB.open(RCPT_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(RCPT_STORE);
        req.onsuccess = () => {
            _rcptDb = req.result;
            _rcptDb.onversionchange = () => { try { _rcptDb.close(); } catch {} _rcptDb = null; _rcptPromise = null; };
            _rcptPromise = null;
            res(_rcptDb);
        };
        req.onerror = () => { _rcptPromise = null; rej(req.error); };
    });
    return _rcptPromise;
}

// Atomic read-modify-write trong cùng transaction để tránh ghi đè giữa 2 click.
async function rcptMerge(drt, patch) {
    if (!drt) return;
    const db = await rcptOpen();
    return new Promise((res, rej) => {
        const tx = db.transaction(RCPT_STORE, 'readwrite');
        const store = tx.objectStore(RCPT_STORE);
        const getReq = store.get(drt);
        getReq.onsuccess = () => {
            const now = Date.now();
            const prev = getReq.result || null;
            const merged = {
                drt,
                ...prev,
                ...patch,
                createdAt: prev?.createdAt || now,
                updatedAt: now,
            };
            rcptCache.set(drt, merged);
            store.put(merged, drt);
        };
        tx.oncomplete = () => res();
        tx.onerror    = () => rej(tx.error);
    });
}

async function preloadRcpt() {
    try {
        const db = await rcptOpen();
        await new Promise((res, rej) => {
            const tx = db.transaction(RCPT_STORE, 'readonly');
            const cur = tx.objectStore(RCPT_STORE).openCursor();
            cur.onsuccess = () => {
                const c = cur.result;
                if (c) { rcptCache.set(c.key, c.value); c.continue(); }
                else res();
            };
            cur.onerror = () => rej(cur.error);
        });
        console.log('[SPX-LOG] preloaded', rcptCache.size, 'rcpt records');
    } catch (e) { console.warn('[SPX-LOG] preloadRcpt', e); }
}
preloadRcpt();

/* ═══════════════════════════════════════════════
   DRT PAGE HELPERS — phân biệt page inbound đang làm vs Detail review (Done).
   Detail signals (any of):
     - Status chip `section.task-info-task-status.task-info-task-done`
     - Print Receipt button (chỉ render khi task Done)
   (DRT_RE + getDrtId định nghĩa ở section TASK ID EXTRACTION đầu file.)
═══════════════════════════════════════════════ */

function getPrintReceiptBtn() {
    return [...document.querySelectorAll('button.ssc-button.task-info-task-action.ssc-btn-type-primary')]
        .find(b => b.textContent.trim() === 'Print Receipt') || null;
}

function isTaskDoneChip() {
    return !!document.querySelector('section.task-info-task-status.task-info-task-done');
}

function isReceiveTaskDetail() {
    if (!/^\/inbound-management\/receive-task\//i.test(location.pathname)) return false;
    if (!document.querySelector('span.task-info-task-id')) return false;
    return isTaskDoneChip() || !!getPrintReceiptBtn();
}

/** Anchor: Collect Payment / Complete (active) hoặc Print Receipt (done). */
function getCfAnchor() {
    const enabled = getCompleteBtn();
    if (enabled) return enabled;
    // Done detail: Complete button mất → fallback Print Receipt.
    const print = getPrintReceiptBtn();
    if (print) return print;
    // Last resort: bất kỳ task-info-task-action button nào (kể cả disabled).
    // Selector KHÔNG có :not(.ssc-btn-disabled) → match cả disabled state.
    const any = document.querySelector('button.task-info-task-action');
    return any || null;
}

function getSenderName() {
    const els = [...document.querySelectorAll('span,div,section')];
    const el = els.find(n => /^\s*Sender Name\b/.test(n.textContent || ''));
    if (!el) return '';
    return el.textContent.replace(/^\s*Sender Name\s*[?:：]?\s*/, '').trim().slice(0, 80);
}

/* ═══════════════════════════════════════════════
   KIOTVIT CASH BOOK — POST /api/cash-flow + render 2 button TM/CK
   trái Collect Payment (active) hoặc Print Receipt (Done detail).
   TM (vàng): cash_source=ket; CK (xanh): bank_account=Ka Bê
   Persistence: rcptDB → done = badge (compact, không clickable).
═══════════════════════════════════════════════ */

const KV_BASE_URL = 'http://pavi:9009';
const KV_BANK     = 'Ka Bê';
const KV_CASH_SRC = 'ket';
// Auth — KiotVit chặn /api/* với preHandler; chỉ bỏ qua cho localhost +
// dải Tailscale 100.64/10. Userscript chạy ở origin sp.spx.shopee.vn nên
// request tới pavi:9009 KHÔNG được bỏ qua → phải gửi Bearer token.
// Luồng cross-origin chuẩn của KiotVit: POST /api/auth/pin {pin} → token (90d).
const KV_PIN       = '112018';
const KV_TOKEN_KEY = 'spx_kv_token_v1';
const ROUND_UNIT = 1000;
const ROUND_DOWN_THRESHOLD = 149;
let kvSpxCatIdCached = null;

function gmReqJson(opts) {
    return new Promise((res, rej) => {
        GM_xmlhttpRequest({ ...opts,
            onload: r => (r.status >= 200 && r.status < 300
                ? res(r) : rej(new Error(`HTTP ${r.status}: ${(r.responseText||'').slice(0,200)}`))),
            onerror: () => rej(new Error('network')),
            ontimeout: () => rej(new Error('timeout'))
        });
    });
}
function kvGetToken() {
    try { return localStorage.getItem(KV_TOKEN_KEY) || null; } catch { return null; }
}
function kvSetToken(t) {
    try { t ? localStorage.setItem(KV_TOKEN_KEY, t) : localStorage.removeItem(KV_TOKEN_KEY); } catch {}
}

// POST /api/auth/pin → token. Route này được preHandler bỏ qua auth nên
// gọi bằng gmReqJson trần (không Bearer).
async function kvLogin() {
    const r = await gmReqJson({
        method: 'POST',
        url: `${KV_BASE_URL}/api/auth/pin`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ pin: KV_PIN })
    });
    const j = JSON.parse(r.responseText);
    if (!j.token) throw new Error('login KiotVit: không nhận được token');
    kvSetToken(j.token);
    return j.token;
}

// gmReqJson + Bearer. Chưa có token → login. Gặp 401 (token hết hạn / secret
// đổi) → xoá cache, login lại, retry đúng 1 lần.
async function kvAuthedReq(opts) {
    const withAuth = (tk) => ({ ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${tk}` } });
    let token = kvGetToken() || await kvLogin();
    try {
        return await gmReqJson(withAuth(token));
    } catch (e) {
        if (!/^HTTP 401/.test(e.message)) throw e;
        kvSetToken(null);
        token = await kvLogin();
        return await gmReqJson(withAuth(token));
    }
}

function kvUid() {
    const a = new Uint8Array(8); crypto.getRandomValues(a);
    return [...a].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function roundVnd(n) {
    const remainder = n % ROUND_UNIT;
    if (remainder <= ROUND_DOWN_THRESHOLD) return Math.floor(n / ROUND_UNIT) * ROUND_UNIT;
    return Math.ceil(n / ROUND_UNIT) * ROUND_UNIT;
}

async function kvDiscoverSpxCategory() {
    if (kvSpxCatIdCached) return kvSpxCatIdCached;
    const r = await kvAuthedReq({ method: 'GET', url: `${KV_BASE_URL}/api/cash-categories` });
    const list = JSON.parse(r.responseText);
    if (!Array.isArray(list)) throw new Error('format danh mục lạ');
    const spx = list.find(c => c.tag === 'SPX')
              || list.find(c => /spx/i.test(c.tag||'') || /spx/i.test(c.name||''));
    if (!spx) throw new Error('Không tìm thấy danh mục SPX trong KiotVit');
    kvSpxCatIdCached = spx.id;
    return spx.id;
}

async function kvPushIncome(method, amount, taskId) {
    const catId = await kvDiscoverSpxCategory();
    const ts = new Date().toLocaleString('vi-VN', { hour12: false });   // "08/05/2026 16:23:40"
    const drt = taskId || getDrtId() || '';
    const note = drt ? `COD ${ts} · ${drt}` : `COD ${ts}`;
    const body = {
        id: kvUid(),
        type: 'income',
        amount,
        method,
        category: 'manual',
        category_id: catId,
        party_id: 'NOI_BO',
        party_type: 'customer',
        note,
        created_via: 'spx-log-log-userscript'
    };
    if (method === 'cash') body.cash_source = KV_CASH_SRC;
    else body.bank_account = KV_BANK;

    const r = await kvAuthedReq({
        method: 'POST',
        url: `${KV_BASE_URL}/api/cash-flow`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body)
    });
    const j = JSON.parse(r.responseText);
    if (!j.id) throw new Error(j.error || 'no id in response');
    return j;
}

/* ── Toast (self-contained — không phụ thuộc open-2-end) ── */
const TOAST_CSS =
    'position:fixed;right:18px;bottom:38px;z-index:999999;' +
    'padding:10px 14px;background:rgba(0,0,0,0.82);color:white;' +
    'border-radius:8px;font-size:14px;font-family:system-ui,sans-serif;' +
    'box-shadow:0 6px 18px rgba(0,0,0,0.3);opacity:0;transition:opacity 0.25s;max-width:380px;';

function logToast(msg, timeout = 3000) {
    let el = document.getElementById('spx-log-toast');
    if (!el) {
        el = Object.assign(document.createElement('div'), { id: 'spx-log-toast' });
        el.style.cssText = TOAST_CSS;
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => el.style.opacity = '0', timeout);
}

/* ── Complete/Collect Payment button selector ── */
function getCompleteBtn() {
    const candidates = document.querySelectorAll('button.ssc-button.task-info-task-action.ssc-btn-type-primary:not(.ssc-btn-disabled)');
    for (const b of candidates) {
        const t = b.textContent.trim();
        if (t === 'Complete' || t === 'Collect Payment') return b;
    }
    return null;
}

function isInboundTask() { return location.pathname.startsWith('/inbound-management'); }

/* ── Income button factory + state machine ── */
function makeIncomeBtn(label, method, amount, taskId) {
    const btn = document.createElement('button');
    btn.className = `spx-cf-btn spx-cf-${label.toLowerCase()}-btn`;
    btn.type = 'button';
    btn.dataset.spxCfMethod = method;
    btn.dataset.spxCfAmount = String(amount);
    btn.dataset.spxCfState  = 'idle';
    btn.dataset.spxCfTaskId = taskId;

    const BASE_BG = method === 'cash' ? '#eab308' : '#16a34a';
    const BASE_FG = method === 'cash' ? '#1f2937' : '#fff';

    Object.assign(btn.style, {
        padding: '8px 14px', marginRight: '8px', flexShrink: '0',
        background: BASE_BG, color: BASE_FG,
        border: 'none', borderRadius: '6px', cursor: 'pointer',
        fontSize: '13px', fontWeight: '600', fontFamily: 'system-ui,sans-serif',
        whiteSpace: 'nowrap', transition: 'background-color .15s',
        pointerEvents: 'auto', position: 'relative', zIndex: '10'
    });

    let confirmTimer = null;
    const getAmount = () => parseInt(btn.dataset.spxCfAmount, 10) || 0;
    const getState  = () => btn.dataset.spxCfState || 'idle';
    const setState  = (s) => { btn.dataset.spxCfState = s; };

    const setIdle = () => {
        setState('idle'); btn.disabled = false;
        btn.textContent = `Lập phiếu thu ${label} ${fmtShorthand(getAmount())}`;
        btn.style.background = BASE_BG; btn.style.color = BASE_FG;
        btn.title = `POST /api/cash-flow type=income method=${method} amount=${getAmount()}`;
    };
    const setConfirming = () => {
        setState('confirming');
        btn.textContent = `Xác nhận ${label} ${fmtShorthand(getAmount())} ?`;
        btn.style.background = '#000'; btn.style.color = '#fff';
    };
    const setSending = () => {
        setState('sending'); btn.disabled = true;
        btn.textContent = `Đang gửi ${label}…`;
        btn.style.background = '#6b7280'; btn.style.color = '#fff';
    };
    const setDone = (code) => {
        setState('done'); btn.disabled = true;
        btn.textContent = `Đã lập phiếu thu ${label} ${fmtShorthand(getAmount())}`;
        btn.style.background = BASE_BG; btn.style.color = BASE_FG;
        // code lưu trong rcptDB cho audit; KHÔNG hiện trong button text (gọn hơn).
    };
    const setError = (reason) => {
        setState('error'); btn.disabled = false;
        btn.textContent = `✕ Lỗi ${label} — bấm lại`;
        btn.style.background = '#dc2626'; btn.style.color = '#fff';
        btn.title = `Lỗi: ${reason} — click để thử lại`;
    };

    if (isVoucherDoneSync(taskId, method)) setDone();
    else setIdle();

    async function doSend() {
        const currentAmount = getAmount();
        const currentTaskId = btn.dataset.spxCfTaskId;
        setSending();
        try {
            const res = await kvPushIncome(method, currentAmount, currentTaskId);
            await markVoucherDone(currentTaskId, method, currentAmount, res.code, {
                source: isReceiveTaskDetail() ? 'detail' : 'inbound',
                duplicate: !!res.already_exists
            });
            // Toast success bỏ — button text "Đã lập phiếu thu ..." + badge swap đã rõ.
            // Trigger swap button → badge ngay (ensureCfIncomeBtns sẽ replace).
            ensureCfIncomeBtns();
        } catch (err) {
            setError(err.message);
            logToast(`✕ Ghi phiếu thu thất bại: ${err.message}`, 5000);
        }
    }

    const handler = async (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        const state = getState();
        console.log('[SPX-CF]', label, 'click — state=', state, 'amount=', getAmount());
        if (state === 'sending' || state === 'done') return;
        if (state === 'error') { await doSend(); return; }
        if (state === 'idle') {
            setConfirming();
            confirmTimer = setTimeout(setIdle, 3000);
            return;
        }
        if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
        await doSend();
    };
    btn.addEventListener('click', handler, { capture: true });
    return btn;
}

/* markVoucherDone — exposed via SpxLog. Persist rcptDB + log audit event. */
async function markVoucherDone(taskId, method, amount, code, extras) {
    const slot = {
        code: code || null,
        amount,
        ts: Date.now(),
        ...(extras || {})
    };
    const slotKey = method === 'cash' ? 'tm' : 'ck';
    // Persist vào rcptDB (SSoT) + log event (audit trail).
    await rcptMerge(taskId, {
        amount,
        sender: extras?.sender || getSenderName() || '',
        operator: extras?.operator || '',
        [slotKey]: slot,
    });
    return logEvent('voucher', { method, amount, code }, taskId);
}

/* Result badge — render khi voucher done (replace button). Compact, không clickable. */
function makeResultBadge(label, method, amount, code) {
    const span = document.createElement('span');
    span.className = `spx-cf-result spx-cf-${label.toLowerCase()}-result`;
    span.dataset.spxCfMethod = method;
    const BG = method === 'cash' ? '#fef3c7' : '#dcfce7';
    const FG = method === 'cash' ? '#92400e' : '#166534';
    const BORDER = method === 'cash' ? '#eab308' : '#16a34a';
    Object.assign(span.style, {
        display: 'inline-flex', alignItems: 'center',
        padding: '6px 10px', marginRight: '8px', flexShrink: '0',
        background: BG, color: FG,
        border: `1px solid ${BORDER}`, borderRadius: '6px',
        fontSize: '12px', fontWeight: '600', fontFamily: 'system-ui,sans-serif',
        whiteSpace: 'nowrap', position: 'relative'
    });
    span.textContent = `Đã lập phiếu thu ${label} ${fmtShorthand(amount)}`;
    // Custom tooltip phía trên badge (consistent với check icon ở NSS column).
    const tip = document.createElement('span');
    Object.assign(tip.style, {
        position: 'absolute',
        bottom: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)',
        padding: '5px 9px', background: '#1f2937', color: '#fff',
        fontSize: '12px', fontWeight: '500', borderRadius: '4px',
        whiteSpace: 'nowrap', pointerEvents: 'none',
        opacity: '0', transition: 'opacity .15s', zIndex: '999999',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)'
    });
    tip.textContent = `Đã lập phiếu thu ${label} ${fmtShorthand(amount)}${code ? ' · ' + code : ''}`;
    span.appendChild(tip);
    span.addEventListener('mouseenter', () => { tip.style.opacity = '1'; });
    span.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    return span;
}

function ensureCfIncomeBtns() {
    if (!isInboundTask()) return;
    // Anchor: Collect Payment / Complete (active) hoặc Print Receipt / disabled (Done detail).
    const anchor = getCfAnchor();
    const cod = getCurrentCod();
    const taskId = getDrtId();
    if (!anchor || !taskId) {
        document.querySelectorAll('.spx-cf-btn, .spx-cf-result').forEach(b => b.remove());
        return;
    }
    // COD=0/null + chưa có voucher → không render gì (không có gì để ghi).
    // COD=0 + đã có voucher (Done detail revisit, Total Collection cleared) → vẫn
    // render badge để user thấy proof "đã ghi phiếu thu". Dùng amount từ slot.
    const hasAnyVoucher = !!getVoucherSlot(taskId, 'cash') || !!getVoucherSlot(taskId, 'bank');
    if ((cod == null || cod <= 0) && !hasAnyVoucher) {
        document.querySelectorAll('.spx-cf-btn, .spx-cf-result').forEach(b => b.remove());
        return;
    }
    const parent = anchor.parentElement;
    if (!parent) return;
    // Amount: từ COD hiện tại nếu có, fallback từ voucher slot (Done detail revisit).
    const amount = (cod != null && cod > 0) ? roundVnd(cod)
                 : (getVoucherSlot(taskId, 'cash')?.amount || getVoucherSlot(taskId, 'bank')?.amount || 0);

    // Nếu một method đã done thì ẩn button method kia (chống bấm nhầm tạo phiếu trùng).
    // SPX thực tế chỉ có 1 luồng tiền: hoặc TM hoặc CK, không phải cả hai.
    const anyDone = !!getVoucherSlot(taskId, 'cash') || !!getVoucherSlot(taskId, 'bank');

    // Render từng method độc lập: badge nếu done (rcptDB has slot), button nếu chưa.
    // Vị trí: TM (cash) bên trái CK (bank), CK bên trái anchor.
    for (const [method, label] of [['bank', 'CK'], ['cash', 'TM']]) {
        const slotClass = method === 'cash' ? 'tm' : 'ck';
        const slot = getVoucherSlot(taskId, method);
        const existing = parent.querySelector(`.spx-cf-${slotClass}-btn, .spx-cf-${slotClass}-result`);

        // Method khác đã done → method này KHÔNG render button (chống duplicate).
        if (!slot && anyDone) {
            if (existing) existing.remove();
            continue;
        }

        if (slot) {
            // Voucher đã ghi — render badge (hide button).
            const isAlreadyBadge = existing?.classList.contains(`spx-cf-${slotClass}-result`);
            if (isAlreadyBadge) {
                const expected = `Đã lập phiếu thu ${label} ${fmtShorthand(slot.amount || amount)}`;
                if (existing.textContent !== expected) existing.textContent = expected;
                continue;
            }
            const badge = makeResultBadge(label, method, slot.amount || amount, slot.code || '');
            if (existing) existing.replaceWith(badge);
            else {
                const ckEl = parent.querySelector('.spx-cf-ck-btn, .spx-cf-ck-result');
                const anchorEl = (method === 'cash' && ckEl) ? ckEl : anchor;
                parent.insertBefore(badge, anchorEl);
            }
        } else {
            // Chưa ghi — render button.
            const isAlreadyButton = existing?.classList.contains(`spx-cf-${slotClass}-btn`);
            if (isAlreadyButton) {
                const storedAmount = parseInt(existing.dataset.spxCfAmount || '0', 10);
                const storedTask   = existing.dataset.spxCfTaskId || '';
                if (storedAmount !== amount || storedTask !== taskId) {
                    existing.dataset.spxCfAmount = String(amount);
                    existing.dataset.spxCfTaskId = taskId;
                    if (existing.dataset.spxCfState === 'idle') {
                        existing.textContent = `Lập phiếu thu ${label} ${fmtShorthand(amount)}`;
                        existing.title = `POST /api/cash-flow type=income method=${method} amount=${amount}`;
                    }
                }
                continue;
            }
            const btn = makeIncomeBtn(label, method, amount, taskId);
            if (existing) existing.replaceWith(btn);
            else {
                const ckEl = parent.querySelector('.spx-cf-ck-btn, .spx-cf-ck-result');
                const anchorEl = (method === 'cash' && ckEl) ? ckEl : anchor;
                parent.insertBefore(btn, anchorEl);
            }
        }
    }
}

/* ═══════════════════════════════════════════════
   LIST VIEW ANNOTATION — chèn COD shorthand kế "Yes" của col NSS.
   Pattern td: <td><div><span class="td-content">Yes</span></div></td>
   Chỉ annotate task đã có data trong IDB (phiên mới user đã visit detail).
   Phiên lịch sử (chưa có data) → để nguyên "Yes", không tag.
═══════════════════════════════════════════════ */

/** Detect list view qua DOM — có column header "NSS" + "Receive Task ID". */
function isDropOffListView() {
    const headers = document.querySelectorAll('th, .ssc-table-th');
    if (!headers.length) return false;
    let hasNss = false, hasTaskId = false;
    for (const h of headers) {
        const t = h.textContent.trim();
        if (t === 'NSS') hasNss = true;
        else if (t === 'Receive Task ID') hasTaskId = true;
        if (hasNss && hasTaskId) return true;
    }
    return false;
}

/** Lấy text gốc của cell, EXCLUDE tag annotation của ta.
 *  Vue reuse tr khi paginate → text node có thể thay đổi nhưng span cũ dính lại
 *  → textContent gộp = "Yes(32k)✓" (sai). Clone + strip rồi mới compare. */
function rawCellText(td) {
    const content = td.querySelector('.td-content');
    if (!content) return td.textContent.trim();
    const clone = content.cloneNode(true);
    clone.querySelectorAll('.spx-cod-tag, .spx-cf-check').forEach(e => e.remove());
    return clone.textContent.trim();
}

async function annotateNssColumn() {
    if (!isDropOffListView()) return;
    const rows = document.querySelectorAll('tr.ssc-table-row, tr[class*="table-row"]');
    if (!rows.length) return;

    const todo = [];
    for (const tr of rows) {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 6) continue;
        let taskIdCell = null, nssCell = null;
        for (const td of tds) {
            const text = rawCellText(td);
            if (!taskIdCell && /^DRT[\dA-Z]+$/.test(text)) taskIdCell = td;
            else if (!nssCell && (text === 'Yes' || text === 'No')) nssCell = td;
            if (taskIdCell && nssCell) break;
        }
        if (!taskIdCell || !nssCell) continue;
        const taskId = rawCellText(taskIdCell);

        // Vue reuse tr giữa pages — task ID có thể đã đổi. Cleanup stale annotation
        // trước khi quyết định annotate mới.
        const lastTask = tr.dataset.spxAnnotatedTask;
        if (lastTask !== taskId) {
            tr.querySelectorAll('.spx-cod-tag, .spx-cf-check').forEach(e => e.remove());
            tr.dataset.spxAnnotatedTask = taskId;
        }

        if (rawCellText(nssCell) !== 'Yes') continue;
        // Idempotent — skip nếu đã annotate cho task hiện tại.
        if (nssCell.querySelector('.spx-cod-tag')) continue;
        todo.push({
            taskId,
            target: nssCell.querySelector('span.td-content') || nssCell.querySelector('span') || nssCell
        });
    }
    if (!todo.length) return;

    // Batch IDB read trong 1 transaction.
    let db;
    try { db = await idbOpen(); } catch { return; }
    const tx = db.transaction(ST_TASKS, 'readonly');
    const store = tx.objectStore(ST_TASKS);
    await Promise.all(todo.map(item => new Promise(res => {
        const req = store.get(item.taskId);
        req.onsuccess = () => {
            const t = req.result;
            if (t && !item.target.querySelector('.spx-cod-tag')) {
                // Display giá trị HIỆN TẠI (last_cod) — không phải historical max.
                // User gỡ đơn → COD về 0 → hiện (0k) thay vì stale (22k).
                // Fallback max_cod cho data legacy chưa có last_cod field.
                const cod = (typeof t.last_cod === 'number') ? t.last_cod : (t.max_cod || 0);
                const tag = document.createElement('span');
                tag.className = 'spx-cod-tag';
                tag.style.cssText = 'margin-left:6px;color:#16a34a;font-weight:700;font-size:15px;';
                tag.textContent = `(${fmtShorthand(cod)})`;
                item.target.appendChild(tag);

                // Voucher check icon — phiên đã lập phiếu thu (rcptDB có slot tm hoặc ck).
                const rec = rcptCache.get(item.taskId);
                if (rec && (rec.tm || rec.ck)) {
                    const check = document.createElement('span');
                    check.className = 'spx-cf-check';
                    Object.assign(check.style, {
                        marginLeft: '4px', color: '#16a34a',
                        fontWeight: '700', fontSize: '15px',
                        position: 'relative', cursor: 'help'
                    });
                    check.textContent = '✓';

                    // Custom tooltip phía trên icon (không dùng title= → tránh native tooltip ở cursor).
                    const slots = [rec.tm && 'TM', rec.ck && 'CK'].filter(Boolean).join('+');
                    const codeStr = (rec.tm?.code || rec.ck?.code || '');
                    const tip = document.createElement('span');
                    tip.className = 'spx-cf-check-tip';
                    Object.assign(tip.style, {
                        position: 'absolute',
                        bottom: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)',
                        padding: '5px 9px', background: '#1f2937', color: '#fff',
                        fontSize: '12px', fontWeight: '500', borderRadius: '4px',
                        whiteSpace: 'nowrap', pointerEvents: 'none',
                        opacity: '0', transition: 'opacity .15s', zIndex: '999999',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.25)'
                    });
                    tip.textContent = `Phiếu thu ${slots}${codeStr ? ' · ' + codeStr : ''}`;
                    check.appendChild(tip);
                    check.addEventListener('mouseenter', () => { tip.style.opacity = '1'; });
                    check.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });

                    item.target.appendChild(check);
                }
            }
            res();
        };
        req.onerror = () => res();
    })));
    // KHÔNG db.close(): idbOpen() trả về connection dùng chung sống lâu (_db).
    // Đóng ở đây sẽ giết connection của toàn script — logEvent + annotate kế tiếp
    // đều chết với "database connection is closing".
}

// Strategy: HIDE-FIRST khi page thay đổi (paginate/sort/filter) → debounce render
// lại sau khi DOM ổn định. Tránh hiện sai (X) trong lúc Vue đang re-render rows.
let lastFirstTask = '';
let annotateDebounce = null;
const ANNOTATE_DEBOUNCE_MS = 300;

function getFirstRowTask() {
    const tr = document.querySelector('tr.ssc-table-row, tr[class*="table-row"]');
    if (!tr) return '';
    for (const td of tr.querySelectorAll('td')) {
        const text = rawCellText(td);
        if (/^DRT[\dA-Z]+$/.test(text)) return text;
    }
    return '';
}

function wipeAnnotations() {
    document.querySelectorAll('.spx-cod-tag, .spx-cf-check').forEach(e => e.remove());
    document.querySelectorAll('tr[data-spx-annotated-task]').forEach(tr => {
        delete tr.dataset.spxAnnotatedTask;
    });
}

function scheduleAnnotate() {
    if (!isDropOffListView()) return;
    const firstTask = getFirstRowTask();
    // No change → no work (cleanup logic trong annotateNssColumn handle idempotent).
    if (firstTask === lastFirstTask) return;
    // Page changed (paginate/sort/filter) → ẨN NGAY tất cả tag.
    wipeAnnotations();
    lastFirstTask = firstTask;
    // Debounce — đợi DOM ổn định 300ms (Vue thường render xong trong vài frame).
    if (annotateDebounce) clearTimeout(annotateDebounce);
    annotateDebounce = setTimeout(() => {
        annotateDebounce = null;
        annotateNssColumn();
    }, ANNOTATE_DEBOUNCE_MS);
}

// MutationObserver body-wide — fire scheduleAnnotate khi Vue mutate DOM.
// scheduleAnnotate cheap-bail nếu first-task chưa đổi → CPU OK.
new MutationObserver(scheduleAnnotate).observe(document.body, {
    childList: true, subtree: true, characterData: true
});

// Safety net mỗi 2s — phòng case page change mà mutation không fire (VD navigate
// SPA dùng pushState không trigger DOM mutation kịp). Skip when tab hidden.
setInterval(() => { if (!document.hidden) scheduleAnnotate(); }, 2000);
setTimeout(scheduleAnnotate, 800);
// Re-run once on tab focus to catch state changes made via another tab/window.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { pollTick(); scheduleAnnotate(); }
});

console.log('[SPX-LOG] v1.8 loaded — query qua window.SpxLog (vd: await SpxLog.listTasks())');
})();
