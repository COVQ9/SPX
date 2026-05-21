// ==UserScript==
// @name         SF Keyboard
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/sf-keyboard.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/sf-keyboard.user.js
// @version      1.7
// @description  Touch numeric keypad — 2-panel layout: fn trái (SPXVN/Voice/Clear/Print/Done/Enter) + numpad phải (0-9/A/B/C/⌫); A=T10 B=T11 C=T12; Done = double-Ctrl completion flow
// @match        https://sp.spx.shopee.vn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
'use strict';

// Skip inside iframes (find-details' hidden eye-preview iframe). Keypad + mic
// session in a hidden frame is useless and would compete for the mic.
if (window.top !== window) return;

// Guard chống chạy 2 lần (re-inject) → tránh tạo 2 thanh #sf-kb chồng nhau.
if (document.getElementById('sf-kb')) return;

// ============================================================
// SECTION 1 — CONSTANTS
// ============================================================

const Z_BASE        = 2147483600;   // dưới QR header open-2-end (2147483647)

const DEBOUNCE_MS   = 1100;         // sau khi user ngắt nói X ms thì parse
const HARD_MAX_MS   = 8000;         // tối đa 8s tổng cộng cho 1 phiên voice

// Prefix mã vận đơn phụ thuộc năm: đuôi 0X = (năm - 2020).
//   2026 → SPXVN06 · 2027 → SPXVN07 · ...
function awbPrefix() {
  return 'SPXVN' + String(new Date().getFullYear() - 2020).padStart(2, '0');
}

// Suffix ký tự tháng cho AWB 16 ký tự (chưa có char cuối).
function getExtraChar() {
  const m = new Date().getMonth() + 1;
  if (m <= 9)   return String(m);
  if (m === 10) return 'A';
  if (m === 11) return 'B';
  return 'C';
}

// ============================================================
// SECTION 2 — INPUT HELPERS
// ============================================================

function isVisible(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// Ô "Scan Tracking Number" trên trang receive task. Bàn phím CHỈ available khi:
//   1. trang có badge trạng thái "Created" hoặc "Doing" (chưa hoàn tất)
//   2. có ô input thực trong <section class="order-input">
// → ẩn khi badge là Done (hoặc trạng thái khác ngoài created/doing).
function getTargetInput() {
  if (!document.querySelector('.task-info-task-created, .task-info-task-doing')) return null;
  return [...document.querySelectorAll('section.order-input input[placeholder="Please Input"]')]
    .find(isVisible) || null;
}

// Set value xuyên qua React/Vue controlled input + bắn input/change.
const _nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
function setNativeValue(input, value) {
  _nativeSetter.call(input, value);
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function insertAtCaret(text) {
  const input = getTargetInput();
  if (!input) { toast('⚠ không thấy ô nhập mã'); return; }
  input.focus();
  const v     = input.value;
  const start = input.selectionStart ?? v.length;
  const end   = input.selectionEnd   ?? v.length;
  const expected = v.slice(0, start) + text + v.slice(end);
  setNativeValue(input, expected);
  // Chỉ set cursor nếu value chưa bị transform (e.g. scan-job tự chèn prefix)
  if (input.value === expected) {
    try { input.setSelectionRange(start + text.length, start + text.length); } catch {}
  }
}

function backspaceAtCaret() {
  const input = getTargetInput();
  if (!input) return;
  input.focus();
  const v     = input.value;
  const start = input.selectionStart ?? v.length;
  const end   = input.selectionEnd   ?? v.length;
  if (start !== end) {
    setNativeValue(input, v.slice(0, start) + v.slice(end));
    try { input.setSelectionRange(start, start); } catch {}
  } else if (start > 0) {
    setNativeValue(input, v.slice(0, start - 1) + v.slice(end));
    try { input.setSelectionRange(start - 1, start - 1); } catch {}
  }
}

function clearInput() {
  const input = getTargetInput();
  if (!input) return;
  input.focus();
  setNativeValue(input, '');
  try { input.setSelectionRange(0, 0); } catch {}
}

function pressEnter() {
  const input = getTargetInput();
  if (!input) { toast('⚠ không thấy ô nhập mã'); return; }
  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
    }));
  }
}

// Print All — dispatch Alt+P trên document để handler của scan-job.user.js chạy printAll().
function firePrintAll() {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'p', code: 'KeyP', keyCode: 80, which: 80,
    altKey: true, bubbles: true, cancelable: true
  }));
}

// ============================================================
// SECTION 3 — FILL + SUBMIT (dùng cho voice)
// ============================================================

function fillAndSubmit(value) {
  const input = getTargetInput();
  if (!input) { setVoiceStatus('⚠ không tìm thấy ô input', 'warn'); return; }
  setNativeValue(input, value);
  setTimeout(() => {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', keyCode: 13, bubbles: true }));
    }
  }, 80);
}

// ============================================================
// SECTION 4 — VOICE ENGINE  (port từ voice_2_nums.user.js)
// ============================================================

// extractDigits strip dấu trên transcript TRƯỚC khi tra map → keys chỉ cần ASCII.
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

// A/B/C (tháng 10/11/12) + S/P/X/V/N (AWB prefix).
const LETTER_MAP = {
  'a': 'A', 'ah': 'A',
  'be': 'B', 'bi': 'B', 'bee': 'B', 'b': 'B',
  'ce': 'C', 'c': 'C',
  'es': 'S', 'et': 'S', 'ess': 'S', 's': 'S',
  'pe': 'P', 'pi': 'P', 'p': 'P',
  'ix': 'X', 'it': 'X', 'ich': 'X', 'x': 'X',
  'vi': 'V', 've': 'V', 'v': 'V',
  'en': 'N', 'no': 'N', 'ne': 'N', 'n': 'N',
};

const FILLER_WORDS = ['tram', 'muoi', 'moi', 'linh', 'le', 'ruoi', 'chuc', 'va', 'hoac',
                      'gio', 'gioi', 'so'];

const COMPLETION_PHRASES = [
  'chot', 'ket phien', 'ket thuc',
  'xong roi', 'het roi', 'da xong',
  'dong phien', 'het phien',
];

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/đ/g, 'd').replace(/Đ/g, 'd');
}

function matchCompletion(transcript) {
  const norm = stripDiacritics(transcript.toLowerCase().trim()).replace(/\s+/g, ' ');
  return COMPLETION_PHRASES.some(p => norm.includes(p));
}

function fireDoubleCtrl() {
  const make = () => new KeyboardEvent('keydown', {
    key: 'Control', code: 'ControlLeft', bubbles: true, cancelable: true
  });
  document.dispatchEvent(make());
  setTimeout(() => document.dispatchEvent(make()), 120);
}

// Tách digit/letter từ transcript thô → string compact "0-9A-C-S-P-X-V-N".
function extractDigits(transcript) {
  const collapse = (s) => ' ' + s.replace(/\s+/g, ' ').trim() + ' ';
  let s = collapse(stripDiacritics(transcript.toLowerCase()).replace(/[.,!?:;'"()\[\]/\\]/g, ' '));
  for (const w of FILLER_WORDS) {
    s = s.replace(new RegExp(`\\s${w}\\s`, 'g'), ' ');
  }
  s = collapse(s);
  for (const [w, d] of Object.entries(DIGIT_MAP)) {
    s = s.replace(new RegExp(`\\s${w}\\s`, 'g'), ` ${d} `);
  }
  for (const [w, c] of Object.entries(LETTER_MAP)) {
    s = s.replace(new RegExp(`\\s${w}\\s`, 'g'), ` ${c} `);
  }
  return s.replace(/[^0-9A-CSPXVN]/g, '');
}

// Format compact → readable preview với placeholder _.
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
  if (extra || compact.length > 9) out += ' ' + (extra || '_');
  return out;
}

// Trả về AWB hợp lệ hoặc null. Prefix theo năm hiện tại (awbPrefix()).
function parseToAWB(transcript) {
  const compact = extractDigits(transcript);
  const PFX     = awbPrefix();                          // vd "SPXVN06"
  const reFull  = new RegExp('^' + PFX + '\\d{9}[0-9A-C]$');
  const reFull16= new RegExp('^' + PFX + '\\d{9}$');
  if (compact.length === 17 && reFull.test(compact))   return compact;
  if (compact.length === 16 && reFull16.test(compact)) return compact + getExtraChar();
  if (compact.length === 9  && /^\d{9}$/.test(compact))            return PFX + compact + getExtraChar();
  if (compact.length === 10 && /^\d{9}[0-9A-C]$/.test(compact))    return PFX + compact;
  return null;
}

// Score 1 alternative: ưu tiên alt yield nhiều char hợp lệ hơn (cap 17).
function scoreAlt(altText, prevText) {
  const len = extractDigits((prevText + ' ' + altText).trim()).length;
  return len <= 17 ? len : 17 - (len - 17);
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const voiceSupported = !!SR;

let recognition    = null;
let listening      = false;
let voiceMode      = false;   // panel voice đang hiển thị?
let accumulated    = '';      // final transcript tích lũy
let currentInterim = '';      // interim transcript hiện tại
let parseDebounce  = null;
let hardTimeout    = null;
let revertTimer    = null;    // timer tự quay về keypad

function combinedTranscript() {
  return (accumulated + ' ' + currentInterim).trim();
}

function tryParseNow(force = false) {
  const text = combinedTranscript();
  if (matchCompletion(text)) {
    setVoiceStatus('✓ chốt phiên', 'ok');
    renderVoice(text, 'cmd');
    fireDoubleCtrl();
    stopListening();
    return true;
  }
  const awb = parseToAWB(text);
  if (awb) {
    setVoiceStatus('✓ ' + awb, 'ok');
    renderVoice(text, 'ok');
    fillAndSubmit(awb);
    stopListening();
    return true;
  }
  if (force) {
    setVoiceStatus('⚠ không nhận ra', 'warn');
    renderVoice(text, 'warn');
    stopListening();
  }
  return false;
}

function startListening(lang = 'vi-VN') {
  if (listening) { stopListening(); return; }
  if (!voiceSupported) { toast('Trình duyệt không hỗ trợ giọng nói'); return; }

  accumulated    = '';
  currentInterim = '';
  recognition = new SR();
  recognition.lang            = lang;
  recognition.continuous      = true;
  recognition.interimResults  = true;
  recognition.maxAlternatives = 6;

  recognition.onstart = () => {
    listening = true;
    voicePanel.classList.add('listening');
    setVoiceStatus('🎙 đang nghe…', 'active');
    renderVoice('', 'live');
    clearTimeout(hardTimeout);
    hardTimeout = setTimeout(() => {
      if (!listening) return;            // user đã dừng tay → bỏ qua
      tryParseNow(true);
    }, HARD_MAX_MS);
  };

  recognition.onresult = (e) => {
    const pickBestAlt = (result, prevParts) => {
      if (result.length <= 1) return result[0].transcript;
      const prev = prevParts.join(' ');
      let bestT = result[0].transcript, bestSc = scoreAlt(bestT, prev);
      for (let j = 1; j < result.length; j++) {
        const sc = scoreAlt(result[j].transcript, prev);
        if (sc > bestSc) { bestSc = sc; bestT = result[j].transcript; }
      }
      return bestT;
    };
    let finalParts = [], interimParts = [];
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
    renderVoice(combined, 'live');
    setVoiceStatus('🎙 ' + (combined || 'đang nghe…'), 'active');

    clearTimeout(parseDebounce);
    parseDebounce = setTimeout(() => tryParseNow(true), DEBOUNCE_MS);
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') { stopListening(); return; }
    if (e.error === 'network' && lang === 'vi-VN') {
      // vi-VN cần cloud; thử en-US có offline pack sẵn trên Windows
      clearTimeout(hardTimeout);
      try { recognition?.stop(); } catch {}
      recognition = null;
      listening = false;
      voicePanel.classList.remove('listening');
      setVoiceStatus('🔄 offline (en-US)…', 'active');
      setTimeout(() => { if (voiceMode) startListening('en-US'); }, 400);
      return;
    }
    const friendly = {
      'not-allowed':         '✕ Chưa cấp quyền micro — bấm 🔒 trên thanh địa chỉ → Microphone → Allow → tải lại trang',
      'service-not-allowed': '✕ Chưa cấp quyền micro — bấm 🔒 trên thanh địa chỉ → Microphone → Allow → tải lại trang',
      'audio-capture':       '✕ Không tìm thấy micro — kiểm tra thiết bị thu âm',
      'network':             '✕ Lỗi mạng — dịch vụ giọng nói cần Internet (cài gói offline: Settings → Time & Language → Speech)',
    };
    setVoiceStatus(friendly[e.error] || ('✕ lỗi: ' + e.error), 'err');
    stopListening();
  };

  recognition.onend = () => {
    if (listening && combinedTranscript()) tryParseNow(true);
    stopListening();
  };

  try { recognition.start(); }
  catch (err) { setVoiceStatus('✕ ' + err.message, 'err'); stopListening(); }
}

function stopListening() {
  listening = false;
  voicePanel.classList.remove('listening');
  clearTimeout(parseDebounce);
  clearTimeout(hardTimeout);
  try { recognition?.stop(); } catch {}
  recognition = null;
  // Quay về keypad sau 2s để user kịp nhìn kết quả.
  clearTimeout(revertTimer);
  revertTimer = setTimeout(() => { if (!listening) exitVoiceMode(); }, 2000);
}

// Mic dừng khi tab ẩn / rời trang (tránh để mic sáng sau SPA nav).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && listening) stopListening();
});
window.addEventListener('pagehide', () => { if (listening) stopListening(); });

// ============================================================
// SECTION 5 — PRESS FEEDBACK (visual + click sound — thay haptic)
// ============================================================

let _ac = null;
function ensureAudio() {
  if (!_ac) {
    try { _ac = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  if (_ac && _ac.state === 'suspended') _ac.resume();
}
function clickSound() {
  if (!_ac) return;
  const t    = _ac.currentTime;
  const osc  = _ac.createOscillator();
  const gain = _ac.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(900, t);
  osc.frequency.exponentialRampToValueAtTime(420, t + 0.03);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.16, t + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.032);
  osc.connect(gain); gain.connect(_ac.destination);
  osc.start(t); osc.stop(t + 0.04);
}
function ripple(key, x, y) {
  const rect = key.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.1;
  const r = document.createElement('span');
  r.className = 'sf-ripple';
  r.style.width = r.style.height = size + 'px';
  r.style.left  = ((x ?? rect.left + rect.width / 2)  - rect.left - size / 2) + 'px';
  r.style.top   = ((y ?? rect.top  + rect.height / 2) - rect.top  - size / 2) + 'px';
  key.appendChild(r);
  setTimeout(() => r.remove(), 460);
}

// ============================================================
// SECTION 6 — STYLES (industrial)
// ============================================================

const COLORS = {
  num:    { bg: 'linear-gradient(180deg,#fdfdfe,#dfe3ea)', fg: '#11161f', edge: '#aab1bf' },
  prefix: { bg: 'linear-gradient(180deg,#3b9bff,#1668d6)', fg: '#fff', edge: '#0d4ea3' },
  back:   { bg: 'linear-gradient(180deg,#ffa940,#d97706)', fg: '#fff', edge: '#a85a04' },
  voice:  { bg: 'linear-gradient(180deg,#2cd4d4,#0a9696)', fg: '#fff', edge: '#077575' },
  clear:  { bg: 'linear-gradient(180deg,#ff5a5f,#cf1322)', fg: '#fff', edge: '#9c0e18' },
  print:  { bg: 'linear-gradient(180deg,#9a5cff,#6b21d6)', fg: '#fff', edge: '#4c179c' },
  enter:  { bg: 'linear-gradient(180deg,#56d364,#2f9e3f)', fg: '#fff', edge: '#1f7a2c' },
  done:   { bg: 'linear-gradient(180deg,#ffd700,#c9a000)', fg: '#3d2e00', edge: '#8a6e00' },
};

const style = document.createElement('style');
style.textContent = `
#sf-kb {
  /* left+right:0 cho width = vùng nội dung (KHÔNG dùng 100vw vì 100vw gồm cả
     thanh cuộn dọc → dư vài px → sinh thanh cuộn ngang). */
  position: fixed; left: 0; right: 0; bottom: 0;
  box-sizing: border-box;
  background: linear-gradient(180deg,#2b323d,#1b1f27);
  border-top: 3px solid #11151c;
  box-shadow: 0 -10px 32px rgba(0,0,0,0.55);
  z-index: ${Z_BASE};
  font-family: 'Segoe UI',Roboto,Arial,sans-serif;
  user-select: none; -webkit-user-select: none;
  touch-action: manipulation;
  transition: transform .26s cubic-bezier(.4,0,.2,1);
}
#sf-kb.sf-collapsed { transform: translateY(100%); }

/* ── HANDLE ─────────────────────────────────────────── */
#sf-kb-handle {
  position: absolute; right: 14px; top: -72px;
  width: auto; padding: 0 24px; height: 72px;
  background: linear-gradient(180deg,#2b323d,#1b1f27);
  border: 3px solid #11151c; border-bottom: none;
  border-radius: 16px 16px 0 0;
  display: flex; align-items: center; justify-content: center;
  color: #cfd6e2; font-size: 19px; font-weight: 700; letter-spacing: .5px;
  cursor: pointer; box-shadow: 0 -6px 18px rgba(0,0,0,0.4);
}
#sf-kb-handle .sf-caret { font-size: 22px; }

/* ── KEY GRID ───────────────────────────────────────── */
#sf-kb-keys {
  display: flex; flex-direction: row; align-items: stretch;
  gap: 0; padding: 10px 10px 12px;
  box-sizing: border-box;
}
#sf-kb-fn {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(2, 1fr);
  gap: 8px;
  flex: 3;
}
.sf-kb-sep {
  width: 2px;
  background: rgba(255,255,255,.18);
  margin: 0 8px;
  align-self: stretch;
  flex-shrink: 0;
}
#sf-kb-num {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  grid-auto-rows: clamp(64px,11vh,98px);
  gap: 8px;
  flex: 7;
}
.sf-key {
  position: relative; overflow: hidden;
  box-sizing: border-box;
  grid-row: span 1;
  min-height: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  border-radius: 12px;
  font-weight: 800; line-height: 1.05;
  cursor: pointer;
  border: 1px solid rgba(0,0,0,.25);
  box-shadow: 0 4px 0 0 var(--edge), 0 6px 12px rgba(0,0,0,.42);
  transition: transform .05s ease, box-shadow .05s ease, filter .05s ease;
}
.sf-key .sf-sub {
  font-size: clamp(9px,1.4vh,12px); font-weight: 700;
  opacity: .82; margin-top: 3px; letter-spacing: .4px;
}
.sf-key.sf-num   { font-size: clamp(24px,3.8vh,38px); }
.sf-key.sf-fn    { font-size: clamp(15px,2.2vh,22px); text-transform: uppercase; letter-spacing: .6px; }
.sf-key .sf-ic {
  width: clamp(38px,6vh,58px); height: auto; display: block;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,.4));
}
.sf-key.sf-pressed {
  transform: translateY(4px);
  box-shadow: 0 0 0 0 var(--edge), 0 2px 6px rgba(0,0,0,.4);
  filter: brightness(.92);
}
.sf-key[data-disabled="1"] { opacity: .4; pointer-events: none; }

.sf-ripple {
  position: absolute; border-radius: 50%;
  background: rgba(255,255,255,.5);
  transform: scale(0); pointer-events: none;
  animation: sf-ripple .46s ease-out forwards;
}
.sf-key.sf-num .sf-ripple { background: rgba(20,30,50,.22); }
@keyframes sf-ripple { to { transform: scale(2.6); opacity: 0; } }

/* ── VOICE PANEL ────────────────────────────────────── */
/* Chiều cao KHỚP đúng keypad (2 hàng phím + gap + padding) → voice panel
   chỉ chiếm đúng diện tích thanh bàn phím ở đáy, không bung fullscreen. */
#sf-kb-voice {
  display: none; flex-direction: column;
  padding: 12px 16px; gap: 10px;
  height: calc(2 * clamp(64px,11vh,98px) + 30px);
  box-sizing: border-box; overflow: hidden;
}
#sf-kb-voice.listening {
  animation: sf-pulse 1.1s ease-in-out infinite;
}
@keyframes sf-pulse {
  0%,100% { box-shadow: inset 0 0 0 0 rgba(255,77,79,0); }
  50%      { box-shadow: inset 0 0 0 4px rgba(255,77,79,.55); }
}
#sf-kb-voice-top {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
#sf-kb-voice-status {
  font-family: Consolas,Menlo,monospace; font-weight: 700;
  font-size: clamp(14px,2.1vh,18px);
  padding: 6px 14px; border-radius: 8px;
  color: #fff; background: rgba(255,255,255,.12);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#sf-kb-voice-status.active { background: rgba(22,119,255,.32); }
#sf-kb-voice-status.ok     { background: rgba(47,158,63,.5); }
#sf-kb-voice-status.warn   { background: rgba(217,119,6,.5); }
/* err: thông báo dài (vd hướng dẫn cấp quyền micro) → cho xuống dòng,
   bỏ ellipsis để user đọc được đầy đủ. */
#sf-kb-voice-status.err {
  background: rgba(207,19,34,.55);
  white-space: normal; line-height: 1.3;
}
#sf-kb-voice-exit {
  flex: none; cursor: pointer;
  background: linear-gradient(180deg,#ff5a5f,#cf1322); color: #fff;
  border: 1px solid rgba(0,0,0,.3); border-radius: 10px;
  font-size: clamp(15px,2.2vh,20px); font-weight: 800;
  padding: 10px 22px; text-transform: uppercase; letter-spacing: .6px;
  box-shadow: 0 4px 0 0 #9c0e18, 0 6px 12px rgba(0,0,0,.42);
}
#sf-kb-voice-exit:active { transform: translateY(4px); box-shadow: 0 0 0 0 #9c0e18; }
#sf-kb-voice-display {
  flex: 1; min-height: 0; overflow: hidden;
  box-sizing: border-box;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  font-family: Consolas,Menlo,monospace; font-weight: 800;
  font-size: clamp(34px,7vh,64px); letter-spacing: 6px;
  color: #fff; text-align: center;
  border-radius: 12px; padding: 10px;
  border: 3px solid #1677ff;
  background: rgba(0,0,0,.3);
}
#sf-kb-voice-display.ok   { border-color: #2f9e3f; background: rgba(47,158,63,.22); }
#sf-kb-voice-display.warn { border-color: #d97706; background: rgba(217,119,6,.22); }
#sf-kb-voice-display.cmd  { border-color: #9a5cff; background: rgba(107,33,214,.28); letter-spacing: 2px; }
#sf-kb-voice-display.full { font-size: clamp(26px,4.6vh,44px); letter-spacing: 3px; }
#sf-kb-voice-display .sf-vline {
  white-space: nowrap; line-height: 1.1;
  max-width: 96vw; overflow: hidden; text-overflow: ellipsis;
}
#sf-kb-voice-display .ph  { color: rgba(255,255,255,.22); }
#sf-kb-voice-display .raw {
  margin-top: 10px;
  font-size: 14px; font-weight: 400; letter-spacing: 0;
  opacity: .6; max-width: 80vw; word-break: break-word;
}

/* ── TOAST ──────────────────────────────────────────── */
#sf-kb-toast {
  position: fixed; left: 50%; bottom: 38vh; transform: translateX(-50%);
  background: rgba(17,21,28,.95); color: #fff;
  font-family: 'Segoe UI',sans-serif; font-size: 16px; font-weight: 700;
  padding: 12px 22px; border-radius: 10px;
  border: 1px solid rgba(255,255,255,.15);
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
  z-index: ${Z_BASE + 5}; opacity: 0; transition: opacity .2s;
  pointer-events: none;
}
#sf-kb-toast.show { opacity: 1; }
`;
document.head.appendChild(style);

// ============================================================
// SECTION 7 — BUILD UI
// ============================================================

const kb = document.createElement('div');
kb.id = 'sf-kb';

// — Handle —
const handle = document.createElement('div');
handle.id = 'sf-kb-handle';
const caret = document.createElement('span'); caret.className = 'sf-caret';
handle.append(caret);

// — Keypad grid —
const keysEl = document.createElement('div');
keysEl.id = 'sf-kb-keys';

// Icon backspace đậm, dạng SVG fill — nhìn "lực lưỡng" hơn ký tự ⌫.
const ICON_BACK = '<svg class="sf-ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 ' +
  '2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 ' +
  '14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z"/></svg>';

// def: [label, kind, action-id, _span, subLabel]
const FN_KEYS = [
  ['⏎ Enter', 'enter',  'enter',  1],
  ['🎙 Voice','voice',  'voice',  1],
  ['Print All','print', 'print',  1],
  ['✓ XONG',  'done',  'done',   1],
  ['Clear',   'clear',  'clear',  1],
  ['SPXVN',   'prefix', 'prefix', 1, awbPrefix().slice(5)],
];

const NUM_KEYS = [
  ['0','num','d0',1], ['1','num','d1',1], ['2','num','d2',1],
  ['3','num','d3',1], ['4','num','d4',1], ['5','num','d5',1],
  ['6','num','d6',1],
  ['7','num','d7',1], ['8','num','d8',1], ['9','num','d9',1],
  ['A','num','dA',1], ['B','num','dB',1], ['C','num','dC',1],
  [ICON_BACK, 'back', 'back', 1],
];

function buildKey(def) {
  const [label, kind, id, , sub] = def;
  const c = COLORS[kind === 'num' ? 'num' : kind];
  const el = document.createElement('div');
  el.className = 'sf-key ' + (kind === 'num' ? 'sf-num' : 'sf-fn');
  el.dataset.k = id;
  el.dataset.kind = kind;
  el.style.background = c.bg;
  el.style.color      = c.fg;
  el.style.setProperty('--edge', c.edge);
  el.innerHTML = label + (sub ? `<span class="sf-sub">${sub}</span>` : '');
  if (id === 'voice' && !voiceSupported) el.dataset.disabled = '1';
  return el;
}

const fnPanel = document.createElement('div');
fnPanel.id = 'sf-kb-fn';
FN_KEYS.forEach(d => fnPanel.appendChild(buildKey(d)));

const sep = document.createElement('div');
sep.className = 'sf-kb-sep';

const numPanel = document.createElement('div');
numPanel.id = 'sf-kb-num';
NUM_KEYS.forEach(d => numPanel.appendChild(buildKey(d)));

keysEl.append(fnPanel, sep, numPanel);

// — Voice panel —
const voicePanel = document.createElement('div');
voicePanel.id = 'sf-kb-voice';
const vTop    = document.createElement('div'); vTop.id = 'sf-kb-voice-top';
const vStatus = document.createElement('div'); vStatus.id = 'sf-kb-voice-status';
vStatus.textContent = '🎙 đang nghe…';
const vExit   = document.createElement('div'); vExit.id = 'sf-kb-voice-exit';
vExit.textContent = '✕ Thoát';
vTop.append(vStatus, vExit);
const vDisplay = document.createElement('div'); vDisplay.id = 'sf-kb-voice-display';
voicePanel.append(vTop, vDisplay);

kb.append(handle, keysEl, voicePanel);

// — Toast —
const toastEl = document.createElement('div');
toastEl.id = 'sf-kb-toast';

document.body.append(kb, toastEl);

// ============================================================
// SECTION 8 — VIEW HELPERS
// ============================================================

let _toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function setVoiceStatus(text, cls) {
  vStatus.className = cls || '';
  vStatus.textContent = text;
}

function renderVoice(transcript, state /* live|ok|warn|cmd */) {
  // Bọc transcript trong .sf-vline để nó là 1 dòng inline duy nhất —
  // nếu để các <span> char là con trực tiếp của flex-column thì chúng xếp dọc.
  if (state === 'cmd') {
    vDisplay.className = 'cmd';
    vDisplay.innerHTML = '<div class="sf-vline">CHỐT PHIÊN</div>' +
      '<div class="raw">' + escapeHtml(transcript) + '</div>';
    return;
  }
  const compact = extractDigits(transcript);
  const display = formatForDisplay(compact);
  const isFull  = /[SPXVN]/.test(compact);
  const html = display.split('').map(ch =>
    ch === '_' ? '<span class="ph">_</span>' : escapeHtml(ch)).join('');
  vDisplay.className = (state || 'live') + (isFull ? ' full' : '');
  vDisplay.innerHTML = '<div class="sf-vline">' + html + '</div>' +
    (transcript ? '<div class="raw">' + escapeHtml(transcript) + '</div>' : '');
}

// — collapse / expand —
function setCollapsed(on) {
  kb.classList.toggle('sf-collapsed', on);
  caret.textContent = on ? '▲ BÀN PHÍM' : '▼ THU GỌN';
}
// Luôn bắt đầu thu gọn — chỉ hiện khi user chủ động bấm handle.
setCollapsed(true);

handle.addEventListener('pointerdown', e => {
  e.preventDefault();
  ensureAudio(); clickSound();
  setCollapsed(!kb.classList.contains('sf-collapsed'));
});

// — voice mode switch —
function enterVoiceMode() {
  voiceMode = true;
  keysEl.style.display = 'none';
  voicePanel.style.display = 'flex';
  renderVoice('', 'live');
}
function exitVoiceMode() {
  voiceMode = false;
  clearTimeout(revertTimer);
  voicePanel.style.display = 'none';
  voicePanel.classList.remove('listening');
  keysEl.style.display = 'flex';
  // Phím Voice bị ẩn ngay giữa lúc 'pressed' (keysEl display:none nên không
  // nhận pointerup) → xoá trạng thái pressed sót lại khi quay về keypad.
  keysEl.querySelectorAll('.sf-key.sf-pressed').forEach(k => k.classList.remove('sf-pressed'));
}
function toggleVoice() {
  if (voiceMode) { stopListening(); exitVoiceMode(); return; }
  if (!voiceSupported) { toast('Trình duyệt không hỗ trợ giọng nói'); return; }
  if (kb.classList.contains('sf-collapsed')) setCollapsed(false);
  enterVoiceMode();
  startListening();
}

vExit.addEventListener('pointerdown', e => {
  e.preventDefault();
  ensureAudio(); clickSound();
  stopListening();
  exitVoiceMode();
});

// ============================================================
// SECTION 9 — KEY ACTIONS
// ============================================================

function doAction(id) {
  if (id === 'prefix')      insertAtCaret(awbPrefix());
  else if (id === 'done')   fireDoubleCtrl();
  else if (id[0] === 'd')   insertAtCaret(id.slice(1));
  else if (id === 'back')   backspaceAtCaret();
  else if (id === 'clear')  clearInput();
  else if (id === 'enter')  pressEnter();
  else if (id === 'print')  firePrintAll();
  else if (id === 'voice')  toggleVoice();
}

// pointerdown: preventDefault để KHÔNG cướp focus khỏi ô input.
keysEl.addEventListener('pointerdown', e => {
  const key = e.target.closest('.sf-key');
  if (!key || key.dataset.disabled === '1') return;
  e.preventDefault();
  ensureAudio();
  clickSound();
  ripple(key, e.clientX, e.clientY);
  key.classList.add('sf-pressed');
  doAction(key.dataset.k);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
  keysEl.addEventListener(ev, e => {
    const key = e.target.closest('.sf-key');
    if (key) key.classList.remove('sf-pressed');
  })
);
// Phòng con trỏ rời phím khi đang giữ.
keysEl.addEventListener('pointermove', e => {
  if (e.buttons === 0) return;
  const key = e.target.closest('.sf-key');
  keysEl.querySelectorAll('.sf-key.sf-pressed').forEach(k => {
    if (k !== key) k.classList.remove('sf-pressed');
  });
});

// ============================================================
// SECTION 10 — MOUNT / SCOPE (chỉ trang scan job)
// ============================================================

let _visibleNow = false;
function updateVisibility() {
  const has = !!getTargetInput();
  if (has === _visibleNow) return;
  _visibleNow = has;
  kb.style.display      = has ? 'block' : 'none';
  toastEl.style.display = has ? 'block' : 'none';
  if (!has) {
    if (listening) stopListening();
    if (voiceMode) exitVoiceMode();
  }
}
kb.style.display      = 'none';
toastEl.style.display = 'none';
updateVisibility();

let _visTimer = null;
const visObserver = new MutationObserver(() => {
  clearTimeout(_visTimer);
  _visTimer = setTimeout(updateVisibility, 200);
});
visObserver.observe(document.body, {
  childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class']
});

// SPA navigation — patch history (pattern scan-job.user.js).
['pushState', 'replaceState'].forEach(m => {
  const orig = history[m];
  history[m] = function (...args) {
    const r = orig.apply(this, args);
    setTimeout(updateVisibility, 60);
    return r;
  };
});
window.addEventListener('popstate', () => setTimeout(updateVisibility, 60));

console.log('[SPX] SF Keyboard v1.7 loaded — touch keypad + voice' +
            (voiceSupported ? '' : ' (SpeechRecognition không hỗ trợ → phím Voice tắt)'));
})();
