// ==UserScript==
// @name         Open-End flows
// @namespace    http://tampermonkey.net/
// @version      3.4
// @description  Full flow: login ORB → auto drop-off → scan input → endtask complete + COD sound, measurement, collect payment + minor hotkeys
// @match        https://spx.shopee.vn/*
// @match        https://sp.spx.shopee.vn/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';

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

function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') <= 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

const isInbound = () => location.pathname.startsWith('/inbound-management');

/* ═══════════════════════════════════════════════
   LOGIN ORB
═══════════════════════════════════════════════ */
const ORB_IMAGE = 'https://raw.githubusercontent.com/tasuaongvang/spx/refs/heads/main/qr-open.png';
const ORB_SIZE  = 345;
const SESSION_ERRORS = [
    'request header cookie.spx_cid OR spx_sp_cid is required',
    'Your account has logged in on another device. To use this device, please log in again.'
];

function autoClickOK() {
    qa('.ssc-message-box, .ssc-dialog').forEach(el => {
        const text = el.innerText || '';
        if (text.includes('Notification') && SESSION_ERRORS.some(msg => text.includes(msg))) {
            const ok = el.querySelector('button');
            if (ok && /ok/i.test(ok.textContent)) ok.click();
        }
    });
}

function enhanceLogin() {
    const btn = q('button.index_googleBtn__V3otA.ssc-react-button-block');
    if (!btn) return;

    if (!btn.dataset.tmOrbDone) {
        btn.dataset.tmOrbDone = '1';
        btn.textContent = '';
        Object.assign(btn.style, {
            position: 'fixed', top: '50%', left: '50%',
            width: ORB_SIZE + 'px', height: ORB_SIZE + 'px',
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%', cursor: 'pointer', zIndex: '999999',
            backgroundImage: `url("${ORB_IMAGE}")`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            border: 'none', boxShadow: 'none'
        });
        startLoginWatcher(); // watch from this moment
    }

    const parent = btn.parentElement;
    if (parent && !parent.dataset.tmBgDone) {
        parent.dataset.tmBgDone = '1';
        Object.assign(parent.style, {
            position: 'fixed', inset: '0', background: 'white',
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            zIndex: '999998'
        });
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
   (fix: was using wrong attribute data-_tm-orb-done)
═══════════════════════════════════════════════ */
let loginWatchStarted = false;

function startLoginWatcher() {
    if (loginWatchStarted) return;
    loginWatchStarted = true;

    const iv = setInterval(() => {
        if (!q('button.index_googleBtn__V3otA[data-tm-orb-done="1"]')) {
            clearInterval(iv);
            playChime();
            goToDropOff();
        }
    }, 200);
}

/* ═══════════════════════════════════════════════
   CHIME
═══════════════════════════════════════════════ */
function playChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
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
    } catch {}
}

function playBoom() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const t0 = ctx.currentTime;

        // Sub-bass whoomp: 180Hz → 30Hz sweep
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(180, t0);
        osc.frequency.exponentialRampToValueAtTime(30, t0 + 0.7);
        oscGain.gain.setValueAtTime(0.9, t0);
        oscGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9);
        osc.connect(oscGain);
        oscGain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.9);

        // Filtered white noise: the crack + rumble
        const size = ctx.sampleRate * 1.0;
        const buf = ctx.createBuffer(1, size, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;

        const noise = ctx.createBufferSource();
        noise.buffer = buf;

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, t0);
        filter.frequency.exponentialRampToValueAtTime(80, t0 + 0.8);

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.7, t0);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.8);

        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(ctx.destination);
        noise.start(t0);
        noise.stop(t0 + 1.0);
    } catch {}
}

/* ═══════════════════════════════════════════════
   DROP-OFF NAVIGATE
═══════════════════════════════════════════════ */
function goToDropOff() {
    const findLink = () => qa('a.submenu-item').find(a =>
        a.title === 'Drop-off Receive Task' || a.textContent.includes('Drop-off Receive Task')
    );

    const link = findLink();
    if (link) { link.click(); waitDropOffBtn(btn => btn.click()); return; }

    // Wait for menu to render after login redirect
    const obs = new MutationObserver(() => {
        const l = findLink();
        if (l) { obs.disconnect(); l.click(); waitDropOffBtn(btn => btn.click()); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 10000);
}

function waitDropOffBtn(cb, timeout = 10000) {
    const t0 = Date.now();
    const existing = qa('button').find(b => b.textContent.includes('Drop-off Receive') && b.offsetParent);
    if (existing) { cb(existing); return; }

    const obs = new MutationObserver(() => {
        const btn = qa('button').find(b => b.textContent.includes('Drop-off Receive') && b.offsetParent);
        if (btn) { obs.disconnect(); cb(btn); }
        else if (Date.now() - t0 > timeout) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), timeout); // hard fallback
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
    const t = normalize(el.innerText).toLowerCase();
    return t === 'created' || t === 'doing';
}

function shiftAction() {
    if (blockDoubleShift()) return;
    const dropBtn = q('button.ssc-button.ssc-btn-type-primary');
    if (dropBtn && normalize(dropBtn.innerText) === 'Drop-off Receive') { dropBtn.click(); return; }
    const taskLink = q('a.ssc-menu-item[href="/inbound-management/receive-task"]');
    if (taskLink) { taskLink.click(); return; }
    spaNavigate(PATH_RECEIVE);
}

function tryConfirmPopup() {
    for (const body of qa('.ssc-message-box-content .ssc-message-box-body')) {
        if (normalize(body.innerText) === POPUP_TEXT) {
            const btn = body.closest('.ssc-message-box-content')
                ?.querySelector('button.ssc-message-box-action-button');
            if (btn && normalize(btn.innerText) === 'Confirm') { btn.click(); return true; }
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
    const tab = qa('.ssc-tabs-tab').find(t => normalize(t.innerText) === 'DOP Received');
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
const DBL_DELAY   = 500; // ctrl/dot
const SCAN_GAP_MS = 150; // scanner finishes a code in <150ms; human typing is slower

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

    /* ── Enter ── */
    if (e.key === 'Enter') {
        // 1. ORB login page
        const orb = q('button.index_googleBtn__V3otA[data-tm-orb-done="1"]');
        if (orb) { orb.click(); e.preventDefault(); return; }

        // 2. Endtask barcode ending with Enter (scanner in input field)
        if (editable) {
            const el = document.activeElement;
            if (el && 'value' in el && isEndTask(el.value || '')) {
                e.preventDefault(); e.stopImmediatePropagation();
                handleScanInput(el); return;
            }
        }

        // 3. Non-editable scan buffer trigger
        if (!editable) {
            if (inputBuffer) doManualFlow();
            inputBuffer = '';
        }
        return;
    }

    /* ── Build scan buffer (non-editable) ── */
    if (!editable && e.key.length === 1) {
        if (now - lastKeyTime > SCAN_GAP_MS) inputBuffer = ''; // age-out stale chars
        inputBuffer += e.key;
        lastKeyTime = now;
    }

    /* ── Numpad double dot → manual flow ── */
    if (!editable && e.key === '.' && e.location === 3) {
        if (now - lastDot <= DBL_DELAY) { doManualFlow(); inputBuffer = ''; lastDot = 0; }
        else lastDot = now;
        return;
    }

    /* ── Double CTRL (triple when COD outstanding) ── */
    if (e.key === 'Control' && !e.repeat) {
        if (ctrlArmed) {
            ctrlArmed = false;
            const completeBtn = isInbound() && getCompleteBtn();
            if (completeBtn) {
                e.preventDefault(); e.stopImmediatePropagation(); vueClick(completeBtn);
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
                e.preventDefault(); e.stopImmediatePropagation(); vueClick(completeBtn);
            } else if (!editable) {
                doManualFlow(); inputBuffer = '';
            }
        } else {
            lastCtrl = now;
        }
    }

    /* ── Double Shift → Drop-off Receive (non-editable only) ── */
    if (e.key === 'Shift' && !editable) {
        if (now - lastShift < DBL_WINDOW) { e.preventDefault(); shiftAction(); }
        lastShift = now;
        return;
    }

    /* ── Double/hold Backtick → confirm popup / ticket center ── */
    if (e.key === '`' && !editable) {
        if (now - lastBtick < DBL_WINDOW) {
            e.preventDefault(); backtickAction(); lastBtick = 0; return;
        }
        lastBtick = now; holdKey = '`'; holdStart = now;
        setTimeout(checkHold, HOLD_TIME + 10);
        return;
    }

    /* ── Double/hold ESC → DOP Received tab ── */
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
    if (q('section.order-input .ssc-input')) return; // already in input field

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
    const menu = q('section.menu.expand-menu');
    if (!menu || document.getElementById('spx-spacer')) return;
    const spacer = document.createElement('div');
    spacer.id = 'spx-spacer';
    for (let i = 0; i < 10; i++) spacer.appendChild(document.createElement('br'));
    menu.parentNode.insertBefore(spacer, menu);
}

function getCompleteBtn() {
    for (const b of qa('button.ssc-button.task-info-task-action.ssc-btn-type-primary:not(.ssc-btn-disabled)')) {
        const t = b.textContent.trim();
        if (t === 'Complete' || t === 'Collect Payment') return b;
    }
}

function handleLastBox() {
    const box = q('.ssc-message-box');
    if (!box || !isVisible(box)) return;
    const btn = q('.ssc-btn-type-primary', box);
    if (btn) setTimeout(() => vueClick(btn), 300);
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
    } catch { return false; }
}

/* ═══════════════════════════════════════════════
   INBOUND: QR + TOAST
═══════════════════════════════════════════════ */
function ensureQR() {
    if (document.getElementById('spx-qr')) return;
    const img = Object.assign(document.createElement('img'), { id: 'spx-qr' });
    img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJYAAACWAQAAAAAUekxPAAAA9UlEQVR4nOWWO27EMBBDn3YEbCnfIEeRbparyUfZG4zKAGMwxdpNPuVOkUxlsKEJkqCK+HrH7RsEfwVDDmCa5h2AHkm8XZI5Jpkkz+G9AaUMmmINVqkv4vgV2+vrOX7A1vuxZfJe/mrSMv298uw9O8/nTbu+kvK8Rl2jQqzBGseW5a8UbUZTtBlgaXqhwv1RKt2cjzKy9M5okk6xtBy9yDEJeLJbWo+e552m5z+k9vechpnV3xt0SbAfbzo2os2UXFWg0FlDa5hTI6e/1wo1leZHITbP3aNhTm3THln9PfdIAQGRl6u9lMIawN373XP8Lf/sHfsJB1+v8liflXwAAAAASUVORK5CYII=';
    Object.assign(img.style, {
        position: 'fixed', top: '25px', left: '7%',
        transform: 'translateX(-50%)', width: '185px',
        opacity: '0.95', zIndex: '2147483647', pointerEvents: 'none'
    });
    document.body.appendChild(img);
}

function showToast(msg, timeout = 1200) {
    let el = document.getElementById('spx-toast');
    if (!el) {
        el = Object.assign(document.createElement('div'), { id: 'spx-toast' });
        Object.assign(el.style, {
            position: 'fixed', right: '18px', bottom: '38px', zIndex: '999999',
            padding: '8px 12px', background: 'rgba(0,0,0,0.72)', color: 'white',
            borderRadius: '6px', fontSize: '13px', fontFamily: 'system-ui, sans-serif',
            boxShadow: '0 6px 18px rgba(0,0,0,0.3)', opacity: '0', transition: 'opacity 0.25s'
        });
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => el.style.opacity = '0', timeout);
}

/* ═══════════════════════════════════════════════
   INBOUND: COD SOUND
═══════════════════════════════════════════════ */
const codSound = new Audio('https://github.com/tasuaongvang/spx/raw/refs/heads/main/COD.mp3');
let codAudioReady = false, codLastValue = null;

function unlockAudio() {
    if (codAudioReady) return;
    const origVol = codSound.volume;
    codSound.volume = 0;
    codSound.play().then(() => {
        codSound.pause();
        codSound.currentTime = 0;
        codSound.volume = origVol;
        codAudioReady = true;
        window.removeEventListener('click',   unlockAudio);
        window.removeEventListener('keydown', unlockAudio);
    }).catch(() => { codSound.volume = origVol; });
}
window.addEventListener('click',   unlockAudio);
window.addEventListener('keydown', unlockAudio);

function checkTotalCollection() {
    const sec = qa('section.task-info-amount-item')
        .find(s => s.textContent.includes('Total Collection'));
    if (!sec) return;
    const raw = sec.querySelector('p')?.textContent.trim();
    if (!raw || raw === '–' || raw === '') { codLastValue = null; return; }
    const val = parseFloat(raw.replace(/,/g, ''));
    if (isNaN(val)) return;
    const hasScanField = !!q('section.order-input');
    if (codLastValue !== null && val > codLastValue && hasScanField && codAudioReady) {
        codSound.currentTime = 0;
        codSound.play().catch(() => {});
    }
    codLastValue = val;
}

/* ═══════════════════════════════════════════════
   INBOUND: MEASUREMENT + COLLECT PAYMENT (NSS)
═══════════════════════════════════════════════ */
function autoConfirmMeasurement() {
    qa('.ssc-dialog-content.large').forEach(popup => {
        const title = popup.querySelector('.ssc-dialog-title span');
        if (title?.textContent.trim() !== 'Measurement') return;
        const btn = popup.querySelector('.ssc-dialog-footer .ssc-btn-type-primary');
        if (btn) btn.click();
    });
}

function autoFillCollectPayment(node) {
    const title = node.querySelector?.('.ssc-dialog-title span');
    if (title?.textContent.trim() !== 'Collect Payment') return;
    const input = node.querySelector('input[placeholder="Please Input"]');
    if (input) {
        input.value = '1000000';
        ['input', 'change'].forEach(t => input.dispatchEvent(new Event(t, { bubbles: true })));
    }
    const cancelBtn  = node.querySelector('.ssc-dialog-footer .ssc-button:not(.ssc-btn-type-primary)');
    const confirmBtn = node.querySelector('.ssc-dialog-footer .ssc-btn-type-primary');
    if (cancelBtn) { cancelBtn.style.opacity = '0.35'; cancelBtn.style.pointerEvents = 'none'; }
    if (confirmBtn) {
        Object.assign(confirmBtn.style, {
            opacity: '1', transform: 'scale(1.03)', transition: '0.18s ease',
            boxShadow: '0 0 0 2px rgba(255,111,0,0.25),0 2px 6px rgba(0,0,0,0.18)',
            borderRadius: '8px', fontWeight: '600'
        });
        setTimeout(() => confirmBtn.focus(), 80);
        setTimeout(() => confirmBtn.click(), 400);
    }
}

setInterval(checkTotalCollection, 500);

/* ═══════════════════════════════════════════════
   INBOUND: ENDTASK SCANNER
═══════════════════════════════════════════════ */
const ENDTASK_CODES = ['TDONEZ', 'endtask', '4710200746078', 'SPXVN12345678910'];
const isEndTask = v => ENDTASK_CODES.some(c => v.includes(c));
const _origValueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

function clearInput(el) {
    try {
        _origValueDesc.set.call(el, '');
        ['input', 'change'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
    } catch {}
}

function handleScanInput(el) {
    if (!el || !('value' in el)) return;
    const v = (el.value || '').replace(/[\r\n]+/g, '');
    if (!isEndTask(v)) return;
    clearInput(el);
    showToast('endtask detected → auto complete');
    vueClick(getCompleteBtn());
}

// Live typing / paste in editable
document.addEventListener('input', e => handleScanInput(e.target), true);

// Catch scanners that write value programmatically (bypassing events).
// Instead of patching the GLOBAL HTMLInputElement.prototype.value (which fires
// on every Vue render, every input across all scripts), patch only the specific
// scan input element on inbound pages.
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

// Find and patch scan inputs on inbound pages
function patchInboundScanInputs() {
    if (!isInbound()) return;
    const input = q('section.order-input .ssc-input input');
    if (input) patchInputForEndtask(input);
}

/* ═══════════════════════════════════════════════
   UNIFIED OBSERVER
═══════════════════════════════════════════════ */

// "Entered a previous inbound task" modal auto-confirm
function handlePreviousTaskModal() {
    const modal = qa('.ssc-message-box-wrapper').find(
        m => m.querySelector('.ssc-message-box-title span')?.textContent.includes('Entered a previous inbound task')
    );
    if (modal) {
        const btn = qa('button', modal).find(b => b.textContent.includes('Enter previous task'));
        if (btn) btn.click();
    }
}

let uiScheduled = false;
function smartUpdate() {
    uiScheduled = false;
    autoClickOK();
    enhanceLogin();
    scanForSuspiciousDialog();
    patchInboundScanInputs();
    if (isInbound()) {
        removeHeader(); ensureQR(); handleLastBox();
        autoConfirmMeasurement();
    }
    handlePreviousTaskModal();
}

// Single observer handles everything:
// - addedNodes → autoFillCollectPayment (needs the node itself)
// - rAF-debounced → smartUpdate (login, inbound UI, suspicious dialog, etc.)
new MutationObserver(mutations => {
    for (const m of mutations)
        for (const node of m.addedNodes)
            if (node instanceof HTMLElement) autoFillCollectPayment(node);
    if (!uiScheduled) {
        uiScheduled = true;
        requestAnimationFrame(smartUpdate);
    }
}).observe(document.body, { childList: true, subtree: true });

setTimeout(smartUpdate, 400);
console.log('[SPX] open-end flow v3.4 loaded');
})();