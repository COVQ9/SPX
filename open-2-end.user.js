// ==UserScript==
// @name         Open-End flows
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/open-2-end.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/open-2-end.user.js
// @version      3.36
// @description  Full flow: login QR → auto drop-off → scan input → endtask complete + COD sound (IndexedDB cache), measurement, collect payment + minor hotkeys + operator name dưới QR. (Cash flow voucher buttons moved to log-log.user.js v1.1+)
// @match        https://spx.shopee.vn/*
// @match        https://sp.spx.shopee.vn/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';

// Skip inside iframes. find-details creates a hidden iframe to /awb-printing
// for eye-preview; without this guard, open-2-end inits inside that iframe →
// duplicate observers/intervals/listeners, useless because the iframe never
// shows login/QR/COD UI. Top-frame only.
if (window.top !== window) return;

// Shared audio queue — stored on document.documentElement so it is accessible
// from all scripts regardless of @grant sandbox level (window is a proxy in
// @grant GM_* scripts and does NOT share properties with @grant none scripts).
const _docEl = document.documentElement;
if (!_docEl._spxInterruptSound) {
    let _activeAudio = null;
    _docEl._spxInterruptSound = function(audio) {
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
const { idb } = document.documentElement.SpxShared;

/* ═══════════════════════════════════════════════
   UTILS
═══════════════════════════════════════════════ */
const q  = (s, r = document) => r.querySelector(s);
const qa = (s, r = document) => [...r.querySelectorAll(s)];

function vueClick(el) {
    if (!el) return;
    try {
        ['pointerdown','mousedown','pointerup','mouseup','click']
            .forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, composed:true })));
    } catch { try { el.click(); } catch {} }
}

const isVisible = document.documentElement.SpxShared?.isVisible
    || function (el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') <= 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };

const isInbound = () => location.pathname.startsWith('/inbound-management');

const pollFor = document.documentElement.SpxShared?.pollFor
    || function (check, callback, { timeout = 10000, interval = 100 } = {}) {
        const t0 = Date.now();
        const tick = () => {
            const r = check();
            if (r) { callback(r); return; }
            if (Date.now() - t0 < timeout) setTimeout(tick, interval);
        };
        tick();
    };

/* ═══════════════════════════════════════════════
   AUDIO (single shared context — no leaks)
═══════════════════════════════════════════════ */
let audioCtx = null;
let audioUnlocked = false;
let codUnlocked = false; // moved off codSound._unlocked → cleaner state

function getCtx() {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (e) { console.warn('[SPX] AudioContext init failed', e); return null; }
    }
    return audioCtx;
}

function unlockAudio() {
    const ctx = getCtx();
    if (ctx) {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        audioUnlocked = true;
    }

    if (codSound && !codUnlocked) {
        const v = codSound.volume;
        codSound.volume = 0;
        codSound.play().then(() => {
            codSound.pause();
            codSound.currentTime = 0;
            codSound.volume = v;
            codUnlocked = true;
        }).catch(() => { codSound.volume = v; });
    }

    if (audioUnlocked && (codUnlocked || codSoundFailed)) {
        window.removeEventListener('click',   unlockAudio);
        window.removeEventListener('keydown', unlockAudio);
    }
}
window.addEventListener('click',   unlockAudio);
window.addEventListener('keydown', unlockAudio);

function playChime() {
    const ctx = getCtx(); if (!ctx) return;
    try {
        [[880, 0], [1320, 100], [1760, 200]].forEach(([freq, delay]) =>
            setTimeout(() => {
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, ctx.currentTime);
                gain.gain.setValueAtTime(0, ctx.currentTime);
                gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(); osc.stop(ctx.currentTime + 0.4);
            }, delay)
        );
    } catch (e) { console.warn('[SPX] playChime', e); }
}

function playBoom() {
    const ctx = getCtx(); if (!ctx) return;
    try {
        const t0 = ctx.currentTime;

        const comp = ctx.createDynamicsCompressor();
        comp.threshold.setValueAtTime(-18, t0);
        comp.knee.setValueAtTime(6, t0);
        comp.ratio.setValueAtTime(6, t0);
        comp.attack.setValueAtTime(0.001, t0);
        comp.release.setValueAtTime(0.15, t0);

        const master = ctx.createGain();
        master.gain.setValueAtTime(1.6, t0);
        comp.connect(master);
        master.connect(ctx.destination);

        const crackSize = ctx.sampleRate * 0.06;
        const crackBuf = ctx.createBuffer(1, crackSize, ctx.sampleRate);
        const crackData = crackBuf.getChannelData(0);
        for (let i = 0; i < crackSize; i++) crackData[i] = Math.random() * 2 - 1;
        const crack = ctx.createBufferSource(); crack.buffer = crackBuf;
        const crackHP = ctx.createBiquadFilter();
        crackHP.type = 'highpass';
        crackHP.frequency.setValueAtTime(1500, t0);
        const crackGain = ctx.createGain();
        crackGain.gain.setValueAtTime(0.95, t0);
        crackGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);
        crack.connect(crackHP); crackHP.connect(crackGain); crackGain.connect(comp);
        crack.start(t0); crack.stop(t0 + 0.07);

        const sub = ctx.createOscillator();
        const subGain = ctx.createGain();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(220, t0);
        sub.frequency.exponentialRampToValueAtTime(50, t0 + 0.45);
        subGain.gain.setValueAtTime(1.0, t0);
        subGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.7);
        sub.connect(subGain); subGain.connect(comp);
        sub.start(t0); sub.stop(t0 + 0.75);

        const saw = ctx.createOscillator();
        const sawGain = ctx.createGain();
        saw.type = 'sawtooth';
        saw.frequency.setValueAtTime(160, t0);
        saw.frequency.exponentialRampToValueAtTime(40, t0 + 0.4);
        sawGain.gain.setValueAtTime(0.55, t0);
        sawGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
        saw.connect(sawGain); sawGain.connect(comp);
        saw.start(t0); saw.stop(t0 + 0.6);

        const rumbleSize = ctx.sampleRate * 0.8;
        const rumbleBuf = ctx.createBuffer(1, rumbleSize, ctx.sampleRate);
        const rumbleData = rumbleBuf.getChannelData(0);
        for (let i = 0; i < rumbleSize; i++) rumbleData[i] = Math.random() * 2 - 1;
        const rumble = ctx.createBufferSource(); rumble.buffer = rumbleBuf;
        const rumbleLP = ctx.createBiquadFilter();
        rumbleLP.type = 'lowpass';
        rumbleLP.frequency.setValueAtTime(2200, t0);
        rumbleLP.frequency.exponentialRampToValueAtTime(120, t0 + 0.7);
        const rumbleGain = ctx.createGain();
        rumbleGain.gain.setValueAtTime(0.85, t0);
        rumbleGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.75);
        rumble.connect(rumbleLP); rumbleLP.connect(rumbleGain); rumbleGain.connect(comp);
        rumble.start(t0); rumble.stop(t0 + 0.8);
    } catch (e) { console.warn('[SPX] playBoom', e); }
}

/* ═══════════════════════════════════════════════
   AUDIO CACHE (IndexedDB) — ETag stale-while-revalidate.
   Records: { blob, etag, checkedAt }. ETag round-trip skipped
   while checkedAt is within AUDIO_FRESH_MS (24 h).
═══════════════════════════════════════════════ */
const IDB_NAME       = 'spx_audio';
const IDB_STORE      = 'mp3';
const AUDIO_FRESH_MS = 24 * 60 * 60 * 1000;

function gmFetchBlob(url, etag) {
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

async function loadCachedAudio(key, url) {
    const raw = await idb.get(IDB_NAME, 1, IDB_STORE, key).catch(() => null);
    // Support old format (raw Blob) and new format ({ blob, etag, checkedAt })
    const cachedBlob = raw instanceof Blob ? raw : (raw?.blob ?? null);
    const cachedEtag = raw?.etag ?? null;
    const cachedAt   = raw?.checkedAt ?? 0;

    if (!cachedBlob) {
        // No cache — fetch fresh
        const r = await gmFetchBlob(url, null);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const rec = { blob: r.blob, etag: r.etag, checkedAt: Date.now() };
        idb.put(IDB_NAME, 1, IDB_STORE, key, rec)
            .then(() => window.NeonSync?.coldSync('spx_audio_cache', key, rec))
            .catch(e => console.warn('[SPX] IDB write failed for', key, e));
        console.log('[SPX] cached', key, '(' + Math.round(r.blob.size / 1024) + ' KB)');
        const a = new Audio(URL.createObjectURL(r.blob));
        a.preload = 'auto';
        return a;
    }

    const a = new Audio(URL.createObjectURL(cachedBlob));
    a.preload = 'auto';

    // Background ETag refresh — skip if still fresh
    if (Date.now() - cachedAt < AUDIO_FRESH_MS) return a;
    (async () => {
        const r   = await gmFetchBlob(url, cachedEtag);
        const now = Date.now();
        if (r.status === 304) {
            const _rec304 = { blob: cachedBlob, etag: cachedEtag, checkedAt: now };
            idb.put(IDB_NAME, 1, IDB_STORE, key, _rec304)
                .then(() => window.NeonSync?.coldSync('spx_audio_cache', key, _rec304))
                .catch(() => {});
            return;
        }
        if (r.status !== 200) return;
        const old = a.src;
        a.src = URL.createObjectURL(r.blob);
        if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
        const _rec200 = { blob: r.blob, etag: r.etag, checkedAt: now };
        idb.put(IDB_NAME, 1, IDB_STORE, key, _rec200)
            .then(() => window.NeonSync?.coldSync('spx_audio_cache', key, _rec200))
            .catch(e => console.warn('[SPX] IDB write failed', key, e));
    })();

    return a;
}

/* ═══════════════════════════════════════════════
   OPERATOR NAME (stale-while-revalidate)
   Render cache instant (nếu có), rồi luôn fetch fresh từ /sp-api/current_user
   để bắt đổi tài khoản. API chỉ work trên sp.spx.shopee.vn.
═══════════════════════════════════════════════ */
const OP_KEY    = 'operator_email_oe';
let operatorName = '';

async function detectOperatorName() {
    try {
        const cached = await idb.get(IDB_NAME, 1, IDB_STORE, OP_KEY).catch(() => null);
        if (cached?.name) { operatorName = cached.name; updateQrLabel(); }

        if (!location.hostname.startsWith('sp.')) return; // login host chưa có session
        const res   = await fetch('/sp-api/current_user?ignore_point_list_flag=true');
        const json  = await res.json();
        const email = (json?.data?.email || json?.data?.account || json?.email || json?.account || '').toLowerCase().trim();
        const name  = email.split('@')[0] || '';
        if (!name || name === cached?.name) return;
        operatorName = name;
        updateQrLabel();
        const _opRec = { name, checkedAt: Date.now() };
        idb.put(IDB_NAME, 1, IDB_STORE, OP_KEY, _opRec).catch(() => {});
    } catch (e) { console.warn('[SPX] detectOperatorName', e); }
}

function updateQrLabel() {
    const el = document.getElementById('spx-qr-label');
    if (el && operatorName) el.textContent = operatorName;
}

detectOperatorName();

/* ═══════════════════════════════════════════════
   COD MP3
═══════════════════════════════════════════════ */
const COD_URL = 'https://github.com/tasuaongvang/spx/raw/refs/heads/main/COD.mp3';
let codSound = null;
let codSoundFailed = false;

loadCachedAudio('cod', COD_URL)
    .then(a => { codSound = a; })
    .catch(e => {
        console.warn('[SPX] COD.mp3 load failed, will use synth fallback', e);
        codSoundFailed = true;
        if (audioUnlocked) {
            window.removeEventListener('click',   unlockAudio);
            window.removeEventListener('keydown', unlockAudio);
        }
    });

function playCodChime() {
    const ctx = getCtx(); if (!ctx) return;
    try {
        const t0 = ctx.currentTime;
        [[523.25, 0], [659.25, 0], [783.99, 0.18]].forEach(([f, d]) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'triangle';
            o.frequency.setValueAtTime(f, t0 + d);
            g.gain.setValueAtTime(0, t0 + d);
            g.gain.linearRampToValueAtTime(0.18, t0 + d + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.55);
            o.connect(g); g.connect(ctx.destination);
            o.start(t0 + d); o.stop(t0 + d + 0.6);
        });
    } catch (e) { console.warn('[SPX] playCodChime', e); }
}

/* ═══════════════════════════════════════════════
   LOGIN QR (cùng QR header — pixelated khi scale lên)
═══════════════════════════════════════════════ */
const ORB_SIZE = 345;
const QR_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJYAAACWAQAAAAAUekxPAAAA9UlEQVR4nOWWO27EMBBDn3YEbCnfIEeRbparyUfZG4zKAGMwxdpNPuVOkUxlsKEJkqCK+HrH7RsEfwVDDmCa5h2AHkm8XZI5Jpkkz+G9AaUMmmINVqkv4vgV2+vrOX7A1vuxZfJe/mrSMv298uw9O8/nTbu+kvK8Rl2jQqzBGseW5a8UbUZTtBlgaXqhwv1RKt2cjzKy9M5okk6xtBy9yDEJeLJbWo+e552m5z+k9vechpnV3xt0SbAfbzo2os2UXFWg0FlDa5hTI6e/1wo1leZHITbP3aNhTm3THln9PfdIAQGRl6u9lMIawN373XP8Lf/sHfsJB1+v8liflXwAAAAASUVORK5CYII=';
const SESSION_ERRORS = [
    'request header cookie.spx_cid OR spx_sp_cid is required',
    'Your account has logged in on another device. To use this device, please log in again.'
];

let loginDone = false; // master flag — once set, enhanceLogin is no-op

function autoClickOK() {
    qa('.ssc-message-box, .ssc-dialog').forEach(el => {
        // textContent: no reflow (innerText forces layout)
        const text = el.textContent || '';
        if (text.includes('Notification') && SESSION_ERRORS.some(msg => text.includes(msg))) {
            const ok = el.querySelector('button');
            if (ok && /ok/i.test(ok.textContent)) ok.click();
        }
    });
}

const ORB_CSS_TEXT =
    `position:fixed;top:50%;left:50%;width:${ORB_SIZE}px;height:${ORB_SIZE}px;` +
    'transform:translate(-50%,-50%);cursor:pointer;z-index:999999;' +
    `background:url('${QR_DATA_URL}') center/contain no-repeat;` +
    'border:none;image-rendering:pixelated;';

const ORB_PARENT_CSS =
    'position:fixed;inset:0;background:white;display:flex;' +
    'justify-content:center;align-items:center;z-index:999998;';

function enhanceLogin() {
    if (loginDone) return;

    const btn = q('button.index_googleBtn__V3otA.ssc-react-button-block');
    if (!btn) return;

    if (!btn.dataset.tmOrbDone) {
        btn.dataset.tmOrbDone = '1';
        btn.textContent = '';
        btn.style.cssText = ORB_CSS_TEXT;
        startLoginWatcher();
    }

    const parent = btn.parentElement;
    if (parent && !parent.dataset.tmBgDone) {
        parent.dataset.tmBgDone = '1';
        parent.style.cssText = ORB_PARENT_CSS;
    }

    const right = q('.index_right__7HK8z');
    if (right && !right.dataset.tmHidden) {
        right.dataset.tmHidden = '1';
        [...right.children].forEach(el => {
            if (!el.querySelector('.index_googleBtn__V3otA')) el.style.display = 'none';
        });
    }

    const normal = q('button.ssc-react-button.index_button__7Q3DI:not(.index_googleBtn__V3otA)');
    if (normal) normal.style.display = 'none';
}

/* ═══════════════════════════════════════════════
   POST-LOGIN WATCHER → AUTO-NAVIGATE
═══════════════════════════════════════════════ */
let loginWatchStarted = false;

function startLoginWatcher() {
    if (loginWatchStarted) return;
    loginWatchStarted = true;

    const iv = setInterval(() => {
        if (!q('button.index_googleBtn__V3otA[data-tm-orb-done="1"]')) {
            clearInterval(iv);
            loginDone = true; // stop running enhanceLogin forever
            playChime();
            goToDropOff();
        }
    }, 200);
    // Safety: clear after 5 min regardless (login page should resolve by then)
    setTimeout(() => clearInterval(iv), 5 * 60 * 1000);
}

/* ═══════════════════════════════════════════════
   DROP-OFF NAVIGATE — polling (no extra observers)
═══════════════════════════════════════════════ */
function goToDropOff() {
    pollFor(
        () => qa('a.submenu-item').find(a =>
            a.title === 'Drop-off Receive Task' || a.textContent.includes('Drop-off Receive Task')),
        link => {
            link.click();
            waitDropOffBtn(btn => btn.click());
        },
        { timeout: 10000, interval: 100 }
    );
}

function waitDropOffBtn(cb, timeout = 10000) {
    pollFor(
        () => qa('button').find(b => b.textContent.includes('Drop-off Receive') && b.offsetParent),
        cb,
        { timeout, interval: 120 }
    );
}

/* ═══════════════════════════════════════════════
   MINOR HOTKEYS — HELPERS
═══════════════════════════════════════════════ */
const PATH_RECEIVE  = '/inbound-management/receive-task';
const PATH_DROP_OFF = '/order-management/drop-off';
const TICKET_HREF   = '/point-service-point-support/ticket-center';
const POPUP_TEXT    = 'The task has not been completed yet, are you sure you want to quit?';
const DBL_WINDOW    = 350;
const HOLD_TIME     = 300;

function normalize(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

function spaNavigate(path) {
    if (location.pathname === path) return;
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
}

function blockDoubleShift() {
    const el = q('section.task-info-task-status');
    if (!el) return false;
    const t = normalize(el.textContent).toLowerCase();
    return t === 'created' || t === 'doing';
}

function shiftAction() {
    if (blockDoubleShift()) return;
    const dropBtn = q('button.ssc-button.ssc-btn-type-primary');
    if (dropBtn && normalize(dropBtn.textContent) === 'Drop-off Receive') { dropBtn.click(); return; }
    const taskLink = q('a.ssc-menu-item[href="/inbound-management/receive-task"]');
    if (taskLink) { taskLink.click(); return; }
    spaNavigate(PATH_RECEIVE);
}

function tryConfirmPopup() {
    for (const body of qa('.ssc-message-box-content .ssc-message-box-body')) {
        if (normalize(body.textContent) === POPUP_TEXT) {
            const btn = body.closest('.ssc-message-box-content')
                ?.querySelector('button.ssc-message-box-action-button');
            if (btn && normalize(btn.textContent) === 'Confirm') { btn.click(); return true; }
        }
    }
    return false;
}

function clickTicketCenter() {
    const link = q(`a[href="${TICKET_HREF}"]`);
    if (link) link.click(); else spaNavigate(TICKET_HREF);
}

function backtickAction() {
    if (tryConfirmPopup()) return;
    setTimeout(() => { if (!tryConfirmPopup()) clickTicketCenter(); }, 200);
}

function clickDOP(attempts = 8) {
    const tab = qa('.ssc-tabs-tab').find(t => normalize(t.textContent) === 'DOP Received');
    if (tab) { tab.click(); return; }
    if (attempts > 0) setTimeout(() => clickDOP(attempts - 1), 120);
}

function escAction() {
    if (location.pathname.includes(PATH_DROP_OFF)) { clickDOP(); return; }
    spaNavigate(PATH_DROP_OFF);
    setTimeout(() => clickDOP(), 200);
}

/* ═══════════════════════════════════════════════
   KEYBOARD — UNIFIED (capture phase)
═══════════════════════════════════════════════ */
let inputBuffer = '';
let lastKeyTime = 0;
let lastDot   = 0;
let lastCtrl  = 0;
let lastShift = 0;
let lastBtick = 0;
let lastEsc   = 0;
let ctrlArmed = false;
let holdKey   = null;
let holdStart = 0;
const DBL_DELAY   = 500;
const SCAN_GAP_MS = 150;

function checkHold() {
    if (!holdKey || Date.now() - holdStart < HOLD_TIME) return;
    if (holdKey === '`')      backtickAction();
    if (holdKey === 'Escape') escAction();
    holdKey = null;
}

document.addEventListener('keydown', e => {
    const now    = Date.now();
    const target = e.target;
    const editable = target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName);

    if (e.key === 'Enter') {
        const orb = q('button.index_googleBtn__V3otA[data-tm-orb-done="1"]');
        if (orb) { orb.click(); e.preventDefault(); return; }

        if (editable) {
            const el = document.activeElement;
            if (el && 'value' in el && isEndTask(el.value || '')) {
                e.preventDefault(); e.stopImmediatePropagation();
                handleScanInput(el); return;
            }
        }

        if (!editable) {
            if (inputBuffer) doManualFlow();
            inputBuffer = '';
        }
        return;
    }

    if (!editable && e.key.length === 1) {
        if (now - lastKeyTime > SCAN_GAP_MS) inputBuffer = '';
        inputBuffer += e.key;
        lastKeyTime = now;
    }

    if (!editable && e.key === '.' && e.location === 3) {
        if (now - lastDot <= DBL_DELAY) { doManualFlow(); inputBuffer = ''; lastDot = 0; }
        else lastDot = now;
        return;
    }

    if (e.key === 'Control' && !e.repeat) {
        if (ctrlArmed) {
            ctrlArmed = false;
            const completeBtn = isInbound() && getCompleteBtn();
            if (completeBtn) {
                e.preventDefault(); e.stopImmediatePropagation();
                document.documentElement._spxHVSound?.();
                vueClick(completeBtn);
            }
            return;
        }
        if (now - lastCtrl <= DBL_DELAY) {
            lastCtrl = 0;
            const completeBtn = isInbound() && getCompleteBtn();
            if (completeBtn) {
                if (codLastValue > 0) {
                    ctrlArmed = true; playBoom(); return;
                }
                e.preventDefault(); e.stopImmediatePropagation();
                document.documentElement._spxHVSound?.();
                vueClick(completeBtn);
            } else if (!editable) {
                doManualFlow(); inputBuffer = '';
            }
        } else {
            lastCtrl = now;
        }
    }

    if (e.key === 'Shift' && !editable) {
        if (now - lastShift < DBL_WINDOW) { e.preventDefault(); shiftAction(); }
        lastShift = now;
        return;
    }

    if (e.key === '`' && !editable) {
        if (now - lastBtick < DBL_WINDOW) {
            e.preventDefault(); backtickAction(); lastBtick = 0; return;
        }
        lastBtick = now; holdKey = '`'; holdStart = now;
        setTimeout(checkHold, HOLD_TIME + 10);
        return;
    }

    if (e.key === 'Escape' && !editable) {
        if (now - lastEsc < DBL_WINDOW) {
            e.preventDefault(); escAction(); lastEsc = 0; return;
        }
        lastEsc = now; holdKey = 'Escape'; holdStart = now;
        setTimeout(checkHold, HOLD_TIME + 10);
        return;
    }
}, true);

document.addEventListener('keyup', e => {
    if (e.key === '`' || e.key === 'Escape') holdKey = null;
});

function doManualFlow() {
    if (q('section.order-input .ssc-input')) return;

    const path = location.pathname.replace(/\/$/, '');
    if (path === '/inbound-management/receive-task') {
        const t0 = Date.now();
        const tryBtn = () => {
            const btn = qa('button').find(b => b.textContent.includes('Drop-off Receive') && b.offsetParent);
            if (btn) { btn.click(); return; }
            if (Date.now() - t0 < 5000) setTimeout(tryBtn, 200);
        };
        tryBtn(); return;
    }
    goToDropOff();
}

/* ═══════════════════════════════════════════════
   INBOUND: HEADER + COMPLETE BTN
═══════════════════════════════════════════════ */
function removeHeader() {
    qa('.ssc-layout-item.header-container, section.sp-title').forEach(el => el.remove());
}

// Spacer pushes the entire sidebar (logo + dropdown + menu) down so the
// fixed QR floats over a clean empty area. Inserted at the TOP of the
// sidebar parent — not just before the menu — otherwise the SPX logo and
// hub dropdown peek out above the QR.
function ensureSpacer() {
    if (document.getElementById('spx-spacer')) return;
    const menu = q('section.menu.expand-menu');
    if (!menu) return;
    const parent = menu.parentNode;
    if (!parent) return;
    const spacer = document.createElement('div');
    spacer.id = 'spx-spacer';
    spacer.style.height = '250px'; // clears QR (top 25px + 185px height + label ~20px + margin)
    parent.insertBefore(spacer, parent.firstChild);
}

function getCompleteBtn() {
    for (const b of qa('button.ssc-button.task-info-task-action.ssc-btn-type-primary:not(.ssc-btn-disabled)')) {
        const t = b.textContent.trim();
        if (t === 'Complete' || t === 'Collect Payment') return b;
    }
}

const handledBoxes = new WeakSet();
function handleLastBox() {
    const box = q('.ssc-message-box');
    if (!box || handledBoxes.has(box) || !isVisible(box)) return;
    const btn = q('.ssc-btn-type-primary', box);
    if (!btn) return;
    handledBoxes.add(box); // dedup BEFORE timeout to prevent N×click on same box
    setTimeout(() => vueClick(btn), 300);
}

/* ═══════════════════════════════════════════════
   INBOUND: SUSPICIOUS ACTIVITY DIALOG
═══════════════════════════════════════════════ */
const handledDialogs = new WeakSet();

function scanForSuspiciousDialog() {
    qa('.location-check-dialog-content').forEach(item => {
        try {
            const dlg = item.closest('.ssc-dialog-content') || item.closest('.ssc-dialog');
            if (!dlg || !isVisible(dlg)) return;
            if (!dlg.querySelector('.ssc-dialog-title span')?.textContent.includes('Suspicious Activity Detected')) return;
            if (handledDialogs.has(dlg)) return;
            handledDialogs.add(dlg);
            handleLocationDialog(dlg, item);
        } catch (err) { console.error('[SPX]', err); }
    });
}

function handleLocationDialog(dlg, inner) {
    let attempt = 0;
    const trySelect = () => {
        attempt++;
        if (forceCheckFirstRadio(inner || dlg)) {
            setTimeout(() => {
                const btn = dlg.querySelector('.ssc-dialog-footer .ssc-btn-type-primary')
                         || dlg.querySelector('button.ssc-btn-type-primary');
                if (btn) vueClick(btn);
            }, 140);
            return;
        }
        vueClick(dlg.querySelector('.ssc-dialog-body') || dlg);
        if (attempt < 15) setTimeout(trySelect, 120);
    };
    setTimeout(trySelect, 50);
}

function forceCheckFirstRadio(ctx) {
    try {
        const wrapper = (ctx.querySelector ? ctx : document).querySelector('.ssc-radio-wrapper');
        if (!wrapper) return false;
        const input = wrapper.querySelector('input[type="radio"]');
        if (input && !input.checked) {
            input.checked = true;
            ['input', 'change'].forEach(t => input.dispatchEvent(new Event(t, { bubbles: true })));
            input.click();
        }
        return !!(input?.checked);
    } catch (e) { console.warn('[SPX] forceCheckFirstRadio', e); return false; }
}

/* ═══════════════════════════════════════════════
   INBOUND: QR + TOAST
═══════════════════════════════════════════════ */
// Static parts of the QR style; `left` is set dynamically to center on the
// actual menu width (was hard-coded 7% which landed off-center).
const QR_TOP        = 25;
const QR_WIDTH      = 185;
const QR_LABEL_GAP  = 4;
const QR_LABEL_TOP  = QR_TOP + QR_WIDTH + QR_LABEL_GAP; // PNG vuông → render height = width
const QR_BASE_CSS   = `position:fixed;top:${QR_TOP}px;width:${QR_WIDTH}px;opacity:0.95;z-index:2147483647;pointer-events:none;transform:translateX(-50%);`;
const QR_LABEL_CSS  =
    `position:fixed;top:${QR_LABEL_TOP}px;width:${QR_WIDTH}px;text-align:center;` +
    'font-family:system-ui,sans-serif;font-size:13px;font-weight:600;color:#374151;' +
    'opacity:0.95;z-index:2147483647;pointer-events:none;transform:translateX(-50%);';

let _qrResizeObserver = null;
let _qrResizeListener = null;
function ensureQR() {
    if (document.getElementById('spx-qr')) return;
    const menu = q('section.menu.expand-menu');
    if (!menu) return; // pre-login or menu not rendered yet

    // Tear down any previous observer/listener (e.g. SPA re-mounted the menu,
    // leaving the old ResizeObserver pinning a detached node + closure).
    if (_qrResizeObserver) { try { _qrResizeObserver.disconnect(); } catch {} _qrResizeObserver = null; }
    if (_qrResizeListener) { window.removeEventListener('resize', _qrResizeListener); _qrResizeListener = null; }

    const img = Object.assign(document.createElement('img'), { id: 'spx-qr' });
    img.src = QR_DATA_URL;
    img.style.cssText = QR_BASE_CSS;
    document.body.appendChild(img);

    const label = Object.assign(document.createElement('div'), { id: 'spx-qr-label' });
    label.style.cssText = QR_LABEL_CSS;
    label.textContent = operatorName || '';
    document.body.appendChild(label);

    // Center QR + label horizontally over the sidebar/menu
    const positionQR = () => {
        const rect = menu.getBoundingClientRect();
        if (rect.width > 0) {
            const cx = (rect.left + rect.width / 2) + 'px';
            img.style.left   = cx;
            label.style.left = cx;
        }
    };
    positionQR();
    _qrResizeListener = positionQR;
    window.addEventListener('resize', _qrResizeListener);
    if (typeof ResizeObserver !== 'undefined') {
        _qrResizeObserver = new ResizeObserver(positionQR);
        _qrResizeObserver.observe(menu);
    }
}

const TOAST_CSS =
    'position:fixed;right:18px;bottom:38px;z-index:999999;' +
    'padding:8px 12px;background:rgba(0,0,0,0.72);color:white;' +
    'border-radius:6px;font-size:13px;font-family:system-ui,sans-serif;' +
    'box-shadow:0 6px 18px rgba(0,0,0,0.3);opacity:0;transition:opacity 0.25s;';

function showToast(msg, timeout = 1200) {
    let el = document.getElementById('spx-toast');
    if (!el) {
        el = Object.assign(document.createElement('div'), { id: 'spx-toast' });
        el.style.cssText = TOAST_CSS;
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => el.style.opacity = '0', timeout);
}

/* ═══════════════════════════════════════════════
   INBOUND: COD CHIME (gated by Collect Payment confirm)
═══════════════════════════════════════════════ */
let codLastValue = null;
let codLastPath  = '';

/** Check button bottom = "Collect Payment" (= active COD task, có tiền chờ thu).
 *  KHÔNG match "Complete" hay "Print Receipt" hay disabled state. */
function isCollectPaymentMode() {
    return !!qa('button.ssc-button.task-info-task-action.ssc-btn-type-primary')
        .find(b => b.textContent.trim() === 'Collect Payment');
}

function checkTotalCollection() {
    // Navigation guard — pathname đổi → reset codLastValue, skip play lần đầu
    // (tránh false trigger khi sang task khác đã có sẵn COD).
    if (location.pathname !== codLastPath) {
        codLastPath = location.pathname;
        codLastValue = null;
        return;
    }
    const sec = qa('section.task-info-amount-item')
        .find(s => s.textContent.includes('Total Collection'));
    if (!sec) return;
    const raw = sec.querySelector('p')?.textContent.trim();
    if (!raw || raw === '–' || raw === '') { codLastValue = 0; return; }
    const val = parseFloat(raw.replace(/,/g, ''));
    if (isNaN(val)) return;
    // Trigger conditions (theo spec user):
    //   1. Button bottom = "Collect Payment" (active COD mode)
    //   2. COD tăng (val > codLastValue) — bao gồm "–" → first positive
    //   3. codLastValue đã initialized (!= null) — chống false trigger lần đầu sau nav
    // Decrease (remove order) → val < codLastValue → no play, chỉ update codLastValue.
    if (codLastValue !== null && val > codLastValue && isCollectPaymentMode()) {
        const delta = val - codLastValue;
        console.log('[SPX] COD chime trigger — Δ', delta, 'mp3?', !!(codSound && codUnlocked), 'audioCtx?', audioUnlocked);
        if (codSound && codUnlocked) {
            _docEl._spxInterruptSound(codSound);
        } else if (audioUnlocked) {
            playCodChime(); // AudioContext synth — plays immediately, no queue
        } else {
            console.warn('[SPX] COD chime SKIP — audio chưa unlock (cần user click/keydown ít nhất 1 lần)');
        }
    }
    codLastValue = val;
}

/* ═══════════════════════════════════════════════
   INBOUND: MEASUREMENT + COLLECT PAYMENT (NSS)
═══════════════════════════════════════════════ */
const handledMeasurement  = new WeakSet();
const handledPreviousTask = new WeakSet();

// When user clicks "Edit" on a scanned off-platform AWB, the Measurement dialog
// opens — but user wants to fill fields manually. Flag is set on Edit click and
// consumed on the next Measurement dialog encounter. Scan flow unaffected (scanning
// never sets this flag). 5s auto-reset is a safety net if no dialog appears.
let _skipMeasurement  = false;
let _skipMeasureTimer = null;
document.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn && btn.textContent.trim() === 'Edit') {
        _skipMeasurement = true;
        clearTimeout(_skipMeasureTimer);
        _skipMeasureTimer = setTimeout(() => { _skipMeasurement = false; }, 5000);
    }
}, true);

function autoConfirmMeasurement() {
    qa('.ssc-dialog-content.large').forEach(popup => {
        if (handledMeasurement.has(popup)) return;
        const title = popup.querySelector('.ssc-dialog-title span');
        if (title?.textContent.trim() !== 'Measurement') return;
        const btn = popup.querySelector('.ssc-dialog-footer .ssc-btn-type-primary');
        if (!btn) return;
        handledMeasurement.add(popup); // dedup before click
        if (_skipMeasurement) {
            _skipMeasurement = false;
            clearTimeout(_skipMeasureTimer);
            // Focus weight input so user can type immediately
            setTimeout(() => popup.querySelector('input[placeholder="Input"]')?.focus(), 50);
            return; // user opened via Edit — let them fill manually
        }
        btn.click();
    });
}

const COLLECT_CONFIRM_CSS =
    'opacity:1;transform:scale(1.03);transition:0.18s ease;' +
    'box-shadow:0 0 0 2px rgba(255,111,0,0.25),0 2px 6px rgba(0,0,0,0.18);' +
    'border-radius:8px;font-weight:600;';

function autoFillCollectPayment(node) {
    // Pre-filter: most added nodes aren't dialogs — skip cheaply
    const dialog = node.matches?.('.ssc-dialog-content')
        ? node
        : node.querySelector?.('.ssc-dialog-content');
    if (!dialog) return;

    const title = dialog.querySelector('.ssc-dialog-title span');
    if (title?.textContent.trim() !== 'Collect Payment') return;

    const input = dialog.querySelector('input[placeholder="Please Input"]');
    if (input) {
        input.value = '1000000';
        ['input', 'change'].forEach(t => input.dispatchEvent(new Event(t, { bubbles: true })));
    }
    const cancelBtn  = dialog.querySelector('.ssc-dialog-footer .ssc-button:not(.ssc-btn-type-primary)');
    const confirmBtn = dialog.querySelector('.ssc-dialog-footer .ssc-btn-type-primary');
    if (cancelBtn) { cancelBtn.style.opacity = '0.35'; cancelBtn.style.pointerEvents = 'none'; }
    if (confirmBtn) {
        confirmBtn.style.cssText = (confirmBtn.style.cssText || '') + COLLECT_CONFIRM_CSS;
        setTimeout(() => confirmBtn.focus(), 80);
        setTimeout(() => confirmBtn.click(), 400);
    }
}

// COD interval: only run on inbound pages — saves 2 querySelectorAll/sec elsewhere.
// Also skip when tab hidden; Chrome throttles to 1Hz anyway and a chime nobody
// will hear is wasted work + risk of mp3 quota burn.
const _codIv = setInterval(() => { if (!document.hidden && isInbound()) checkTotalCollection(); }, 500);

/* ═══════════════════════════════════════════════
   INBOUND: ENDTASK SCANNER
═══════════════════════════════════════════════ */
const ENDTASK_CODES = new Set(['TDONEZ', 'endtask', '4710200746078', 'SPXVN12345678910']);
const isEndTask = v => ENDTASK_CODES.has((v || '').trim());
const _origValueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

function clearInput(el) {
    try {
        _origValueDesc.set.call(el, '');
        ['input', 'change'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
    } catch (e) { console.warn('[SPX] clearInput', e); }
}

function handleScanInput(el) {
    if (!el || !('value' in el)) return;
    const v = (el.value || '').replace(/[\r\n]+/g, '');
    if (!isEndTask(v)) return;
    clearInput(el);
    showToast('endtask detected → auto complete');
    document.documentElement._spxHVSound?.();
    vueClick(getCompleteBtn());
}

document.addEventListener('input', e => handleScanInput(e.target), true);

function patchInputForEndtask(input) {
    if (!input || input._endtaskPatched) return;
    input._endtaskPatched = true;
    Object.defineProperty(input, 'value', {
        set(v) {
            const clean = typeof v === 'string' ? v.replace(/[\r\n]+/g, '') : v;
            _origValueDesc.set.call(this, clean);
            setTimeout(() => handleScanInput(this), 0);
        },
        get() { return _origValueDesc.get.call(this); },
        configurable: true
    });
}

let _patchedScanInput = null;
function patchInboundScanInputs() {
    if (!isInbound()) return;
    // Cached fast-path: already patched and still in DOM → skip query
    if (_patchedScanInput?.isConnected) return;
    const input = q('section.order-input .ssc-input input');
    if (input) {
        patchInputForEndtask(input);
        _patchedScanInput = input;
    }
}

/* ═══════════════════════════════════════════════
   UNIFIED OBSERVER — rAF-throttled, addedNodes-only
═══════════════════════════════════════════════ */

function handlePreviousTaskModal() {
    const modal = qa('.ssc-message-box-wrapper').find(m => {
        if (handledPreviousTask.has(m)) return false;
        return m.querySelector('.ssc-message-box-title span')?.textContent.includes('Entered a previous inbound task');
    });
    if (modal) {
        const btn = qa('button', modal).find(b => b.textContent.includes('Enter previous task'));
        if (btn) {
            handledPreviousTask.add(modal); // dedup before click
            btn.click();
        }
    }
}

/* RECEIPT LEDGER + COD INCOME BUTTONS — moved to log-log.user.js (v1.1+) */

let uiScheduled = false;
function smartUpdate() {
    uiScheduled = false;
    autoClickOK();
    if (!loginDone) enhanceLogin();
    scanForSuspiciousDialog();
    patchInboundScanInputs();
    // Header + QR + spacer: run on EVERY logged-in page so default Shopee
    // header is always gone and QR persists across hard reloads anywhere.
    removeHeader();
    ensureQR();
    ensureSpacer();
    if (isInbound()) {
        handleLastBox();
        autoConfirmMeasurement();
    }
    handlePreviousTaskModal();
}

const _mainObs = new MutationObserver(mutations => {
    // Skip mutation batches with no added nodes — Vue/React fire many
    // attribute/text mutations; saves CPU on busy SPA churn.
    let hasAdd = false;
    for (let i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length) { hasAdd = true; break; }
    }
    if (!hasAdd) return;

    for (const m of mutations) {
        for (const node of m.addedNodes) {
            if (node instanceof HTMLElement) autoFillCollectPayment(node);
        }
    }

    if (!uiScheduled) {
        uiScheduled = true;
        requestAnimationFrame(smartUpdate);
    }
});
_mainObs.observe(document.body, { childList: true, subtree: true });

document.documentElement.SpxShared?.addUnloadCleanup?.(() => {
    clearInterval(_codIv);
    _mainObs.disconnect();
    if (_qrResizeObserver) { try { _qrResizeObserver.disconnect(); } catch {} }
    if (_qrResizeListener) { window.removeEventListener('resize', _qrResizeListener); }
});

setTimeout(smartUpdate, 400);
console.log('[SPX] open-end flow v3.35 loaded');
})();
