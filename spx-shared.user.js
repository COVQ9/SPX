// ==UserScript==
// @name         SPX Shared
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/spx-shared.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/spx-shared.user.js
// @version      1.0
// @description  Shared utilities: authoritative SPA nav patch (spx-nav, fires once per navigation), parametric IDB helpers, GM request wrapper. Sort this script FIRST in Tampermonkey dashboard.
// @match        https://spx.shopee.vn/*
// @match        https://sp.spx.shopee.vn/*
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

(function () {
'use strict';

const _docEl = document.documentElement;
if (_docEl.SpxShared) return;

// ── SPA nav patch ─────────────────────────────────────────────────────────────
// Single authoritative patch so 'spx-nav' fires exactly once per navigation.
// Guard prevents chain-wrapping if a fallback script (find-details) already
// patched due to wrong TM load order — whichever runs first wins.
if (!_docEl._spxNavPatched) {
    _docEl._spxNavPatched = true;
    for (const m of ['pushState', 'replaceState']) {
        const orig = history[m];
        history[m] = function () {
            const r = orig.apply(this, arguments);
            try { window.dispatchEvent(new Event('spx-nav')); } catch {}
            return r;
        };
    }
    window.addEventListener('popstate', () => {
        try { window.dispatchEvent(new Event('spx-nav')); } catch {}
    });
}

// ── IDB helpers (parametric, auto-creates store on first open) ────────────────
function idbOpen(dbName, version, storeName) {
    return new Promise((res, rej) => {
        const req = indexedDB.open(dbName, version);
        req.onupgradeneeded = () => {
            if (storeName && !req.result.objectStoreNames.contains(storeName)) {
                req.result.createObjectStore(storeName);
            }
        };
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
    });
}

function idbGet(dbName, version, storeName, key) {
    return idbOpen(dbName, version, storeName).then(db => new Promise((res, rej) => {
        const r = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        r.onsuccess = () => { res(r.result); db.close(); };
        r.onerror   = () => { rej(r.error);  db.close(); };
    }));
}

function idbPut(dbName, version, storeName, key, val) {
    return idbOpen(dbName, version, storeName).then(db => new Promise((res, rej) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(val, key);
        tx.oncomplete = () => { res();         db.close(); };
        tx.onerror    = () => { rej(tx.error); db.close(); };
    }));
}

// ── GM request wrapper ────────────────────────────────────────────────────────
function gmReq(opts) {
    return new Promise((res, rej) => {
        GM_xmlhttpRequest({
            timeout: 30000,
            ...opts,
            onload:    r => (r.status >= 200 && r.status < 300
                ? res(r)
                : rej(new Error(`HTTP ${r.status}: ${(r.responseText || '').slice(0, 200)}`))),
            onerror:   () => rej(new Error('network')),
            ontimeout: () => rej(new Error('timeout')),
        });
    });
}

_docEl.SpxShared = { idb: { open: idbOpen, get: idbGet, put: idbPut }, gmReq };
console.log('[SPX] spx-shared v1.0');
})();
