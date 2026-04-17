// ==UserScript==
// @name         Scan Job
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/Scan%20Job.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/Scan%20Job.user.js
// @version      2.7
// @description  All-in-one: error sounds (offline cache), auto-focus, head-n-tail typing, R3/R4 popups, Alt+P print — operator-aware audio
// @match        https://sp.spx.shopee.vn/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
'use strict';

// ============================================================
// SECTION 1 — CONSTANTS
// ============================================================

const GH             = "https://github.com/tasuaongvang/spx/raw/refs/heads/main/";
const SILENT_URL     = "https://github.com/anars/blank-audio/raw/master/1-second-of-silence.mp3";
const SILENT_KEY     = "audio_silent";
const DEFAULT_SUFFIX = 'tsov';

// Pre-cache the silence file (different domain, handled separately)
const _silentCache = GM_getValue(SILENT_KEY, null);
let _silentSrc = _silentCache?.data || SILENT_URL;
{
  const _sh = _silentCache?.etag ? { 'If-None-Match': _silentCache.etag } : {};
  GM_xmlhttpRequest({
    method: 'GET', url: SILENT_URL, headers: _sh, responseType: 'arraybuffer',
    onload(r) {
      if (r.status === 200) {
        const d = 'data:audio/mp3;base64,' + toBase64(new Uint8Array(r.response));
        const e = r.responseHeaders.match(/etag:\s*(.+)/i)?.[1]?.trim() || null;
        GM_setValue(SILENT_KEY, { etag: e, data: d });
        _silentSrc = d;
      }
    }
  });
}

const OPERATOR_MAP = {
  'tasua.ongvang@gmail.com':   'tsov',
  'con.ong.vang.q9@gmail.com': 'covq9',
};

const COMMON_FILES = [
  "not-created.mp3", "pending-canceled.mp3", "too-many.mp3",
  "invalid-scan.mp3", "not-found.mp3", "in-other-task.mp3",
  "already-scanned.mp3", "picked-up.mp3", "done.mp3",
  "fire1.mp3", "fire2.mp3", "missed.mp3", "slowdown.mp3",
  "ready.mp3", "network.mp3", "turn-off-printer.mp3"
];

// ============================================================
// SECTION 2 — GM AUDIO CACHE
// ============================================================

// Uint8Array → base64 (chunked to avoid stack overflow on large files)
function toBase64(arr) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk)
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  return btoa(bin);
}

// Fetch from GitHub with ETag caching.
// Resolves with a fresh or cached data: URI.
function gmFetch(filename, cached) {
  return new Promise(resolve => {
    const headers = {};
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    GM_xmlhttpRequest({
      method: 'GET',
      url: GH + filename,
      headers,
      responseType: 'arraybuffer',
      onload(resp) {
        if (resp.status === 304 && cached?.data) {
          resolve(cached.data);
        } else if (resp.status === 200) {
          const dataUrl = 'data:audio/mp3;base64,' + toBase64(new Uint8Array(resp.response));
          const etag    = resp.responseHeaders.match(/etag:\s*(.+)/i)?.[1]?.trim() || null;
          GM_setValue('audio_' + filename, { etag, data: dataUrl });
          resolve(dataUrl);
        } else {
          resolve(cached?.data || GH + filename); // fallback
        }
      },
      onerror() { resolve(cached?.data || GH + filename); }
    });
  });
}

// Build an Audio from GM cache immediately (sync).
// Pass the cached object in so GM_getValue is called only once per file.
function buildAudio(filename) {
  const cached = GM_getValue('audio_' + filename, null);
  const audio  = new Audio();
  if (cached?.data) audio.src = cached.data;
  return { audio, cached }; // return cached so background fetch can reuse it
}

// ============================================================
// SECTION 3 — SHARED AUDIO STATE
// ============================================================

let audioUnlocked     = false;
let soundEnabled      = true;
let operatorAudioReady = false; // true once welcome/rok src are set
let welcomePending    = false;  // play welcome as soon as operatorAudioReady & audioUnlocked

const welcomeAudio = new Audio();
const rokAudio     = new Audio();

// Build common SFX from cache immediately, stagger ETag checks in background
const SFX = {};
COMMON_FILES.forEach((f, i) => {
  const { audio, cached } = buildAudio(f);
  SFX[f] = audio;
  // Stagger background ETag validation: 1 request every 150ms
  setTimeout(() => {
    gmFetch(f, cached).then(d => { if (SFX[f].src !== d) SFX[f].src = d; });
  }, i * 150);
});

// Error sound rules
const errorSounds = [
  { pattern: /Received Successfully/i,                     audio: rokAudio                    },
  { pattern: /order is not created status/i,               audio: SFX["not-created.mp3"]      },
  { pattern: /order pending canceled/i,                    audio: SFX["pending-canceled.mp3"] },
  { pattern: /too many orders for this receive task/i,     audio: SFX["too-many.mp3"]         },
  { pattern: /please input a valid scan tracking number/i, audio: SFX["invalid-scan.mp3"]     },
  { pattern: /fleetorder not found/i,                      audio: SFX["not-found.mp3"]        },
  { pattern: /already been scanned/i,                      audio: SFX["in-other-task.mp3"]    },
  { pattern: /order exists already/i,                      audio: SFX["already-scanned.mp3"]  },
  { pattern: /order picked up already/i,                   audio: SFX["picked-up.mp3"]        },
  { pattern: /completed successfully/i,                    audio: SFX["done.mp3"]             },
  { pattern: /R1/i,                                        audio: SFX["fire1.mp3"]            },
  { pattern: /R3/i,                                        audio: SFX["fire2.mp3"]            },
  { pattern: /just missed!/i,                              audio: SFX["missed.mp3"]           },
  { pattern: /^X$/,                                         audio: SFX["slowdown.mp3"]         },
  { pattern: /ready!/i,                                    audio: SFX["ready.mp3"]            },
  { pattern: /service point server error/i,                audio: SFX["network.mp3"]          },
];

// ============================================================
// SECTION 4 — OPERATOR DETECTION
// ============================================================

async function detectOperator() {
  try {
    const res   = await fetch('/sp-api/current_user?ignore_point_list_flag=true');
    const json  = await res.json();
    const email = (json?.data?.email || json?.data?.account || json?.email || json?.account || '').toLowerCase().trim();
    return OPERATOR_MAP[email] || DEFAULT_SUFFIX;
  } catch {
    return DEFAULT_SUFFIX;
  }
}

async function initOperatorAudio() {
  const suffix      = await detectOperator();
  const welcomeFile = `welcome_${suffix}.mp3`;
  const rokFile     = `rok_${suffix}.mp3`;

  // Load from cache immediately (sync, single GM_getValue per file)
  const wEntry = GM_getValue('audio_' + welcomeFile, null);
  const rEntry = GM_getValue('audio_' + rokFile,     null);
  if (wEntry?.data) welcomeAudio.src = wEntry.data;
  if (rEntry?.data) rokAudio.src     = rEntry.data;

  // Mark ready — welcome can now play if audio is already unlocked
  operatorAudioReady = true;
  if (welcomePending && audioUnlocked) {
    playAudio(welcomeAudio);
    welcomePending = false;
  }

  // Background ETag checks (staggered, reuse already-read cache entries)
  gmFetch(welcomeFile, wEntry).then(d => { if (welcomeAudio.src !== d) welcomeAudio.src = d; });
  setTimeout(() => {
    gmFetch(rokFile, rEntry).then(d => { if (rokAudio.src !== d) rokAudio.src = d; });
  }, 200);
}

initOperatorAudio(); // fire & forget

// ============================================================
// SECTION 5 — AUDIO ENGINE
// ============================================================

function playAudio(audioObj, _retries = 20) {
  if (!soundEnabled || !audioObj.src) return;
  if (!audioUnlocked) {
    if (_retries > 0) setTimeout(() => playAudio(audioObj, _retries - 1), 150);
    return;
  }
  try { audioObj.currentTime = 0; audioObj.play(); } catch {}
}

function tryUnlockAudio() {
  if (audioUnlocked) return;
  new Audio(_silentSrc).play()?.then(() => {
    audioUnlocked = true;
    if (window._spxSkipWelcome) {
      window._spxSkipWelcome = false;
    } else if (operatorAudioReady) {
      playAudio(welcomeAudio);
    } else {
      welcomePending = true;
    }
    updateSpeakerIcon();
  }).catch(() => setTimeout(tryUnlockAudio, 500));
}

window.addEventListener("click",   tryUnlockAudio, { once: true });
window.addEventListener("keydown", tryUnlockAudio, { once: true });
tryUnlockAudio();

// Block Shopee's own success-alert sound
const _origPlay = HTMLAudioElement.prototype.play;
HTMLAudioElement.prototype.play = function () {
  if (this.src?.includes("success-alert")) return Promise.resolve();
  return _origPlay.call(this);
};

// ============================================================
// SECTION 6 — SPEAKER BUTTON
// ============================================================

function updateSpeakerIcon() {
  const btn = document.querySelector(".spx-speaker");
  if (!btn) return;
  btn.textContent = !audioUnlocked ? "🔇" : soundEnabled ? "🔊" : "🔈";
}

function createSpeaker() {
  const section = document.querySelector("section.order-input");
  if (!section || section.querySelector(".spx-speaker")) return;

  const btn = document.createElement("div");
  btn.className = "spx-speaker";
  btn.title     = "Âm thanh";
  Object.assign(btn.style, {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: "28px", height: "28px", marginLeft: "8px",
    borderRadius: "50%", background: "#fff", border: "1px solid #ccc",
    cursor: "pointer", fontSize: "18px",
    boxShadow: "0 0 4px rgba(0,0,0,0.2)", userSelect: "none", zIndex: 9999
  });

  section.style.display    = "flex";
  section.style.alignItems = "center";
  section.appendChild(btn);

  btn.onclick = () => {
    if (!audioUnlocked) { tryUnlockAudio(); return; }
    soundEnabled = !soundEnabled;
    updateSpeakerIcon();
  };

  updateSpeakerIcon();
}

// ============================================================
// SECTION 7 — TOAST SOUND HANDLER
// ============================================================

const _playedNodes  = new WeakSet();
const _skipPatterns = [/printed successfully/i];

function handleToastNode(node) {
  if (_playedNodes.has(node)) return;
  _playedNodes.add(node);
  const msg = node.innerText.trim();
  if (_skipPatterns.some(r => r.test(msg))) return;
  for (const rule of errorSounds) {
    if (rule.pattern.test(msg)) { playAudio(rule.audio); return; }
  }
}

// Only scan nodes added in this mutation batch — not the entire document
function scanToastNodes(mutations) {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches('.ssc-message-content, .ssc-message-tutu')) {
        handleToastNode(node);
      } else {
        node.querySelectorAll('.ssc-message-content, .ssc-message-tutu')
            .forEach(handleToastNode);
      }
    }
  }
}

// ============================================================
// SECTION 8 — AUTO-FOCUS INPUT (pause on confirm popup)
// ============================================================

function refocusInput() {
  const popup      = document.querySelector('.ssc-message-box-content');
  const confirmBtn = document.querySelector('.ssc-message-box-action-button.ssc-btn-type-primary');
  if (popup && confirmBtn) {
    if (document.activeElement !== confirmBtn) confirmBtn.focus();
    return;
  }
  const input = document.querySelector('section.order-input .ssc-input input');
  if (input && document.activeElement !== input) input.focus();
}

setInterval(refocusInput, 500);

// ============================================================
// SECTION 9 — HEAD-N-TAIL TYPING
// ============================================================

function getExtraChar() {
  const m = new Date().getMonth() + 1;
  if (m <= 9)   return String(m);
  if (m === 10) return 'A';
  if (m === 11) return 'B';
  return 'C'; // December
}

let _hntSuspend = false;

function attachHeadNTail(input) {
  if (!input || input.dataset.headtailAttached) return;
  input.dataset.headtailAttached = "1";

  let lastInputTime = Date.now();
  let extraAppended = false;
  let overwriteNext = false;
  const SCANNER_THRESHOLD = 30;

  input.addEventListener('keydown', e => {
    if (e.key === "Delete" || e.key === "Backspace") {
      _hntSuspend = true;
      setTimeout(() => { _hntSuspend = false; }, 50);
    }
  });

  input.addEventListener('input', () => {
    if (_hntSuspend) return;

    const now   = Date.now();
    const delta = now - lastInputTime;
    lastInputTime = now;
    if (delta <= SCANNER_THRESHOLD) return; // scanner input — skip

    let value   = input.value;
    const extra = getExtraChar();

    // Replace ++ or .. shorthand with SPXVN06
    if (value.includes('++') || value.includes('..')) {
      const replaced = value.replace(/\+\+|\.\./g, 'SPXVN06');
      if (replaced !== value) {
        input.value = replaced;
        input.setSelectionRange(replaced.length, replaced.length);
        value = replaced;
      }
    }

    // Auto-format bare 9-digit codes → SPXVN06{digits}{month}
    if (/^\d{9}$/.test(value)) {
      const newVal = 'SPXVN06' + value + extra;
      input.value  = newVal;
      input.setSelectionRange(newVal.length, newVal.length);
      extraAppended = true;
      overwriteNext = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // Uppercase
    const cursorPos = input.selectionStart;
    const upper     = value.toUpperCase();
    if (upper !== value) {
      input.value = upper;
      input.setSelectionRange(cursorPos, cursorPos);
      value = upper;
    }

    // Auto-append month char at length 16
    if (!extraAppended && value.length === 16 && !value.endsWith(extra)) {
      input.value   = value + extra;
      extraAppended = true;
      overwriteNext = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // If user types another char after auto-append: replace the month char
    if (overwriteNext && value.length >= 17) {
      const lastTyped = value[value.length - 1];
      input.value     = value.slice(0, -2) + lastTyped;
      input.setSelectionRange(input.value.length, input.value.length);
      overwriteNext   = false;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if (value.length < 16) { extraAppended = false; overwriteNext = false; }
  });
}

function scanHeadNTailInputs(root = document) {
  root.querySelectorAll(
    'input[placeholder="Please Input"], input[placeholder="Please input or Scan"]'
  ).forEach(attachHeadNTail);
}

// ============================================================
// SECTION 10 — SHARED LABEL POPUP
// ============================================================

function showLabelPopup(input, label, className, rightOffset) {
  const container = input.closest('.ssc-input');
  if (!container || container.querySelector('.' + className)) return;

  if (window.getComputedStyle(container).position === 'static')
    container.style.position = 'relative';

  const popup = document.createElement('div');
  popup.classList.add('ssc-message-content', className);
  popup.innerText = label;
  Object.assign(popup.style, {
    position: 'absolute', right: rightOffset, top: '50%',
    transform: 'translateY(-50%)',
    background: 'rgba(0,0,0,0.85)', color: '#fff',
    padding: '6px 14px', fontSize: '18px', borderRadius: '8px',
    fontWeight: 'bold', textAlign: 'center', zIndex: '10',
    whiteSpace: 'nowrap', boxShadow: '0 0 8px rgba(0,0,0,0.3)',
    opacity: '0', transition: 'opacity 0.2s ease'
  });
  container.appendChild(popup);
  requestAnimationFrame(() => popup.style.opacity = '1');
  setTimeout(() => {
    popup.style.opacity = '0';
    setTimeout(() => popup.remove(), 200);
  }, 2000);
}

// ============================================================
// SECTION 11 — R3 POPUP (No Data + empty Sender Name)
// ============================================================

let _r3PrevTrue    = false;
let _r3Debounce    = null;
let _r3LastTrigger = 0;
const R3_COOLDOWN  = 1200;

function isVisible(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function getVisibleText(el) {
  if (!el) return '';
  let t = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) t += node.textContent;
    else if (node.nodeType === Node.ELEMENT_NODE && isVisible(node)) t += getVisibleText(node);
  }
  return t.trim();
}

function isSenderNameEmpty() {
  for (const section of document.querySelectorAll('.task-info-content-base-item')) {
    const label   = section.querySelector('.task-info-content-base-item-label');
    const content = section.querySelector('.task-info-content-base-item-content');
    if (label?.textContent.includes('Sender Name')) return getVisibleText(content) === '';
  }
  return false;
}

function checkR3() {
  const placeholder   = document.querySelector('.ssc-table-empty-placeholder');
  const placeholderOK = placeholder && isVisible(placeholder)
    && placeholder.querySelector('p')?.textContent.trim() === 'No Data';

  const input = Array.from(
    document.querySelectorAll('input[placeholder="Please Input"]')
  ).find(isVisible);

  const conditionNow = !!(placeholderOK && input && isSenderNameEmpty());
  const now          = performance.now();

  if (conditionNow && !_r3PrevTrue && now - _r3LastTrigger > R3_COOLDOWN) {
    _r3LastTrigger = now;
    showLabelPopup(input, 'R3', 'r3-popup', '-191px');
  }
  _r3PrevTrue = conditionNow;
}

function debouncedR3() {
  clearTimeout(_r3Debounce);
  _r3Debounce = setTimeout(checkR3, 300);
}

// ============================================================
// SECTION 12 — R4 POPUP + X guard (SPA Safe)
// ============================================================

function attachR4(input) {
  if (!input || input.hasAttribute('data-guard-attached')) return;
  input.setAttribute('data-guard-attached', 'true');

  const parentDiv = input.parentElement;
  parentDiv.style.position = 'relative';

  let xVisible = false;

  function showX() {
    if (xVisible) return;
    xVisible = true;
    parentDiv.querySelector('#tm-warning-x')?.remove();

    const xBox = document.createElement('div');
    xBox.id = 'tm-warning-x';
    xBox.classList.add('ssc-message-tutu');
    const h = input.offsetHeight;
    Object.assign(xBox.style, {
      position: 'absolute', right: '0', top: '0',
      height: h + 'px', width: h + 'px', lineHeight: h + 'px',
      textAlign: 'center', color: '#fff',
      background: '#f5222d', borderRadius: '2px',
      fontWeight: 'bold', cursor: 'pointer'
    });
    xBox.innerText = 'X';
    xBox.addEventListener('click', () => { input.value = ''; xBox.remove(); input.focus(); });
    parentDiv.appendChild(xBox);
    setTimeout(() => { xBox.remove(); xVisible = false; }, 700);
  }

  // BUG FIX: max length is 17 chars; `paste` fires before value updates so
  // use only the `input` event (which fires after both typing and paste).
  input.addEventListener('input', () => {
    if (input.value.length > 17) {
      input.value = input.value.slice(0, 17);
      showX();
    }
  });

  showLabelPopup(input, 'R4', 'r4-popup', '-261px');
}

// ============================================================
// SECTION 13 — ALT+P PRINT ALL
// ============================================================

const _printStyle = document.createElement('style');
_printStyle.textContent = `
  @keyframes spx-shake {
    0%,100% { transform: translateX(0); }
    25%     { transform: translateX(-4px); }
    75%     { transform: translateX(4px); }
  }
  .spx-shake { display: inline-block; animation: spx-shake 0.35s ease-in-out infinite; }
`;
document.head.appendChild(_printStyle);

const wait = ms => new Promise(r => setTimeout(r, ms));

async function printAll() {
  const buttons = Array.from(
    document.querySelectorAll('button.ssc-button.ssc-btn-type-text')
  ).filter(b => b.textContent.trim() === 'Print');
  const total = buttons.length;
  if (total === 0) { alert('No Print buttons found!'); return; }

  let count = 0;
  const popup = document.createElement('div');
  Object.assign(popup.style, {
    position: 'fixed', top: '2%', left: '68%', transform: 'translateX(-50%)',
    background: 'rgba(255,255,255,0.9)', border: '2px solid #1890ff',
    padding: '25px 40px', fontSize: '20px', color: '#333',
    zIndex: 9999, borderRadius: '14px', textAlign: 'center',
    boxShadow: '0 10px 25px rgba(0,0,0,0.25)',
    fontFamily: `'Inter','Segoe UI','Helvetica Neue',Arial,sans-serif`
  });
  popup.innerHTML = `
    <div id="p-status" style="margin-bottom:10px;">từ từ nha ...</div>
    <div style="margin-bottom:15px;font-size:42px;">
      <span id="p-count" style="font-weight:700;color:red;">0</span> / ${total}
    </div>
    <div id="p-wait" style="font-size:20px;color:#555;">chờ chút ...</div>
  `;
  document.body.appendChild(popup);

  const statusLine = popup.querySelector('#p-status');
  const countNum   = popup.querySelector('#p-count');
  const waitLine   = popup.querySelector('#p-wait');

  // Track already-seen toast nodes to avoid false positives from old toasts
  const seenToasts = new WeakSet();
  // Mark all currently existing toasts as "seen" before we start
  document.querySelectorAll('div.ssc-message .ssc-message-content')
    .forEach(n => seenToasts.add(n));

  function waitForFreshToast(containsText, timeoutMs = 8000) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs);

      const check = () => {
        for (const node of document.querySelectorAll('div.ssc-message .ssc-message-content')) {
          if (seenToasts.has(node)) continue;       // skip old toasts
          if (!node.textContent.includes(containsText)) continue;
          seenToasts.add(node);                      // mark as consumed
          clearTimeout(timer);
          obs.disconnect();
          resolve();
          return true;
        }
        return false;
      };

      // Check immediately (toast may have appeared before observer attached)
      if (check()) return;

      const obs = new MutationObserver(() => check());
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  for (const btn of buttons) {
    btn.scrollIntoView({ block: 'center' });        // instant, no smooth animation
    await wait(80);                                   // minimal gap for scroll settle
    btn.click();
    await waitForFreshToast('Printed Successfully');
    count++;
    statusLine.textContent = count < total ? 'đang nhấn nút Print ...' : 'đã nhấn hết';
    countNum.textContent   = count;
  }

  waitLine.textContent = 'vẫn phải chờ nha bé ...';

  // Wait briefly for the last toast to clear
  await wait(2500);

  waitLine.innerHTML =
    'hình như xong r á ‎‎ ↪ ‎‎ <span class="spx-shake" style="color:red;font-weight:bold;">bật ⦿ tắt máy in đi bé ơi</span>';

  const autoTimer = setTimeout(() => {
    playAudio(SFX["turn-off-printer.mp3"]);
    closePopup();
  }, 2000);

  function closePopup() {
    clearTimeout(autoTimer);
    popup.remove();
    document.removeEventListener('click',   closePopup);
    document.removeEventListener('keydown', closePopup);
  }
  document.addEventListener('click',   closePopup);
  document.addEventListener('keydown', closePopup);
}

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 'p') { e.preventDefault(); return; }
  if (e.altKey  && e.key.toLowerCase() === 'p') { e.preventDefault(); printAll(); }
});

// ============================================================
// SECTION 14 — UNIFIED OBSERVER + SINGLE SPA WATCHER
// ============================================================

// Initial scan
scanHeadNTailInputs();
createSpeaker();
checkR3();

const _mainObserver = new MutationObserver(mutations => {
  // Speaker: only create if not yet present (cheap guard)
  createSpeaker();

  // Toast sounds: only scan newly added nodes, not entire document
  scanToastNodes(mutations);

  // Head-n-tail: attach to any new inputs
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches('input[placeholder="Please Input"], input[placeholder="Please input or Scan"]'))
        attachHeadNTail(node);
      else
        scanHeadNTailInputs(node);
    }
  }

  // R3 (debounced — many mutations may fire per page render)
  debouncedR3();
});

_mainObserver.observe(document.body, { childList: true, subtree: true });

// Single interval for all SPA navigation concerns (replaces two separate intervals)
let _lastHref = location.href;

setInterval(() => {
  const newHref = location.href;
  if (newHref !== _lastHref) {
    _lastHref = newHref;
    // R3: reset edge-detection on page change
    _r3PrevTrue = false;
    setTimeout(checkR3, 1000);
    // R4: allow re-attach on new page (pathname changed)
    document.querySelector('.order-input input')?.removeAttribute('data-guard-attached');
  }
  // R4: try to attach on current page (guard prevents double-attach)
  const inp = document.querySelector('.order-input input');
  if (inp) attachR4(inp);
}, 300);

})();