// ==UserScript==
// @name         refund NSS
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/Refund-NSS.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/Refund-NSS.user.js
// @version      7.0
// @description  QR thanh toán + auto upload proof từ Dropbox (OCR.space + semantic rename) + ghi phiếu chi vào sổ quỹ KiotVit qua Tailscale. v6.0: bỏ GAS proxy, chuyển sang Dropbox API trực tiếp (GM_xmlhttpRequest bypass CORS); auto token refresh.
// @match        https://sp.spx.shopee.vn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      cdnjs.cloudflare.com
// @connect      api.vietqr.io
// @connect      api.dropbox.com
// @connect      api.dropboxapi.com
// @connect      content.dropboxapi.com
// @connect      api.ocr.space
// @connect      gofile.io
// @connect      *.gofile.io
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
'use strict';

// Access neon-sync's public API through unsafeWindow (the real page window).
// _NS in sandbox scripts without @grant unsafeWindow is undefined,
// making all push/onPullComplete calls silent no-ops.
const _NS = unsafeWindow.NeonSync;
console.log('[SPX] NeonSync via unsafeWindow:', !!_NS, 'push:', typeof _NS?.push, 'onPullComplete:', typeof _NS?.onPullComplete);

// Skip inside iframes. find-details opens a hidden iframe for eye-preview;
// Refund-NSS in that iframe would spawn a 2nd background poll + observer +
// global listeners, with no UI ever visible. Top-frame only.
if (window.top !== window) return;

const TARGET_PATH = '/finance-management/cash-collection';
const onTarget    = () => location.pathname.startsWith(TARGET_PATH);

// ─── BANK CONFIG ─────────────────────────────────────────────
const BANK_BIN   = '970436';          // VCB
const ACCOUNT_NO = 'P68002SPCSPF1';
const ACCT_NAME  = 'CONG TY SPX EXPRESS';
const NOTE_PFX   = 'COD - 224';

// Nguồn tiền (bank_account trong KiotVit) auto-chọn theo ngân hàng gửi nhận diện từ OCR.
// Đây chỉ là default — chỉnh được trong Settings (⚙) để khớp CHÍNH XÁC tên TK trong KiotVit.
const KV_BANK_VCB_DEFAULT = 'Ka Bê';   // ảnh VCB Digibank
const KV_BANK_MSB_DEFAULT = 'Kỹ Sư';   // ảnh MSB + người chuyển Trần Hữu Trung

// ─── GM KEYS ─────────────────────────────────────────────────
const QRJS_KEY    = 'qrjs_lib_v1';
const QRJS_CDN    = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
// SHA-256 of qrcodejs 1.0.0 minified from cdnjs (computed 2026-05-14). Pin
// here so a future cdnjs compromise OR poisoned GM cache cannot silently
// substitute a malicious payload. Update only when the pinned version moves.
const QRJS_SHA256 = 'c541ef06327885a8415bca8df6071e14189b4855336def4f36db54bde8484f36';
const CLICKED_KEY = 'qr_clicked_v1';

function getClickedSet() {
    try { return new Set(JSON.parse(GM_getValue(CLICKED_KEY, '[]'))); }
    catch { return new Set(); }
}
function markClicked(key) {
    const s = getClickedSet();
    s.add(key);
    GM_setValue(CLICKED_KEY, JSON.stringify([...s]));
}

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
function fmtDate(s) {
    const [y, m, d] = s.trim().split('-');
    return `${d}.${m}.${y}`;
}

function parseAmount(s) {
    return Math.round(parseFloat((s || '').replace(/,/g, '')) || 0);
}

/** Strip mọi non-digit → parseInt. Dùng cho VND OCR text (luôn integer, không decimal).
 *  Handles cả VN-format ("215.400", "215.400 đ") lẫn US-format ("215,400") cùng lúc.
 *  KHÔNG dùng cho SPX cell text (vd "215,400.00") vì sẽ đọc thành 21540000 — dùng parseAmount đó. */
function parseVndAmount(s) {
    const digits = (s || '').replace(/[^0-9]/g, '');
    return digits ? parseInt(digits, 10) : 0;
}

// ─── QR.JS — GM-CACHED + SHA-256 PINNED ──────────────────────
async function _sha256hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2,'0')).join('');
}

async function ensureQRLib() {
    if (typeof QRCode !== 'undefined') return;

    const verifyAndEval = async (src, source) => {
        const h = await _sha256hex(src);
        if (h !== QRJS_SHA256) {
            console.error('[SPX] QR.js SHA-256 mismatch from', source, '— refusing to eval. expected:', QRJS_SHA256, 'got:', h);
            return false;
        }
        try { (0, eval)(src); } catch (e) { console.warn('[SPX] QR.js eval failed', e); }
        return typeof QRCode !== 'undefined';
    };

    const cached = GM_getValue(QRJS_KEY, null);
    if (cached && await verifyAndEval(cached, 'GM cache')) return;
    if (cached) { try { GM_setValue(QRJS_KEY, null); } catch {} }

    const fresh = await new Promise((res, rej) => {
        GM_xmlhttpRequest({
            method: 'GET', url: QRJS_CDN,
            onload:  r => r.status === 200 ? res(r.responseText) : rej(new Error(r.status)),
            onerror: () => rej(new Error('network'))
        });
    });
    if (!await verifyAndEval(fresh, 'cdnjs')) {
        throw new Error('QR.js SRI mismatch — supply-chain check failed');
    }
    try { GM_setValue(QRJS_KEY, fresh); } catch {}
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
// AUTO UPLOAD PROOF (v6.0 — Dropbox-based, auto OCR + CF)
// ═══════════════════════════════════════════════════════════

const SK = {
    dbxAccess:  'dbx_access_token',     // short-lived access token (auto-quản lý)
    dbxExpiry:  'dbx_token_expiry',     // ms timestamp hết hạn access token
    dbxRefresh: 'dbx_refresh_token',    // long-lived refresh token (user điền)
    dbxClientId:'dbx_client_id',        // Dropbox app key
    dbxClientSecret:'dbx_client_secret',// Dropbox app secret
    dbxFolder:  'dbx_folder_path',      // vd /NSS Proofs
    dbxDone:    'gd_processed_v1',      // Set fileIds đã xử lý (giữ key cũ để không mất dữ liệu)
    dbxAuto:    'gd_auto_upload',       // boolean: ON = poll thấy ảnh mới thì auto OCR + upload ngầm
    ocrKey:  'ocr_space_api_key',
    ocrPause:'ocr_paused_until',    // ms timestamp — OCR rate-limit → skip auto đến lúc đó
    ocrLang: 'ocr_space_language',  // 'eng' | 'vie' | 'auto' — OCR.space language code
    // GoFile long-term archive
    gfToken: 'gofile_api_token',    // GoFile account API token (Bearer)
    gfAccountId: 'gofile_account_id', // GoFile account UUID — cần cho /accounts/<id> endpoint
    gfFolderId: 'gofile_folder_id', // contentId của folder đích (từ URL gofile.io/d/<id>)
    gfBackedUp: 'gofile_backed_up_v1',  // Set Drive fileIds đã upload xong lên GoFile
    ocrFailRetry: 'ocr_fail_retry_v1',  // {fileId: attemptCount} — cap số lần re-OCR file OCR_FAIL_
    ocrPauseRemind: 'ocr_pause_last_remind',  // ms timestamp — last "OCR còn paused" reminder toast
    // KiotVit cash book (sổ quỹ) — Tailscale direct POST
    kvUrl:   'kv_base_url',         // vd http://kiotvit-pc:9009 hoặc http://100.x.x.x:9009
    kvBank:  'kv_bank_name',        // tên TK ngân hàng fallback khi OCR không nhận diện được
    kvBankVcb: 'kv_bank_vcb',       // nguồn tiền cho ảnh VCB Digibank
    kvBankMsb: 'kv_bank_msb',       // nguồn tiền cho ảnh MSB + người chuyển Trần Hữu Trung
    kvSpx:   'kv_spx_cat_v2',       // {id, ts} — auto-discover qua API, TTL 24h
    kvDone:  'kv_recorded_v1',      // Set rows đã VERIFY có phiếu chi → button green ✓ persist
    kvPending:'kv_pending_v1',      // map cfKey→{id,code,ver} — đã POST nhưng chưa xanh (ver: pending|failed)
    kvCutoff:'kv_cf_cutoff_iso',    // ISO date — row date < cutoff không inject pen (đã làm tay)
    kvToken: 'kv_auth_token_v1'     // Bearer token KiotVit (cấp qua /api/auth/pin, hạn 90d)
};
const CF_CUTOFF_DEFAULT = '2026-05-05';
const KV_CAT_TTL_MS = 24 * 60 * 60 * 1000;
// KiotVit chặn /api/* bằng preHandler — chỉ bỏ qua cho localhost + dải Tailscale
// 100.64/10. Userscript ở origin sp.spx.shopee.vn nên phải gửi Bearer token.
const KV_PIN = GM_getValue('spx_kv_pin', '112018');
const OCR_PAUSE_MS = 15 * 60 * 1000;            // 15 min cho per-minute rate limit
const OCR_PAUSE_DAILY_MS = 6 * 60 * 60 * 1000;   // 6h cho per-day quota — quota reset hằng ngày, không spam mỗi 15p
const OCR_API_URL = 'https://api.ocr.space/parse/image';
const OCR_LANG_DEFAULT = 'eng';
// Pre-filled defaults — loaded on any fresh device from GitHub. User can override
// via ⚙ Settings; the saved GM value always takes priority over these.
const D = {
    kvUrl:      'http://pavi:9009',
    kvBank:     'Ka Bê',
    ocrKey:     'K86500552088957',
    gfToken:    'yVPBRMAwp8g3jf5oVdzIk1hPF1yvPou5',
    gfAccountId:'f49d50b1-bbab-4b46-851d-af4d1b963700',
    gfFolderId: 'b6f41638-7170-4116-93f0-7a902fc89041',
};
function cfg(skField) { return (GM_getValue(SK[skField], '') || D[skField] || '').trim(); }
const OCR_ENGINE = '3';  // engine 3: newest, accuracy cao nhất cho bank screenshots
const SPX_LIST_COUNT = 100;

// ─── CUSTOM TOOLTIP (vẽ phía trên element, không bị chuột che) ─
const spxTipEl = document.createElement('div');
Object.assign(spxTipEl.style, {
    position: 'fixed', zIndex: '9999999', display: 'none', opacity: '0',
    background: 'rgba(0,0,0,0.88)', color: '#fff',
    padding: '6px 10px', borderRadius: '6px',
    fontSize: '12px', fontFamily: 'system-ui,sans-serif',
    pointerEvents: 'none', maxWidth: '320px',
    whiteSpace: 'pre-wrap', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    transition: 'opacity .1s'
});
document.body.appendChild(spxTipEl);
let spxCurrentTip = null;

function spxShowTip(target, text) {
    spxTipEl.textContent = text;
    spxTipEl.style.display = 'block';
    const r = target.getBoundingClientRect();
    const tw = spxTipEl.offsetWidth;
    const th = spxTipEl.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.top - th - 8;                // mặc định: phía trên
    x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
    if (y < 8) y = r.bottom + 8;            // không đủ chỗ trên → flip xuống dưới
    spxTipEl.style.left = x + 'px';
    spxTipEl.style.top = y + 'px';
    spxTipEl.style.opacity = '1';
}

function spxHideTip() {
    spxTipEl.style.opacity = '0';
    spxTipEl.style.display = 'none';
}

document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[data-spx-tip]');
    if (!el || el === spxCurrentTip) return;
    spxCurrentTip = el;
    spxShowTip(el, el.dataset.spxTip);
});
document.addEventListener('mouseout', e => {
    if (!spxCurrentTip) return;
    const goingTo = e.relatedTarget;
    if (goingTo && spxCurrentTip.contains(goingTo)) return;  // còn trong cùng element
    spxCurrentTip = null;
    spxHideTip();
});

// ─── TOAST ───────────────────────────────────────────────────
// Toast hiện ở bên phải nút "📥 Proofs" (trigger), cách 24px, stack dọc
// xuống dưới nếu nhiều cái song song. Fallback góc phải-trên viewport
// nếu chưa có trigger button (page chưa render xong).
const TOAST_GAP = 24;
function toast(msg, color = '#16a34a', ms = 3500) {
    let wrap = document.getElementById('spx-toast-wrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'spx-toast-wrap';
        Object.assign(wrap.style, {
            position: 'fixed', zIndex: '9999999',
            display: 'flex', flexDirection: 'column', gap: '8px',
            alignItems: 'flex-end', pointerEvents: 'none'
        });
        document.body.appendChild(wrap);
    }
    if (triggerWrap && document.body.contains(triggerWrap)) {
        const r = triggerWrap.getBoundingClientRect();
        wrap.style.top = r.top + 'px';
    } else {
        wrap.style.top = '20px';
    }
    {
        wrap.style.right = '20px';
        wrap.style.left = 'auto';
    }

    const t = document.createElement('div');
    Object.assign(t.style, {
        background: color, color: '#fff', padding: '10px 16px',
        borderRadius: '8px', fontSize: '13px', fontFamily: 'system-ui,sans-serif',
        boxShadow: '0 6px 20px rgba(0,0,0,0.25)', maxWidth: '380px',
        pointerEvents: 'auto'
    });
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => t.remove(), ms);
}

// ─── GM HTTP ─────────────────────────────────────────────────
if (!document.documentElement.SpxShared) { console.warn('[SPX] refund-nss: SpxShared not ready, aborting'); return; }
const { gmReq } = document.documentElement.SpxShared;

// ─── KIOTVIT AUTH (Bearer token) ─────────────────────────────
// POST /api/auth/pin {pin} → token. Route này được preHandler bỏ qua auth.
async function kvLogin(url) {
    const r = await gmReq({
        method: 'POST',
        url: `${url}/api/auth/pin`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ pin: KV_PIN })
    });
    let j;
    try { j = JSON.parse(r.responseText); } catch { throw new Error('login KiotVit: phản hồi không phải JSON'); }
    if (!j.token) throw new Error('login KiotVit: không nhận được token');
    GM_setValue(SK.kvToken, j.token);
    return j.token;
}

// gmReq + Bearer. Chưa có token → login. Gặp 401 → xoá cache, login lại, retry 1 lần.
async function kvAuthedReq(url, opts) {
    const withAuth = (tk) => ({ ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${tk}` } });
    let token = GM_getValue(SK.kvToken, '') || await kvLogin(url);
    try {
        return await gmReq(withAuth(token));
    } catch (e) {
        if (!/^HTTP 401/.test(e.message || '')) throw e;
        GM_setValue(SK.kvToken, '');
        token = await kvLogin(url);
        return await gmReq(withAuth(token));
    }
}

// ─── DATE / URL HELPERS ──────────────────────────────────────
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidIso(s) { return typeof s === 'string' && ISO_RE.test(s); }

function revokeItemUrls(items) {
    if (!items) return;
    for (const it of items) {
        if (it && it.previewUrl) {
            try { URL.revokeObjectURL(it.previewUrl); } catch {}
            it.previewUrl = null;
        }
    }
}

// ─── DROPBOX API ─────────────────────────────────────────────
// fileId → current filename. Populated by dbxList(), updated by dbxRename().
// dbxMove cần tên hiện tại để tạo to_path; Dropbox ID ổn định qua rename/move.
const _dbxNameMap = new Map();

function _mimeFromName(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    return ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
}

let _dbxRefreshInflight = null;

async function dbxEnsureToken() {
    const expiry = +GM_getValue(SK.dbxExpiry, 0);
    if (expiry - Date.now() > 120_000 && GM_getValue(SK.dbxAccess, '')) return;
    if (_dbxRefreshInflight) return _dbxRefreshInflight;
    _dbxRefreshInflight = (async () => {
        try {
            const rt = cfg('dbxRefresh'), ci = cfg('dbxClientId'), cs = cfg('dbxClientSecret');
            if (!rt || !ci || !cs) throw new Error('Thiếu Dropbox refresh_token/client_id/client_secret (⚙)');
            const r = await gmReq({
                method: 'POST',
                url: 'https://api.dropbox.com/oauth2/token',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}`
                    + `&client_id=${encodeURIComponent(ci)}&client_secret=${encodeURIComponent(cs)}`
            });
            let j; try { j = JSON.parse(r.responseText); } catch { throw new Error('Dropbox token: phản hồi không phải JSON'); }
            if (!j.access_token) throw new Error(j.error_description || j.error || 'no access_token');
            GM_setValue(SK.dbxAccess, j.access_token);
            GM_setValue(SK.dbxExpiry, Date.now() + (j.expires_in || 14400) * 1000);
        } finally { _dbxRefreshInflight = null; }
    })();
    return _dbxRefreshInflight;
}

async function dbxApiCall(opts) {
    await dbxEnsureToken();
    const token = GM_getValue(SK.dbxAccess, '');
    const headers = { 'Authorization': `Bearer ${token}` };
    if (opts.argHeader) headers['Dropbox-API-Arg'] = opts.argHeader;
    else if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await gmReq({
        method: opts.method || 'POST',
        url: opts.url,
        headers,
        ...(opts.body !== undefined && { data: JSON.stringify(opts.body) }),
        ...(opts.responseType && { responseType: opts.responseType }),
    });
    if (opts.responseType === 'arraybuffer') return r;
    let j; try { j = JSON.parse(r.responseText); } catch { throw new Error('Dropbox: phản hồi không phải JSON'); }
    if (j.error_summary || j.error) throw new Error('Dropbox: ' + (j.error_summary || j.error_description || JSON.stringify(j.error)));
    return j;
}

async function dbxList() {
    const folder = GM_getValue(SK.dbxFolder, '') || '/NSS Proofs';
    const j = await dbxApiCall({ url: 'https://api.dropboxapi.com/2/files/list_folder', body: { path: folder, recursive: false } });
    return (j.entries || [])
        .filter(e => e['.tag'] === 'file' && /\.(jpe?g|png|gif|webp|heic)$/i.test(e.name))
        .map(e => { _dbxNameMap.set(e.id, e.name); return { id: e.id, name: e.name, mimeType: _mimeFromName(e.name) }; });
}

async function dbxGet(id) {
    const r = await dbxApiCall({ url: 'https://content.dropboxapi.com/2/files/download', argHeader: JSON.stringify({ path: id }), responseType: 'arraybuffer' });
    const name = _dbxNameMap.get(id) || 'proof.jpg';
    const bytes = new Uint8Array(r.response);
    let bin = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.byteLength; i += CHUNK)
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return { ok: true, id, name, mimeType: _mimeFromName(name), dataB64: btoa(bin) };
}

async function dbxRename(id, newName) {
    const folder = GM_getValue(SK.dbxFolder, '') || '/NSS Proofs';
    const j = await dbxApiCall({ url: 'https://api.dropboxapi.com/2/files/move_v2', body: { from_path: id, to_path: `${folder}/${newName}`, autorename: false } });
    const moved = j.metadata || j;
    _dbxNameMap.set(id, moved.name || newName);
    return { ok: true, id, name: moved.name || newName };
}

async function dbxMove(id, subfolder) {
    const folder = GM_getValue(SK.dbxFolder, '') || '/NSS Proofs';
    const currentName = _dbxNameMap.get(id) || id;
    const destFolder = `${folder}/${subfolder}`;
    const toPath = `${destFolder}/${currentName}`;
    const doMove = () => dbxApiCall({ url: 'https://api.dropboxapi.com/2/files/move_v2', body: { from_path: id, to_path: toPath, autorename: true } });
    let j;
    try {
        j = await doMove();
    } catch (e) {
        // Subfolder chưa tồn tại → tạo rồi retry (GAS làm điều này tự động)
        if (/no_parent|not_found/i.test(e.message)) {
            await dbxApiCall({ url: 'https://api.dropboxapi.com/2/files/create_folder_v2', body: { path: destFolder, autorename: false } })
                .catch(() => {}); // ignore "already exists"
            j = await doMove();
        } else throw e;
    }
    _dbxNameMap.delete(id);
    return { ok: true, id, name: (j.metadata || j).name || currentName };
}

const GARBAGE_SUBFOLDER = 'garbage';
const DONE_SUBFOLDER    = 'done';
const RETENTION_DAYS    = 10;

function fireDbxMoveGarbage(fileId) {
    dbxMove(fileId, GARBAGE_SUBFOLDER)
        .catch(e => console.warn('[SPX] move-to-garbage failed', fileId, e.message));
}
function fireDbxMoveDone(fileId) {
    dbxMove(fileId, DONE_SUBFOLDER)
        .catch(e => console.warn('[SPX] move-to-done failed', fileId, e.message));
}

function fireDbxCleanupDone() {
    (async () => {
        const folder = GM_getValue(SK.dbxFolder, '') || '/NSS Proofs';
        let j;
        try { j = await dbxApiCall({ url: 'https://api.dropboxapi.com/2/files/list_folder', body: { path: `${folder}/${DONE_SUBFOLDER}`, recursive: false } }); }
        catch (e) { if (/not_found/i.test(e.message)) return; console.warn('[SPX] cleanup list', e.message); return; }
        const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
        const old = (j.entries || []).filter(e => e['.tag'] === 'file' && new Date(e.server_modified).getTime() < cutoff);
        for (const f of old) dbxApiCall({ url: 'https://api.dropboxapi.com/2/files/delete_v2', body: { path: f.id } })
            .catch(e => console.warn('[SPX] cleanup delete', f.name, e.message));
        if (old.length) console.log('[SPX] cleanup done/: xóa', old.length, 'files cũ');
    })();
}

// ─── GOFILE BACKUP ──────────────────────────────────────────
function getBackedUpSet() {
    try { return new Set(JSON.parse(GM_getValue(SK.gfBackedUp, '[]'))); }
    catch { return new Set(); }
}
function addBackedUp(fileId) {
    const s = getBackedUpSet();
    s.add(fileId);
    GM_setValue(SK.gfBackedUp, JSON.stringify([...s]));
}
// ─── OCR FAIL RETRY BUDGET ───────────────────────────────────
// File rename ra OCR_FAIL_ thì cleanup pass sẽ retry mỗi cycle. Cap số lần
// để file fail vĩnh viễn (ảnh mờ, không phải bill) không đốt quota infinite.
function getOcrFailRetry() {
    try { return JSON.parse(GM_getValue(SK.ocrFailRetry, '{}')) || {}; }
    catch { return {}; }
}
function saveOcrFailRetry(m) {
    GM_setValue(SK.ocrFailRetry, JSON.stringify(m));
}
function bumpOcrFailRetry(fileId) {
    const m = getOcrFailRetry();
    m[fileId] = (m[fileId] || 0) + 1;
    saveOcrFailRetry(m);
    return m[fileId];
}
function clearOcrFailRetry(fileId) {
    const m = getOcrFailRetry();
    if (m[fileId] != null) {
        delete m[fileId];
        saveOcrFailRetry(m);
    }
}
function pruneOcrFailRetry(liveIds) {
    const m = getOcrFailRetry();
    let changed = false;
    for (const id of Object.keys(m)) {
        if (!liveIds.has(id)) { delete m[id]; changed = true; }
    }
    if (changed) saveOcrFailRetry(m);
}

function pruneBackedUpSet(liveIds) {
    const s = getBackedUpSet();
    const pruned = new Set([...s].filter(id => liveIds.has(id)));
    if (pruned.size !== s.size) {
        GM_setValue(SK.gfBackedUp, JSON.stringify([...pruned]));
    }
    return pruned;
}

/** Upload 1 blob lên GoFile folder đã config. Trả về response.data nếu OK.
 *  Endpoint: https://upload.gofile.io/uploadfile (modern API).
 *  Auth: Authorization: Bearer <token>. Folder target qua field `folderId`. */
async function gofileUpload(blob, filename) {
    const token = cfg('gfToken');
    const folderId = cfg('gfFolderId');
    if (!token || !folderId) throw new Error('missing GoFile token/folderId');

    const fd = new FormData();
    fd.append('file', blob, filename);
    fd.append('folderId', folderId);

    const r = await gmReq({
        method: 'POST',
        url: 'https://upload.gofile.io/uploadfile',
        headers: { 'Authorization': `Bearer ${token}` },
        data: fd
    });
    let j;
    try { j = JSON.parse(r.responseText); } catch { throw new Error('GoFile non-JSON response'); }
    if (j.status !== 'ok') throw new Error(j.error || j.status || 'gofile upload failed');
    return j.data;
}

/** Fire-and-forget backup. Không block flow chính. Chỉ chạy nếu config có đủ. */
function fireGofileBackup(fileId, blob, filename) {
    if (!cfg('gfToken') || !cfg('gfFolderId')) return;
    if (getBackedUpSet().has(fileId)) return;
    gofileUpload(blob, filename)
        .then(() => addBackedUp(fileId))
        .catch(e => toast(`⚠ GoFile backup: ${e.message}`, '#d97706', 4000));
}

const FILE_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function fmtDateForFile(iso) {
    // "2026-05-07" → "07MAY2026"
    const [y, m, d] = iso.split('-');
    return `${d}${FILE_MONTHS[parseInt(m, 10) - 1]}${y}`;
}
function fileExt(name) {
    const m = (name || '').match(/\.[^.]+$/);
    return m ? m[0] : '.jpg';
}
function buildSemanticName(iso, amount, origName) {
    return `${NOTE_PFX} - ${fmtDateForFile(iso)} - VND ${amount}${fileExt(origName)}`;
}
// Match filename đã ở dạng semantic — skip rename idempotent.
// e.g. "COD - 224 - 07MAY2026 - VND 215400.jpg"
const SEMANTIC_NAME_RE = /^COD - \d+ - \d{2}[A-Z]{3}\d{4} - VND \d+\.\w+$/;
const RENAME_BUDGET_PER_POLL = 3;       // cleanup OCR retry per poll — giảm để tránh đốt quota OCR.space
const OCR_FAIL_MAX_RETRY = 3;           // tối đa retry OCR cho file OCR_FAIL_ — sau đó dừng, chỉ backup
const OCR_PAUSE_REMIND_MS = 30 * 60 * 1000;   // 30 phút giữa các toast nhắc "OCR còn paused"
const CLEANUP_PARALLELISM = 3;          // số file cleanup chạy song song

/** Compute desired filename based on OCR result. Trả null nếu không cần rename
 *  (đã đúng format, hoặc OCR data không đủ để build tên). */
function computeRenameTarget(currentName, ocr, fileId) {
    if (SEMANTIC_NAME_RE.test(currentName)) return null;
    if (currentName.startsWith('OCR_FAIL_')) return null;
    if (!ocr) return `OCR_FAIL_${fileId}${fileExt(currentName)}`;
    if (isValidIso(ocr.note_date_iso) && ocr.amount > 0) {
        return buildSemanticName(ocr.note_date_iso, ocr.amount, currentName);
    }
    // OCR thành công nhưng không extract được date+amount (vd ảnh không phải bill ck) —
    // mark OCR_FAIL_ để retry budget có thể cap, tránh cleanup re-OCR vô tận.
    return `OCR_FAIL_${fileId}${fileExt(currentName)}`;
}

function b64ToBlob(b64, mimeType) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mimeType || 'image/jpeg' });
}

function getProcessedSet() {
    try { return new Set(JSON.parse(GM_getValue(SK.dbxDone, '[]'))); }
    catch { return new Set(); }
}
function saveProcessedSet(s) {
    GM_setValue(SK.dbxDone, JSON.stringify([...s]));
}
function addProcessed(ids) {
    const s = getProcessedSet();
    for (const id of ids) s.add(id);
    saveProcessedSet(s);
}

// ─── OCR.space ───────────────────────────────────────────────
// API trả plain text — parser tự extract structured fields qua regex
// vì note do userscript encode vào QR (format chuẩn: "COD - 224 - 23.05.2026").

function extractNoteDateIso(text) {
    // Regex match note format: "COD - 224 - DD.MM.YYYY"
    const m = (text || '').match(/COD\s*[-–]\s*\d+\s*[-–]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const yr = m[3];
    return `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractAmount(text) {
    if (!text) return null;
    // 1: sau label "Số tiền" (label tiếng Việt — có thể fail nếu OCR engine eng)
    let m = text.match(/S[ốốoo]\s*ti[ềền][^0-9]*([0-9][0-9,.\s]{2,})/i);
    if (m) {
        const v = parseVndAmount(m[1]);
        if (v > 0) return v;
    }
    // 2: kèm currency suffix VND/đ/đồng
    m = text.match(/([0-9]{1,3}(?:[,.][0-9]{3})+)\s*(?:đ|VND|VNĐ|đồng)/i);
    if (m) {
        const v = parseVndAmount(m[1]);
        if (v > 0) return v;
    }
    // 3: largest grouped-number trong text (cả VN dot-sep lẫn US comma-sep)
    const all = text.match(/[0-9]{1,3}(?:[,.][0-9]{3})+/g) || [];
    const nums = all.map(s => parseVndAmount(s)).filter(n => n >= 1000);
    if (nums.length) return Math.max(...nums);
    // 4: plain number ≥ 1000 không có separator (vd OCR trả "171137 VND")
    const plain = (text.match(/\b([0-9]{4,})\b/g) || []).map(Number).filter(n => n >= 1000);
    if (plain.length) return Math.max(...plain);
    return null;
}

/** Bỏ dấu tiếng Việt + lowercase — để match tên người chuyển bất kể OCR có/không dấu. */
function stripVnDiacritics(s) {
    return (s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .toLowerCase();
}

/** Nhận diện nguồn tiền (bank_account KiotVit) từ raw OCR text.
 *  - VCB Digibank                          → setting kvBankVcb (default "Ka Bê")
 *  - MSB HOẶC người chuyển Trần Hữu Trung  → setting kvBankMsb (default "Kỹ Sư")
 *  Trả null nếu không khớp → caller fallback về setting kvBank.
 *
 *  MSB nhận diện qua OR (không AND): logo "MSB" là wordmark đồ hoạ — OCR hay
 *  đọc trượt. Tên chủ TK "Trần Hữu Trung" (có/không dấu, hoa/thường đều khớp
 *  nhờ stripVnDiacritics) là tín hiệu đủ mạnh; VCB đã return ở trên nên không đụng. */
function detectBankFromOcr(rawText) {
    const norm = stripVnDiacritics(rawText);
    if (/vcb\s*digibank/.test(norm)) {
        return (GM_getValue(SK.kvBankVcb, '') || KV_BANK_VCB_DEFAULT).trim();
    }
    const isMsb = /\bmsb\b/.test(norm);
    const senderTrung = /tran\s*huu\s*trung/.test(norm);
    if (isMsb || senderTrung) {
        return (GM_getValue(SK.kvBankMsb, '') || KV_BANK_MSB_DEFAULT).trim();
    }
    return null;
}

async function ocrExtract(blob, mimeType = 'image/jpeg') {
    const key = cfg('ocrKey');
    if (!key) throw new Error('missing OCR.space key');

    const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej;
        r.readAsDataURL(blob);
    });
    const lang = (GM_getValue(SK.ocrLang, '') || OCR_LANG_DEFAULT).trim();
    const body = `apikey=${encodeURIComponent(key)}`
        + `&base64Image=${encodeURIComponent(dataUrl)}`
        + `&language=${encodeURIComponent(lang)}`
        + `&OCREngine=${encodeURIComponent(OCR_ENGINE)}`
        + `&scale=true&isOverlayRequired=false`;

    let r;
    try {
        r = await gmReq({
            method: 'POST',
            url: OCR_API_URL,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: body
        });
    } catch (e) {
        const msg = e.message || '';
        if (/HTTP 429|rate.?limit|daily limit/i.test(msg)) {
            const pauseMs = /daily/i.test(msg) ? OCR_PAUSE_DAILY_MS : OCR_PAUSE_MS;
            GM_setValue(SK.ocrPause, Date.now() + pauseMs);
            console.warn('[SPX] OCR.space rate-limit, paused', Math.round(pauseMs / 60000), 'min');
        }
        throw e;
    }
    let j;
    try { j = JSON.parse(r.responseText); }
    catch { throw new Error('OCR.space non-JSON response'); }
    if (j.IsErroredOnProcessing) {
        const msg = Array.isArray(j.ErrorMessage) ? j.ErrorMessage.join('; ') : (j.ErrorMessage || 'OCR error');
        // OCR.space báo daily limit qua ErrorMessage thay vì HTTP 429
        if (/daily limit|too fast|rate/i.test(msg)) {
            const pauseMs = /daily/i.test(msg) ? OCR_PAUSE_DAILY_MS : OCR_PAUSE_MS;
            GM_setValue(SK.ocrPause, Date.now() + pauseMs);
            console.warn('[SPX] OCR.space rate-limit (in body), paused', Math.round(pauseMs / 60000), 'min');
        }
        throw new Error('OCR: ' + msg);
    }
    const rawText = (j.ParsedResults && j.ParsedResults[0] && j.ParsedResults[0].ParsedText) || '';
    const note_date_iso = extractNoteDateIso(rawText);
    const amount = extractAmount(rawText);
    // Note line: tìm dòng chứa "COD ..."
    const noteMatch = rawText.match(/COD[^\n]+/i);
    return {
        amount,
        note: noteMatch ? noteMatch[0].trim() : null,
        note_date_iso,
        bank: detectBankFromOcr(rawText),
        rawText
    };
}

function isOcrPaused() {
    const until = +GM_getValue(SK.ocrPause, 0) || 0;
    return until > Date.now();
}

/** Transient error: rate limit, server error, network/timeout — sẽ tự khôi phục.
 *  KHÔNG nên rename file thành OCR_FAIL_ trong case này — giữ tên cũ, retry sau. */
function isTransientOcrError(msg) {
    return /HTTP 429|HTTP 5\d\d|timeout|network|rate.?limit|daily limit/i.test(msg || '');
}

// ─── KIOTVIT CASH BOOK (Tailscale direct POST) ───────────────

function kvUid() {
    // 16 hex random — đủ entropy cho cash_flow.id
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── REFUND STATE IDB (owned here, pulled cross-device via Neon) ──────────────
const RSDB = 'spx_refund_state';
const RSST = 'cfkeys';
let _rsDb = null;
function rsOpen() {
    if (_rsDb) return Promise.resolve(_rsDb);
    return new Promise((res, rej) => {
        const r = indexedDB.open(RSDB, 1);
        r.onupgradeneeded = () => {
            if (!r.result.objectStoreNames.contains(RSST))
                r.result.createObjectStore(RSST);
        };
        r.onsuccess = () => { _rsDb = r.result; res(_rsDb); };
        r.onerror   = () => rej(r.error);
    });
}
function rsPut(cfKey, rec) {
    return rsOpen().then(db => new Promise((res, rej) => {
        const tx = db.transaction(RSST, 'readwrite');
        tx.objectStore(RSST).put(rec, cfKey);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    }));
}
function rsGetAll() {
    return rsOpen().then(db => new Promise((res, rej) => {
        const req = db.transaction(RSST, 'readonly').objectStore(RSST).getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror   = () => rej(req.error);
    }));
}
function pushRefundState(cfKey, status, kv_id, kv_code) {
    const rec = { cf_key: cfKey, _key: cfKey, status, kv_id: kv_id || null, kv_code: kv_code || null };
    rsPut(cfKey, rec).catch(() => {});
    _NS?.push('spx_refund_state', rec);
}
async function mergeRefundIdbToGm() {
    try {
        const all = await rsGetAll();
        const done = all.filter(r => r && r.status === 'done').map(r => r.cf_key);
        console.log('[SPX] mergeIdbToGm: IDB total=' + all.length + ' done=' + done.length);
        if (!done.length) return;
        const s = getRecordedSet();
        let added = 0;
        done.forEach(k => { if (!s.has(k)) { s.add(k); added++; } });
        if (added) { GM_setValue(SK.kvDone, JSON.stringify([...s])); console.log('[SPX] mergeIdbToGm: added ' + added + ' keys'); }
    } catch (e) { console.warn('[SPX] mergeIdbToGm error', e); }
}
async function migrateGmToIdb() {
    try {
        const existing = await rsGetAll();
        const existingKeys = new Set(existing.map(r => r && (r.cf_key || r._key)).filter(Boolean));
        const gmKeys = [...getRecordedSet()].filter(k => !existingKeys.has(k));
        if (!gmKeys.length) return;
        for (const key of gmKeys) {
            const rec = { cf_key: key, _key: key, status: 'done', kv_id: null, kv_code: null };
            await rsPut(key, rec);
            _NS?.push('spx_refund_state', rec);
        }
        console.log('[SPX] Migrated', gmKeys.length, 'refund records to IDB+Neon');
    } catch (e) { console.warn('[SPX] migrateGmToIdb', e); }
}

function getRecordedSet() {
    try { return new Set(JSON.parse(GM_getValue(SK.kvDone, '[]'))); }
    catch { return new Set(); }
}
function markRecorded(key, kv_id, kv_code) {
    const s = getRecordedSet();
    s.add(key);
    GM_setValue(SK.kvDone, JSON.stringify([...s]));
    pushRefundState(key, 'done', kv_id, kv_code);
}
/** Batch mark — tránh lost-update khi nhiều promise concurrent gọi markRecorded.
 *  Single read-modify-write thay vì N round-trip. */
function markRecordedBatch(keys) {
    if (!keys.length) return;
    const s = getRecordedSet();
    for (const k of keys) s.add(k);
    GM_setValue(SK.kvDone, JSON.stringify([...s]));
}

// ─── PENDING MAP (đã POST nhưng chưa VERIFY xanh) ─────────────
// cfKey → { id, code, ver }. ver='failed' (ghi hỏng/404 → ✕ đỏ) | 'pending'
// (POST OK nhưng verify chưa xong → ? vàng, tự verify lại). id ổn định per cfKey
// dùng cho mọi retry → server idempotency guard chống phiếu trùng.
function getPendingMap() {
    try { return JSON.parse(GM_getValue(SK.kvPending, '{}')) || {}; }
    catch { return {}; }
}
function getPendingEntry(cfKey) {
    return getPendingMap()[cfKey] || null;
}
function setPendingEntry(cfKey, entry) {
    const m = getPendingMap();
    m[cfKey] = { ...(m[cfKey] || {}), ...entry };
    GM_setValue(SK.kvPending, JSON.stringify(m));
}
function delPendingEntry(cfKey) {
    const m = getPendingMap();
    if (cfKey in m) { delete m[cfKey]; GM_setValue(SK.kvPending, JSON.stringify(m)); }
}
/** id ổn định cho cfKey — reuse id đã sinh (pending) để retry idempotent. */
function stableCfId(cfKey) {
    const e = getPendingEntry(cfKey);
    return (e && e.id) || kvUid();
}

/** GET danh sách cash_categories, tìm tag='SPX', cache id vào GM với TTL 24h.
 *  Cache stale → tự refresh, tránh bị stuck với category đã xóa/đổi tag.
 *  In-flight memoization: N concurrent caller share cùng 1 promise (tránh N duplicate GET
 *  khi processCfBatch song song lần đầu trong session). */
let kvCategoryInflight = null;
async function kvDiscoverSpxCategory() {
    const raw = GM_getValue(SK.kvSpx, '');
    if (raw) {
        try {
            const c = JSON.parse(raw);
            if (c && c.id && c.ts && (Date.now() - c.ts) < KV_CAT_TTL_MS) return c.id;
        } catch {}
    }
    if (kvCategoryInflight) return kvCategoryInflight;
    const url = cfg('kvUrl').replace(/\/+$/, '');
    if (!url) throw new Error('Chưa cài KiotVit URL trong Settings (⚙)');
    kvCategoryInflight = (async () => {
        try {
            const r = await kvAuthedReq(url, {
                method: 'GET',
                url: `${url}/api/cash-categories`
            });
            let list;
            try { list = JSON.parse(r.responseText); }
            catch { throw new Error('Phản hồi không phải JSON'); }
            if (!Array.isArray(list)) throw new Error('Format danh mục lạ');
            const spx = list.find(c => c.tag === 'SPX')
                     || list.find(c => /spx/i.test(c.tag || '') || /spx/i.test(c.name || ''));
            if (!spx) throw new Error('Không tìm thấy danh mục SPX trong KiotVit (tạo tag=SPX trước)');
            GM_setValue(SK.kvSpx, JSON.stringify({ id: spx.id, ts: Date.now() }));
            return spx.id;
        } finally {
            kvCategoryInflight = null;
        }
    })();
    return kvCategoryInflight;
}

// Throttle warning toast: chỉ show 1 lần/session khi missing SPX category.
let kvCategoryWarned = false;

// Resolve tên TK ngân hàng → canonical bank_accounts.id (shape ổn định cho
// cash_flow.bank_account). Server cũng tự canonicalize theo name nên đây chỉ
// là gửi giá trị bền nhất; fetch fail / không khớp → trả nguyên tên, server
// vẫn xử đúng. Cache list trong session (TK hiếm khi đổi).
let kvBankListCache = null;
async function kvResolveBankId(name, url) {
    const raw = (name || '').trim();
    if (!raw) return raw;
    try {
        if (!kvBankListCache) {
            const r = await kvAuthedReq(url, { method: 'GET', url: `${url}/api/bank-accounts` });
            const list = JSON.parse(r.responseText);
            kvBankListCache = Array.isArray(list) ? list : [];
        }
        const lo = raw.toLowerCase();
        const hit = kvBankListCache.find(a => (a.name || '').trim().toLowerCase() === lo)
                 || kvBankListCache.find(a => (a.account_number || '').trim() === raw);
        return hit ? hit.id : raw;
    } catch {
        return raw;  // server resolveBankAccountKey theo name — graceful fallback
    }
}

/** POST /api/cash-flow tạo phiếu chi cho 1 row SPX. Retry 1 lần trên transient error.
 *  `id` ổn định truyền từ caller → retry dùng lại id → server idempotency (already_exists)
 *  chống phiếu trùng. */
async function kvPushCashFlow(rowData, id) {
    const url = cfg('kvUrl').replace(/\/+$/, '');
    if (!url) throw new Error('Chưa cài KiotVit URL trong Settings (⚙)');
    // Nguồn tiền: ưu tiên bank nhận diện từ OCR (rowData.bank), fallback setting kvBank.
    const bank = (rowData.bank || cfg('kvBank') || 'Ka Bê').trim();
    // Gửi canonical id (bank_accounts.id) thay vì tên — shape ổn định, miễn
    // nhiễm đổi tên TK. Server vẫn canonicalize nếu đây là tên (graceful).
    const bankKey = await kvResolveBankId(bank, url);

    let catId;
    try { catId = await kvDiscoverSpxCategory(); }
    catch (e) {
        // Cảnh báo (chỉ 1 lần/session) nhưng vẫn cho push — phiếu vào uncategorized, không exclude khỏi profit.
        if (!kvCategoryWarned) {
            toast('⚠ ' + e.message + ' — phiếu sẽ tính vào lợi nhuận', '#d97706', 5000);
            kvCategoryWarned = true;
        }
    }

    const body = {
        id: id || kvUid(),
        type: 'expense',
        amount: rowData.amount,
        method: 'bank',
        bank_account: bankKey,
        category: 'manual',
        note: rowData.note,
        created_via: 'spx-userscript'
    };
    if (catId) body.category_id = catId;

    const send = () => kvAuthedReq(url, {
        method: 'POST',
        url: `${url}/api/cash-flow`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body)
    });

    let r;
    try { r = await send(); }
    catch (e) {
        // Retry 1 lần cho transient errors (network/timeout/5xx) — Tailscale hibernate hay flake
        const transient = /network|timeout|HTTP 5\d\d/.test(e.message || '');
        if (!transient) throw e;
        await new Promise(res => setTimeout(res, 1000));
        r = await send();
    }
    let j;
    try { j = JSON.parse(r.responseText); } catch { throw new Error('Phản hồi không phải JSON'); }
    if (!j.id) throw new Error(j.error || 'Không có id trong phản hồi');
    return j;  // { id, code, already_exists? }
}

/** Đọc lại phiếu chi từ KiotVit — GET /api/cash-flow/:id (route đã có sẵn).
 *  Phân biệt 3 outcome:
 *   - ok:true            → phiếu tồn tại + khớp expense/amount → tick xanh
 *   - reason:'notfound'  → HTTP 404 = KiotVit XÁC NHẬN không có phiếu → ✕ đỏ
 *   - reason:'mismatch'  → có phiếu nhưng sai type/amount → ✕ đỏ
 *   - reason:'unverified'→ network/timeout/5xx = chưa biết → ? vàng, verify lại sau */
async function kvVerifyCashFlow(id, expected) {
    const url = cfg('kvUrl').replace(/\/+$/, '');
    if (!url) return { ok: false, reason: 'unverified', error: 'Chưa cài KiotVit URL' };
    let r;
    try {
        r = await kvAuthedReq(url, { method: 'GET', url: `${url}/api/cash-flow/${encodeURIComponent(id)}` });
    } catch (e) {
        const msg = e.message || '';
        if (/^HTTP 404/.test(msg)) return { ok: false, reason: 'notfound' };
        // network / timeout / 5xx → không xác minh được
        return { ok: false, reason: 'unverified', error: msg };
    }
    let row;
    try { row = JSON.parse(r.responseText); } catch { return { ok: false, reason: 'unverified', error: 'Phản hồi không phải JSON' }; }
    if (!row || !row.id) return { ok: false, reason: 'notfound' };
    if (row.type !== 'expense' || Number(row.amount) !== Number(expected.amount)) {
        return { ok: false, reason: 'mismatch',
                 error: `phiếu ${row.id}: type=${row.type} amount=${row.amount}` };
    }
    return { ok: true, row };
}

/** Orchestrator ghi phiếu chi an toàn: POST + verify read-back.
 *  Trả { status, id, code?, error? } với status ∈ verified | unverified | failed.
 *  - verified   → đã đọc lại được phiếu trong KiotVit → markRecorded, ✓ xanh
 *  - unverified → POST OK nhưng verify chưa xong (mất mạng) → pending, ? vàng
 *  - failed     → POST hỏng / 404 / sai phiếu → pending ver=failed, ✕ đỏ */
async function kvRecordAndVerify(rowData, cfKey) {
    const id = stableCfId(cfKey);
    // Ghi id xuống pending TRƯỚC khi POST — crash giữa chừng vẫn giữ id để retry idempotent.
    setPendingEntry(cfKey, { id, ver: 'failed' });

    let pushRes;
    try {
        pushRes = await kvPushCashFlow(rowData, id);
    } catch (err) {
        return { status: 'failed', id, error: err.message };
    }
    const code = pushRes.code;

    // Verify read-back — retry tối đa 3 lần nếu 'unverified' (network blip).
    let v;
    for (let attempt = 0; attempt < 3; attempt++) {
        v = await kvVerifyCashFlow(id, { amount: rowData.amount });
        if (v.ok || v.reason !== 'unverified') break;
        if (attempt < 2) await new Promise(res => setTimeout(res, 800));
    }
    if (v.ok) {
        delPendingEntry(cfKey);
        markRecorded(cfKey, id, code);
        return { status: 'verified', id, code };
    }
    if (v.reason === 'unverified') {
        setPendingEntry(cfKey, { id, code, ver: 'pending' });
        return { status: 'unverified', id, code, error: v.error };
    }
    // notfound | mismatch → ghi hỏng
    setPendingEntry(cfKey, { id, code, ver: 'failed' });
    return { status: 'failed', id, code,
             error: v.reason === 'notfound' ? 'KiotVit không có phiếu sau khi ghi' : v.error };
}

/** Verify ngầm 1 entry pending (chỉ GET, KHÔNG POST lại). Dùng cho auto re-verify
 *  state vàng. Trả true nếu đã chuyển sang verified. */
const kvVerifyInflight = new Set();
async function kvReverifyEntry(cfKey, entry) {
    if (!entry || !entry.id || kvVerifyInflight.has(cfKey)) return false;
    kvVerifyInflight.add(cfKey);
    try {
        const v = await kvVerifyCashFlow(entry.id, { amount: Number(cfKey.split('|')[1]) });
        if (v.ok) {
            delPendingEntry(cfKey);
            markRecorded(cfKey, entry.id, entry.code);
            return true;
        }
        if (v.reason === 'notfound' || v.reason === 'mismatch') {
            setPendingEntry(cfKey, { ...entry, ver: 'failed' });
        }
        return false;
    } finally {
        kvVerifyInflight.delete(cfKey);
    }
}

/** Sweep mọi entry pending ver='pending' → verify lại. Gọi từ backgroundPoll.
 *  Trả số entry vừa chuyển verified (caller scanRows nếu > 0). */
async function kvReverifyPending() {
    const m = getPendingMap();
    const targets = Object.entries(m).filter(([, e]) => e && e.ver === 'pending');
    if (!targets.length) return 0;
    let promoted = 0;
    for (const [cfKey, entry] of targets) {
        if (await kvReverifyEntry(cfKey, entry)) promoted++;
    }
    return promoted;
}

// ─── SPX API (same-origin) ───────────────────────────────────
async function spxList() {
    const r = await fetch(`/sp-api/point/dropoff/fee/shipping_fee/drop_off/cash/list?station_type=9&pageno=1&count=${SPX_LIST_COUNT}`,
        { credentials: 'include' });
    const j = await r.json();
    if (j.retcode !== 0) throw new Error('list: ' + j.message);
    return j.data.list || [];
}

function cfCutoff() {
    return GM_getValue(SK.kvCutoff, '') || CF_CUTOFF_DEFAULT;
}

/** Auto-lập phiếu chi cho mỗi item upload thành công.
 *  Skip lịch sử trước cutoff, đã recorded, hoặc thiếu/sai ISO date.
 *  Parallel: mỗi item POST KiotVit độc lập → Promise.allSettled.
 *  recorded Set chỉ ghi 1 lần ở cuối (batch) tránh lost-update do concurrent write. */
async function processCfBatch(uploadedItems) {
    const cutoff = cfCutoff();
    const recorded = getRecordedSet();
    const errors = [];
    let cfSkip = 0;
    const pending = [];
    // Dedupe trong cùng batch: 2 row khác fileId nhưng cùng date+amount → chỉ post 1 lần.
    const seenInBatch = new Set();
    for (const it of uploadedItems) {
        const iso = it.ocr && it.ocr.note_date_iso;
        if (!isValidIso(iso)) { cfSkip++; continue; }
        if (iso < cutoff) { cfSkip++; continue; }
        const dateFmt = fmtDate(iso);
        const cfKey = `${iso}|${it.match.row.pending_amount}`;
        if (recorded.has(cfKey) || seenInBatch.has(cfKey)) { cfSkip++; continue; }
        seenInBatch.add(cfKey);
        pending.push({ it, iso, dateFmt, cfKey });
    }
    // POST + verify read-back từng item. kvRecordAndVerify tự markRecorded khi verified
    // → KHÔNG markRecordedBatch ở đây nữa (tránh đánh dấu xanh phiếu chưa verify).
    const results = await Promise.allSettled(pending.map(p => kvRecordAndVerify({
        date: p.dateFmt, iso: p.iso,
        amount: p.it.match.row.pending_amount,
        bank: p.it.ocr && p.it.ocr.bank,
        note: `${NOTE_PFX} - ${p.dateFmt}`
    }, p.cfKey)));
    let cfOk = 0, cfUnverified = 0, cfFail = 0;
    results.forEach(r => {
        // kvRecordAndVerify không reject — nhưng phòng thủ allSettled vẫn ổn.
        const v = r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
        if (v.status === 'verified') { cfOk++; }
        else if (v.status === 'unverified') { cfUnverified++; if (v.error) errors.push('chưa xác minh: ' + v.error); }
        else { cfFail++; if (v.error) errors.push(v.error); }
    });
    return { cfOk, cfUnverified, cfFail, cfSkip, errors };
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

/** Click programmatically nút Search/Refresh của SPX để framework tự re-fetch list.
 *  Ưu tiên `.pro-filter-btn-confirm` (filter panel confirm button), fallback text match. */
function spxRefreshList() {
    const filterBtn = document.querySelector('.pro-filter-btn-confirm');
    if (filterBtn) { filterBtn.click(); return true; }
    for (const b of document.querySelectorAll('.ssc-button, button')) {
        const txt = (b.textContent || '').trim();
        if (txt === 'Search' || txt === 'Tìm kiếm' || txt === 'Refresh' || txt === 'Làm mới') {
            b.click();
            return true;
        }
    }
    return false;
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
    const allFiles = await dbxList();
    // Prune processed Set: chỉ giữ id còn live ở Dropbox root (file đã move sang done/garbage biến mất).
    const liveIds = new Set(allFiles.map(f => f.id));
    const processed = getProcessedSet();
    const pruned = new Set([...processed].filter(id => liveIds.has(id)));
    if (pruned.size !== processed.size) saveProcessedSet(pruned);

    // Prune GoFile backed-up Set — bỏ id không còn ở Drive (đã bị cleanupOld xóa)
    pruneBackedUpSet(liveIds);
    // Prune OCR fail-retry counter — bỏ id đã hết (Drive xóa file cũ sau 7d)
    pruneOcrFailRetry(liveIds);

    const newFiles = allFiles.filter(f => !pruned.has(f.id));

    async function processNewFile(meta) {
        try {
            const r = await dbxGet(meta.id);
            const blob = b64ToBlob(r.dataB64, r.mimeType);
            let filename = r.name || meta.name || 'proof.jpg';
            let ocr = null, error = null;
            try { ocr = await ocrExtract(blob, r.mimeType); }
            catch (e) { error = e.message; console.warn('[SPX] NSS ocrExtract fail:', e.message); }

            // Rename TRƯỚC khi upload — backend SPX nhận file với semantic name.
            // Skip nếu OCR transient fail (sẽ retry ở poll cycle sau, tránh OCR_FAIL_ sai).
            if (!error || !isTransientOcrError(error)) {
                const desiredName = computeRenameTarget(filename, ocr, meta.id);
                const gotSemantic = desiredName && SEMANTIC_NAME_RE.test(desiredName);
                if (gotSemantic) clearOcrFailRetry(meta.id);
                else bumpOcrFailRetry(meta.id);  // bao gồm error + partial OCR
                if (desiredName) {
                    try {
                        await dbxRename(meta.id, desiredName);
                        filename = desiredName;
                    } catch (e) {
                        toast(`⚠ rename failed: ${e.message}`, '#d97706', 4000);
                    }
                }
            } else {
                console.warn('[SPX] OCR transient, skipping rename', meta.id, error);
            }

            // GoFile backup defer đến SAU match phase — chỉ backup file match.status==='ok'.
            // File fail match (warn/no_match/error) sẽ bị quarantine → không cần backup junk.

            return {
                fileId: meta.id,
                blob, filename,
                ocr, error,
                previewUrl: URL.createObjectURL(blob)
            };
        } catch (e) {
            return { fileId: meta.id, error: 'drive: ' + e.message };
        }
    }

    // Parallel: dbxGet + OCR cho mỗi file độc lập → tiết kiệm latency tuần tự.
    // Dropbox API stateless nên concurrent calls an toàn. Bound the
    // wave to CLEANUP_PARALLELISM (3) to cap concurrent Dropbox calls — without
    // this, a sudden burst of N newFiles fires N concurrent requests
    // and OCR.space requests, risking 429s + quota burn.
    const items = [];
    for (let i = 0; i < newFiles.length; i += CLEANUP_PARALLELISM) {
        const wave = newFiles.slice(i, i + CLEANUP_PARALLELISM);
        items.push(...await Promise.all(wave.map(processNewFile)));
    }

    // Cleanup pass: 3 nhánh để tránh đốt OCR quota lãng phí.
    //   (a) name đã semantic → CHỈ backup, không OCR lại.
    //   (b) OCR_FAIL_ trong budget (< OCR_FAIL_MAX_RETRY) → retry OCR.
    //   (c) OCR_FAIL_ hết budget → chỉ backup, bỏ OCR (file ảnh mờ/không phải bill).
    //   (d) tên chưa semantic và chưa OCR_FAIL_ → OCR + rename.
    const failRetry = getOcrFailRetry();
    const backedUp  = getBackedUpSet();
    const needsAttention = (f) => {
        const nm = f.name || '';
        const isSemantic = SEMANTIC_NAME_RE.test(nm);
        const isOcrFail  = nm.startsWith('OCR_FAIL_');
        const needBackup = !backedUp.has(f.id);
        const overBudget = isOcrFail && (failRetry[f.id] || 0) >= OCR_FAIL_MAX_RETRY;
        // Đã có semantic name VÀ đã backup → không cần làm gì.
        if (isSemantic && !needBackup) return false;
        // Hết budget VÀ đã backup → cũng bỏ.
        if (overBudget && !needBackup) return false;
        return true;
    };
    const staleFiles = allFiles.filter(f => pruned.has(f.id) && needsAttention(f));

    async function cleanupOne(meta) {
        try {
            const r = await dbxGet(meta.id);
            let currentName = r.name || meta.name || 'proof.jpg';
            const blob = b64ToBlob(r.dataB64, r.mimeType);

            const isSemantic = SEMANTIC_NAME_RE.test(currentName);
            const isOcrFail  = currentName.startsWith('OCR_FAIL_');
            const overBudget = isOcrFail && (failRetry[meta.id] || 0) >= OCR_FAIL_MAX_RETRY;

            // Nhánh (a) semantic name còn trong root → backup GoFile rồi move sang done/.
            // File đã xử lý thành công từ cycle trước nhưng chưa move (vd upload OK, moveDone lỗi).
            if (isSemantic) {
                fireGofileBackup(meta.id, blob, currentName);
                fireDbxMoveDone(meta.id);
                return;
            }
            // Nhánh (c) OCR_FAIL_ vượt retry budget → quarantine vào garbage, KHÔNG backup.
            // Sau move file biến mất khỏi dbxList → script ngừng track hoàn toàn.
            if (overBudget) {
                fireDbxMoveGarbage(meta.id);
                return;
            }

            // Nhánh (b) hoặc (d): OCR rồi quyết định rename.
            let ocr = null, ocrErr = null;
            try { ocr = await ocrExtract(blob, r.mimeType); }
            catch (e) {
                ocrErr = e.message;
                console.warn('[SPX] cleanup OCR fail', meta.id, e.message);
            }
            // Transient error → giữ tên cũ, retry cycle sau (không tính vào budget,
            // không rename thành OCR_FAIL_).
            if (ocrErr && isTransientOcrError(ocrErr)) {
                toast(`⚠ OCR transient (sẽ retry): ${ocrErr.slice(0, 80)}`, '#d97706', 5000);
                fireGofileBackup(meta.id, blob, currentName);
                return;
            }
            // Bookkeeping retry counter:
            //   - OCR thành công ra semantic name → clear counter (file fix được, có thể re-OCR sau này)
            //   - OCR error (non-transient) HOẶC OCR thành công nhưng vẫn không ra semantic
            //     (ảnh không phải bill, partial extract) → bump counter
            const target = computeRenameTarget(currentName, ocr, meta.id);
            const gotSemantic = target && SEMANTIC_NAME_RE.test(target);
            if (gotSemantic) {
                clearOcrFailRetry(meta.id);
            } else {
                const n = bumpOcrFailRetry(meta.id);
                if (n >= OCR_FAIL_MAX_RETRY) {
                    console.warn('[SPX] OCR retry budget exhausted', meta.id, 'after', n, 'attempts');
                }
            }
            if (target) {
                try {
                    await dbxRename(meta.id, target);
                    currentName = target;
                } catch (e) { toast(`⚠ cleanup rename: ${e.message}`, '#d97706', 4000); }
            }
            fireGofileBackup(meta.id, blob, currentName);
        } catch (e) {
            console.warn('[SPX] cleanup error', meta.id, e.message);
        }
    }

    // Chạy theo wave CLEANUP_PARALLELISM = 3 file/wave để cap concurrent Dropbox calls.
    const batch = staleFiles.slice(0, RENAME_BUDGET_PER_POLL);
    for (let i = 0; i < batch.length; i += CLEANUP_PARALLELISM) {
        await Promise.allSettled(batch.slice(i, i + CLEANUP_PARALLELISM).map(cleanupOne));
    }
    // Match
    let rows = [];
    let spxListOk = false;
    try { rows = await spxList(); spxListOk = true; }
    catch (e) { toast('SPX List API lỗi — sẽ retry poll sau: ' + e.message, '#dc2626', 5000); }
    const byDate = new Map();
    for (const row of rows) byDate.set(row.account_date, row);
    for (const it of items) {
        if (it.error) { it.match = { status: 'error', reason: it.error }; continue; }
        if (!it.ocr) { it.match = { status: 'error', reason: 'no OCR data' }; continue; }
        if (!isValidIso(it.ocr.note_date_iso)) {
            it.match = { status: 'error', reason: `bad date format: "${it.ocr.note_date_iso}"` };
            continue;
        }
        const unix = vnMidnightUnix(it.ocr.note_date_iso);
        const row = byDate.get(unix);
        if (!row) {
            if (it.ocr.bank && it.ocr.amount > 0) {
                // Bank đã nhận diện (MSB/VCB) + OCR hợp lệ → synthesize row từ OCR.
                // Covers: spxList fail, timing issue, row chưa có trong API.
                // spxAttachProof sẽ bị skip cho synthetic rows (không có account_id thật).
                it.match = { status: 'ok', row: {
                    pending_amount: it.ocr.amount,
                    account_date: unix,
                    proof_list: [],
                    synthetic: true
                }};
            } else if (!spxListOk) {
                // API fail + bank không nhận diện → giữ lại cho retry, KHÔNG garbage.
                it.match = { status: 'error', reason: 'spx_list_failed' };
            } else {
                it.match = { status: 'no_match', reason: `no row for ${it.ocr.note_date_iso}` };
            }
            continue;
        }
        if (row.pending_amount !== it.ocr.amount) {
            it.match = { status: 'warn', row,
                reason: `amount ${it.ocr.amount.toLocaleString('vi-VN')}đ vs row ${row.pending_amount.toLocaleString('vi-VN')}đ` };
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
            info.style.cssText = 'flex:1;font-size:12px;line-height:1.4';
            const color = COLORS[it.match.status];
            // OCR snapshot — luôn hiển thị để debug khi mismatch
            const escHtml = s => String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
            let ocrLine = '';
            if (it.ocr) {
                const gAmt = (it.ocr.amount || 0).toLocaleString('vi-VN');
                const gDate = escHtml(it.ocr.note_date_iso || '?');
                const gNote = escHtml((it.ocr.note || '').slice(0, 40));
                ocrLine = `<div style="color:#6b7280;font-size:11px">OCR: ${gDate} · ${gAmt}đ${gNote ? ' · "' + gNote + '"' : ''}</div>`;
            }
            let matchLine = '';
            if (it.match.status === 'ok' || it.match.status === 'warn') {
                const dateIso = new Date(it.match.row.account_date * 1000).toISOString().slice(0, 10);
                matchLine = `<div>→ Row ${dateIso} · ${it.match.row.pending_amount.toLocaleString('vi-VN')}đ</div>`
                    + `<div style="color:${color};font-size:11px">`
                    + (it.match.status === 'ok' ? '✓ OK' : '⚠ ' + it.match.reason) + '</div>';
            } else {
                matchLine = `<div style="color:${color};font-size:11px">${it.match.status === 'no_match' ? '✖ ' : '⚠ '}${it.match.reason || 'error'}</div>`;
            }
            info.innerHTML = ocrLine + matchLine;
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
    // Note: rename trên Drive đã chạy ở processPoll TRƯỚC khi vào đây — it.filename
    // đã là semantic name (hoặc OCR_FAIL_*). spxUploadImage forward filename đó
    // cho SPX backend.
    let ok = 0, fail = 0;
    for (const it of selected) {
        try {
            const up = await spxUploadImage(it.blob, it.filename);
            if (!it.match.row.synthetic) {
                // Attach proof vào NSS row thật — synthetic rows không có account_id.
                await spxAttachProof(it.match.row, up);
                it.match.row.proof_list = [...(it.match.row.proof_list || []),
                    { proof_url: up.url, proof_upload_time: up.time }];
            }
            it.uploaded = true;
            ok++;
            // Move file sang done/ — file biến mất khỏi root, không bị poll lại.
            if (it.fileId) fireDbxMoveDone(it.fileId);
        } catch (e) {
            it.uploaded = false;
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
        background: '#fff', borderRadius: '12px',
        width: 'min(1400px, 96vw)',
        maxHeight: '94vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 12px 48px rgba(0,0,0,0.4)'
    });
    // 3 sections in fluid grid: Auto-Upload | KiotVit | GoFile.
    // Header static, body scrolls, footer sticky → save/test/reset luôn nhìn thấy.
    const labelCss = 'display:block;font-size:12px;color:#555;margin-bottom:4px';
    const inputCss = 'width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-bottom:12px;font-family:monospace;font-size:12px;box-sizing:border-box';
    const sectionTitleCss = 'font-size:11px;color:#888;margin:0 0 10px;letter-spacing:.05em;text-transform:uppercase;font-weight:600';
    const sectionCss = 'border:1px solid #e5e7eb;border-radius:10px;padding:16px;background:#fafafa;display:flex;flex-direction:column';
    card.innerHTML = `
        <div style="padding:18px 24px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;flex:none">
            <h3 style="margin:0;font-size:16px">Settings · Refund NSS</h3>
            <button id="s-close-x" aria-label="Close" style="background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:#666;padding:0 6px">×</button>
        </div>
        <div style="padding:20px 24px">
            <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start">
                <div style="${sectionCss}">
                    <div style="${sectionTitleCss}">Auto-Upload Proof · Dropbox</div>
                    <label style="${labelCss}">Refresh token (lấy từ OAuth flow)</label>
                    <input id="s-dbx-refresh" style="${inputCss}" placeholder="ABSl..." />
                    <label style="${labelCss}">App key (client_id — Dropbox App Console)</label>
                    <input id="s-dbx-ci" style="${inputCss}" placeholder="abcdef1234567890" />
                    <label style="${labelCss}">App secret (client_secret — Dropbox App Console)</label>
                    <input id="s-dbx-cs" style="${inputCss}" placeholder="xyz..." />
                    <button id="s-dbx-reauth" style="margin-top:6px;padding:6px 12px;background:#0061ff;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;width:100%">Re-authorize Dropbox (lấy token mới đủ scope)</button>
                    <div id="s-dbx-reauth-wrap" style="display:none;margin-top:6px">
                        <label style="${labelCss}">Dán auth code từ URL sau khi authorize:</label>
                        <input id="s-dbx-code" style="${inputCss}" placeholder="paste code ở đây..." />
                        <button id="s-dbx-exchange" style="margin-top:4px;padding:5px 10px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;width:100%">Exchange → lưu refresh token</button>
                    </div>
                    <label style="${labelCss}">Folder path (vd /NSS Proofs)</label>
                    <input id="s-dbx-folder" style="${inputCss}" placeholder="/NSS Proofs" />
                    <label style="display:flex;align-items:flex-start;gap:8px;margin-top:auto;padding-top:6px;font-size:13px;color:#333;cursor:pointer;user-select:none;line-height:1.45">
                        <input id="s-dbx-auto" type="checkbox" style="width:16px;height:16px;cursor:pointer;margin-top:2px;flex:none" />
                        <span>Auto upload ngầm (poll 15-60s adaptive, không hiện modal — chỉ upload ảnh OCR khớp ✓ OK + tự lập phiếu chi)</span>
                    </label>
                </div>
                <div style="${sectionCss}">
                    <div style="${sectionTitleCss}">KiotVit Sổ Quỹ (Tailscale)</div>
                    <label style="${labelCss}">KiotVit base URL</label>
                    <input id="s-kv-url" style="${inputCss}" placeholder="http://pavi:9009" />
                    <label style="${labelCss}">Nguồn tiền — VCB Digibank (auto khi OCR ra "VCB Digibank")</label>
                    <input id="s-kv-bank-vcb" style="${inputCss}" placeholder="Ka Bê" />
                    <label style="${labelCss}">Nguồn tiền — MSB (auto khi OCR ra "MSB" + người chuyển Trần Hữu Trung)</label>
                    <input id="s-kv-bank-msb" style="${inputCss}" placeholder="Kỹ Sư" />
                    <label style="${labelCss}">Nguồn tiền — fallback (khi OCR không nhận diện được ngân hàng)</label>
                    <input id="s-kv-bank" style="${inputCss}" placeholder="Ka Bê" />
                    <label style="${labelCss}">CF cutoff date (ISO YYYY-MM-DD) — row trước ngày này không hiện pen</label>
                    <input id="s-kv-cutoff" style="${inputCss}" placeholder="${CF_CUTOFF_DEFAULT}" />
                </div>
                <div style="${sectionCss}">
                    <div style="${sectionTitleCss}">OCR + GoFile Archive</div>
                    <label style="${labelCss}">OCR.space API key (đăng ký free tại ocr.space/ocrapi)</label>
                    <input id="s-ocr" style="${inputCss}" placeholder="K8XXXXXXXX..." />
                    <label style="${labelCss}">OCR language (eng/vie/...)</label>
                    <select id="s-ocr-lang" style="${inputCss}">
                        <option value="eng">eng — English (note format)</option>
                        <option value="vie">vie — Vietnamese (bank labels)</option>
                        <option value="auto">auto — OCR.space tự detect</option>
                    </select>
                    <label style="${labelCss}">GoFile API token (Account Settings → API)</label>
                    <input id="s-gf-token" style="${inputCss}" placeholder="yVPB..." />
                    <label style="${labelCss}">GoFile account ID (UUID — Account Settings → Profile)</label>
                    <input id="s-gf-account" style="${inputCss}" placeholder="f49d50b1-..." />
                    <label style="${labelCss}">GoFile folder ID (từ URL gofile.io/d/&lt;id&gt;)</label>
                    <input id="s-gf-folder" style="${inputCss}" placeholder="b6f41638-..." />
                </div>
            </div>
        </div>
        <div style="flex:none;border-top:1px solid #e5e7eb;padding:14px 24px;background:#fff">
            <div id="s-status" style="font-size:12px;color:#666;margin-bottom:10px;min-height:18px;line-height:1.5"></div>
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button id="s-reset" style="padding:8px 12px;border:1px solid #d1d5db;background:#fff;border-radius:6px;cursor:pointer;font-size:12px">Reset processed</button>
                    <button id="s-reset-cf" style="padding:8px 12px;border:1px solid #d1d5db;background:#fff;border-radius:6px;cursor:pointer;font-size:12px">Reset CF recorded</button>
                    <button id="s-reset-gf" style="padding:8px 12px;border:1px solid #d1d5db;background:#fff;border-radius:6px;cursor:pointer;font-size:12px">Reset GoFile backed-up</button>
                    <button id="s-reset-ocr-pause" style="padding:8px 12px;border:1px solid #d1d5db;background:#fff;border-radius:6px;cursor:pointer;font-size:12px">Reset OCR pause</button>
                </div>
                <div style="display:flex;gap:8px">
                    <button id="s-test" style="padding:8px 16px;border:1px solid #1677ff;color:#1677ff;background:#fff;border-radius:6px;cursor:pointer">Test</button>
                    <button id="s-cancel" style="padding:8px 16px;border:1px solid #d1d5db;background:#fff;border-radius:6px;cursor:pointer">Cancel</button>
                    <button id="s-save" style="padding:8px 18px;border:none;background:#1677ff;color:#fff;border-radius:6px;cursor:pointer;font-weight:500">Save</button>
                </div>
            </div>
        </div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    card.querySelector('#s-dbx-refresh').value = GM_getValue(SK.dbxRefresh, '');
    card.querySelector('#s-dbx-ci').value      = GM_getValue(SK.dbxClientId, '');
    card.querySelector('#s-dbx-cs').value      = GM_getValue(SK.dbxClientSecret, '');
    card.querySelector('#s-dbx-folder').value  = GM_getValue(SK.dbxFolder, '') || '/NSS Proofs';
    card.querySelector('#s-dbx-auto').checked  = GM_getValue(SK.dbxAuto, false);
    card.querySelector('#s-ocr').value     = cfg('ocrKey');
    card.querySelector('#s-ocr-lang').value = GM_getValue(SK.ocrLang, '') || OCR_LANG_DEFAULT;
    card.querySelector('#s-kv-url').value  = cfg('kvUrl');
    card.querySelector('#s-kv-bank').value = cfg('kvBank') || 'Ka Bê';
    card.querySelector('#s-kv-bank-vcb').value = GM_getValue(SK.kvBankVcb, '') || KV_BANK_VCB_DEFAULT;
    card.querySelector('#s-kv-bank-msb').value = GM_getValue(SK.kvBankMsb, '') || KV_BANK_MSB_DEFAULT;
    card.querySelector('#s-kv-cutoff').value = GM_getValue(SK.kvCutoff, CF_CUTOFF_DEFAULT);
    card.querySelector('#s-gf-token').value = cfg('gfToken');
    card.querySelector('#s-gf-account').value = cfg('gfAccountId');
    card.querySelector('#s-gf-folder').value = cfg('gfFolderId');
    const status = card.querySelector('#s-status');
    card.querySelector('#s-cancel').onclick = () => overlay.remove();
    card.querySelector('#s-close-x').onclick = () => overlay.remove();
    card.querySelector('#s-save').onclick = () => {
        const autoOn = card.querySelector('#s-dbx-auto').checked;
        const kvUrlVal = card.querySelector('#s-kv-url').value.trim().replace(/\/+$/, '');
        // Cảnh báo: bật auto nhưng chưa cài KiotVit URL → CF sẽ fail tự động sau mỗi upload
        if (autoOn && !kvUrlVal) {
            const ok = confirm('Auto upload đang BẬT nhưng KiotVit URL trống → phần auto-CF sẽ fail mỗi lần.\n\nVẫn save?');
            if (!ok) return;
        }
        const cutoffVal = card.querySelector('#s-kv-cutoff').value.trim();
        if (cutoffVal && !ISO_RE.test(cutoffVal)) {
            status.textContent = '✗ CF cutoff phải dạng YYYY-MM-DD';
            return;
        }
        GM_setValue(SK.dbxRefresh,      card.querySelector('#s-dbx-refresh').value.trim());
        GM_setValue(SK.dbxClientId,     card.querySelector('#s-dbx-ci').value.trim());
        GM_setValue(SK.dbxClientSecret, card.querySelector('#s-dbx-cs').value.trim());
        GM_setValue(SK.dbxFolder,       card.querySelector('#s-dbx-folder').value.trim() || '/NSS Proofs');
        GM_setValue(SK.dbxAuto,         autoOn);
        GM_setValue(SK.dbxAccess, ''); GM_setValue(SK.dbxExpiry, 0);  // clear cached token khi config đổi
        GM_setValue(SK.ocrKey,  card.querySelector('#s-ocr').value.trim());
        GM_setValue(SK.ocrLang, card.querySelector('#s-ocr-lang').value);
        const oldUrl = cfg('kvUrl').replace(/\/+$/, '');
        GM_setValue(SK.kvUrl,   kvUrlVal);
        GM_setValue(SK.kvBank,  card.querySelector('#s-kv-bank').value.trim() || 'Ka Bê');
        GM_setValue(SK.kvBankVcb, card.querySelector('#s-kv-bank-vcb').value.trim() || KV_BANK_VCB_DEFAULT);
        GM_setValue(SK.kvBankMsb, card.querySelector('#s-kv-bank-msb').value.trim() || KV_BANK_MSB_DEFAULT);
        GM_setValue(SK.kvCutoff, cutoffVal || CF_CUTOFF_DEFAULT);
        GM_setValue(SK.gfToken, card.querySelector('#s-gf-token').value.trim());
        GM_setValue(SK.gfAccountId, card.querySelector('#s-gf-account').value.trim());
        GM_setValue(SK.gfFolderId, card.querySelector('#s-gf-folder').value.trim());
        // Đổi URL → invalidate SPX cat cache (DB khác → id khác).
        if (kvUrlVal !== oldUrl) GM_setValue(SK.kvSpx, '');
        kvCategoryWarned = false;  // re-warn nếu cần với config mới
        overlay.remove();
        toast('Saved.', '#16a34a');
        refreshTriggerBadge();
        scanRows();  // re-eval CF cutoff cho rows hiện hữu
    };
    card.querySelector('#s-reset').onclick = () => {
        GM_setValue(SK.dbxDone, '[]');
        status.textContent = 'Dropbox processed list cleared → next poll re-fetches all files.';
    };
    card.querySelector('#s-reset-cf').onclick = () => {
        const ok = confirm('Reset CF recorded set?\n\nTất cả nút CF (✓ xanh / ? vàng / ✕ đỏ) sẽ về pen đỏ idle. Phiếu chi đã có trong KiotVit KHÔNG bị xóa — chỉ trạng thái client thôi.\n\nDùng khi cần re-push 1 batch (sau khi xóa phiếu trong KiotVit).');
        if (!ok) return;
        GM_setValue(SK.kvDone, '[]');
        GM_setValue(SK.kvPending, '{}');
        status.textContent = 'CF recorded + pending set cleared → mọi nút CF về pen idle sau khi list re-render.';
        scanRows();
    };
    card.querySelector('#s-reset-gf').onclick = () => {
        const ok = confirm('Reset GoFile backed-up set?\n\nNext poll sẽ re-upload TẤT CẢ files trong Drive folder lên GoFile (kể cả files đã backup → tạo duplicate).\n\nDùng khi muốn force re-upload.');
        if (!ok) return;
        GM_setValue(SK.gfBackedUp, '[]');
        status.textContent = 'GoFile backed-up set cleared → poll sau sẽ re-upload mọi file.';
    };
    card.querySelector('#s-dbx-reauth').onclick = () => {
        const ci = card.querySelector('#s-dbx-ci').value.trim() || cfg('dbxClientId');
        if (!ci) { status.textContent = '⚠ Nhập App key (client_id) trước.'; return; }
        const scopes = 'files.metadata.read files.metadata.write files.content.read files.content.write account_info.read';
        const redirectUri = 'https://localhost/';
        const url = `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(ci)}&response_type=code&token_access_type=offline&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}`;
        window.open(url, '_blank');
        card.querySelector('#s-dbx-reauth-wrap').style.display = '';
        status.textContent = 'Authorize xong → copy code từ URL bar (sau ?code=) → dán vào ô bên trên.';
    };
    card.querySelector('#s-dbx-exchange').onclick = async () => {
        const code = card.querySelector('#s-dbx-code').value.trim();
        const ci = card.querySelector('#s-dbx-ci').value.trim() || cfg('dbxClientId');
        const cs = card.querySelector('#s-dbx-cs').value.trim() || cfg('dbxClientSecret');
        const redirectUri = 'https://localhost/';
        if (!code || !ci || !cs) { status.textContent = '⚠ Cần code + client_id + client_secret.'; return; }
        status.textContent = 'Đang exchange code...';
        try {
            const r = await gmReq({
                method: 'POST', url: 'https://api.dropbox.com/oauth2/token',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: `code=${encodeURIComponent(code)}&grant_type=authorization_code`
                    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
                    + `&client_id=${encodeURIComponent(ci)}&client_secret=${encodeURIComponent(cs)}`
            });
            const j = JSON.parse(r.responseText);
            if (!j.refresh_token) throw new Error(j.error_description || JSON.stringify(j));
            GM_setValue(SK.dbxRefresh, j.refresh_token);
            GM_setValue(SK.dbxAccess, j.access_token || '');
            GM_setValue(SK.dbxExpiry, j.expires_in ? Date.now() + j.expires_in * 1000 : 0);
            card.querySelector('#s-dbx-refresh').value = j.refresh_token;
            card.querySelector('#s-dbx-reauth-wrap').style.display = 'none';
            status.textContent = '✓ Refresh token mới đã lưu. Nhớ Save settings.';
        } catch (e) { status.textContent = '✗ Exchange lỗi: ' + e.message; }
    };
    card.querySelector('#s-reset-ocr-pause').onclick = () => {
        GM_setValue(SK.ocrPause, 0);
        status.textContent = 'OCR pause cleared → poll tiếp theo sẽ retry OCR ngay.';
        refreshTriggerBadge();
    };
    card.querySelector('#s-test').onclick = async () => {
        status.textContent = 'Testing...';
        const dbxRt  = card.querySelector('#s-dbx-refresh').value.trim();
        const dbxCi  = card.querySelector('#s-dbx-ci').value.trim();
        const dbxCs  = card.querySelector('#s-dbx-cs').value.trim();
        const dbxFol = card.querySelector('#s-dbx-folder').value.trim() || '/NSS Proofs';
        const ocrKey = card.querySelector('#s-ocr').value.trim();
        const kvUrl = card.querySelector('#s-kv-url').value.trim().replace(/\/+$/, '');
        const gfTok = card.querySelector('#s-gf-token').value.trim();
        const gfAcc = card.querySelector('#s-gf-account').value.trim();
        const gfFid = card.querySelector('#s-gf-folder').value.trim();
        const results = [];
        if (dbxRt && dbxCi && dbxCs) {
            try {
                const tr = await gmReq({
                    method: 'POST',
                    url: 'https://api.dropbox.com/oauth2/token',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    data: `grant_type=refresh_token&refresh_token=${encodeURIComponent(dbxRt)}`
                        + `&client_id=${encodeURIComponent(dbxCi)}&client_secret=${encodeURIComponent(dbxCs)}`
                });
                const tj = JSON.parse(tr.responseText);
                if (!tj.access_token) throw new Error(tj.error_description || tj.error || 'no token');
                const lr = await gmReq({
                    method: 'POST',
                    url: 'https://api.dropboxapi.com/2/files/list_folder',
                    headers: { 'Authorization': `Bearer ${tj.access_token}`, 'Content-Type': 'application/json' },
                    data: JSON.stringify({ path: dbxFol, recursive: false })
                });
                const lj = JSON.parse(lr.responseText);
                if (lj.error_summary) throw new Error(lj.error_summary);
                const imgCount = (lj.entries || []).filter(e => /\.(jpe?g|png|gif|webp|heic)$/i.test(e.name)).length;
                results.push(`✓ Dropbox: token OK · "${dbxFol}" · ${imgCount} ảnh`);
            } catch (e) { results.push('✗ Dropbox: ' + e.message); }
        } else if (dbxRt || dbxCi || dbxCs) {
            results.push('⚠ Dropbox: cần cả refresh_token + client_id + client_secret để test');
        }
        if (ocrKey) {
            try {
                // Test với 1x1 transparent PNG để verify key recognized (response sẽ có ParsedResults rỗng)
                const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAAlwSFlzAAALEwAACxMBAJqcGAAAAAxJREFUCNdjYGBgAAAABAABKuTtNgAAAABJRU5ErkJggg==';
                const fd = new FormData();
                fd.append('apikey', ocrKey);
                fd.append('base64Image', 'data:image/png;base64,' + tinyPng);
                fd.append('language', 'eng');
                const r = await gmReq({ method: 'POST', url: OCR_API_URL, data: fd });
                const j = JSON.parse(r.responseText);
                if (j.IsErroredOnProcessing) {
                    const msg = Array.isArray(j.ErrorMessage) ? j.ErrorMessage.join('; ') : j.ErrorMessage;
                    if (/api ?key|unauth|invalid/i.test(msg || '')) results.push('✗ OCR.space: invalid key');
                    else results.push(`⚠ OCR.space key OK, response: ${msg || 'error'}`);
                } else {
                    results.push('✓ OCR.space: key recognized');
                }
            } catch (e) { results.push('✗ OCR.space: ' + e.message); }
        }
        if (kvUrl) {
            try {
                const r = await kvAuthedReq(kvUrl, { method: 'GET', url: `${kvUrl}/api/cash-categories` });
                const list = JSON.parse(r.responseText);
                if (!Array.isArray(list)) throw new Error('format lạ');
                const spx = list.find(c => c.tag === 'SPX')
                          || list.find(c => /spx/i.test(c.tag || '') || /spx/i.test(c.name || ''));
                results.push(spx
                    ? `✓ KiotVit: ${list.length} danh mục, SPX="${spx.name}" (${spx.tag})`
                    : `⚠ KiotVit OK nhưng không tìm thấy danh mục SPX`);
            } catch (e) { results.push('✗ KiotVit: ' + e.message); }
        }
        if (gfTok && gfAcc) {
            try {
                // Test bằng GET account info — verify token alive + accountId valid
                const r = await gmReq({
                    method: 'GET',
                    url: `https://api.gofile.io/accounts/${encodeURIComponent(gfAcc)}`,
                    headers: { 'Authorization': `Bearer ${gfTok}` }
                });
                const j = JSON.parse(r.responseText);
                results.push(j.status === 'ok'
                    ? `✓ GoFile: token OK · email=${j.data?.email || '?'} · tier=${j.data?.tier || '?'}`
                    : `✗ GoFile: ${j.error || j.status}`);
            } catch (e) { results.push('✗ GoFile: ' + e.message); }
        } else if (gfTok || gfAcc) {
            results.push('⚠ GoFile: cần cả token + accountId để test');
        }
        if (gfTok && gfFid) {
            const setSize = getBackedUpSet().size;
            results.push(`GoFile backed-up set: ${setSize} file(s)`);
        }
        status.innerHTML = results.join('<br>') || '(điền config rồi bấm Test)';
    };
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ─── INLINE TRIGGER (next to Export) ─────────────────────────
let triggerWrap = null;
let triggerBtn  = null;
let actionsEl   = null;
let pendingCount = 0;
let pollTimer = null;
let processing = false;

function findExportWrap() {
    const btns = document.querySelectorAll('.ssc-button');
    for (const b of btns) {
        if (b.textContent.trim().startsWith('Export')) {
            return b.closest('.ssc-dropdown') || b.parentElement;
        }
    }
    return null;
}

function btnStyle(bg) {
    return {
        padding: '6px 10px', border: 'none', background: bg, color: '#fff',
        borderRadius: '6px', cursor: 'pointer', fontSize: '13px'
    };
}

function ensureTrigger() {
    if (!onTarget()) return;
    if (triggerWrap && document.body.contains(triggerWrap)) return;
    const exportWrap = findExportWrap();
    if (!exportWrap) return; // not yet rendered

    triggerWrap = document.createElement('span');
    triggerWrap.id = 'spxqr-trigger-wrap';
    Object.assign(triggerWrap.style, {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        marginLeft: '8px', verticalAlign: 'middle',
        fontFamily: 'system-ui,sans-serif'
    });

    triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.id = 'spxqr-trigger';
    Object.assign(triggerBtn.style, {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '6px 12px', background: '#fff', color: '#333',
        border: '1px solid #d9d9d9', borderRadius: '4px',
        cursor: 'pointer', fontSize: '14px', lineHeight: '1.5'
    });
    triggerBtn.innerHTML = `<span class="spxqr-auto-dot" style="display:none;width:8px;height:8px;border-radius:50%;background:#16a34a;box-shadow:0 0 0 2px #fff,0 0 6px #16a34a"></span>`
        + `📥 <span class="spxqr-tlabel">Proofs</span>`
        + `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>`;
    triggerBtn.onclick = e => { e.stopPropagation(); toggleActions(); };

    actionsEl = document.createElement('span');
    actionsEl.id = 'spxqr-actions';
    Object.assign(actionsEl.style, {
        display: 'none', gap: '6px', alignItems: 'center'
    });

    const gear = document.createElement('button');
    gear.textContent = '⚙';
    gear.dataset.spxTip = 'Settings';
    Object.assign(gear.style, btnStyle('#6b7280'));
    gear.onclick = () => { closeActions(); showSettingsModal(); };

    const checkBtn = document.createElement('button');
    checkBtn.id = 'spxqr-check';
    Object.assign(checkBtn.style, btnStyle('#1677ff'));
    checkBtn.onclick = () => { closeActions(); runProcess(false); };

    const procBtn = document.createElement('button');
    procBtn.id = 'spxqr-proc';
    procBtn.textContent = '📤 Process';
    Object.assign(procBtn.style, btnStyle('#16a34a'));
    procBtn.onclick = () => { closeActions(); runProcess(true); };

    actionsEl.append(gear, checkBtn, procBtn);

    // GoFile archive shortcut — always visible kế bên Proofs button
    const gfBtn = document.createElement('button');
    gfBtn.type = 'button';
    gfBtn.id = 'spxqr-gf';
    gfBtn.innerHTML = '🗄️ ScreenShot Archive';
    Object.assign(gfBtn.style, btnStyle('#f97316'));
    gfBtn.style.marginLeft = '4px';
    gfBtn.onclick = e => {
        e.stopPropagation();
        const folderId = cfg('gfFolderId');
        if (!folderId) {
            toast('GoFile folder ID chưa cấu hình (⚙ Settings)', '#d97706', 4000);
            return;
        }
        window.open(`https://gofile.io/d/${folderId}`, '_blank', 'noopener,noreferrer');
    };

    triggerWrap.append(triggerBtn, gfBtn, actionsEl);
    exportWrap.parentNode.insertBefore(triggerWrap, exportWrap.nextSibling);
    refreshTriggerBadge();
}

function toggleActions() {
    if (!actionsEl) return;
    actionsEl.style.display = actionsEl.style.display === 'none' ? 'inline-flex' : 'none';
}

function closeActions() {
    if (actionsEl) actionsEl.style.display = 'none';
}

function removeTrigger() {
    triggerWrap?.remove();
    triggerWrap = null; triggerBtn = null; actionsEl = null;
}

function ocrPauseRemainingLabel() {
    const until = +GM_getValue(SK.ocrPause, 0) || 0;
    const ms = until - Date.now();
    if (ms <= 0) return '';
    if (ms < 60 * 1000) return `${Math.ceil(ms / 1000)}s`;
    if (ms < 60 * 60 * 1000) return `${Math.ceil(ms / 60000)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
}

function refreshTriggerBadge() {
    const tlabel = triggerBtn?.querySelector('.spxqr-tlabel');
    if (tlabel) tlabel.textContent = `Proofs${pendingCount ? ` (${pendingCount})` : ''}`;
    const c = document.getElementById('spxqr-check');
    if (c) c.textContent = `📥 Check${pendingCount ? ` (${pendingCount})` : ''}`;
    const dot = triggerBtn?.querySelector('.spxqr-auto-dot');
    if (dot) {
        const auto = GM_getValue(SK.dbxAuto, false);
        const paused = isOcrPaused();
        dot.style.display = auto ? 'inline-block' : 'none';
        dot.style.background = paused ? '#d97706' : '#16a34a';
        dot.style.boxShadow = paused
            ? '0 0 0 2px #fff,0 0 6px #d97706'
            : '0 0 0 2px #fff,0 0 6px #16a34a';
        if (auto) {
            const remain = paused ? ocrPauseRemainingLabel() : '';
            triggerBtn.dataset.spxTip = paused
                ? `Auto upload ON · OCR paused (rate limit) — resume sau ${remain}. Settings → Reset OCR pause để clear.`
                : 'Auto upload ON';
        } else delete triggerBtn.dataset.spxTip;
    }
}

// Click outside → close actions menu
document.addEventListener('click', e => {
    if (!triggerWrap || !actionsEl || actionsEl.style.display === 'none') return;
    if (triggerWrap.contains(e.target)) return;
    closeActions();
});

async function runProcess(openOverlay) {
    if (processing) return;
    processing = true;
    let items;
    try {
        const hasKey = cfg('ocrKey');
        if (!cfg('dbxRefresh') || !cfg('dbxClientId') || !cfg('dbxClientSecret') || !hasKey) {
            toast('Set Drive URL + secret + OCR.space key first (⚙).', '#d97706', 5000);
            return;
        }
        items = await processPoll();
        if (items.length === 0) {
            pendingCount = 0;
            if (openOverlay) toast('No new proofs.', '#6b7280');
            return;
        }
        pendingCount = items.length;
        if (!openOverlay) { toast(`${items.length} new — click 📤 to review.`, '#1677ff'); return; }
        // spx_list_failed items: API lỗi thoáng → không cho vào modal, giữ lại retry poll sau.
        const retryItems   = items.filter(it => it.match.status === 'error' && it.match.reason === 'spx_list_failed');
        const displayItems = items.filter(it => it.match.reason !== 'spx_list_failed');
        const selected = await showProofConfirm(displayItems);
        if (!selected) return;  // user cancelled — keep items processable next call

        pendingCount = 0;
        // Quarantine: item user KHÔNG tick → garbage + mark processed ngay.
        // Upload-failed items KHÔNG mark processed → sẽ reappear ở poll sau để retry.
        const selectedIds = new Set(selected.map(it => it.fileId));
        const rejectedItems = displayItems.filter(it => !selectedIds.has(it.fileId));
        addProcessed(rejectedItems.map(it => it.fileId));  // rejected = user saw + skipped = done
        for (const it of rejectedItems) {
            if (it.fileId) fireDbxMoveGarbage(it.fileId);
        }
        if (selected.length === 0) {
            const issues = displayItems.filter(it => it.match.status !== 'ok').length;
            toast(issues
                ? `${displayItems.length} file → garbage (${issues} không OK + ${displayItems.length - issues} đã skip)`
                : `${displayItems.length} file → garbage (không tick item nào)`, '#6b7280', 4500);
            return;
        }
        // Backup GoFile cho selected items (defer từ processNewFile)
        for (const it of selected) {
            if (it.fileId && it.blob) fireGofileBackup(it.fileId, it.blob, it.filename);
        }
        const { ok, fail } = await doUpload(selected);
        // doUpload đã gọi fireDbxMoveDone cho từng item upload thành công.
        // Chỉ mark processed items upload OK — failed items giữ lại để retry poll sau.
        const uploadedItems = selected.filter(it => it.uploaded);
        addProcessed(uploadedItems.map(it => it.fileId));

        // Auto-CF cho items upload thành công (cùng logic với auto mode)
        const { cfOk, cfUnverified, cfFail, cfSkip } = await processCfBatch(uploadedItems);
        if (cfOk > 0 || cfUnverified > 0 || cfFail > 0) scanRows();  // re-eval pen icons ngay

        const parts = [`Uploaded ${ok}/${selected.length}`];
        if (fail) parts.push(`${fail} failed`);
        if (uploadedItems.length > 0) {
            const cfPart = `CF ${cfOk}/${uploadedItems.length} verified`
                + (cfUnverified ? ` (${cfUnverified} chưa xác minh)` : '')
                + (cfFail ? ` (${cfFail} fail)` : '')
                + (cfSkip ? ` (${cfSkip} skip)` : '');
            parts.push(cfPart);
        }
        toast(parts.join(' · '),
              (fail || cfFail || cfUnverified) ? '#d97706' : '#16a34a', 5500);
        if (ok > 0 && !spxRefreshList()) {
            toast('Upload xong — bấm Search hoặc F5 để xem kết quả', '#1677ff', 4000);
        }
    } catch (e) {
        console.error('[SPX] runProcess error', e);
        toast('Error: ' + e.message, '#dc2626', 6000);
    } finally {
        if (items) revokeItemUrls(items);
        processing = false;
        refreshTriggerBadge();
    }
}

// State cho pause-resume notification — chỉ toast "✓ OCR resumed" sau khi
// thực sự đã trải qua pause window (tránh false positive lúc khởi động).
let ocrWasPaused = false;

function checkOcrPauseNotifications() {
    const paused = isOcrPaused();
    if (paused) {
        ocrWasPaused = true;
        const last = +GM_getValue(SK.ocrPauseRemind, 0) || 0;
        if (Date.now() - last >= OCR_PAUSE_REMIND_MS) {
            const remain = ocrPauseRemainingLabel();
            toast(`⏸ OCR.space rate-limit · còn ${remain}. Auto-resume khi hết, hoặc Settings → Reset OCR pause.`,
                  '#d97706', 6000);
            GM_setValue(SK.ocrPauseRemind, Date.now());
        }
    } else if (ocrWasPaused) {
        // Vừa hết pause → toast resume 1 lần.
        ocrWasPaused = false;
        GM_setValue(SK.ocrPauseRemind, 0);
        toast('✓ OCR resumed', '#16a34a', 4000);
    }
}

async function backgroundPoll() {
    if (!onTarget() || processing) return 0;
    checkOcrPauseNotifications();
    // Sweep các nút "chưa xác minh" (vàng) → verify lại; promote → xanh.
    // Chạy độc lập với Drive config (chỉ cần KiotVit URL).
    try {
        const promoted = await kvReverifyPending();
        if (promoted > 0) scanRows();
    } catch (e) { console.warn('[SPX] kvReverifyPending error', e.message); }
    try {
        const hasKey = cfg('ocrKey');
        if (!cfg('dbxRefresh') || !cfg('dbxClientId') || !cfg('dbxClientSecret') || !hasKey) return 0;
        // Lightweight: list metadata only, count files chưa processed
        const files = await dbxList();
        const liveIds = new Set(files.map(f => f.id));
        const processed = getProcessedSet();
        const pruned = new Set([...processed].filter(id => liveIds.has(id)));
        if (pruned.size !== processed.size) saveProcessedSet(pruned);
        const newCount = files.filter(f => !pruned.has(f.id)).length;
        // Stale work detection: file đã processed nhưng tên stale HOẶC chưa backup GoFile.
        // Loại bỏ OCR_FAIL_ hết retry budget (file không OCR được vĩnh viễn — không trigger
        // runAutoUpload vô tận chỉ vì 1 file ảnh mờ tồn đọng).
        const backedUp  = getBackedUpSet();
        const failRetry = getOcrFailRetry();
        const hasStaleWork = files.some(f => {
            if (!pruned.has(f.id)) return false;
            const nm = f.name || '';
            const isSemantic = SEMANTIC_NAME_RE.test(nm);
            const isOcrFail  = nm.startsWith('OCR_FAIL_');
            const overBudget = isOcrFail && (failRetry[f.id] || 0) >= OCR_FAIL_MAX_RETRY;
            const needRename   = !isSemantic && !isOcrFail;   // chưa OCR lần nào → cần OCR + rename
            const needRetryOcr = isOcrFail && !overBudget;     // còn budget retry
            const needBackup   = !backedUp.has(f.id);          // mọi file đều cần backup, kể cả dead-OCR
            return needRename || needRetryOcr || needBackup;
        });
        pendingCount = newCount;
        refreshTriggerBadge();

        // AUTO MODE: trigger nếu có new files HOẶC stale work (rename/backup chưa xong).
        // Skip nếu OCR.space đang pause.
        if ((newCount > 0 || hasStaleWork) && GM_getValue(SK.dbxAuto, false) && !isOcrPaused()) {
            await runAutoUpload();
        }
        fireDbxCleanupDone();
        return newCount + (hasStaleWork ? 1 : 0);  // count > 0 keeps poll cadence active
    } catch (e) {
        console.warn('[SPX] backgroundPoll error', e.message);
        return 0;
    }
}

async function runAutoUpload() {
    if (processing) return;
    if (isOcrPaused()) return;  // quota cooldown
    processing = true;
    let items;
    try {
        items = await processPoll();
        if (items.length === 0) return;
        // warn: row thật tồn tại nhưng amount khác OCR → dùng row.pending_amount (authoritative), vẫn safe.
        const safeItems  = items.filter(it => it.match.status === 'ok' || it.match.status === 'warn');
        // error (OCR fail, transient rate-limit, bad date) → retry cycle sau, KHÔNG garbage.
        // Chỉ no_match (OCR OK, có date+amount, nhưng không tìm ra row SPX + không nhận bank) → garbage.
        const retryItems = items.filter(it => it.match.status === 'error');
        const junkItems  = items.filter(it => it.match.status === 'no_match');
        const skipped = junkItems.length;
        // Chỉ mark processed safe + junk. retryItems KHÔNG mark → sẽ tự prune rồi retry cycle sau.
        addProcessed([...safeItems, ...junkItems].map(it => it.fileId));
        pendingCount = 0;
        refreshTriggerBadge();
        // Quarantine no_match: OCR OK nhưng không tìm ra row SPX và không nhận bank → không xử lý được.
        for (const it of junkItems) {
            if (it.fileId) fireDbxMoveGarbage(it.fileId);
        }
        // Backup GoFile cho safeItems (defer từ processNewFile — chỉ backup file valid).
        for (const it of safeItems) {
            if (it.fileId && it.blob) fireGofileBackup(it.fileId, it.blob, it.filename);
        }
        if (safeItems.length === 0) {
            const retryCount = retryItems.length;
            const msg = retryCount
                ? `⚠ ${junkItems.length} → garbage, ${retryCount} lỗi OCR sẽ retry cycle sau.`
                : `⚠ ${items.length} file → garbage (no match). Check garbage/ folder.`;
            toast(msg, '#d97706', 6000);
            return;
        }

        const { ok, fail } = await doUpload(safeItems);
        const uploadedItems = safeItems.filter(it => it.uploaded);
        const { cfOk, cfUnverified, cfFail, cfSkip, errors } = await processCfBatch(uploadedItems);
        if (errors.length) console.warn('[SPX] auto CF errors:', errors);
        if (cfOk > 0 || cfUnverified > 0 || cfFail > 0) scanRows();  // re-eval pen icons ngay

        const parts = [`Auto-uploaded ${ok}/${safeItems.length}`];
        if (fail) parts.push(`${fail} failed`);
        if (skipped) parts.push(`${skipped} need review`);
        if (uploadedItems.length > 0) {
            const cfPart = `CF ${cfOk}/${uploadedItems.length} verified`
                + (cfUnverified ? ` (${cfUnverified} chưa xác minh)` : '')
                + (cfFail ? ` (${cfFail} fail)` : '')
                + (cfSkip ? ` (${cfSkip} skip)` : '');
            parts.push(cfPart);
        }
        toast(parts.join(' · '),
              (fail || cfFail || cfUnverified || skipped) ? '#d97706' : '#16a34a', 5500);
        if (ok > 0) spxRefreshList();
    } catch (e) {
        console.error('[SPX] runAutoUpload error', e);
        toast('Auto error: ' + e.message, '#dc2626', 6000);
    } finally {
        if (items) revokeItemUrls(items);
        processing = false;
    }
}

// Adaptive poll: 15s baseline, exp backoff khi folder rỗng (15→30→60s max).
// Reset khi có activity. Tránh spam Drive proxy khi không có gì để làm.
const POLL_BASE_MS = 15000;
const POLL_MAX_MS = 60000;
let consecutiveEmpty = 0;

function nextPollDelay() {
    if (consecutiveEmpty >= 8) return POLL_MAX_MS;
    if (consecutiveEmpty >= 4) return 30000;
    return POLL_BASE_MS;
}

// Poll generation counter. stopPoll() bumps the gen; any in-flight scheduler
// or pending callback checks the gen before re-arming. Without this, a rapid
// nav-away-and-back during a backgroundPoll could leave two scheduler chains
// running (one from the prior cycle, one from startPoll on return).
let pollGen = 0;

function schedulePoll() {
    if (pollTimer || !onTarget() || document.hidden) return;
    const gen = pollGen;
    pollTimer = setTimeout(async () => {
        pollTimer = null;
        if (gen !== pollGen) return; // stopped meanwhile
        const count = await backgroundPoll();
        if (gen !== pollGen) return; // stopped during work
        if (count > 0) consecutiveEmpty = 0;
        else consecutiveEmpty++;
        if (onTarget() && !document.hidden) schedulePoll();
    }, nextPollDelay());
}

function startPoll() {
    if (pollTimer || document.hidden) return;
    consecutiveEmpty = 0;
    const gen = pollGen;
    backgroundPoll().then(count => {
        if (gen !== pollGen) return; // stopPoll fired during initial poll
        consecutiveEmpty = count > 0 ? 0 : 1;
        schedulePoll();
    });
}

function stopPoll() {
    pollGen++; // invalidate any in-flight schedulers
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// Pause polling while tab is hidden — avoid OCR.space + Dropbox API calls for
// proofs the user can't act on. Resume when tab regains visibility.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll();
    else if (onTarget()) startPoll();
});

// ─── ROW INJECTION ───────────────────────────────────────────

/** Dữ liệu row bất kể status — dùng cho CF button (phiếu chi BẮT BUỘC dù row đã chuyển Collected). */
function getRowDataAny(tr) {
    const tds    = tr.querySelectorAll('td');
    const dateEl = tds[1]?.querySelector('.td-content');
    const amtEl  = tds[4]?.querySelector('.td-content');
    if (!dateEl || !amtEl) return null;
    const dateStr = dateEl.textContent.trim();
    const amtStr  = amtEl.textContent.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const amount = parseAmount(amtStr);
    if (!amount) return null;
    return { date: fmtDate(dateStr), iso: dateStr, amount, note: `${NOTE_PFX} - ${fmtDate(dateStr)}` };
}

/** Chỉ rows "Pending Proof Submission" — dùng cho QR button (chuyển khoản chưa làm). */
function getRowData(tr) {
    const statusEl = tr.querySelectorAll('td')[2]?.querySelector('.td-content');
    if (!statusEl?.textContent.includes('Pending Proof Submission')) return null;
    return getRowDataAny(tr);
}

/** Đảm bảo cell amount layout flex để gắn nhiều button bên cạnh. Idempotent. */
function ensureAmountCellFlex(tr) {
    const amtTd    = tr.querySelectorAll('td')[4];
    const innerDiv = amtTd?.querySelector('div');
    if (!innerDiv) return null;
    if (!innerDiv.dataset.spxFlex) {
        Object.assign(innerDiv.style, {
            display: 'flex', alignItems: 'center', gap: '8px'
        });
        const amtSpan = innerDiv.querySelector('.td-content');
        if (amtSpan) amtSpan.style.flexShrink = '0';
        innerDiv.dataset.spxFlex = '1';
    }
    return innerDiv;
}

function injectQRBtn(tr) {
    const rowData = getRowData(tr);
    const existing = tr.querySelector('.spxqr-btn');

    // Status no longer pending → remove stale QR button + dot.
    // (CF button persists — handled separately bởi injectCfBtn.)
    if (!rowData) {
        if (existing) existing.remove();
        tr.querySelector('.spxqr-dot')?.remove();
        delete tr.dataset.qrKey;
        return;
    }

    // Re-inject if row data changed (same <tr>, new record).
    const key = `${rowData.iso}|${rowData.amount}`;
    if (existing && tr.dataset.qrKey === key) return;
    if (existing) existing.remove();
    tr.dataset.qrKey = key;

    const innerDiv = ensureAmountCellFlex(tr);
    if (!innerDiv) return;
    const amtSpan = innerDiv.querySelector('.td-content');

    // Unread dot — symmetric with QR button, removed once user clicks QR.
    if (amtSpan && !getClickedSet().has(key)) {
        const dot = document.createElement('span');
        dot.className = 'spxqr-dot';
        dot.textContent = '•';
        Object.assign(dot.style, {
            color: '#1677ff', fontSize: '22px', lineHeight: '22px',
            width: '8px', textAlign: 'center', flexShrink: '0',
            userSelect: 'none', pointerEvents: 'none'
        });
        innerDiv.insertBefore(dot, amtSpan);
    }

    const btn = document.createElement('button');
    btn.type  = 'button';
    btn.className = 'spxqr-btn';
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
    btn.onclick = e => {
        e.stopPropagation();
        showOverlay(rowData);
        markClicked(key);
        innerDiv.querySelector('.spxqr-dot')?.remove();
    };
    innerDiv.appendChild(btn);
}

// ─── CF (sổ quỹ phiếu chi) BUTTON — TÁCH KHỎI QR ─────────────
// Tồn tại MÃI MÃI miễn row có date+amount, kể cả khi status đổi
// "Pending Proof Submission" → "Collected" (QR mất, CF còn).
// State machine: idle (pen) → confirming (?) → sending (…)
//   → done (✓ xanh)        : đã VERIFY đọc lại được phiếu trong KiotVit
//   → unverified (? vàng)  : POST OK nhưng verify chưa xong → tự verify lại
//   → error (✕ đỏ)         : ghi hỏng / KiotVit xác nhận không có phiếu
// Done = persistent (kv_recorded_v1) — reload trang vẫn ✓.
// Unverified/error = persistent (kv_pending_v1) — giữ id ổn định để retry idempotent.
// CHỐNG TICK XANH LÁO: ✓ xanh CHỈ hiện sau khi GET /api/cash-flow/:id xác nhận.
const PEN_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="display:block">
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
</svg>`;

/** Trạng thái persistent mong muốn của nút CF theo GM storage. */
function cfDesiredState(key) {
    if (getRecordedSet().has(key)) return 'done';
    const e = getPendingEntry(key);
    if (e && e.ver === 'pending') return 'unverified';
    if (e && e.ver === 'failed') return 'error';
    return 'idle';
}

function injectCfBtn(tr) {
    const rowData = getRowDataAny(tr);
    const existing = tr.querySelector('.spxcf-btn');

    // Row hết hợp lệ (vd hidden/spinner row) → remove. Còn data → giữ button.
    if (!rowData) {
        if (existing) existing.remove();
        delete tr.dataset.cfKey;
        return;
    }

    // Row trước cutoff → đã lập manually, không inject (cleanup nếu có sót).
    if (rowData.iso < cfCutoff()) {
        if (existing) existing.remove();
        delete tr.dataset.cfKey;
        return;
    }

    const key = `${rowData.iso}|${rowData.amount}`;
    const desired = cfDesiredState(key);
    // Idempotent skip: same key AND trạng thái persistent của nút khớp GM hiện tại.
    // `cfPersist` chỉ lưu trạng thái BỀN (idle/done/unverified/error) — transient
    // (confirming/sending) đều map về 'idle' nên scanRows giữa lúc gửi KHÔNG clobber.
    if (existing && tr.dataset.cfKey === key && existing.dataset.cfPersist === desired) return;
    if (existing) existing.remove();
    tr.dataset.cfKey = key;

    const innerDiv = ensureAmountCellFlex(tr);
    if (!innerDiv) return;

    const cfBtn = document.createElement('button');
    cfBtn.type = 'button';
    cfBtn.className = 'spxcf-btn';
    Object.assign(cfBtn.style, {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '22px', height: '22px', padding: '0', flexShrink: '0',
        fontSize: '13px', lineHeight: '1',
        background: '#dc2626', color: '#fff',
        border: 'none', borderRadius: '4px', cursor: 'pointer',
        transition: 'background-color .15s'
    });

    let cfState = 'idle'; // idle | confirming | sending | done | unverified | error
    let confirmTimer = null;

    const setIdle = () => {
        cfState = 'idle';
        cfBtn.disabled = false;
        cfBtn.innerHTML = PEN_SVG;
        cfBtn.style.background = '#dc2626';
        cfBtn.dataset.cfPersist = 'idle';
        cfBtn.dataset.spxTip = `Ghi phiếu chi · ${rowData.note} · ${rowData.amount.toLocaleString('vi-VN')}đ`;
    };
    const setConfirming = () => {
        cfState = 'confirming';
        cfBtn.innerHTML = '?';
        cfBtn.style.background = '#dc2626';
        cfBtn.dataset.cfPersist = 'idle';  // transient → idle để scanRows không clobber
        cfBtn.dataset.spxTip = 'Bấm lần nữa để xác nhận (3s)';
    };
    const setSending = () => {
        cfState = 'sending';
        cfBtn.disabled = true;
        cfBtn.innerHTML = '…';
        cfBtn.style.background = '#6b7280';
        cfBtn.dataset.cfPersist = 'idle';
        cfBtn.dataset.spxTip = 'Đang gửi + xác minh...';
    };
    const setDone = (code) => {
        cfState = 'done';
        cfBtn.disabled = true;
        cfBtn.innerHTML = '✓';
        cfBtn.style.background = '#16a34a';
        cfBtn.dataset.cfPersist = 'done';
        cfBtn.dataset.spxTip = `Đã ghi + xác minh phiếu chi${code ? ' · ' + code : ''}`;
    };
    const setUnverified = () => {
        cfState = 'unverified';
        cfBtn.disabled = false;
        cfBtn.innerHTML = '?';
        cfBtn.style.background = '#d97706';  // amber
        cfBtn.dataset.cfPersist = 'unverified';
        cfBtn.dataset.spxTip = 'Đã gửi nhưng CHƯA xác minh được phiếu — tự kiểm tra lại, hoặc bấm để kiểm ngay';
    };
    const setError = (reason) => {
        cfState = 'error';
        cfBtn.disabled = false;
        cfBtn.innerHTML = '✕';
        cfBtn.style.background = '#dc2626';
        cfBtn.dataset.cfPersist = 'error';
        cfBtn.dataset.spxTip = `Ghi hỏng: ${reason || 'không gửi được'} — bấm lại để thử lần nữa`;
        // KHÔNG auto-reset — user phải bấm tay để retry, lặp đến khi ✓.
    };

    const applyResult = (res) => {
        if (res.status === 'verified') setDone(res.code);
        else if (res.status === 'unverified') {
            setUnverified();
            toast('⏳ Đã ghi phiếu nhưng chưa xác minh được — sẽ tự kiểm tra lại', '#d97706', 5000);
        } else {
            setError(res.error);
            toast('✗ Ghi phiếu thất bại: ' + (res.error || '') + ' — bấm ✕ để thử lại', '#dc2626', 6000);
        }
    };

    // POST + verify read-back. ✓ xanh CHỈ khi verified.
    const doSend = async () => {
        setSending();
        try {
            applyResult(await kvRecordAndVerify(rowData, key));
        } catch (err) {
            setError(err.message);
        }
    };

    // Chỉ verify lại (GET, KHÔNG POST) — cho state vàng "chưa xác minh".
    const doReverify = async () => {
        const entry = getPendingEntry(key);
        if (!entry) {  // có thể đã được sweep promote
            setIdle(); injectCfBtn(tr); return;
        }
        setSending();
        const promoted = await kvReverifyEntry(key, entry);
        if (promoted) { setDone(entry.code); return; }
        const e2 = getPendingEntry(key);
        if (e2 && e2.ver === 'failed') setError('KiotVit không có phiếu sau khi ghi');
        else setUnverified();
    };

    // Trạng thái khởi tạo theo GM storage.
    if (desired === 'done') setDone();
    else if (desired === 'error') setError('lần ghi trước thất bại');
    else if (desired === 'unverified') {
        setUnverified();
        // Auto re-verify ngầm ngay khi inject (in-flight guard chống spam).
        kvReverifyEntry(key, getPendingEntry(key)).then(ok => { if (ok) setDone(); });
    }
    else setIdle();

    cfBtn.onclick = async e => {
        e.stopPropagation();
        if (cfState === 'sending' || cfState === 'done') return;
        // Error → retry full POST+verify. Unverified → chỉ verify lại.
        if (cfState === 'error') { await doSend(); return; }
        if (cfState === 'unverified') { await doReverify(); return; }
        // Idle → confirming (3s window).
        if (cfState === 'idle') {
            setConfirming();
            confirmTimer = setTimeout(setIdle, 3000);
            return;
        }
        // Confirming → execute.
        if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
        await doSend();
    };
    innerDiv.appendChild(cfBtn);
}

function scanRows() {
    if (!onTarget()) return;
    document.querySelectorAll('tr.ssc-table-row').forEach(tr => {
        injectQRBtn(tr);
        injectCfBtn(tr);
    });
}

// ─── SPA NAVIGATION ──────────────────────────────────────────
function onNav() {
    if (!onTarget()) { closeOverlay(); removeTrigger(); stopPoll(); return; }
    ensureTrigger();
    startPoll();
    setTimeout(scanRows, 600);
}
window.addEventListener('spx-nav', onNav);
window.addEventListener('popstate', onNav);

// Throttle: SPX page rất noisy (toast/tooltip/modal đều fire mutations).
// scanRows + ensureTrigger idempotent nên rate-limit là an toàn.
let scanScheduled = false;
function scheduleScan() {
    if (scanScheduled || !onTarget()) return;
    scanScheduled = true;
    setTimeout(() => {
        scanScheduled = false;
        if (!onTarget()) return;
        scanRows();
        ensureTrigger();
    }, 100);
}

const _mainObserverNss = new MutationObserver(scheduleScan);
_mainObserverNss.observe(document.body, { childList: true, subtree: true });

// onPullComplete is registered unconditionally so it fires even when the user
// navigates to cash-collection after neon-sync has already pulled (SPA nav case).
// mergeRefundIdbToGm updates GM kvDone for any page; scanRows then runs only
// when cash-collection is active, or immediately if already there.
_NS?.onPullComplete(() => {
    console.log('[SPX] onPullComplete fired, onTarget=' + onTarget());
    mergeRefundIdbToGm().then(() => { if (onTarget()) scanRows(); })
        .catch(e => console.warn('[SPX] onPullComplete merge error', e));
});

// ─── INIT ────────────────────────────────────────────────────
if (onTarget()) {
    scanRows();
    ensureTrigger();
    startPoll();
    ensureQRLib().catch(() => {});
    // Merge Neon-pulled refund state from IDB → GM, then re-scan buttons.
    // Two passes: immediate (picks up cached IDB from last session) + 5s (picks up today's Neon pull).
    mergeRefundIdbToGm().then(() => { if (onTarget()) scanRows(); }).catch(() => {});
    setTimeout(() => migrateGmToIdb().catch(() => {}), 3500);
    // Re-push all IDB done records to Neon — recovers records whose Neon push
    // failed silently in a previous session (drain lost on page close mid-flight).
    setTimeout(async () => {
        try {
            const all = await rsGetAll();
            const done = all.filter(r => r && r.status === 'done');
            if (!done.length) return;
            done.forEach(r => _NS?.push('spx_refund_state',
                { cf_key: r.cf_key, _key: r.cf_key, status: 'done', kv_id: r.kv_id || null, kv_code: r.kv_code || null }));
            console.log('[SPX] repush IDB→Neon: ' + done.length + ' records queued');
        } catch (e) { console.warn('[SPX] repush error', e); }
    }, 4000);
    setTimeout(() => mergeRefundIdbToGm().then(() => { if (onTarget()) scanRows(); }).catch(() => {}), 5000);
}

document.documentElement.SpxShared?.addUnloadCleanup?.(() => {
    stopPoll();
    _mainObserverNss.disconnect();
});

console.log('[SPX] Refund NSS v7.0 loaded');
})();