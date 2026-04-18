// ==UserScript==
// @name         Refund NSS
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/Refund%20NSS.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/Refund%20NSS.user.js
// @version      2.1
// @description  QR thanh toán + auto upload proof từ Telegram bot qua Gemini OCR
// @match        https://sp.spx.shopee.vn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      cdnjs.cloudflare.com
// @connect      api.vietqr.io
// @connect      api.telegram.org
// @connect      generativelanguage.googleapis.com
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

// ═══════════════════════════════════════════════════════════
// AUTO UPLOAD PROOF (v2.1)
// ═══════════════════════════════════════════════════════════

const SK = {
    tgToken: 'tg_bot_token',
    tgChat:  'tg_chat_id',
    tgOff:   'tg_offset',
    gem:     'gemini_api_key'
};

// ─── TOAST ───────────────────────────────────────────────────
function toast(msg, color = '#16a34a', ms = 3500) {
    const t = document.createElement('div');
    Object.assign(t.style, {
        position: 'fixed', top: '20px', right: '20px', zIndex: '9999999',
        background: color, color: '#fff', padding: '10px 16px',
        borderRadius: '8px', fontSize: '13px', fontFamily: 'system-ui,sans-serif',
        boxShadow: '0 6px 20px rgba(0,0,0,0.25)', maxWidth: '360px'
    });
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
}

// ─── GM HTTP ─────────────────────────────────────────────────
function gmReq(opts) {
    return new Promise((res, rej) => {
        GM_xmlhttpRequest({ ...opts,
            onload: r => (r.status >= 200 && r.status < 300
                ? res(r)
                : rej(new Error(`HTTP ${r.status}: ${(r.responseText || '').slice(0, 200)}`))),
            onerror: () => rej(new Error('network')),
            ontimeout: () => rej(new Error('timeout'))
        });
    });
}

// ─── TELEGRAM ────────────────────────────────────────────────
async function tgGetUpdates() {
    const token = GM_getValue(SK.tgToken, '');
    if (!token) throw new Error('missing bot token');
    const offset = GM_getValue(SK.tgOff, 0);
    const url = `https://api.telegram.org/bot${token}/getUpdates`
        + `?offset=${offset}&timeout=0&allowed_updates=${encodeURIComponent('["message"]')}`;
    const r = await gmReq({ method: 'GET', url });
    const j = JSON.parse(r.responseText);
    if (!j.ok) throw new Error(j.description || 'telegram error');
    return j.result;
}

async function tgGetFilePath(fileId) {
    const token = GM_getValue(SK.tgToken, '');
    const r = await gmReq({
        method: 'GET',
        url: `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
    });
    const j = JSON.parse(r.responseText);
    if (!j.ok) throw new Error(j.description);
    return j.result.file_path;
}

async function tgDownload(filePath) {
    const token = GM_getValue(SK.tgToken, '');
    const r = await gmReq({
        method: 'GET',
        url: `https://api.telegram.org/file/bot${token}/${filePath}`,
        responseType: 'arraybuffer'
    });
    return r.response;
}

function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

// ─── GEMINI ──────────────────────────────────────────────────
async function geminiExtract(imageB64, mimeType = 'image/jpeg') {
    const key = GM_getValue(SK.gem, '');
    if (!key) throw new Error('missing gemini key');
    const body = {
        contents: [{
            parts: [
                { text: 'Extract fields from this Vietnamese bank transfer confirmation screenshot. Return JSON only.' },
                { inline_data: { mime_type: mimeType, data: imageB64 } }
            ]
        }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'object',
                required: ['amount', 'note', 'note_date_iso'],
                properties: {
                    amount:        { type: 'integer' },
                    note:          { type: 'string' },
                    txn_id:        { type: 'string' },
                    note_date_iso: { type: 'string' }
                }
            }
        }
    };
    const r = await gmReq({
        method: 'POST',
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(key)}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body)
    });
    const j = JSON.parse(r.responseText);
    const txt = j.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) throw new Error('gemini empty response');
    return JSON.parse(txt);
}

// ─── SPX API (same-origin) ───────────────────────────────────
async function spxList() {
    const r = await fetch('/sp-api/point/dropoff/fee/shipping_fee/drop_off/cash/list?station_type=9&pageno=1&count=24',
        { credentials: 'include' });
    const j = await r.json();
    if (j.retcode !== 0) throw new Error('list: ' + j.message);
    return j.data.list || [];
}

async function spxUploadImage(blob, filename = 'proof.jpg') {
    const fd = new FormData();
    fd.append('file', blob, filename);
    const r = await fetch('/sp-api/point/fee/shipping_fee/drop_off/image/multiple/upload',
        { method: 'POST', credentials: 'include', body: fd });
    const j = await r.json();
    if (j.retcode !== 0) throw new Error('upload: ' + j.message);
    return { url: j.data.url_list[0], time: j.data.upload_time };
}

async function spxAttachProof(row, added) {
    const proof_list = [
        ...(row.proof_list || []),
        { proof_url: added.url, proof_upload_time: added.time }
    ];
    const r = await fetch('/sp-api/point/dropoff/fee/shipping_fee/drop_off/cash/proof/update',
        { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: row.id, account_date: row.account_date, proof_list }) });
    const j = await r.json();
    if (j.retcode !== 0) throw new Error('attach: ' + j.message);
}

// ─── MATCH ───────────────────────────────────────────────────
function vnMidnightUnix(iso) {
    // "2026-04-17" → Vietnam local midnight unix seconds
    return Math.floor(Date.parse(iso + 'T00:00:00+07:00') / 1000);
}

async function processPoll() {
    const updates = await tgGetUpdates();
    const chatFilter = GM_getValue(SK.tgChat, '');
    const items = [];
    for (const u of updates) {
        // Auto-capture chat_id on first message
        if (!GM_getValue(SK.tgChat, '') && u.message?.chat?.id) {
            GM_setValue(SK.tgChat, String(u.message.chat.id));
        }
        if (chatFilter && String(u.message?.chat?.id) !== String(chatFilter)) continue;
        if (!u.message?.photo) continue;
        const largest = u.message.photo.reduce((a, b) => (a.file_size || 0) > (b.file_size || 0) ? a : b);
        try {
            const fp = await tgGetFilePath(largest.file_id);
            const buf = await tgDownload(fp);
            const blob = new Blob([buf], { type: 'image/jpeg' });
            const b64 = bufToBase64(buf);
            let gemini = null, error = null;
            try { gemini = await geminiExtract(b64, 'image/jpeg'); }
            catch (e) { error = e.message; }
            items.push({
                updateId: u.update_id,
                blob, filename: fp.split('/').pop() || 'proof.jpg',
                gemini, error,
                previewUrl: URL.createObjectURL(blob)
            });
        } catch (e) {
            items.push({ updateId: u.update_id, error: 'telegram: ' + e.message });
        }
    }
    // Match
    let rows = [];
    try { rows = await spxList(); } catch (e) { toast('List API failed: ' + e.message, '#dc2626'); }
    const byDate = new Map();
    for (const row of rows) byDate.set(row.account_date, row);
    for (const it of items) {
        if (it.error) { it.match = { status: 'error', reason: it.error }; continue; }
        if (!it.gemini) { it.match = { status: 'error', reason: 'no OCR data' }; continue; }
        const unix = vnMidnightUnix(it.gemini.note_date_iso);
        const row = byDate.get(unix);
        if (!row) {
            it.match = { status: 'no_match', reason: `no row for ${it.gemini.note_date_iso}` };
            continue;
        }
        if (row.pending_amount !== it.gemini.amount) {
            it.match = { status: 'warn', row,
                reason: `amount ${it.gemini.amount.toLocaleString('vi-VN')}đ vs row ${row.pending_amount.toLocaleString('vi-VN')}đ` };
        } else {
            it.match = { status: 'ok', row };
        }
    }
    return items;
}

// ─── CONFIRM OVERLAY ─────────────────────────────────────────
function showProofConfirm(items) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: '999998',
            background: 'rgba(0,0,0,0.68)',
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            fontFamily: 'system-ui,sans-serif'
        });
        const card = document.createElement('div');
        Object.assign(card.style, {
            background: '#fff', borderRadius: '12px', padding: '20px 24px',
            minWidth: '560px', maxWidth: '780px', maxHeight: '80vh', overflow: 'auto'
        });
        const title = document.createElement('h3');
        title.style.cssText = 'margin:0 0 12px;font-size:16px';
        title.textContent = `Process Proofs (${items.length} new)`;
        card.appendChild(title);

        const list = document.createElement('div');
        const COLORS = { ok: '#16a34a', warn: '#d97706', no_match: '#dc2626', error: '#dc2626' };
        items.forEach(it => {
            const row = document.createElement('label');
            Object.assign(row.style, {
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '8px', borderRadius: '8px', cursor: 'pointer',
                background: '#f8f9fa', marginBottom: '6px'
            });
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = it.match.status === 'ok';
            cb.disabled = it.match.status === 'no_match' || it.match.status === 'error';
            const img = document.createElement('img');
            img.src = it.previewUrl || '';
            img.style.cssText = 'width:48px;height:48px;object-fit:cover;border-radius:4px;background:#e5e7eb';
            const info = document.createElement('div');
            info.style.cssText = 'flex:1;font-size:13px';
            const color = COLORS[it.match.status];
            if (it.match.status === 'ok' || it.match.status === 'warn') {
                const dateIso = new Date(it.match.row.account_date * 1000).toISOString().slice(0, 10);
                info.innerHTML = `<div>→ ${dateIso} · ${it.match.row.pending_amount.toLocaleString('vi-VN')}đ</div>`
                    + `<div style="color:${color};font-size:11px;margin-top:2px">`
                    + (it.match.status === 'ok' ? '✓ OK' : '⚠ ' + it.match.reason) + '</div>';
            } else {
                info.innerHTML = `<div style="color:${color}">${it.match.status === 'no_match' ? '✖ ' : '⚠ '}${it.match.reason || 'error'}</div>`;
            }
            row.append(cb, img, info);
            it.__cb = cb;
            list.appendChild(row);
        });
        card.appendChild(list);

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        cancel.style.cssText = 'padding:8px 16px;border:1px solid #d1d5db;background:#fff;border-radius:6px;cursor:pointer';
        const ok = document.createElement('button');
        ok.textContent = 'Upload';
        ok.style.cssText = 'padding:8px 16px;border:none;background:#1677ff;color:#fff;border-radius:6px;cursor:pointer';
        cancel.onclick = () => { overlay.remove(); resolve(null); };
        ok.onclick = () => {
            const selected = items.filter(it => it.__cb?.checked);
            overlay.remove();
            resolve(selected);
        };
        footer.append(cancel, ok);
        card.appendChild(footer);
        overlay.appendChild(card);
        overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
        document.body.appendChild(overlay);
    });
}

async function doUpload(selected) {
    let ok = 0, fail = 0;
    for (const it of selected) {
        try {
            const up = await spxUploadImage(it.blob, it.filename);
            await spxAttachProof(it.match.row, up);
            // Reflect in local cached row so subsequent items on the same row append correctly
            it.match.row.proof_list = [...(it.match.row.proof_list || []),
                { proof_url: up.url, proof_upload_time: up.time }];
            ok++;
        } catch (e) {
            fail++;
            toast(`Fail: ${e.message}`, '#dc2626', 6000);
        }
    }
    return { ok, fail };
}

// ─── SETTINGS MODAL ──────────────────────────────────────────
function showSettingsModal() {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '999998',
        background: 'rgba(0,0,0,0.68)',
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        fontFamily: 'system-ui,sans-serif'
    });
    const card = document.createElement('div');
    Object.assign(card.style, {
        background: '#fff', borderRadius: '12px', padding: '24px',
        minWidth: '460px', maxWidth: '560px'
    });
    card.innerHTML = `
        <h3 style="margin:0 0 16px;font-size:16px">Auto-Upload Proof Settings</h3>
        <label style="display:block;font-size:12px;color:#555;margin-bottom:4px">Telegram bot token</label>
        <input id="s-tg" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-bottom:12px;font-family:monospace;font-size:12px" placeholder="123456:ABC..." />
        <label style="display:block;font-size:12px;color:#555;margin-bottom:4px">Telegram chat id (auto-detected on first message)</label>
        <input id="s-chat" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-bottom:12px;font-family:monospace;font-size:12px" placeholder="(auto)" />
        <label style="display:block;font-size:12px;color:#555;margin-bottom:4px">Gemini API key</label>
        <input id="s-gem" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-bottom:16px;font-family:monospace;font-size:12px" placeholder="AIza..." />
        <div id="s-status" style="font-size:12px;color:#666;margin-bottom:12px;min-height:18px"></div>
        <div style="display:flex;justify-content:space-between;gap:8px">
            <button id="s-reset" style="padding:8px 16px;border:1px solid #d1d5db;background:#fff;border-radius:6px;cursor:pointer">Reset offset</button>
            <div style="display:flex;gap:8px">
                <button id="s-test" style="padding:8px 16px;border:1px solid #1677ff;color:#1677ff;background:#fff;border-radius:6px;cursor:pointer">Test</button>
                <button id="s-cancel" style="padding:8px 16px;border:1px solid #d1d5db;background:#fff;border-radius:6px;cursor:pointer">Cancel</button>
                <button id="s-save" style="padding:8px 16px;border:none;background:#1677ff;color:#fff;border-radius:6px;cursor:pointer">Save</button>
            </div>
        </div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    card.querySelector('#s-tg').value   = GM_getValue(SK.tgToken, '');
    card.querySelector('#s-chat').value = GM_getValue(SK.tgChat, '');
    card.querySelector('#s-gem').value  = GM_getValue(SK.gem, '');
    const status = card.querySelector('#s-status');
    card.querySelector('#s-cancel').onclick = () => overlay.remove();
    card.querySelector('#s-save').onclick = () => {
        GM_setValue(SK.tgToken, card.querySelector('#s-tg').value.trim());
        GM_setValue(SK.tgChat,  card.querySelector('#s-chat').value.trim());
        GM_setValue(SK.gem,     card.querySelector('#s-gem').value.trim());
        overlay.remove();
        toast('Saved.', '#16a34a');
        refreshPanelBadge();
    };
    card.querySelector('#s-reset').onclick = () => {
        GM_setValue(SK.tgOff, 0);
        status.textContent = 'Offset reset → next poll re-fetches everything.';
    };
    card.querySelector('#s-test').onclick = async () => {
        status.textContent = 'Testing...';
        const tgTok = card.querySelector('#s-tg').value.trim();
        const gemKey = card.querySelector('#s-gem').value.trim();
        const results = [];
        try {
            const r = await gmReq({ method: 'GET', url: `https://api.telegram.org/bot${tgTok}/getMe` });
            const j = JSON.parse(r.responseText);
            results.push(j.ok ? `✓ TG: @${j.result.username}` : `✗ TG: ${j.description}`);
        } catch (e) { results.push('✗ TG: ' + e.message); }
        try {
            const r = await gmReq({
                method: 'POST',
                url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(gemKey)}`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] })
            });
            const j = JSON.parse(r.responseText);
            results.push(j.candidates ? '✓ Gemini' : '✗ Gemini: ' + (j.error?.message || 'unknown'));
        } catch (e) { results.push('✗ Gemini: ' + e.message); }
        status.innerHTML = results.join('<br>');
    };
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ─── FLOATING PANEL ──────────────────────────────────────────
let panelEl = null;
let pendingCount = 0;
let pollTimer = null;
let processing = false;

function ensurePanel() {
    if (panelEl && document.body.contains(panelEl)) return;
    panelEl = document.createElement('div');
    panelEl.id = 'spxqr-panel';
    Object.assign(panelEl.style, {
        position: 'fixed', top: '80px', right: '16px', zIndex: '999990',
        display: 'flex', gap: '6px', alignItems: 'center',
        background: '#fff', padding: '6px 8px', borderRadius: '10px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        fontFamily: 'system-ui,sans-serif', fontSize: '13px'
    });
    const gear = document.createElement('button');
    gear.textContent = '⚙';
    gear.title = 'Settings';
    Object.assign(gear.style, btnStyle('#6b7280'));
    gear.onclick = showSettingsModal;

    const checkBtn = document.createElement('button');
    checkBtn.id = 'spxqr-check';
    Object.assign(checkBtn.style, btnStyle('#1677ff'));
    checkBtn.onclick = () => runProcess(false);

    const procBtn = document.createElement('button');
    procBtn.id = 'spxqr-proc';
    procBtn.textContent = '📤 Process';
    Object.assign(procBtn.style, btnStyle('#16a34a'));
    procBtn.onclick = () => runProcess(true);

    panelEl.append(gear, checkBtn, procBtn);
    document.body.appendChild(panelEl);
    refreshPanelBadge();
}

function btnStyle(bg) {
    return {
        padding: '6px 10px', border: 'none', background: bg, color: '#fff',
        borderRadius: '6px', cursor: 'pointer', fontSize: '13px'
    };
}

function removePanel() {
    panelEl?.remove();
    panelEl = null;
}

function refreshPanelBadge() {
    const c = document.getElementById('spxqr-check');
    if (c) c.textContent = `📥 Check${pendingCount ? ` (${pendingCount})` : ''}`;
}

let cachedQueue = [];

async function runProcess(openOverlay) {
    if (processing) return;
    processing = true;
    try {
        const hasToken = GM_getValue(SK.tgToken, '');
        const hasKey = GM_getValue(SK.gem, '');
        if (!hasToken || !hasKey) {
            toast('Set Telegram token + Gemini key first (⚙).', '#d97706', 5000);
            return;
        }
        const items = await processPoll();
        if (items.length === 0) {
            pendingCount = 0;
            if (openOverlay) toast('No new proofs.', '#6b7280');
            return;
        }
        cachedQueue = items;
        pendingCount = items.length;
        if (!openOverlay) { toast(`${items.length} new — click 📤 to review.`, '#1677ff'); return; }
        const selected = await showProofConfirm(items);
        if (!selected) return;
        // Advance offset past all OCR'd updates — failed uploads don't retry automatically.
        const maxId = Math.max(...items.map(it => it.updateId));
        GM_setValue(SK.tgOff, maxId + 1);
        pendingCount = 0;
        cachedQueue = [];
        if (selected.length === 0) { toast('Skipped all.', '#6b7280'); return; }
        const { ok, fail } = await doUpload(selected);
        toast(`Uploaded ${ok}/${selected.length}${fail ? ` · ${fail} failed` : ''}`,
              fail ? '#d97706' : '#16a34a', 5000);
    } catch (e) {
        toast('Error: ' + e.message, '#dc2626', 6000);
    } finally {
        processing = false;
        refreshPanelBadge();
    }
}

async function backgroundPoll() {
    if (!onTarget() || processing) return;
    try {
        const hasToken = GM_getValue(SK.tgToken, '');
        const hasKey = GM_getValue(SK.gem, '');
        if (!hasToken || !hasKey) return;
        // Lightweight: just count unread updates without OCR
        const r = await gmReq({
            method: 'GET',
            url: `https://api.telegram.org/bot${hasToken}/getUpdates`
                + `?offset=${GM_getValue(SK.tgOff, 0)}&timeout=0&allowed_updates=${encodeURIComponent('["message"]')}`
        });
        const j = JSON.parse(r.responseText);
        if (!j.ok) return;
        const chatFilter = GM_getValue(SK.tgChat, '');
        const photos = j.result.filter(u => u.message?.photo
            && (!chatFilter || String(u.message.chat.id) === String(chatFilter)));
        pendingCount = photos.length;
        refreshPanelBadge();
    } catch {}
}

function startPoll() {
    if (pollTimer) return;
    backgroundPoll();
    pollTimer = setInterval(backgroundPoll, 15000);
}

function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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
    const rowData = getRowData(tr);
    const existing = tr.querySelector('.spxqr-btn');

    // Status no longer pending → remove stale button if any.
    if (!rowData) {
        if (existing) existing.remove();
        delete tr.dataset.qrKey;
        return;
    }

    // Re-inject if row data changed (same <tr>, new record).
    const key = `${rowData.date}|${rowData.amount}`;
    if (existing && tr.dataset.qrKey === key) return;
    if (existing) existing.remove();
    tr.dataset.qrKey = key;

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
    btn.className = 'spxqr-btn';
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
    if (!onTarget()) { closeOverlay(); removePanel(); stopPoll(); return; }
    ensurePanel();
    startPoll();
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
    ensurePanel();
    startPoll();
    ensureQRLib().catch(() => {}); // pre-load in background
}

console.log('[SPX] Cash QR v2.1 loaded');
})();