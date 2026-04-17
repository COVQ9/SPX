// ==UserScript==
// @name         Refund NSS
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/Refund%20NSS.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/Refund%20NSS.user.js
// @version      1.9
// @description  QR thanh toán ngân hàng theo từng dòng tiền trên trang cash-collection
// @match        https://sp.spx.shopee.vn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      cdnjs.cloudflare.com
// @connect      api.vietqr.io
// @run-at       document-idle
// ==/UserScript==

(function () {
'use strict';

const TARGET_PATH = '/finance-management/cash-collection';
const onTarget    = () => location.pathname.startsWith(TARGET_PATH);

// ─── BANK CONFIG ─────────────────────────────────────────────
const BANK_BIN   = '970436';          // VCB
const ACCOUNT_NO = 'P68002SPCSPF1';
const ACCT_NAME  = 'CONG TY SPX EXPRESS';
const NOTE_PFX   = 'COD 224';

// ─── GM KEYS ─────────────────────────────────────────────────
const QRJS_KEY = 'qrjs_lib_v1';
const QRJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';

// ─── STATE ───────────────────────────────────────────────────
let useVietQR      = false;
let currentOverlay = null;
let currentRowData = null;

// ─── EMVCo VietQR STRING BUILDER (format từ Debt Book) ───────
// Cấu trúc: tag38 nested, GUID=A000000727, QRIBFTTA, PFI=00
function tlv(tag, value) {
    const v = String(value);
    return String(tag).padStart(2, '0') + String(v.length).padStart(2, '0') + v;
}

function crc16(str) {
    let c = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        c ^= str.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++)
            c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    }
    return c.toString(16).toUpperCase().padStart(4, '0');
}

function buildEMVQR(amount, note) {
    const acctInner = tlv('00', BANK_BIN) + tlv('01', ACCOUNT_NO);
    const tag38     = tlv('00', 'A000000727') + tlv('01', acctInner) + tlv('02', 'QRIBFTTA');
    let s = '';
    s += tlv('00', '00');          // Payload Format Indicator
    s += tlv('01', '12');          // Point of Initiation = dynamic
    s += tlv('38', tag38);         // Merchant Account Info (NAPAS)
    s += tlv('53', '704');         // Currency VND
    if (amount > 0) s += tlv('54', String(Math.round(amount)));
    s += tlv('58', 'VN');          // Country
    if (note)   s += tlv('62', tlv('08', note));  // Additional data
    s += '6304';                   // CRC tag placeholder
    return s + crc16(s);
}

// ─── DATE / AMOUNT UTILS ─────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
function fmtDate(s) {
    const [y, m, d] = s.trim().split('-');
    return `${d}${MONTHS[parseInt(m, 10) - 1]}${y}`;
}

function parseAmount(s) {
    return Math.round(parseFloat((s || '').replace(/,/g, '')) || 0);
}

// ─── QR.JS — GM-CACHED, eval vào sandbox scope ───────────────
function ensureQRLib() {
    if (typeof QRCode !== 'undefined') return Promise.resolve();
    const cached = GM_getValue(QRJS_KEY, null);
    if (cached) {
        try { (0, eval)(cached); } catch {}
        if (typeof QRCode !== 'undefined') return Promise.resolve();
    }
    return new Promise((res, rej) => {
        GM_xmlhttpRequest({
            method: 'GET', url: QRJS_CDN,
            onload: r => {
                if (r.status !== 200) { rej(new Error(r.status)); return; }
                try { (0, eval)(r.responseText); } catch {}
                if (typeof QRCode !== 'undefined') GM_setValue(QRJS_KEY, r.responseText);
                res();
            },
            onerror: () => rej(new Error('network'))
        });
    });
}

async function genOfflineQR(text) {
    await ensureQRLib();
    if (typeof QRCode === 'undefined') throw new Error('QRCode unavailable');

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:300px;height:300px;';
    document.body.appendChild(wrap);

    return new Promise((resolve, reject) => {
        try {
            new QRCode(wrap, {
                text, width: 300, height: 300,
                correctLevel: QRCode.CorrectLevel.L
            });
            setTimeout(() => {
                const canvas = wrap.querySelector('canvas');
                const dataUrl = canvas ? canvas.toDataURL('image/png') : null;
                wrap.remove();
                dataUrl ? resolve(dataUrl) : reject(new Error('no canvas'));
            }, 150);
        } catch (e) { wrap.remove(); reject(e); }
    });
}

// ─── CLIPBOARD ───────────────────────────────────────────────
async function copyDataUrl(dataUrl) {
    try {
        const res  = await fetch(dataUrl);
        const blob = await res.blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch {}
}

// Render card (QR + info + badge, không có nút) lên canvas → dataUrl
async function captureCard() {
    const imgEl = document.querySelector('#spxqr-area img');
    if (!imgEl || !currentRowData) return null;

    const QR   = 280, PAD = 24, TOP = 16, GAP = 12;
    const W    = QR + PAD * 2;
    const infoText  = `${currentRowData.note}  ·  ${currentRowData.amount.toLocaleString('vi-VN')}đ`;
    const badgeText = (useVietQR ? 'generated by VietQR API' : 'QR generated locally').toUpperCase();
    const H = TOP + QR + GAP + 18 + 6 + 14 + 16; // top+qr+gap+info+gap+badge+bottom

    const sc = 2; // retina
    const cv = document.createElement('canvas');
    cv.width  = W * sc;
    cv.height = H * sc;
    const ctx = cv.getContext('2d');
    ctx.scale(sc, sc);

    // White rounded background
    const R = 16;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(R, 0); ctx.lineTo(W - R, 0);
    ctx.quadraticCurveTo(W, 0, W, R);
    ctx.lineTo(W, H - R);
    ctx.quadraticCurveTo(W, H, W - R, H);
    ctx.lineTo(R, H);
    ctx.quadraticCurveTo(0, H, 0, H - R);
    ctx.lineTo(0, R);
    ctx.quadraticCurveTo(0, 0, R, 0);
    ctx.closePath();
    ctx.fill();

    // QR image
    const qrImg = new Image();
    qrImg.src = imgEl.src;
    await new Promise(r => { qrImg.onload = r; qrImg.onerror = r; });
    ctx.drawImage(qrImg, PAD, TOP, QR, QR);

    // Info text
    let y = TOP + QR + GAP + 14;
    ctx.fillStyle = '#555555';
    ctx.font = '13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(infoText, W / 2, y);

    // Badge text
    y += 6 + 12;
    ctx.fillStyle = '#aaaaaa';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(badgeText, W / 2, y);

    return cv.toDataURL('image/png');
}

// ─── VIETQR API v2 — lấy QR string (POST JSON, ko cần frame) ─
const VIETQR_API = 'https://api.vietqr.io/v2/generate';

function fetchQRStringFromAPI(amount, note) {
    return new Promise((res, rej) => {
        GM_xmlhttpRequest({
            method: 'POST',
            url: VIETQR_API,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                accountNo:   ACCOUNT_NO,
                accountName: ACCT_NAME,
                acqId:       BANK_BIN,
                amount,
                addInfo:     note,
                format:      'text',
                template:    'compact'
            }),
            onload: r => {
                try {
                    const json = JSON.parse(r.responseText);
                    const qrCode = json?.data?.qrCode;
                    qrCode ? res(qrCode) : rej(new Error('no qrCode: ' + r.status));
                } catch { rej(new Error('parse error')); }
            },
            onerror: () => rej(new Error('network'))
        });
    });
}

// ─── CAPSLOCK → TOGGLE SOURCE ────────────────────────────────
document.addEventListener('keyup', e => {
    if (e.key !== 'CapsLock') return;
    useVietQR = e.getModifierState('CapsLock');
    if (currentOverlay && currentRowData) renderQR();
});

// ─── OVERLAY ─────────────────────────────────────────────────
function closeOverlay() {
    currentOverlay?.remove();
    currentOverlay = null;
    currentRowData = null;
    const spxQR = document.getElementById('spx-qr');
    if (spxQR) spxQR.style.display = '';
}

async function showOverlay(rowData) {
    closeOverlay();
    const spxQR = document.getElementById('spx-qr');
    if (spxQR) spxQR.style.display = 'none';

    const overlay = document.createElement('div');
    overlay.id = 'spxqr-overlay';
    Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '999999',
        background: 'rgba(0,0,0,0.68)',
        display: 'flex', justifyContent: 'center', alignItems: 'center'
    });

    const escHandler = e => { if (e.key === 'Escape') closeOverlay(); };
    document.addEventListener('keydown', escHandler);

    // Patch remove to clean up the keydown listener
    const _origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => {
        document.removeEventListener('keydown', escHandler);
        _origRemove();
    };
    overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });

    // Card
    const card = document.createElement('div');
    Object.assign(card.style, {
        position: 'relative', background: '#fff', borderRadius: '16px',
        padding: '48px 24px 18px', textAlign: 'center',
        boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
        fontFamily: 'system-ui,sans-serif'
    });

    // Close button — top-left, red X
    const xBtn = document.createElement('div');
    xBtn.innerHTML = '✖';
    Object.assign(xBtn.style, {
        position: 'absolute', top: 0, left: 0,
        width: '38px', height: '38px',
        borderTopLeftRadius: '16px', borderBottomRightRadius: '10px',
        background: '#ff3b30', color: '#fff', fontSize: '16px',
        lineHeight: '38px', textAlign: 'center', cursor: 'pointer'
    });
    xBtn.onclick = closeOverlay;

    // Copy+close button — top-right, blue ✓
    const copyBtn = document.createElement('div');
    copyBtn.innerHTML = '✔';
    copyBtn.title = 'Copy QR & đóng';
    Object.assign(copyBtn.style, {
        position: 'absolute', top: 0, right: 0,
        width: '38px', height: '38px',
        borderTopRightRadius: '16px', borderBottomLeftRadius: '10px',
        background: '#1677ff', color: '#fff', fontSize: '16px',
        lineHeight: '38px', textAlign: 'center', cursor: 'pointer'
    });
    copyBtn.onclick = async () => {
        const dataUrl = await captureCard();
        if (dataUrl) await copyDataUrl(dataUrl);
        closeOverlay();
    };

    // QR display area
    const qrArea = document.createElement('div');
    qrArea.id = 'spxqr-area';
    Object.assign(qrArea.style, {
        width: '280px', height: '280px', margin: '0 auto 14px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '14px', color: '#999'
    });
    qrArea.textContent = 'Đang tạo QR...';

    // Info line
    const infoLine = document.createElement('div');
    Object.assign(infoLine.style, {
        fontSize: '12px', color: '#666', marginBottom: '6px',
        fontFamily: 'monospace', letterSpacing: '.03em'
    });
    infoLine.textContent = `${rowData.note}  ·  ${rowData.amount.toLocaleString('vi-VN')}đ`;

    // Source badge
    const badge = document.createElement('div');
    badge.id = 'spxqr-badge';
    Object.assign(badge.style, {
        fontSize: '11px', color: '#bbb',
        letterSpacing: '.07em', textTransform: 'uppercase'
    });

    card.append(xBtn, copyBtn, qrArea, infoLine, badge);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    currentOverlay  = overlay;
    currentRowData  = rowData;

    await renderQR();
}

async function renderQR() {
    const area  = document.getElementById('spxqr-area');
    const badge = document.getElementById('spxqr-badge');
    if (!area || !currentRowData) return;

    area.innerHTML = '';
    area.textContent = 'Đang tạo QR...';
    if (badge) badge.textContent = useVietQR
        ? '🌐 generated by VietQR API'
        : '📶 QR generated locally';

    try {
        let qrStr;
        if (useVietQR) {
            qrStr = await fetchQRStringFromAPI(currentRowData.amount, currentRowData.note);
        } else {
            qrStr = buildEMVQR(currentRowData.amount, currentRowData.note);
        }
        const dataUrl = await genOfflineQR(qrStr);
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'width:280px;height:280px;';
        area.textContent = '';
        area.appendChild(img);
    } catch (e) {
        area.textContent = 'Lỗi: ' + (e?.message || 'không tạo được QR');
    }
}

// ─── ROW INJECTION ───────────────────────────────────────────
function getRowData(tr) {
    const tds      = tr.querySelectorAll('td');
    const dateEl   = tds[1]?.querySelector('.td-content');
    const statusEl = tds[2]?.querySelector('.td-content');
    const amtEl    = tds[4]?.querySelector('.td-content');
    if (!dateEl || !statusEl || !amtEl) return null;
    if (!statusEl.textContent.includes('Pending Proof Submission')) return null;
    const dateStr = dateEl.textContent.trim();
    const amtStr  = amtEl.textContent.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const amount = parseAmount(amtStr);
    if (!amount) return null;
    return { date: fmtDate(dateStr), amount, note: `${NOTE_PFX} ${fmtDate(dateStr)}` };
}

function injectQRBtn(tr) {
    if (tr.dataset.qrInjected) return;
    const rowData = getRowData(tr);
    if (!rowData) return;
    tr.dataset.qrInjected = 'true';

    const tds      = tr.querySelectorAll('td');
    const amtTd    = tds[4];
    const innerDiv = amtTd?.querySelector('div');
    if (!innerDiv) return;

    // Make amount cell flex so QR button sits nicely next to the number
    Object.assign(innerDiv.style, {
        display: 'flex', alignItems: 'center', gap: '8px'
    });
    const amtSpan = innerDiv.querySelector('.td-content');
    if (amtSpan) amtSpan.style.flexShrink = '0';

    const btn = document.createElement('button');
    btn.type  = 'button';
    btn.title = `${rowData.note} · ${rowData.amount.toLocaleString('vi-VN')}đ`;
    btn.innerHTML = `<svg viewBox="0 0 12 12" width="13" height="13" fill="currentColor" style="display:block">
        <rect x="1" y="1" width="4" height="4"/><rect x="7" y="1" width="4" height="4"/>
        <rect x="1" y="7" width="4" height="4"/><rect x="7" y="7" width="1" height="1"/>
        <rect x="9" y="7" width="2" height="1"/><rect x="7" y="9" width="2" height="1"/>
        <rect x="10" y="10" width="1" height="1"/>
    </svg>`;
    Object.assign(btn.style, {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '22px', height: '22px', padding: '0', flexShrink: '0',
        background: '#1677ff', color: '#fff',
        border: 'none', borderRadius: '4px', cursor: 'pointer'
    });
    btn.onclick = e => { e.stopPropagation(); showOverlay(rowData); };
    innerDiv.appendChild(btn);
}

function scanRows() {
    if (!onTarget()) return;
    document.querySelectorAll('tr.ssc-table-row').forEach(injectQRBtn);
}

// ─── SPA NAVIGATION ──────────────────────────────────────────
function onNav() {
    if (!onTarget()) { closeOverlay(); return; }
    setTimeout(scanRows, 600);
}
window.addEventListener('spx-nav', onNav);
window.addEventListener('popstate', onNav);

new MutationObserver(() => {
    if (onTarget()) scanRows();
}).observe(document.body, { childList: true, subtree: true });

// ─── INIT ────────────────────────────────────────────────────
if (onTarget()) {
    scanRows();
    ensureQRLib().catch(() => {}); // pre-load in background
}

console.log('[SPX] Cash QR v1.9 loaded');
})();