// ==UserScript==
// @name         Xata Sync
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/xata-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/xata-sync.user.js
// @version      2.3
// @description  Bidirectional sync: mọi IDB store của SPX scripts ↔ XATA cloud DB. Push sau mỗi write (dirty queue + debounce 2s), pull khi load trang. Cold sync cho blobs/token/scripts.
// @match        https://spx.shopee.vn/*
// @match        https://sp.spx.shopee.vn/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      xata.tech
// @run-at       document-start
// ==/UserScript==

(function () {
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const SQL_URL     = 'https://e2m1d4r6ht7n9ai2thjlcm3h74.us-east-1.xata.tech/sql';
const CONN_STRING = 'postgresql://xata:Fbn15DCfJTpZvGaNQprYznJIayzfpRuKUDgr4RPvO9gpQ1m8SKztq8f5FO0I7BtN@e2m1d4r6ht7n9ai2thjlcm3h74.us-east-1.xata.tech:5432/xata?sslmode=require';
const ORG_ID      = 'e1ctkk';
const API_KEY     = 'xau_ZI4e6aXbXTUkCPoo0AqlDscU1qo5esqt';

// ── Device ID ─────────────────────────────────────────────────────────────────
const DEVICE_ID = (() => {
    let id = GM_getValue('xata_device_id', '');
    if (!id) { id = Math.random().toString(36).slice(2, 8); GM_setValue('xata_device_id', id); }
    return id;
})();

// ── SQL HTTP helper ───────────────────────────────────────────────────────────
function _sqlReq(query, params) {
    return new Promise((res, rej) => {
        GM_xmlhttpRequest({
            method: 'POST',
            url: SQL_URL,
            headers: {
                'Content-Type': 'application/json',
                'Connection-String': CONN_STRING,
            },
            data: JSON.stringify(params && params.length ? { query, params } : { query }),
            onload: r => {
                if (r.status >= 200 && r.status < 300) {
                    try { res(JSON.parse(r.responseText)); } catch { res({ rows: [] }); }
                } else {
                    rej(new Error(`SQL ${r.status}: ${(r.responseText || '').slice(0, 300)}`));
                }
            },
            onerror:   () => rej(new Error('sql network error')),
            ontimeout: () => rej(new Error('sql timeout')),
        });
    });
}

// ── Schema Registry ───────────────────────────────────────────────────────────
const _registry = new Map();

// ── Dirty Queue ───────────────────────────────────────────────────────────────
const _queue = new Map(); // table → Map<xataId, fields>
let _drainTimer = null;

function _enqueue(table, xataId, fields) {
    if (!_queue.has(table)) _queue.set(table, new Map());
    _queue.get(table).set(xataId, fields);
    clearTimeout(_drainTimer);
    _drainTimer = setTimeout(_drainQueue, 2000);
}

async function _drainQueue() {
    for (const [table, batch] of _queue) {
        if (!batch.size) continue;
        try { await _drainTable(table, batch); }
        catch (e) { console.warn('[XataSync] drain failed:', table, e.message); }
    }
}

async function _drainTable(table, batch) {
    const BATCH_SIZE = 100;
    const all = [...batch.entries()].map(([id, fields]) => ({ id, ...fields }));

    for (let i = 0; i < all.length; i += BATCH_SIZE) {
        const chunk = all.slice(i, i + BATCH_SIZE);
        const cols = Object.keys(chunk[0]);
        const colList   = cols.map(c => `"${c}"`).join(', ');
        const updateSet = cols
            .filter(c => c !== 'id')
            .map(c => `"${c}" = EXCLUDED."${c}"`)
            .join(', ');

        const params = [];
        const valuePlaceholders = chunk.map(rec => {
            const start = params.length + 1;
            cols.forEach(c => params.push(rec[c] ?? null));
            return `(${cols.map((_, j) => `$${start + j}`).join(', ')})`;
        }).join(', ');

        const query = `INSERT INTO "${table}" (${colList}) VALUES ${valuePlaceholders} ON CONFLICT (id) DO UPDATE SET ${updateSet}`;
        await _sqlReq(query, params);

        const chunkIds = chunk.map(r => r.id);
        for (const id of chunkIds) batch.delete(id);
    }
}

window.addEventListener('beforeunload', () => { clearTimeout(_drainTimer); _drainQueue(); });

// ── Push (hot stores) ─────────────────────────────────────────────────────────
function push(table, record) {
    const entry = _registry.get(table);
    if (!entry) { console.warn('[XataSync] push: unknown table', table); return; }
    const xataId = entry.idFn(record, DEVICE_ID);
    const fields = entry.toXata(record, DEVICE_ID);
    _enqueue(table, xataId, fields);
}

// ── Cold Sync ─────────────────────────────────────────────────────────────────
async function coldSync(table, localKey, record) {
    const entry = _registry.get(table);
    if (!entry || entry.mode !== 'cold') return;
    const xataId = entry.idFn({ _key: localKey }, DEVICE_ID);

    let fields = entry.toXata({ ...record, _key: localKey }, DEVICE_ID);
    if (record.blob instanceof Blob) {
        fields.blob_b64 = await _blobToBase64(record.blob);
    }

    try {
        const fp = entry.fingerprintField;
        const resp = await _sqlReq(`SELECT "${fp}" FROM "${table}" WHERE id = $1`, [xataId]);
        const row = (resp.rows || [])[0];
        if (row && row[fp] != null && row[fp] === fields[fp]) return;
    } catch (e) {
        console.warn('[XataSync] coldSync check failed:', e.message);
    }

    _enqueue(table, xataId, fields);
    clearTimeout(_drainTimer);
    _drainTimer = setTimeout(_drainQueue, 100);
}

// ── Pull ──────────────────────────────────────────────────────────────────────
async function pullTable(table) {
    const entry = _registry.get(table);
    if (!entry) return;

    const existingDbs = await indexedDB.databases().catch(() => null);
    if (existingDbs && !existingDbs.some(d => d.name === entry.idb.name)) return;

    const lastPull = GM_getValue(`xata_pull_${table}`, 0);
    const since    = new Date(lastPull).toISOString();
    const pullTime = Date.now();
    const PAGE     = 200;
    let offset     = 0;

    while (true) {
        let query, params;
        if (entry.mode === 'append') {
            query  = `SELECT * FROM "${table}" WHERE updated_at > $1 AND device_id != $2 ORDER BY updated_at ASC LIMIT $3 OFFSET $4`;
            params = [since, DEVICE_ID, PAGE, offset];
        } else {
            query  = `SELECT * FROM "${table}" WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT $2 OFFSET $3`;
            params = [since, PAGE, offset];
        }

        let resp;
        try { resp = await _sqlReq(query, params); }
        catch (e) { console.warn('[XataSync] pull error', table, e.message); break; }

        const rows = resp.rows || [];
        if (rows.length) {
            try { await _writeToIdb(entry, rows); }
            catch (e) { console.warn('[XataSync] writeToIdb error', table, e); }
        }

        if (rows.length < PAGE) break;
        offset += PAGE;
    }

    GM_setValue(`xata_pull_${table}`, pullTime);
}

async function pullAll() {
    for (const table of _registry.keys()) {
        try { await pullTable(table); } catch (e) { console.warn('[XataSync] pullAll', table, e); }
    }
}

// ── Write pulled records to IDB ───────────────────────────────────────────────
async function _writeToIdb(entry, xataRecords) {
    const db = await new Promise((res, rej) => {
        const r = indexedDB.open(entry.idb.name, entry.idb.version);
        r.onupgradeneeded = () => {};
        r.onsuccess = () => res(r.result);
        r.onerror   = () => rej(r.error);
    });

    const tx    = db.transaction(entry.idb.store, 'readwrite');
    const store = tx.objectStore(entry.idb.store);

    for (const xataRec of xataRecords) {
        const local = entry.fromXata(xataRec);

        if (entry.mode === 'append') {
            const alreadyImported = GM_getValue(`xata_seen_${xataRec.id}`, false);
            if (alreadyImported) continue;
            const addReq = entry.idb.keyPath
                ? store.add(local)
                : store.put(local, local._key);
            addReq.onsuccess = () => GM_setValue(`xata_seen_${xataRec.id}`, true);
        } else {
            const key = entry.idb.keyPath ? local[entry.idb.keyPath] : local._key;
            if (key == null) continue;
            const getReq = store.get(key);
            getReq.onsuccess = () => {
                const merged   = entry.mergeLocal ? entry.mergeLocal(getReq.result, local) : local;
                const toStore  = { ...merged };
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
    const bsKey = `xata_bs_${entry.idb.store}`;
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
            if (!rec._xataId) {
                const recWithKey = entry.idb.keyPath ? rec : { ...rec, _key: c.primaryKey };
                const xataId = entry.idFn(recWithKey, DEVICE_ID);
                const fields = entry.toXata(recWithKey, DEVICE_ID);
                if (fields.blob_b64 !== null) { // null = has blob but not yet converted; let coldSync handle it
                    _enqueue(entry.table, xataId, fields);
                }
            }
            c.continue();
        };
        cur.onerror  = () => rej(cur.error);
        tx.oncomplete = res;
    });
    db.close();
    GM_setValue(bsKey, true);
    console.log('[XataSync] bootstrap enqueued:', entry.table);
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
        idFn:   (rec, did) => `${did}_${rec.id}`,
        toXata: (rec, did) => ({
            ts: rec.ts, type: rec.type, task_id: rec.task_id || null,
            data: rec.data != null ? JSON.stringify(rec.data) : null,
            url: rec.url || null, device_id: did,
        }),
        fromXata: r => ({
            ts: r.ts, type: r.type, task_id: r.task_id,
            data: _tryParseJson(r.data),
            url: r.url, _xataId: r.id,
        }),
        mergeLocal: null,
    });

    // ── spx_tasks (upsert, last_seen wins) ─────────────────────────
    _registry.set('spx_tasks', {
        table: 'spx_tasks', mode: 'upsert',
        idb: { name: 'spx_log', version: 1, store: 'tasks', keyPath: 'task_id' },
        idFn:   (rec) => rec.task_id || rec._key,
        toXata: (rec, did) => ({
            task_id: rec.task_id, first_seen: rec.first_seen || null,
            last_seen: rec.last_seen || null, max_cod: rec.max_cod || 0,
            last_cod: rec.last_cod || 0, last_status: rec.last_status || null,
            voucher_tm: rec.voucher_tm ? JSON.stringify(rec.voucher_tm) : null,
            voucher_ck: rec.voucher_ck ? JSON.stringify(rec.voucher_ck) : null,
            device_id: did,
        }),
        fromXata: r => ({
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
        idFn:   (rec) => rec.drt || rec._key,
        toXata: (rec) => ({
            drt_id: rec.drt || rec._key, drt: rec.drt || rec._key,
            amount: rec.amount || 0, sender: rec.sender || '', operator: rec.operator || '',
            tm: rec.tm ? JSON.stringify(rec.tm) : null,
            ck: rec.ck ? JSON.stringify(rec.ck) : null,
            created_at: rec.createdAt || null,
            updated_at_ms: rec.updatedAt || null,
        }),
        fromXata: r => ({
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
        idFn:   (rec) => (rec._key || rec.shipment_id || '').replace(/[^A-Za-z0-9_-]/g, '_'),
        toXata: (rec) => ({
            is_hv:       rec.isHV ?? rec.is_hv ?? false,
            task_id:     rec.taskId   || rec.task_id    || null,
            detected_at: rec.detectedAt || rec.detected_at || null,
            checked_at:  rec.checkedAt  || rec.checked_at  || null,
            removed_at:  rec.removedAt  || rec.removed_at  || null,
        }),
        fromXata: r => ({
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
        idFn:   (rec) => `hv_${rec._key || rec.task_id}`,
        toXata: (rec) => ({
            task_id:     rec._key || rec.task_id,
            has_hv:      rec.hasHV || rec.has_hv || false,
            checked_at:  rec.checkedAt || rec.checked_at || null,
            order_count: rec.orderCount || rec.order_count || null,
            hv_shipments: JSON.stringify(rec.hvShipments || rec.hv_shipments || []),
        }),
        fromXata: r => ({
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
        idFn:   (rec) => `au_${(rec._key || '').replace(/[^A-Za-z0-9]/g, '_')}`,
        toXata: (rec) => ({
            filename:   rec._key,
            blob_b64:   rec.blob_b64 || null,   // set async by coldSync when blob present
            etag:       rec.etag || null,
            checked_at: rec.checkedAt || null,
            value_json: (!rec.blob && !rec.blob_b64) ? JSON.stringify({ ...rec, _key: undefined }) : null,
        }),
        fromXata: r => ({
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
        idFn:   () => 'hv_audio',
        toXata: (rec) => ({
            rec_key:    rec._key || 'hv',
            blob_b64:   rec.blob_b64 || null,
            checked_at: rec.checkedAt || null,
        }),
        fromXata: r => ({
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
        idFn:   () => 'bearer_token',
        toXata: (rec) => ({
            token:       rec.token,
            captured_at: rec.capturedAt || null,
            exp:         rec.exp || null,
        }),
        fromXata: r => ({
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
        idFn:   () => 'pdfjs_scripts',
        toXata: (rec) => ({
            url:         rec.url || null,
            main_text:   rec.mainText   || null,
            worker_text: rec.workerText || null,
            cached_at:   rec.cachedAt   || null,
        }),
        fromXata: r => ({
            url: r.url, mainText: r.main_text, workerText: r.worker_text,
            cachedAt: r.cached_at, _key: 'pdfjs',
        }),
        mergeLocal: (local, remote) => {
            if (!local) return remote;
            return (remote.url && remote.url !== local.url) ? remote : local;
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
}, 3000);

// ── Public API ────────────────────────────────────────────────────────────────
unsafeWindow.XataSync = {
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
                [..._registry.keys()].map(t => [t, new Date(GM_getValue(`xata_pull_${t}`, 0)).toISOString()])
            ),
        };
    },
    flushNow: _drainQueue,
};

console.log('[XataSync] v2.0 — deviceId:', DEVICE_ID, '— SQL endpoint ready ✓');

})();
