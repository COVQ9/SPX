// ==UserScript==
// @name         SPX Shared
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/spx-shared.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/spx-shared.user.js
// @version      2.2
// @description  Shared utilities v2.1: SPA nav patch, IDB helpers, GM request wrapper, loadAudio (ETag SWR MP3 cache), toast, watchEl, pollFor, debounce, isVisible, getExtraChar, fmtShorthand, fmtDate, addUnloadCleanup, makeKvAuth, audio sequencer. Sort FIRST in Tampermonkey dashboard.
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
// Guard prevents chain-wrapping if a fallback script already patched first.
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

// ── IDB helpers ───────────────────────────────────────────────────────────────
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

// Cursor scan — returns [{key, value}] for all records in store.
function idbGetAll(dbName, version, storeName) {
    return idbOpen(dbName, version, storeName).then(db => new Promise((res, rej) => {
        const entries = [];
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
        req.onsuccess = e => {
            const cur = e.target.result;
            if (cur) { entries.push({ key: cur.primaryKey, value: cur.value }); cur.continue(); }
            else      { res(entries); db.close(); }
        };
        req.onerror = () => { rej(req.error); db.close(); };
    }));
}

// Long-lived cached connection — avoids open/close on every read/write.
// Automatically invalidated on versionchange or unexpected close.
const _dbCache = new Map(); // "dbName:version" → IDBDatabase

function idbSession(dbName, version, storeName) {
    const cacheKey = `${dbName}:${version}`;
    const cached = _dbCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    return idbOpen(dbName, version, storeName).then(db => {
        _dbCache.set(cacheKey, db);
        db.onversionchange = () => { _dbCache.delete(cacheKey); try { db.close(); } catch {} };
        db.onclose         = () => _dbCache.delete(cacheKey);
        return db;
    });
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

// ── Audio cache: unified MP3 ETag stale-while-revalidate ─────────────────────
// All scripts call SpxShared.loadAudio(key, url, audioEl?, refreshDelay?).
// GM_xmlhttpRequest is captured in this closure so @grant none callers work.

const _AUDIO_DB    = 'spx_audio';
const _AUDIO_STORE = 'mp3';
const _AUDIO_FRESH = 24 * 60 * 60 * 1000;

function _gmFetchBlob(url, etag) {
    return new Promise(resolve => {
        const headers = etag ? { 'If-None-Match': etag } : {};
        GM_xmlhttpRequest({
            method: 'GET', url, headers, responseType: 'blob',
            onload(r) {
                const newEtag = r.responseHeaders?.match(/etag:\s*(.+)/i)?.[1]?.trim() || null;
                if (r.status === 200)      resolve({ status: 200, blob: r.response, etag: newEtag });
                else if (r.status === 304) resolve({ status: 304 });
                else                       resolve({ status: r.status });
            },
            onerror() { resolve({ status: 0 }); },
        });
    });
}

async function loadAudio(key, url, audioEl, refreshDelay = 0) {
    const el = audioEl ?? new Audio();
    el.preload = 'auto';
    el.onerror = e => console.warn('[SPX] audio error', key, e);

    // 1. Read from unified IDB store
    let raw = await idbGet(_AUDIO_DB, 1, _AUDIO_STORE, key).catch(() => null);

    // 2. One-time migration: hv.mp3 was previously stored in spx_fd_audio/mp3
    if (!raw && key === 'hv') {
        raw = await idbGet('spx_fd_audio', 1, 'mp3', 'hv').catch(() => null);
        if (raw) {
            const migRec = raw instanceof Blob ? { blob: raw, etag: null, checkedAt: 0 } : raw;
            idbPut(_AUDIO_DB, 1, _AUDIO_STORE, key, migRec).catch(() => {});
        }
    }

    // 3. Normalise record (old open-2-end stored raw Blob directly)
    const cachedBlob = raw instanceof Blob ? raw : (raw?.blob ?? null);
    const cachedEtag = raw?.etag ?? null;
    const cachedAt   = raw?.checkedAt ?? 0;

    if (cachedBlob) {
        el.src = URL.createObjectURL(cachedBlob);
    } else {
        // 4. No cache — blocking fetch; reject so callers' .catch() fires
        const r = await _gmFetchBlob(url, null);
        if (r.status !== 200) throw new Error(`[SPX] loadAudio ${key}: fetch failed (${r.status})`);
        const rec = { blob: r.blob, etag: r.etag, checkedAt: Date.now() };
        el.src = URL.createObjectURL(r.blob);
        idbPut(_AUDIO_DB, 1, _AUDIO_STORE, key, rec)
            .then(() => window.NeonSync?.coldSync('spx_audio_cache', key, rec))
            .catch(() => {});
        return el;
    }

    // 5. Background ETag refresh — staggered by refreshDelay
    if (Date.now() - cachedAt >= _AUDIO_FRESH) {
        setTimeout(async () => {
            const r   = await _gmFetchBlob(url, cachedEtag);
            const now = Date.now();
            if (r.status === 304) {
                const rec304 = { blob: cachedBlob, etag: cachedEtag, checkedAt: now };
                idbPut(_AUDIO_DB, 1, _AUDIO_STORE, key, rec304)
                    .then(() => window.NeonSync?.coldSync('spx_audio_cache', key, rec304))
                    .catch(() => {});
                return;
            }
            if (r.status !== 200) return;
            const old = el.src;
            el.src = URL.createObjectURL(r.blob);
            if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
            const rec200 = { blob: r.blob, etag: r.etag, checkedAt: now };
            idbPut(_AUDIO_DB, 1, _AUDIO_STORE, key, rec200)
                .then(() => window.NeonSync?.coldSync('spx_audio_cache', key, rec200))
                .catch(() => {});
        }, refreshDelay);
    }

    return el;
}

// ── Unload cleanup registry ───────────────────────────────────────────────────
// Call addUnloadCleanup(fn) from any script; all fns run on pagehide.
// Also closes all cached IDB connections on unload.
const _cleanupFns = [];
function addUnloadCleanup(fn) { _cleanupFns.push(fn); }
window.addEventListener('pagehide', () => {
    _cleanupFns.forEach(fn => { try { fn(); } catch {} });
    _dbCache.forEach(db => { try { db.close(); } catch {} });
    _dbCache.clear();
}, { once: true });

// ── DOM: pollFor ──────────────────────────────────────────────────────────────
// One-shot polling until check() returns truthy, then calls callback with result.
function pollFor(check, callback, { timeout = 10_000, interval = 100 } = {}) {
    const t0 = Date.now();
    const tick = () => {
        const r = check();
        if (r)                             { callback(r); return; }
        if (Date.now() - t0 < timeout)    { setTimeout(tick, interval); }
    };
    tick();
}

// ── DOM: watchEl ──────────────────────────────────────────────────────────────
// MutationObserver-based element watcher — replaces setInterval+querySelectorAll.
// Calls onAdded(el) once per element (tracked via dataset._spxWatched).
// Returns a disconnect function.
function watchEl(selector, onAdded, { root, subtree = true } = {}) {
    const r = root || document.body;
    const scan = () => {
        r.querySelectorAll(selector).forEach(el => {
            if (el.dataset._spxWatched) return;
            el.dataset._spxWatched = '1';
            try { onAdded(el); } catch (e) { console.warn('[SPX] watchEl cb', e); }
        });
    };
    const obs = new MutationObserver(scan);
    obs.observe(r, { childList: true, subtree });
    scan(); // catch already-present elements
    return () => obs.disconnect();
}

// ── DOM: isVisible ────────────────────────────────────────────────────────────
function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') <= 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

// ── debounce ──────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
    let t;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
    };
}

// ── Toast notification ────────────────────────────────────────────────────────
// opts: { timeout=2500, color, bottom, id }
function toast(msg, opts = {}) {
    const {
        timeout = 2500,
        color   = 'rgba(17,21,28,.93)',
        bottom  = '20px',
        id      = 'spx-shared-toast',
    } = opts;
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.style.cssText =
            `position:fixed;right:18px;bottom:${bottom};z-index:2147483640;` +
            `background:${color};color:#fff;padding:10px 16px;border-radius:8px;` +
            'font-size:13px;font-family:system-ui,sans-serif;line-height:1.4;' +
            'box-shadow:0 6px 18px rgba(0,0,0,.3);opacity:0;' +
            'transition:opacity .18s ease;pointer-events:none;max-width:340px;';
        (document.body || _docEl).appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, timeout);
}

// ── SPX business utilities ────────────────────────────────────────────────────

// AWB month suffix: 1-9 → '1'-'9', Oct→'A', Nov→'B', Dec→'C'
function getExtraChar(date) {
    const m = (date || new Date()).getMonth() + 1;
    return m <= 9 ? String(m) : m === 10 ? 'A' : m === 11 ? 'B' : 'C';
}

// Vietnamese shorthand: 250000 → "250k", 1250000 → "1tr250k"
function fmtShorthand(n) {
    n = Math.round(n || 0);
    if (n === 0) return '0';
    const tr = Math.floor(n / 1_000_000);
    const k  = Math.floor((n % 1_000_000) / 1_000);
    let s = '';
    if (tr) s += tr + 'tr';
    if (k)  s += k  + 'k';
    if (!s) s  = n  + '';
    return s;
}

// Date → "07MAY2026" format used in filenames
function fmtDate(date) {
    const d = date || new Date();
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return String(d.getDate()).padStart(2,'0') + months[d.getMonth()] + d.getFullYear();
}

// ── KiotVit auth factory ──────────────────────────────────────────────────────
// Returns { kvLogin, kvAuthedReq } sharing auth state via caller-supplied
// getToken()/setToken() — works with localStorage (log-log) or GM_getValue (refund-nss).
function makeKvAuth(getToken, setToken, kvBaseUrl) {
    async function kvLogin(pin) {
        const r = await gmReq({
            method: 'POST',
            url:    `${kvBaseUrl}/api/auth/pin`,
            headers: { 'Content-Type': 'application/json' },
            data:   JSON.stringify({ pin }),
        });
        const j = JSON.parse(r.responseText);
        if (!j.token) throw new Error('KiotVit login: no token in response');
        setToken(j.token);
        return j.token;
    }

    async function kvAuthedReq(pin, opts) {
        const withAuth = tk => ({
            ...opts,
            headers: { ...(opts.headers || {}), Authorization: `Bearer ${tk}` },
        });
        let token = getToken() || await kvLogin(pin);
        try {
            return await gmReq(withAuth(token));
        } catch (e) {
            if (!/HTTP 401/.test(e.message || '')) throw e;
            setToken(null);
            token = await kvLogin(pin);
            return gmReq(withAuth(token));
        }
    }

    return { kvLogin, kvAuthedReq };
}

// ── Audio sequencer ───────────────────────────────────────────────────────────
// Defined here so ownership is clear; guarded so whichever script loads first wins
// (open-2-end and find-details carry the same guard — they become no-ops with v2).

if (!_docEl._spxInterruptSound) {
    // Interrupt mode: stop current audio, play new one immediately.
    let _activeAudio = null;
    _docEl._spxInterruptSound = function (audio) {
        if (_activeAudio && _activeAudio !== audio) {
            _activeAudio.onended = null;
            _activeAudio.onerror = null;
            _activeAudio.pause();
        }
        _activeAudio = audio;
        audio.currentTime = 0;
        const clear = () => { if (_activeAudio === audio) _activeAudio = null; };
        audio.onended = clear;
        audio.onerror = clear;
        audio.play().catch(e => { console.warn('[SPX] play failed', e); clear(); });
    };
}

if (!_docEl._spxEnqueueSound) {
    // Queue mode: play sounds sequentially, each waits for the previous to finish.
    _docEl._spxEnqueueSound = function (playFn) {
        _docEl._spxAudioQueue = (_docEl._spxAudioQueue || Promise.resolve())
            .then(() => playFn())
            .catch(() => {});
    };
}

// ── Export ────────────────────────────────────────────────────────────────────
_docEl.SpxShared = {
    // IDB
    idb: {
        open:    idbOpen,
        get:     idbGet,
        put:     idbPut,
        getAll:  idbGetAll,
        session: idbSession,
    },
    // Network
    gmReq,
    // Lifecycle
    addUnloadCleanup,
    // DOM
    pollFor,
    watchEl,
    isVisible,
    debounce,
    toast,
    // Business
    getExtraChar,
    fmtShorthand,
    fmtDate,
    makeKvAuth,
    // Audio
    loadAudio,
};

console.log('[SPX] spx-shared v2.2 — loadAudio unified MP3 cache + error hardening');
})();
