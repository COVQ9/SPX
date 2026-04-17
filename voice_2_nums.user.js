// ==UserScript==
// @name         Voice Input v2
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Mic floating + live preview box bên phải input; nói 9/10 số → điền + Enter; voice command "chốt" để complete
// @match        https://sp.spx.shopee.vn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
'use strict';

// ─── MONTH CHAR ──────────────────────────────────────────────
function getExtraChar() {
    const m = new Date().getMonth() + 1;
    if (m <= 9)   return String(m);
    if (m === 10) return 'A';
    if (m === 11) return 'B';
    return 'C';
}

// ─── TARGET INPUT ─────────────────────────────────────────────
function getTargetInput() {
    return [...document.querySelectorAll('input[placeholder="Please Input"]')]
        .find(el => {
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }) || null;
}

// ─── FILL + SUBMIT ────────────────────────────────────────────
function fillAndSubmit(value) {
    const input = getTargetInput();
    if (!input) { setStatus('⚠ không tìm thấy ô input', 'warn'); return; }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress',{ key: 'Enter', keyCode: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
    }, 80);
}

// ─── VOCAB MAP ────────────────────────────────────────────────
// extractDigits sẽ strip diacritics trên transcript TRƯỚC khi tra map
// → keys ở đây chỉ cần ASCII (không dấu)
const DIGIT_MAP = {
    'khong': '0', 'kg': '0', 'hong': '0', 'zero': '0',
    'mot': '1', 'mod': '1', 'moc': '1', 'mat': '1', 'one': '1',
    'hai': '2', 'hay': '2', 'two': '2',
    'ba': '3', 'pa': '3', 'three': '3',
    'bon': '4', 'tu': '4', 'pon': '4', 'four': '4',
    'nam': '5', 'lam': '5', 'ram': '5', 'nang': '5', 'five': '5',
    'sau': '6', 'sao': '6', 'six': '6',
    'bay': '7', 'pay': '7', 'seven': '7',
    'tam': '8', 'tan': '8', 'eight': '8',
    'chin': '9', 'chinh': '9', 'nine': '9',
};

// Letter map: A/B/C (tháng 10/11/12) + S/P/X/V/N (full AWB prefix)
// Người dùng thường đọc: a, bê, cê / ét, pê, ít, vi, en
const LETTER_MAP = {
    // A B C — user xác nhận C luôn đọc là "cê", không bao giờ "ci/xi/si"
    'a': 'A', 'ah': 'A',
    'be': 'B', 'bi': 'B', 'bee': 'B', 'b': 'B',
    'ce': 'C', 'c': 'C',
    // S P X V N
    'es': 'S', 'et': 'S', 'ess': 'S', 's': 'S',
    'pe': 'P', 'pi': 'P', 'p': 'P',
    'ix': 'X', 'it': 'X', 'ich': 'X', 'x': 'X',
    'vi': 'V', 've': 'V', 'v': 'V',
    'en': 'N', 'no': 'N', 'ne': 'N', 'n': 'N',
};

// Filler words bị strip — khi SR gộp digits thành compound number
// ("ba mươi lăm" = 35) thì sau khi strip "muoi" còn "ba lam" → "35"
// Cũng strip âm "gió/sì" trong "ét gió/ét sì" (cách đọc S phổ biến)
const FILLER_WORDS = ['tram', 'muoi', 'moi', 'linh', 'le', 'ruoi', 'chuc', 'va', 'hoac',
                      'gio', 'gioi', 'so'];

// ─── COMPLETION COMMANDS ─────────────────────────────────────
// Phrases tự động normalize (lowercase + bỏ dấu) trước khi so khớp
const COMPLETION_PHRASES = [
    'chot', 'ket phien', 'ket thuc',
    'xong roi', 'het roi', 'da xong',
    'dong phien', 'het phien',
];

function stripDiacritics(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd').replace(/Đ/g, 'd');
}

function matchCompletion(transcript) {
    const norm = stripDiacritics(transcript.toLowerCase().trim()).replace(/\s+/g, ' ');
    return COMPLETION_PHRASES.some(p => norm.includes(p));
}

function fireDoubleCtrl() {
    const make = () => new KeyboardEvent('keydown', {
        key: 'Control', code: 'ControlLeft',
        bubbles: true, cancelable: true
    });
    document.dispatchEvent(make());
    setTimeout(() => document.dispatchEvent(make()), 120);
}

// ─── PARSE ────────────────────────────────────────────────────
// Tách digit/letter từ transcript thô → string compact "0-9A-C-S-P-X-V-N"
function extractDigits(transcript) {
    const collapse = (s) => ' ' + s.replace(/\s+/g, ' ').trim() + ' ';

    // Lowercase + strip diacritics + bỏ punctuation
    let s = collapse(stripDiacritics(transcript.toLowerCase()).replace(/[.,!?:;'"()\[\]/\\]/g, ' '));

    // Strip filler words (mươi, trăm, lẻ, linh, gió...) — user không bao giờ đọc compound
    for (const w of FILLER_WORDS) {
        s = s.replace(new RegExp(`\\s${w}\\s`, 'g'), ' ');
    }
    s = collapse(s);

    // Replace digit words → digits
    for (const [w, d] of Object.entries(DIGIT_MAP)) {
        s = s.replace(new RegExp(`\\s${w}\\s`, 'g'), ` ${d} `);
    }
    // Replace letter words → uppercase letters
    for (const [w, c] of Object.entries(LETTER_MAP)) {
        s = s.replace(new RegExp(`\\s${w}\\s`, 'g'), ` ${c} `);
    }

    // Keep [0-9A-CSPXVN]; uppercase digits already are; uppercase letter words replaced
    return s.replace(/[^0-9A-CSPXVN]/g, '');
}

// Format compact → readable preview, có placeholder _
//   short: "123 456 789_"    (9 hoặc 10 chars)
//   full:  "SPXVN06 123 456 789 _" (17 chars)
function formatForDisplay(compact) {
    const isFull = /[SPXVN]/.test(compact);
    if (isFull) {
        const slots = Array(17).fill('_');
        for (let i = 0; i < compact.length && i < 17; i++) slots[i] = compact[i];
        return slots.slice(0,7).join('') + ' '
             + slots.slice(7,10).join('') + ' '
             + slots.slice(10,13).join('') + ' '
             + slots.slice(13,16).join('') + ' '
             + slots[16];
    }
    const slots = Array(9).fill('_');
    let extra = '';
    for (let i = 0; i < compact.length && i < 10; i++) {
        if (i < 9) slots[i] = compact[i];
        else extra = compact[i];
    }
    let out = slots.slice(0,3).join('') + ' ' + slots.slice(3,6).join('') + ' ' + slots.slice(6,9).join('');
    if (extra || compact.length > 9) out += extra || '_';
    return out;
}

// Trả về AWB nếu hợp lệ, hoặc null
function parseToAWB(transcript) {
    const compact = extractDigits(transcript);
    // Full AWB 17 chars: SPXVN06{9}{1 char}
    if (compact.length === 17 && /^SPXVN06\d{9}[0-9A-C]$/.test(compact)) {
        return compact;
    }
    // Full AWB 16 chars (chưa có suffix tháng) → auto append
    if (compact.length === 16 && /^SPXVN06\d{9}$/.test(compact)) {
        return compact + getExtraChar();
    }
    // Short 9 digits → prepend SPXVN06 + append month
    if (compact.length === 9 && /^\d{9}$/.test(compact)) {
        return 'SPXVN06' + compact + getExtraChar();
    }
    // Short 10 chars (9 digits + 1 [0-9A-C]) → prepend SPXVN06
    if (compact.length === 10 && /^\d{9}[0-9A-C]$/.test(compact)) {
        return 'SPXVN06' + compact;
    }
    return null;
}

// Score 1 alternative dựa trên số digit/char hợp lệ thu được khi append vào prev
// User confirm: chỉ đọc digit-by-digit, không bao giờ đọc compound
// → chỉ cần ưu tiên alt nào yield NHIỀU char hơn (cap 17)
function scoreAlt(altText, prevText) {
    const len = extractDigits((prevText + ' ' + altText).trim()).length;
    if (len <= 17) return len;
    return 17 - (len - 17);  // penalize over-shoot
}

// ─── SPEECH RECOGNITION ──────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
    console.warn('[VoiceInput v2] SpeechRecognition không được hỗ trợ trên trình duyệt này.');
    return;
}

let recognition    = null;
let listening      = false;
let accumulated    = '';   // tích lũy final transcript qua nhiều onresult
let currentInterim = '';   // interim transcript hiện tại (chưa final)
let parseDebounce  = null;
let hardTimeout    = null;

const DEBOUNCE_MS = 1100;  // sau khi user ngắt nói X ms thì parse (đủ buffer cho char thứ 10)
const HARD_MAX_MS = 8000;  // tối đa 8s tổng cộng

function combinedTranscript() {
    return (accumulated + ' ' + currentInterim).trim();
}

function tryParseNow(force = false) {
    const text = combinedTranscript();
    if (matchCompletion(text)) {
        setStatus('✓ chốt phiên', 'ok');
        renderLiveBox(text, 'cmd');
        fireDoubleCtrl();
        stopListening();
        return true;
    }
    const awb = parseToAWB(text);
    if (awb) {
        setStatus('✓ ' + awb, 'ok');
        renderLiveBox(text, 'ok');
        fillAndSubmit(awb);
        stopListening();
        return true;
    }
    if (force) {
        setStatus('⚠ không nhận ra: "' + text + '"', 'warn');
        renderLiveBox(text, 'warn');
        stopListening();
    }
    return false;
}

function startListening() {
    if (listening) { stopListening(); return; }

    accumulated    = '';
    currentInterim = '';
    recognition = new SR();
    recognition.lang            = 'vi-VN';
    recognition.continuous      = true;   // cho phép pause giữa block
    recognition.interimResults  = true;   // hiện preview real-time
    recognition.maxAlternatives = 6;      // nhiều alt → cơ hội pick cao hơn

    recognition.onstart = () => {
        listening = true;
        setStatus('🎙 đang nghe...', 'active');
        btn.classList.add('listening');
        showLiveBox();
        renderLiveBox('', 'live');
        clearTimeout(hardTimeout);
        hardTimeout = setTimeout(() => {
            tryParseNow(true);  // force parse khi hết giờ
        }, HARD_MAX_MS);
    };

    recognition.onresult = (e) => {
        // Pick alt cho 1 result: alt yield nhiều digit nhất khi append
        const pickBestAlt = (result, prevParts) => {
            if (result.length <= 1) return result[0].transcript;
            const prev = prevParts.join(' ');
            let bestT  = result[0].transcript;
            let bestSc = scoreAlt(bestT, prev);
            for (let j = 1; j < result.length; j++) {
                const sc = scoreAlt(result[j].transcript, prev);
                if (sc > bestSc) { bestSc = sc; bestT = result[j].transcript; }
            }
            return bestT;
        };

        // Re-walk toàn bộ results: gom final + interim mới nhất
        let finalParts   = [];
        let interimParts = [];
        for (let i = 0; i < e.results.length; i++) {
            if (e.results[i].isFinal) {
                finalParts.push(pickBestAlt(e.results[i], finalParts));
            } else {
                interimParts.push(pickBestAlt(e.results[i], finalParts.concat(interimParts)));
            }
        }
        accumulated    = finalParts.join(' ').trim();
        currentInterim = interimParts.join(' ').trim();

        const combined = combinedTranscript();
        renderLiveBox(combined, 'live');
        setStatus('🎙 ' + combined, 'active');

        // Luôn debounce — không auto-fire khi đủ 9, đợi user có thể nói tiếp char thứ 10
        clearTimeout(parseDebounce);
        parseDebounce = setTimeout(() => tryParseNow(true), DEBOUNCE_MS);
    };

    recognition.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') {
            stopListening();
            return;
        }
        setStatus('✕ lỗi: ' + e.error, 'err');
        stopListening();
    };

    recognition.onend = () => {
        // Nếu vẫn còn accumulated chưa parse → thử lần cuối
        if (listening && combinedTranscript()) tryParseNow(true);
        stopListening();
    };

    try { recognition.start(); }
    catch (err) { setStatus('✕ ' + err.message, 'err'); stopListening(); }
}

function stopListening() {
    listening = false;
    btn.classList.remove('listening');
    clearTimeout(parseDebounce);
    clearTimeout(hardTimeout);
    try { recognition?.stop(); } catch {}
    recognition = null;
    // Live box: ẩn sau 2s để user kịp nhìn kết quả cuối
    setTimeout(() => { if (!listening) hideLiveBox(); }, 2000);
}

// ─── UI ───────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
    #spx-voice-btn {
        position: fixed; bottom: 80px; right: 18px;
        width: 144px; height: 144px; border-radius: 50%;
        border: none; background: #1677ff; color: #fff;
        font-size: 132px; cursor: pointer; z-index: 2147483646;
        box-shadow: 0 8px 28px rgba(22,119,255,0.45);
        display: flex; align-items: center; justify-content: center;
        transition: background 0.15s, transform 0.15s; user-select: none;
    }
    #spx-voice-btn:hover   { background: #0958d9; }
    #spx-voice-btn.listening {
        background: #f5222d;
        animation: spx-pulse 1s ease-in-out infinite;
    }
    @keyframes spx-pulse {
        0%,100% { box-shadow: 0 0 0 0 rgba(245,34,45,0.5); }
        50%      { box-shadow: 0 0 0 20px rgba(245,34,45,0); }
    }
    #spx-voice-status {
        position: fixed; bottom: 232px; right: 18px;
        max-width: 260px; padding: 6px 10px; border-radius: 8px;
        font-size: 12px; font-family: monospace; font-weight: 600;
        z-index: 2147483646; pointer-events: none;
        opacity: 0; transition: opacity 0.2s;
        text-align: right; word-break: break-all;
    }
    #spx-voice-status.active { background: rgba(0,0,0,0.75);   color: #fff; opacity: 1; }
    #spx-voice-status.ok     { background: rgba(0,204,102,0.9);color: #fff; opacity: 1; }
    #spx-voice-status.warn   { background: rgba(250,173,20,0.9);color: #fff;opacity: 1; }
    #spx-voice-status.err    { background: rgba(245,34,45,0.9);color: #fff; opacity: 1; }

    #spx-voice-live {
        position: fixed; left: 0; top: 0;
        padding: 14px 22px; border-radius: 12px;
        font-family: 'Consolas','Menlo',monospace;
        font-size: 52px; font-weight: 700; letter-spacing: 4px;
        background: rgba(0,0,0,0.88); color: #fff;
        box-shadow: 0 8px 28px rgba(0,0,0,0.35);
        z-index: 2147483645; pointer-events: none;
        white-space: nowrap; line-height: 1;
        display: none;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        border: 3px solid transparent;
    }
    #spx-voice-live.live { background: rgba(0,0,0,0.88); color: #fff;     border-color: #1677ff; }
    #spx-voice-live.ok   { background: rgba(0,150,80,0.95); color: #fff;  border-color: #00c853; }
    #spx-voice-live.warn { background: rgba(180,90,0,0.95); color: #fff;  border-color: #ffab00; }
    #spx-voice-live.cmd  { background: rgba(80,40,160,0.95); color: #fff; border-color: #b388ff; }
    #spx-voice-live.full { font-size: 36px; letter-spacing: 2px; }
    #spx-voice-live .ph  { color: rgba(255,255,255,0.25); }
    #spx-voice-live .raw {
        display: block; font-size: 14px; font-weight: 400;
        letter-spacing: 0; opacity: 0.65; margin-top: 6px;
        max-width: 520px; white-space: normal; word-break: break-word;
    }
`;
document.head.appendChild(style);

const btn = document.createElement('button');
btn.id        = 'spx-voice-btn';
btn.title     = 'Voice Input v2 (click để bật/tắt mic)';
btn.innerHTML = '🎙';
btn.onclick   = startListening;

const statusEl = document.createElement('div');
statusEl.id = 'spx-voice-status';

const liveBox = document.createElement('div');
liveBox.id = 'spx-voice-live';

document.body.appendChild(btn);
document.body.appendChild(statusEl);
document.body.appendChild(liveBox);

// ─── LIVE BOX ────────────────────────────────────────────────
let _liveRAF = null;
function positionLiveBox() {
    const input = getTargetInput();
    if (!input) return;
    const r = input.getBoundingClientRect();
    const boxH = liveBox.offsetHeight || 80;
    let top  = r.top + r.height / 2 - boxH / 2;
    let left = r.right + 24;
    // Clamp vào viewport
    if (top < 8) top = 8;
    if (top + boxH > window.innerHeight - 8) top = window.innerHeight - boxH - 8;
    const maxLeft = window.innerWidth - liveBox.offsetWidth - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    liveBox.style.left = left + 'px';
    liveBox.style.top  = top  + 'px';
}
function liveLoop() {
    if (liveBox.style.display === 'none') { _liveRAF = null; return; }
    positionLiveBox();
    _liveRAF = requestAnimationFrame(liveLoop);
}
function showLiveBox() {
    liveBox.style.display = 'block';
    if (_liveRAF == null) _liveRAF = requestAnimationFrame(liveLoop);
}
function hideLiveBox() {
    liveBox.style.display = 'none';
    if (_liveRAF != null) { cancelAnimationFrame(_liveRAF); _liveRAF = null; }
}
function renderLiveBox(transcript, state /* live | ok | warn | cmd */) {
    // Nếu là completion command thì show text "CHỐT PHIÊN" thay vì digit
    if (state === 'cmd') {
        liveBox.className = 'cmd';
        liveBox.innerHTML = 'CHỐT PHIÊN <span class="raw">' + escapeHtml(transcript) + '</span>';
        return;
    }
    const compact = extractDigits(transcript);
    const display = formatForDisplay(compact);
    const isFull  = /[SPXVN]/.test(compact);
    // Wrap underscores in placeholder span
    const html = display.split('').map(ch => ch === '_' ? '<span class="ph">_</span>' : escapeHtml(ch)).join('');
    liveBox.className = (state || 'live') + (isFull ? ' full' : '');
    let inner = html;
    if (transcript) inner += '<span class="raw">' + escapeHtml(transcript) + '</span>';
    liveBox.innerHTML = inner;
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

let _statusTimer = null;
function setStatus(text, cls) {
    clearTimeout(_statusTimer);
    statusEl.className = cls;
    statusEl.textContent = text;
    if (cls === 'ok' || cls === 'warn' || cls === 'err') {
        _statusTimer = setTimeout(() => {
            statusEl.className = '';
            statusEl.textContent = '';
        }, 3000);
    }
}

// ─── SHOW/HIDE BUTTON THEO INPUT ─────────────────────────────
let _visibleNow = false;
function updateVisibility() {
    const has = !!getTargetInput();
    if (has === _visibleNow) return;
    _visibleNow = has;
    btn.style.display = has ? 'flex' : 'none';
    if (!has) {
        statusEl.className = '';
        statusEl.textContent = '';
        hideLiveBox();
        if (listening) stopListening();
    }
}
btn.style.display = 'none';
updateVisibility();

let _visTimer = null;
const visObserver = new MutationObserver(() => {
    clearTimeout(_visTimer);
    _visTimer = setTimeout(updateVisibility, 200);
});
visObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style','class'] });

// ─── QUICK ACTIVATION: dblclick (desktop) + double-tap (touch) ──
function isInteractiveTarget(el) {
    if (!el) return false;
    if (el === btn || btn.contains(el))             return true;
    if (el === statusEl)                            return true;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || tag === 'LABEL') return true;
    if (el.isContentEditable)                       return true;
    // Bỏ qua nếu nằm trong input/contenteditable
    if (el.closest && el.closest('input, textarea, select, button, a, label, [contenteditable="true"]')) return true;
    return false;
}

function quickActivate() {
    if (!_visibleNow) return;        // không có input → bỏ qua
    startListening();
}

// Desktop: dblclick
document.addEventListener('dblclick', (e) => {
    if (isInteractiveTarget(e.target)) return;
    quickActivate();
}, true);

// Touch: tự detect 2 tap trong 300ms, lệch <30px
let _lastTap = { t: 0, x: 0, y: 0 };
document.addEventListener('touchend', (e) => {
    if (isInteractiveTarget(e.target)) { _lastTap.t = 0; return; }
    if (e.changedTouches.length !== 1) return;
    const t = Date.now();
    const x = e.changedTouches[0].clientX;
    const y = e.changedTouches[0].clientY;
    const dt = t - _lastTap.t;
    const dx = Math.abs(x - _lastTap.x);
    const dy = Math.abs(y - _lastTap.y);
    if (dt < 300 && dx < 30 && dy < 30) {
        _lastTap.t = 0;
        e.preventDefault();
        quickActivate();
    } else {
        _lastTap = { t, x, y };
    }
}, true);

console.log('[SPX] Voice Input v2 loaded');
})();
