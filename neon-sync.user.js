// ==UserScript==
// @name         Neon Sync
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/neon-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/neon-sync.user.js
// @version      3.17
// @description  Bidirectional sync: mọi IDB store của SPX scripts ↔ Neon DB. Push sau mỗi write (dirty queue + debounce 2s), pull khi load trang. Cold sync cho blobs/token/scripts.
// @match        https://spx.shopee.vn/*
// @match        https://sp.spx.shopee.vn/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      neon.tech
// @run-at       document-start
// ==/UserScript==

(function () {
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const AUTH_URL  = 'https://ep-jolly-frost-aoqf0ugs.neonauth.c-2.ap-southeast-1.aws.neon.tech/neondb/auth';
const REST_URL  = 'https://ep-jolly-frost-aoqf0ugs.apirest.c-2.ap-southeast-1.aws.neon.tech/neondb/rest/v1';
const SVC_EMAIL = 'neon-sync@spx.local';
const SVC_PASS  = 'NeonSync_SPX_2024!';

// ── Device ID ─────────────────────────────────────────────────────────────────
const DEVICE_ID = (() => {
    let id = GM_getValue('neon_device_id', '');
    if (!id) { id = Math.random().toString(36).slice(2, 8); GM_setValue('neon_device_id', id); }
    return id;
})();

// ── Auth (Better Auth → JWT for PostgREST) ───────────────────────────────────
// Better Auth sign-in sets an HttpOnly session cookie (hidden from JS).
// GET /token exchanges that cookie for a short-lived EdDSA JWT for PostgREST.
// GM_xmlhttpRequest has an isolated cookie jar — it cannot share the browser
// session even with withCredentials:true. unsafeWindow.fetch IS the browser's
// fetch, shares the real cookie jar, and CORS is already trusted for SPX domains.

const _wfetch = unsafeWindow.fetch.bind(unsafeWindow);

function _authPost(endpoint, body) {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 15_000);
    return _wfetch(`${AUTH_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
        signal: ac.signal,
    }).then(async r => {
        const text = await r.text().catch(() => '');
        if (r.ok) { try { return JSON.parse(text); } catch { throw new Error('auth parse error'); } }
        throw new Error(`auth ${r.status}: ${text.slice(0, 200)}`);
    }).finally(() => clearTimeout(t));
}

function _getJwtFromSession() {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 15_000);
    return _wfetch(`${AUTH_URL}/token`, { credentials: 'include', signal: ac.signal })
        .then(async r => {
            if (r.ok) return r.json();
            throw new Error(`jwt ${r.status}`);
        }).finally(() => clearTimeout(t));
}

function _saveJwt(jwt) {
    let exp = Date.now() + 900_000;
    try {
        const p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (p.exp) exp = p.exp * 1000;
    } catch {}
    GM_setValue('neon_jwt',     jwt);
    GM_setValue('neon_jwt_exp', exp);
}

let _tokenInflight = null;

async function _getToken() {
    const jwt = GM_getValue('neon_jwt', '');
    const exp = GM_getValue('neon_jwt_exp', 0);
    if (jwt && Date.now() < exp - 60_000) return jwt;
    if (_tokenInflight) return _tokenInflight;
    _tokenInflight = _doRefreshToken().finally(() => { _tokenInflight = null; });
    return _tokenInflight;
}

async function _doRefreshToken() {
    try {
        const data = await _getJwtFromSession();
        if (data?.token) { _saveJwt(data.token); console.log('[NeonSync] jwt refreshed ✓'); return data.token; }
    } catch {}

    try {
        await _authPost('/sign-in/email', { email: SVC_EMAIL, password: SVC_PASS });
    } catch {
        try {
            await _authPost('/sign-up/email', { name: 'NeonSync', email: SVC_EMAIL, password: SVC_PASS });
        } catch {}
    }

    const data = await _getJwtFromSession();
    if (data?.token) { _saveJwt(data.token); console.log('[NeonSync] auth OK ✓'); return data.token; }
    _setStatus(false, 'Auth failed — cannot reach Neon');
    throw new Error('auth failed: no JWT from /token after sign-in');
}

// ── Neon Sync Status Indicator ────────────────────────────────────────────────
let _statusOk  = null; // null=pending, true=ok, false=error, 'syncing'=in-progress
let _statusMsg = '';
let _dotTimer  = null;
let _dotStep   = 0;

function _setStatus(ok, msg = '') {
    _statusOk  = ok;
    _statusMsg = msg;
    if (ok === 'syncing') {
        _dotStep = 0;
        if (!_dotTimer) {
            _dotTimer = setInterval(() => {
                _dotStep = (_dotStep + 1) % 3;
                _updateIndicator();
            }, 500);
        }
    } else {
        if (_dotTimer) { clearInterval(_dotTimer); _dotTimer = null; }
    }
    _updateIndicator();
}

function _updateIndicator() {
    const wrap  = document.getElementById('_neon_ind');
    if (!wrap) return;
    const st    = document.getElementById('_neon_ind_status');
    const cloud = document.getElementById('_neon_ind_cloud');
    const xmark = document.getElementById('_neon_ind_x');
    if (!st || !cloud || !xmark) return;

    if (_statusOk === 'syncing') {
        cloud.setAttribute('stroke', '#94a3b8');
        xmark.setAttribute('display', 'none');
        st.textContent    = '(syncing ' + '.'.repeat(_dotStep + 1) + ')';
        st.style.color    = '#f59e0b';
        st.style.fontSize = '14px';
    } else if (_statusOk === true) {
        cloud.setAttribute('stroke', '#22c55e');
        xmark.setAttribute('display', 'none');
        st.textContent = '';
    } else if (_statusOk === false) {
        cloud.setAttribute('stroke', '#ef4444');
        xmark.setAttribute('display', '');
        st.textContent = '';
    } else {
        cloud.setAttribute('stroke', '#94a3b8');
        xmark.setAttribute('display', 'none');
        st.textContent    = '(—)';
        st.style.color    = '#94a3b8';
        st.style.fontSize = '12px';
    }
    const tip = _statusMsg || (_statusOk === true ? 'All good' : _statusOk === false ? 'Sync error' : _statusOk === 'syncing' ? 'Syncing…' : 'Pending');
    wrap.title = tip;
}

function _injectIndicator() {
    if (document.getElementById('_neon_ind')) { _updateIndicator(); return; }
    let helpLi = null;
    for (const span of document.querySelectorAll('.sub-menu-title')) {
        if (span.textContent.trim() === 'Help') { helpLi = span.closest('li'); break; }
    }
    if (!helpLi) return;

    // Mirror the exact <li> structure of the Help section
    const li = document.createElement('li');
    li.id = '_neon_ind';
    li.className = 'submenu ssc-menu-submenu ssc-menu-opened ssc-menu-submenu-disabled';
    li.setAttribute('opened', 'true');
    li.style.cssText = 'color:rgb(149,155,164);border-top:1px solid transparent;border-bottom:1px solid transparent;background:#fff';
    li.innerHTML = `
        <div class="ssc-menu-submenu-title"
             style="height:30px;line-height:normal;background:#fff;display:flex;align-items:center;padding:0 16px;gap:8px">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
                <path id="_neon_ind_cloud" d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke="#94a3b8"/>
                <g id="_neon_ind_x" stroke="#ef4444" stroke-width="2.5" display="none">
                    <line x1="8" y1="8" x2="16" y2="16"/>
                    <line x1="16" y1="8" x2="8" y2="16"/>
                </g>
            </svg>
            <span class="sub-menu-title" style="flex:1;font-size:14px">Neon Sync <span id="_neon_ind_status" style="font-size:12px;font-weight:600;color:#94a3b8;transition:color .3s">(—)</span></span>
        </div>`;
    helpLi.after(li);
    _updateIndicator();
}

// Re-inject on every SPA navigation (menu may be re-rendered)
window.addEventListener('spx-nav', () => setTimeout(_injectIndicator, 600));
document.addEventListener('DOMContentLoaded', () => setTimeout(_injectIndicator, 1200));
setTimeout(_injectIndicator, 2500);

// ── REST helpers ──────────────────────────────────────────────────────────────
async function _restGet(path) {
    const token = await _getToken();
    return new Promise((res, rej) => {
        GM_xmlhttpRequest({
            method: 'GET',
            timeout: 30_000,
            url: `${REST_URL}/${path}`,
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
            onload: r => {
                if (r.status >= 200 && r.status < 300) {
                    try { res(JSON.parse(r.responseText)); } catch { res([]); }
                } else {
                    rej(new Error(`REST ${r.status}: ${(r.responseText || '').slice(0, 300)}`));
                }
            },
            onerror:   () => rej(new Error('rest network error')),
            ontimeout: () => rej(new Error('rest timeout')),
        });
    });
}

async function _restPost(path, rows) {
    const token = await _getToken();
    return new Promise((res, rej) => {
        GM_xmlhttpRequest({
            method: 'POST',
            timeout: 30_000,
            url: `${REST_URL}/${path}`,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            data: JSON.stringify(rows),
            onload: r => {
                if (r.status >= 200 && r.status < 300) res();
                else rej(new Error(`REST ${r.status}: ${(r.responseText || '').slice(0, 300)}`));
            },
            onerror:   () => rej(new Error('rest network error')),
            ontimeout: () => rej(new Error('rest timeout')),
        });
    });
}

// ── Schema Registry ───────────────────────────────────────────────────────────
const _registry = new Map();

// ── Dirty Queue ───────────────────────────────────────────────────────────────
const _queue = new Map(); // table → Map<neonId, fields>
let _drainTimer = null;
let _draining   = false;
let _drainingAt = 0;
const _pullCallbacks = [];

function _enqueue(table, neonId, fields) {
    if (!_queue.has(table)) _queue.set(table, new Map());
    _queue.get(table).set(neonId, fields);
    clearTimeout(_drainTimer);
    _drainTimer = setTimeout(_drainQueue, 2000);
}

async function _drainQueue() {
    if (_draining && Date.now() - _drainingAt > 120_000) {
        console.warn('[NeonSync] drain stuck >120s — force-reset');
        _draining = false;
    }
    if (_draining) return;
    _draining   = true;
    _drainingAt = Date.now();
    _setStatus('syncing');
    let drainOk = true;
    try {
        for (const [table, batch] of _queue) {
            if (!batch.size) continue;
            try { await _drainTable(table, batch); }
            catch (e) {
                console.warn('[NeonSync] drain failed:', table, e.message);
                _setStatus(false, `Push failed: ${table} — ${e.message}`);
                drainOk = false;
            }
        }
        if (drainOk && [..._queue.values()].every(b => !b.size)) {
            _setStatus(true, `Pushed OK · ${new Date().toLocaleTimeString()}`);
        }
    } finally {
        _draining = false;
    }
}

async function _drainTable(table, batch) {
    const BATCH_SIZE = 100;
    const all = [...batch.entries()].map(([id, fields]) => ({ id, ...fields }));
    for (let i = 0; i < all.length; i += BATCH_SIZE) {
        const chunk = all.slice(i, i + BATCH_SIZE);
        await _restPost(table, chunk);
        chunk.forEach(r => batch.delete(r.id));
    }
}

window.addEventListener('beforeunload', () => { clearTimeout(_drainTimer); _drainQueue(); });

// ── Push (hot stores) ─────────────────────────────────────────────────────────
function push(table, record) {
    const entry = _registry.get(table);
    if (!entry) { console.warn('[NeonSync] push: unknown table', table); return; }
    const neonId = entry.idFn(record, DEVICE_ID);
    const fields = entry.toNeon(record, DEVICE_ID);
    _enqueue(table, neonId, fields);
}

// ── Cold Sync ─────────────────────────────────────────────────────────────────
async function coldSync(table, localKey, record) {
    const entry = _registry.get(table);
    if (!entry || entry.mode !== 'cold') return;
    const neonId = entry.idFn({ _key: localKey }, DEVICE_ID);

    let fields = entry.toNeon({ ...record, _key: localKey }, DEVICE_ID);
    if (record.blob instanceof Blob) {
        fields.blob_b64 = await _blobToBase64(record.blob);
    }

    try {
        const fp   = entry.fingerprintField;
        const rows = await _restGet(`${table}?id=eq.${encodeURIComponent(neonId)}&select=${fp}`);
        const row  = rows[0];
        if (row && row[fp] != null && String(row[fp]) === String(fields[fp])) return;
    } catch (e) {
        console.warn('[NeonSync] coldSync check failed:', e.message);
    }

    _enqueue(table, neonId, fields);
    clearTimeout(_drainTimer);
    _drainTimer = setTimeout(_drainQueue, 100);
}

// ── Pull ──────────────────────────────────────────────────────────────────────
async function pullTable(table) {
    const entry = _registry.get(table);
    if (!entry) return true;

    const existingDbs = await indexedDB.databases().catch(() => null);
    if (existingDbs && !existingDbs.some(d => d.name === entry.idb.name)) return true;

    const lastPull = GM_getValue(`neon_pull_${table}`, 0);
    const since    = new Date(lastPull).toISOString();
    const pullTime = Date.now();
    const PAGE     = 200;
    let offset     = 0;
    let pullOk     = true;

    while (true) {
        let qs = `updated_at=gt.${encodeURIComponent(since)}&order=updated_at.asc&limit=${PAGE}&offset=${offset}`;
        if (entry.mode === 'append') qs += `&device_id=neq.${encodeURIComponent(DEVICE_ID)}`;

        let rows;
        try { rows = await _restGet(`${table}?${qs}`); }
        catch (e) { console.warn('[NeonSync] pull error', table, e.message); pullOk = false; break; }

        if (rows.length) {
            try { await _writeToIdb(entry, rows); }
            catch (e) { console.warn('[NeonSync] writeToIdb error', table, e); }
        }

        if (rows.length < PAGE) break;
        offset += PAGE;
    }

    if (pullOk) GM_setValue(`neon_pull_${table}`, pullTime);
    return pullOk;
}

async function pullAll() {
    _setStatus('syncing');
    let allOk = true;
    let failedTable = '';
    for (const table of _registry.keys()) {
        try {
            const ok = await pullTable(table);
            if (!ok) { allOk = false; failedTable = failedTable || table; }
        } catch (e) {
            console.warn('[NeonSync] pullAll', table, e);
            allOk = false; failedTable = failedTable || table;
        }
    }
    _setStatus(allOk,
        allOk
            ? `Pulled OK · ${new Date().toLocaleTimeString()}`
            : `Pull failed: ${failedTable}`
    );
}

// ── Write pulled records to IDB ───────────────────────────────────────────────
async function _writeToIdb(entry, neonRecords) {
    // Guard: neon-sync must never create the DB — only the owning script may
    // define the schema. Without this, an empty onupgradeneeded would create
    // the DB at the target version with no stores, and the owning script's
    // onupgradeneeded would never fire again (version already matches).
    const existingDbs = await indexedDB.databases().catch(() => null);
    if (existingDbs && !existingDbs.some(d => d.name === entry.idb.name)) return;

    const db = await new Promise((res, rej) => {
        const r = indexedDB.open(entry.idb.name, entry.idb.version);
        r.onupgradeneeded = () => {};
        r.onsuccess = () => res(r.result);
        r.onerror   = () => rej(r.error);
    });

    const tx    = db.transaction(entry.idb.store, 'readwrite');
    const store = tx.objectStore(entry.idb.store);

    for (const neonRec of neonRecords) {
        const local = entry.fromNeon(neonRec);

        if (entry.mode === 'append') {
            // Dedup is handled by incremental pull (updated_at > lastPull) — each
            // event is only returned by the server once after it is written.
            // put() is idempotent for the rare edge case of a repeated pull window.
            entry.idb.keyPath
                ? store.put(local)
                : store.put(local, local._key);
        } else {
            const key = entry.idb.keyPath ? local[entry.idb.keyPath] : local._key;
            if (key == null) continue;
            const getReq = store.get(key);
            getReq.onsuccess = () => {
                const merged  = entry.mergeLocal ? entry.mergeLocal(getReq.result, local) : local;
                const toStore = { ...merged };
                delete toStore._key;
                entry.idb.keyPath ? store.put(toStore) : store.put(toStore, key);
            };
        }
    }

    await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror    = () => rej(tx.error);
    });
    db.close();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function _bootstrapTable(entry) {
    const bsKey = `neon_bs_${entry.idb.store}`;
    if (GM_getValue(bsKey, false)) return;

    const existingDbs = await indexedDB.databases().catch(() => null);
    if (existingDbs && !existingDbs.some(d => d.name === entry.idb.name)) return;

    let db;
    try {
        db = await new Promise((res, rej) => {
            const r = indexedDB.open(entry.idb.name, entry.idb.version);
            r.onupgradeneeded = () => {};
            r.onsuccess = () => res(r.result);
            r.onerror   = () => rej(r.error);
        });
    } catch { return; }

    await new Promise((res, rej) => {
        const tx  = db.transaction(entry.idb.store, 'readonly');
        const cur = tx.objectStore(entry.idb.store).openCursor();
        cur.onsuccess = () => {
            const c = cur.result;
            if (!c) { res(); return; }
            const rec = c.value;
            if (!rec._neonId) {
                const recWithKey = entry.idb.keyPath ? rec : { ...rec, _key: c.primaryKey };
                const neonId = entry.idFn(recWithKey, DEVICE_ID);
                const fields = entry.toNeon(recWithKey, DEVICE_ID);
                if (fields.blob_b64 !== null) {
                    _enqueue(entry.table, neonId, fields);
                }
            }
            c.continue();
        };
        cur.onerror   = () => rej(cur.error);
        tx.oncomplete = res;
    });
    db.close();
    GM_setValue(bsKey, true);
    console.log('[NeonSync] bootstrap enqueued:', entry.table);
    await _drainQueue();
}

// ── Blob helpers ──────────────────────────────────────────────────────────────
function _blobToBase64(blob) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onloadend = () => res(r.result.split(',')[1]);
        r.onerror   = rej;
        r.readAsDataURL(blob);
    });
}
function _base64ToBlob(b64, mime = 'audio/mpeg') {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}
function _tryParseJson(s) {
    try { return s ? JSON.parse(s) : undefined; } catch { return undefined; }
}

// ── Built-in Table Registrations ──────────────────────────────────────────────
function _registerBuiltins() {

    // ── spx_events (append-only) ───────────────────────────────────
    _registry.set('spx_events', {
        table: 'spx_events', mode: 'append',
        idb: { name: 'spx_log', version: 1, store: 'events', keyPath: 'id' },
        idFn:    (rec, did) => `${did}_${rec.id}`,
        toNeon:  (rec, did) => ({
            ts: rec.ts, type: rec.type, task_id: rec.task_id || null,
            data: rec.data != null ? JSON.stringify(rec.data) : null,
            url: rec.url || null, device_id: did,
        }),
        fromNeon: r => ({
            ts: r.ts, type: r.type, task_id: r.task_id,
            data: _tryParseJson(r.data),
            url: r.url, _neonId: r.id,
        }),
        mergeLocal: null,
    });

    // ── spx_tasks (upsert, last_seen wins) ─────────────────────────
    _registry.set('spx_tasks', {
        table: 'spx_tasks', mode: 'upsert',
        idb: { name: 'spx_log', version: 1, store: 'tasks', keyPath: 'task_id' },
        idFn:    (rec) => rec.task_id || rec._key,
        toNeon:  (rec, did) => ({
            task_id: rec.task_id, first_seen: rec.first_seen || null,
            last_seen: rec.last_seen || null, max_cod: rec.max_cod || 0,
            last_cod: rec.last_cod || 0, last_status: rec.last_status || null,
            voucher_tm: rec.voucher_tm ? JSON.stringify(rec.voucher_tm) : null,
            voucher_ck: rec.voucher_ck ? JSON.stringify(rec.voucher_ck) : null,
            device_id: did,
        }),
        fromNeon: r => ({
            task_id: r.task_id, first_seen: r.first_seen, last_seen: r.last_seen,
            max_cod: r.max_cod, last_cod: r.last_cod, last_status: r.last_status,
            voucher_tm: _tryParseJson(r.voucher_tm),
            voucher_ck: _tryParseJson(r.voucher_ck),
        }),
        mergeLocal: (local, remote) => {
            if (!local) return remote;
            if ((remote.last_seen || 0) <= (local.last_seen || 0)) return local;
            return {
                ...local, ...remote,
                max_cod: Math.max(local.max_cod || 0, remote.max_cod || 0),
                voucher_tm: local.voucher_tm || remote.voucher_tm,
                voucher_ck: local.voucher_ck || remote.voucher_ck,
            };
        },
    });

    // ── spx_receipts (upsert + tm/ck slot merge) ───────────────────
    _registry.set('spx_receipts', {
        table: 'spx_receipts', mode: 'upsert',
        idb: { name: 'spx_cf_receipts', version: 1, store: 'drt', keyPath: null },
        idFn:    (rec) => rec.drt || rec._key,
        toNeon:  (rec) => ({
            drt_id: rec.drt || rec._key, drt: rec.drt || rec._key,
            amount: rec.amount || 0, sender: rec.sender || '', operator: rec.operator || '',
            tm: rec.tm ? JSON.stringify(rec.tm) : null,
            ck: rec.ck ? JSON.stringify(rec.ck) : null,
            created_at: rec.createdAt || null,
            updated_at_ms: rec.updatedAt || null,
        }),
        fromNeon: r => ({
            drt: r.drt, amount: r.amount, sender: r.sender, operator: r.operator,
            tm: _tryParseJson(r.tm),
            ck: _tryParseJson(r.ck),
            createdAt: r.created_at, updatedAt: r.updated_at_ms,
            _key: r.drt,
        }),
        mergeLocal: (local, remote) => {
            if (!local) return remote;
            return {
                ...local,
                tm: local.tm || remote.tm,
                ck: local.ck || remote.ck,
                amount:    remote.amount  || local.amount,
                sender:    remote.sender  || local.sender,
                updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
            };
        },
    });

    // ── spx_hv_shipments (upsert, checkedAt wins) ──────────────────
    _registry.set('spx_hv_shipments', {
        table: 'spx_hv_shipments', mode: 'upsert',
        idb: { name: 'spx_fd_hv', version: 3, store: 'shipments', keyPath: null },
        idFn:    (rec) => (rec._key || rec.shipment_id || '').replace(/[^A-Za-z0-9_-]/g, '_'),
        toNeon:  (rec) => ({
            is_hv:       rec.isHV ?? rec.is_hv ?? false,
            task_id:     rec.taskId    || rec.task_id    || null,
            detected_at: rec.detectedAt || rec.detected_at || null,
            checked_at:  rec.checkedAt  || rec.checked_at  || null,
            removed_at:  rec.removedAt  || rec.removed_at  || null,
        }),
        fromNeon: r => ({
            isHV: r.is_hv, taskId: r.task_id,
            detectedAt: r.detected_at, checkedAt: r.checked_at, removedAt: r.removed_at,
            _key: r.id,
        }),
        mergeLocal: (local, remote) => {
            if (!local) return remote;
            const remoteTs = remote.checkedAt || remote.detectedAt || 0;
            const localTs  = local.checkedAt  || local.detectedAt  || 0;
            return remoteTs > localTs ? { ...local, ...remote, _key: local._key } : local;
        },
    });

    // ── spx_hv_tasks (upsert, checkedAt wins) ──────────────────────
    _registry.set('spx_hv_tasks', {
        table: 'spx_hv_tasks', mode: 'upsert',
        idb: { name: 'spx_fd_hv', version: 3, store: 'tasks', keyPath: null },
        idFn:    (rec) => `hv_${rec._key || rec.task_id}`,
        toNeon:  (rec) => ({
            task_id:      rec._key || rec.task_id,
            has_hv:       rec.hasHV || rec.has_hv || false,
            checked_at:   rec.checkedAt || rec.checked_at || null,
            order_count:  rec.orderCount || rec.order_count || null,
            hv_shipments: JSON.stringify(rec.hvShipments || rec.hv_shipments || []),
        }),
        fromNeon: r => ({
            hasHV: r.has_hv, checkedAt: r.checked_at,
            orderCount: r.order_count,
            hvShipments: _tryParseJson(r.hv_shipments) || [],
            _key: r.task_id,
        }),
        mergeLocal: (local, remote) => {
            if (!local) return remote;
            if ((remote.checkedAt || 0) <= (local.checkedAt || 0)) return local;
            const merged = { ...local, ...remote, _key: local._key };
            merged.hvShipments = [...new Set([...(local.hvShipments || []), ...(remote.hvShipments || [])])];
            return merged;
        },
    });

    // ── spx_audio_cache (cold, per-file MP3 + operator cache) ──────
    _registry.set('spx_audio_cache', {
        table: 'spx_audio_cache', mode: 'cold', fingerprintField: 'checked_at',
        idb: { name: 'spx_audio', version: 1, store: 'mp3', keyPath: null },
        idFn:    (rec) => `au_${(rec._key || '').replace(/[^A-Za-z0-9]/g, '_')}`,
        toNeon:  (rec) => ({
            filename:   rec._key,
            blob_b64:   rec.blob_b64 || null,
            etag:       rec.etag || null,
            checked_at: rec.checkedAt || null,
            value_json: (!rec.blob && !rec.blob_b64) ? JSON.stringify({ ...rec, _key: undefined }) : null,
        }),
        fromNeon: r => ({
            blob: r.blob_b64 ? _base64ToBlob(r.blob_b64) : null,
            etag: r.etag, checkedAt: r.checked_at,
            ...(_tryParseJson(r.value_json) || {}),
            _key: r.filename,
        }),
        mergeLocal: (local, remote) => {
            if (!local) return remote;
            return (remote.checkedAt || 0) > (local.checkedAt || 0)
                ? { ...remote, _key: local._key }
                : local;
        },
    });

    // ── spx_fd_audio_cache (cold, hv.mp3 only) ─────────────────────
    _registry.set('spx_fd_audio_cache', {
        table: 'spx_fd_audio_cache', mode: 'cold', fingerprintField: 'checked_at',
        idb: { name: 'spx_fd_audio', version: 1, store: 'mp3', keyPath: null },
        idFn:    () => 'hv_audio',
        toNeon:  (rec) => ({
            rec_key:    rec._key || 'hv',
            blob_b64:   rec.blob_b64 || null,
            checked_at: rec.checkedAt || null,
        }),
        fromNeon: r => ({
            blob: r.blob_b64 ? _base64ToBlob(r.blob_b64) : null,
            checkedAt: r.checked_at,
            _key: r.rec_key || 'hv',
        }),
        mergeLocal: (local, remote) => {
            if (!local) return remote;
            return (remote.checkedAt || 0) > (local.checkedAt || 0)
                ? { ...remote, _key: local._key || 'hv' }
                : local;
        },
    });

    // ── spx_tokens (cold, bearer token) ────────────────────────────
    _registry.set('spx_tokens', {
        table: 'spx_tokens', mode: 'cold', fingerprintField: 'exp',
        idb: { name: 'spx_fd_hv', version: 3, store: 'token', keyPath: null },
        idFn:    () => 'bearer_token',
        toNeon:  (rec) => ({
            token:       rec.token,
            captured_at: rec.capturedAt || null,
            exp:         rec.exp || null,
        }),
        fromNeon: r => ({
            token: r.token, capturedAt: r.captured_at, exp: r.exp,
            _key: 'bearer',
        }),
        mergeLocal: (local, remote) => {
            if (!local) return remote;
            if (!remote.exp || remote.exp < Date.now() + 60_000) return local;
            return (remote.exp || 0) > (local.exp || 0) ? remote : local;
        },
    });

    // ── spx_scripts (cold, pdf.js main+worker) ─────────────────────
    _registry.set('spx_scripts', {
        table: 'spx_scripts', mode: 'cold', fingerprintField: 'url',
        idb: { name: 'spx_fd_hv', version: 3, store: 'scripts', keyPath: null },
        idFn:    () => 'pdfjs_scripts',
        toNeon:  (rec) => ({
            url:         rec.url || null,
            main_text:   rec.mainText   || null,
            worker_text: rec.workerText || null,
            cached_at:   rec.cachedAt   || null,
        }),
        fromNeon: r => ({
            url: r.url, mainText: r.main_text, workerText: r.worker_text,
            cachedAt: r.cached_at, _key: 'pdfjs',
        }),
        mergeLocal: (local, remote) => {
            if (!local) return remote;
            return (remote.url && remote.url !== local.url) ? remote : local;
        },
    });

    // ── spx_refund_state (upsert, 'done' beats lower states) ──────
    _registry.set('spx_refund_state', {
        table: 'spx_refund_state', mode: 'upsert',
        idb: { name: 'spx_refund_state', version: 1, store: 'cfkeys', keyPath: null },
        idFn:    (rec) => rec.cf_key || rec._key,
        toNeon:  (rec) => ({
            cf_key:  rec.cf_key || rec._key,
            status:  rec.status || 'done',
            kv_id:   rec.kv_id  || null,
            kv_code: rec.kv_code || null,
        }),
        fromNeon: r => ({
            cf_key: r.cf_key, status: r.status,
            kv_id: r.kv_id, kv_code: r.kv_code,
            _key: r.cf_key,
        }),
        mergeLocal: (local, remote) => {
            if (!local) return remote;
            const rank = { done: 2, pending: 1, failed: 0 };
            return (rank[remote.status] || 0) > (rank[local.status] || 0) ? remote : local;
        },
    });
}

// ── Init ──────────────────────────────────────────────────────────────────────
_registerBuiltins();

setTimeout(async () => {
    await pullAll();
    for (const entry of _registry.values()) {
        await _bootstrapTable(entry).catch(() => {});
    }
    _pullCallbacks.forEach(cb => { try { cb(); } catch {} });
}, 3000);

// ── Public API ────────────────────────────────────────────────────────────────
unsafeWindow.NeonSync = {
    push,
    coldSync,
    pullAll,
    register:   config => _registry.set(config.table, config),
    status() {
        const queueSize = [..._queue.values()].reduce((s, m) => s + m.size, 0);
        return {
            deviceId:    DEVICE_ID,
            tables:      [..._registry.keys()],
            queuedItems: queueSize,
            lastPulls:   Object.fromEntries(
                [..._registry.keys()].map(t => [t, new Date(GM_getValue(`neon_pull_${t}`, 0)).toISOString()])
            ),
        };
    },
    flushNow:        _drainQueue,
    onPullComplete:  (cb) => _pullCallbacks.push(cb),
    clearAuth: () => { GM_setValue('neon_jwt',''); GM_setValue('neon_jwt_exp',0); console.log('[NeonSync] auth cleared'); },
};

console.log('[NeonSync] v3.17 — deviceId:', DEVICE_ID, '— hardened + indicator ✓');

})();
