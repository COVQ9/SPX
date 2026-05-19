// ==UserScript==
// @name         Scan Job
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/scan-job.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/scan-job.user.js
// @version      3.6
// @description  All-in-one: error sounds (IDB cache + 24h freshness), auto-focus (scan-page-scoped), head-n-tail typing, R3/R4 popups, Alt+P print — operator-aware audio, event-driven SPA
// @match        https://sp.spx.shopee.vn/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
'use strict';

// Skip inside iframes. find-details creates a hidden iframe pointing at
// /awb-printing for the eye-preview pipeline; without this guard, scan-job
// loads inside that iframe and plays welcome.mp3 on every eye click (each
// fresh iframe = fresh audio context → tryUnlockAudio fires welcome).
// scan-job's features (welcome, scan focus, R3/R4 popups, Alt+P) are all
// human-facing on the top tab — nothing in an iframe needs them.
if (window.top !== window) return;

// Shared audio queue — stored on document.documentElement so it is accessible
// from all scripts regardless of @grant sandbox level (window is a proxy in
// @grant GM_* scripts and does NOT share properties with @grant none scripts).
const _docEl = document.documentElement;
if (!_docEl._spxEnqueueSound) {
  _docEl._spxEnqueueSound = function(playFn) {
    _docEl._spxAudioQueue = (_docEl._spxAudioQueue || Promise.resolve())
      .then(() => playFn())
      .catch(() => {});
  };
}

// ============================================================
// SECTION 1 — CONSTANTS
// ============================================================

const GH             = "https://github.com/tasuaongvang/spx/raw/refs/heads/main/";
const SILENT_URL     = "https://github.com/anars/blank-audio/raw/master/1-second-of-silence.mp3";
const SILENT_KEY     = "audio_silent";
const DEFAULT_SUFFIX = 'tsov';
const FRESH_WINDOW   = 24 * 60 * 60 * 1000; // 24h

let _silentSrc = SILENT_URL;

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
// SECTION 2 — AUDIO CACHE (IndexedDB + GM CORS bypass)
// ============================================================
// Records: { blob, etag, checkedAt }. ETag round-trip is skipped while
// `Date.now() - checkedAt < FRESH_WINDOW` — saves ~19 network requests
// per warm page load.

const IDB_NAME  = 'spx_audio';
const IDB_STORE = 'mp3';

function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function idbGet(key) {
  return idbOpen().then(db => new Promise((res, rej) => {
    const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    r.onsuccess = () => { res(r.result); db.close(); };
    r.onerror   = () => { rej(r.error);  db.close(); };
  }));
}

function idbPut(key, val) {
  return idbOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => { res();         db.close(); };
    tx.onerror    = () => { rej(tx.error); db.close(); };
  }));
}

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
      onerror() { resolve({ status: 0 }); }
    });
  });
}

async function loadFromCache(audioEl, key) {
  const cached = await idbGet(key).catch(() => null);
  if (cached?.blob) audioEl.src = URL.createObjectURL(cached.blob);
  return cached;
}

function refreshFromNetwork(audioEl, key, url, cached, delay = 0) {
  // Skip ETag round-trip if cache is fresh
  if (cached?.checkedAt && Date.now() - cached.checkedAt < FRESH_WINDOW) return;
  setTimeout(async () => {
    const r = await gmFetchBlob(url, cached?.etag);
    const now = Date.now();
    if (r.status === 304 && cached) {
      const _rec304 = { ...cached, checkedAt: now };
      idbPut(key, _rec304)
        .then(() => window.NeonSync?.coldSync('spx_audio_cache', key, _rec304))
        .catch(e => console.warn('[SPX] IDB checkedAt write failed', key, e));
      return;
    }
    if (r.status !== 200) return;
    const old = audioEl.src;
    audioEl.src = URL.createObjectURL(r.blob);
    if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
    const _rec200 = { blob: r.blob, etag: r.etag, checkedAt: now };
    idbPut(key, _rec200)
      .then(() => window.NeonSync?.coldSync('spx_audio_cache', key, _rec200))
      .catch(e => console.warn('[SPX] IDB write failed', key, e));
  }, delay);
}

// ---- Silent file pre-cache ----
(async () => {
  const cached = await idbGet(SILENT_KEY).catch(() => null);
  if (cached?.blob) _silentSrc = URL.createObjectURL(cached.blob);
  if (cached?.checkedAt && Date.now() - cached.checkedAt < FRESH_WINDOW) return;

  const r = await gmFetchBlob(SILENT_URL, cached?.etag);
  const now = Date.now();
  if (r.status === 304 && cached) {
    const _silRec304 = { ...cached, checkedAt: now };
    idbPut(SILENT_KEY, _silRec304)
      .then(() => window.NeonSync?.coldSync('spx_audio_cache', SILENT_KEY, _silRec304))
      .catch(() => {});
    return;
  }
  if (r.status !== 200) return;
  const old = _silentSrc;
  _silentSrc = URL.createObjectURL(r.blob);
  if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
  const _silRec200 = { blob: r.blob, etag: r.etag, checkedAt: now };
  idbPut(SILENT_KEY, _silRec200)
    .then(() => window.NeonSync?.coldSync('spx_audio_cache', SILENT_KEY, _silRec200))
    .catch(e => console.warn('[SPX] IDB write failed', SILENT_KEY, e));
})();

// ============================================================
// SECTION 3 — SHARED AUDIO STATE
// ============================================================

let audioUnlocked      = false;
let soundEnabled       = true;
let operatorAudioReady = false;
let welcomePending     = false;

const welcomeAudio = new Audio();
const rokAudio     = new Audio();

const SFX = {};
COMMON_FILES.forEach(f => { SFX[f] = new Audio(); });
COMMON_FILES.forEach(async (f, i) => {
  const cached = await loadFromCache(SFX[f], f);
  refreshFromNetwork(SFX[f], f, GH + f, cached, i * 150);
});

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
  { pattern: /^X$/,                                        audio: SFX["slowdown.mp3"]         },
  { pattern: /ready!/i,                                    audio: SFX["ready.mp3"]            },
  { pattern: /service point server error/i,                audio: SFX["network.mp3"]          },
];

// ============================================================
// SECTION 4 — OPERATOR DETECTION (cached 24h)
// ============================================================

const OPERATOR_KEY = 'operator_suffix';

async function detectOperator() {
  const cached = await idbGet(OPERATOR_KEY).catch(() => null);
  if (cached?.suffix && Date.now() - cached.checkedAt < FRESH_WINDOW) {
    return cached.suffix;
  }

  let suffix = DEFAULT_SUFFIX;
  try {
    const res   = await fetch('/sp-api/current_user?ignore_point_list_flag=true');
    const json  = await res.json();
    const email = (json?.data?.email || json?.data?.account || json?.email || json?.account || '').toLowerCase().trim();
    suffix = OPERATOR_MAP[email] || DEFAULT_SUFFIX;
  } catch {}

  const _opRec = { suffix, checkedAt: Date.now() };
  idbPut(OPERATOR_KEY, _opRec)
    .then(() => window.NeonSync?.coldSync('spx_audio_cache', OPERATOR_KEY, _opRec))
    .catch(() => {});
  return suffix;
}

async function initOperatorAudio() {
  const suffix      = await detectOperator();
  const welcomeFile = `welcome_${suffix}.mp3`;
  const rokFile     = `rok_${suffix}.mp3`;

  const [wCached, rCached] = await Promise.all([
    loadFromCache(welcomeAudio, welcomeFile),
    loadFromCache(rokAudio,     rokFile),
  ]);

  operatorAudioReady = true;
  if (welcomePending && audioUnlocked) {
    playAudio(welcomeAudio);
    welcomePending = false;
  }

  refreshFromNetwork(welcomeAudio, welcomeFile, GH + welcomeFile, wCached, 0);
  refreshFromNetwork(rokAudio,     rokFile,     GH + rokFile,     rCached, 200);
}

initOperatorAudio();

// ============================================================
// SECTION 5 — AUDIO ENGINE
// ============================================================

function playAudio(audioObj, _retries = 20) {
  if (!soundEnabled) return;
  if (!audioObj.src || !audioUnlocked) {
    if (_retries > 0) setTimeout(() => playAudio(audioObj, _retries - 1), 150);
    return;
  }
  _docEl._spxEnqueueSound(() => new Promise(resolve => {
    audioObj.currentTime = 0;
    const done = () => { audioObj.onended = null; audioObj.onerror = null; resolve(); };
    audioObj.onended = done;
    audioObj.onerror = done;
    try { audioObj.play().catch(done); } catch { done(); }
  }));
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

// Block Shopee's success-alert sound
const _origPlay = HTMLAudioElement.prototype.play;
HTMLAudioElement.prototype.play = function () {
  if (this.src?.includes("success-alert")) return Promise.resolve();
  return _origPlay.call(this);
};

// ============================================================
// SECTION 6 — SPEAKER BUTTON (cached ref, no hot-path queries)
// ============================================================

let _speakerBtn = null;

function updateSpeakerIcon() {
  if (!_speakerBtn) return;
  _speakerBtn.textContent = !audioUnlocked ? "🔇" : soundEnabled ? "🔊" : "🔈";
}

function createSpeaker() {
  if (_speakerBtn?.isConnected) return;
  const section = document.querySelector("section.order-input");
  if (!section) return;
  const existing = section.querySelector(".spx-speaker");
  if (existing) { _speakerBtn = existing; updateSpeakerIcon(); return; }

  const btn = document.createElement("div");
  btn.className = "spx-speaker";
  btn.title     = "Âm thanh";
  btn.style.cssText =
    "display:inline-flex;align-items:center;justify-content:center;" +
    "width:28px;height:28px;margin-left:8px;border-radius:50%;" +
    "background:#fff;border:1px solid #ccc;cursor:pointer;font-size:18px;" +
    "box-shadow:0 0 4px rgba(0,0,0,0.2);user-select:none;z-index:9999;";

  section.style.display    = "flex";
  section.style.alignItems = "center";
  section.appendChild(btn);

  btn.onclick = () => {
    if (!audioUnlocked) { tryUnlockAudio(); return; }
    soundEnabled = !soundEnabled;
    updateSpeakerIcon();
  };

  _speakerBtn = btn;
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
  // textContent: no reflow (innerText forces layout)
  const msg = node.textContent.trim();
  if (_skipPatterns.some(r => r.test(msg))) return;
  for (const rule of errorSounds) {
    if (rule.pattern.test(msg)) { playAudio(rule.audio); return; }
  }
}

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
// SECTION 8 — AUTO-FOCUS INPUT (event-driven + safety net)
// ============================================================

function refocusInput() {
  const popup      = document.querySelector('.ssc-message-box-content');
  const confirmBtn = document.querySelector('.ssc-message-box-action-button.ssc-btn-type-primary');
  if (popup && confirmBtn) {
    if (document.activeElement !== confirmBtn) confirmBtn.focus();
    return;
  }

  // Strict scope: only enforce focus on the Scan Tracking Number page.
  // Without this guard we hijack focus from every input on every URL, which
  // blocks global hotkeys in sibling scripts (open-2-end double-ctrl, etc.)
  // because their keydown handlers bail when target is an INPUT.
  let input = _scanInput;
  if (!input?.isConnected || !input.closest?.('section.order-input')) {
    const orderSection = document.querySelector('section.order-input');
    if (!orderSection) return; // not on scan page → leave focus alone
    input = orderSection.querySelector('.ssc-input input');
    if (input) _scanInput = input; // cache for next call
  }
  if (input && document.activeElement !== input) input.focus();
}

let _refocusPending = false;
document.addEventListener('focusout', () => {
  if (_refocusPending) return;
  _refocusPending = true;
  setTimeout(() => {
    _refocusPending = false;
    if (document.activeElement === document.body || !document.activeElement) refocusInput();
  }, 50);
});

// Safety net: catch silent focus moves from Shopee's SPA renders
setInterval(refocusInput, 1500);

// ============================================================
// SECTION 9 — HEAD-N-TAIL TYPING
// ============================================================

function computeExtraChar() {
  const m = new Date().getMonth() + 1;
  if (m <= 9)   return String(m);
  if (m === 10) return 'A';
  if (m === 11) return 'B';
  return 'C';
}

let _extraChar = computeExtraChar();
setInterval(() => { _extraChar = computeExtraChar(); }, 60 * 60 * 1000); // refresh hourly

let _hntSuspend = false;
let _scanInput  = null; // cached for refocus + R3 (avoid querySelectorAll churn)

function attachHeadNTail(input) {
  if (!input || input.dataset.headtailAttached) return;
  input.dataset.headtailAttached = "1";
  // Cache only if it's the actual scan input — other Shopee pages have
  // 'Please Input' placeholders too; we don't want refocus to chase them.
  if (input.closest('section.order-input')) _scanInput = input;

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
    if (delta <= SCANNER_THRESHOLD) return;

    let value   = input.value;
    const extra = _extraChar;

    if (value.includes('++') || value.includes('..')) {
      const replaced = value.replace(/\+\+|\.\./g, 'SPXVN06');
      if (replaced !== value) {
        input.value = replaced;
        input.setSelectionRange(replaced.length, replaced.length);
        value = replaced;
      }
    }

    if (/^\d{9}$/.test(value)) {
      const newVal = 'SPXVN06' + value + extra;
      input.value  = newVal;
      input.setSelectionRange(newVal.length, newVal.length);
      extraAppended = true;
      overwriteNext = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    const cursorPos = input.selectionStart;
    const upper     = value.toUpperCase();
    if (upper !== value) {
      input.value = upper;
      input.setSelectionRange(cursorPos, cursorPos);
      value = upper;
    }

    if (!extraAppended && value.length === 16 && !value.endsWith(extra)) {
      input.value   = value + extra;
      extraAppended = true;
      overwriteNext = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

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
  popup.style.cssText =
    `position:absolute;right:${rightOffset};top:50%;transform:translateY(-50%);` +
    'background:rgba(0,0,0,0.85);color:#fff;padding:6px 14px;font-size:18px;' +
    'border-radius:8px;font-weight:bold;text-align:center;z-index:10;' +
    'white-space:nowrap;box-shadow:0 0 8px rgba(0,0,0,0.3);' +
    'opacity:0;transition:opacity 0.2s ease;';
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
let _r3Pending     = false;
let _r3LastTrigger = 0;
const R3_COOLDOWN  = 1200;

function isVisible(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function isSenderNameEmpty() {
  for (const section of document.querySelectorAll('.task-info-content-base-item')) {
    const label   = section.querySelector('.task-info-content-base-item-label');
    const content = section.querySelector('.task-info-content-base-item-content');
    if (label?.textContent.includes('Sender Name')) {
      // innerText (1 reflow) > recursive getComputedStyle (N reflows)
      return content?.innerText.trim() === '';
    }
  }
  return false;
}

function checkR3() {
  const placeholder   = document.querySelector('.ssc-table-empty-placeholder');
  const placeholderOK = placeholder && isVisible(placeholder)
    && placeholder.querySelector('p')?.textContent.trim() === 'No Data';

  // Use cached scan input if still in DOM, else fall back to query
  const input = _scanInput?.isConnected && isVisible(_scanInput)
    ? _scanInput
    : Array.from(document.querySelectorAll('input[placeholder="Please Input"]')).find(isVisible);

  const conditionNow = !!(placeholderOK && input && isSenderNameEmpty());
  const now          = performance.now();

  if (conditionNow && !_r3PrevTrue && now - _r3LastTrigger > R3_COOLDOWN) {
    _r3LastTrigger = now;
    showLabelPopup(input, 'R3', 'r3-popup', '-191px');
  }
  _r3PrevTrue = conditionNow;
}

// Flag-based debounce (no clearTimeout/setTimeout thrash)
function debouncedR3() {
  if (_r3Pending) return;
  _r3Pending = true;
  setTimeout(() => { _r3Pending = false; checkR3(); }, 300);
}

// ============================================================
// SECTION 12 — R4 POPUP + X guard
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
    xBox.style.cssText =
      `position:absolute;right:0;top:0;height:${h}px;width:${h}px;line-height:${h}px;` +
      'text-align:center;color:#fff;background:#f5222d;border-radius:2px;' +
      'font-weight:bold;cursor:pointer;';
    xBox.innerText = 'X';
    xBox.addEventListener('click', () => { input.value = ''; xBox.remove(); input.focus(); });
    parentDiv.appendChild(xBox);
    setTimeout(() => { xBox.remove(); xVisible = false; }, 700);
  }

  input.addEventListener('input', () => {
    if (input.value.length > 17) {
      input.value = input.value.slice(0, 17);
      showX();
    }
  });

  showLabelPopup(input, 'R4', 'r4-popup', '-261px');
}

function tryAttachR4() {
  const inp = document.querySelector('.order-input input');
  if (inp) attachR4(inp);
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
  // 'in tem' = find-details relabelled display text; 'Print' = SPX native fallback.
  const buttons = Array.from(
    document.querySelectorAll('button.ssc-button.ssc-btn-type-text')
  ).filter(b => { const t = b.textContent.trim(); return t === 'Print' || t === 'in tem'; });
  const total = buttons.length;
  if (total === 0) { alert('No Print buttons found!'); return; }

  let count = 0;
  const popup = document.createElement('div');
  popup.style.cssText =
    'position:fixed;top:2%;left:68%;transform:translateX(-50%);' +
    'background:rgba(255,255,255,0.9);border:2px solid #1890ff;' +
    'padding:25px 40px;font-size:20px;color:#333;z-index:9999;' +
    'border-radius:14px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.25);' +
    "font-family:'Inter','Segoe UI','Helvetica Neue',Arial,sans-serif;";
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

  const seenToasts = new WeakSet();
  document.querySelectorAll('div.ssc-message .ssc-message-content')
    .forEach(n => seenToasts.add(n));

  function waitForFreshToast(containsText, timeoutMs = 8000) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs);

      const check = () => {
        for (const node of document.querySelectorAll('div.ssc-message .ssc-message-content')) {
          if (seenToasts.has(node)) continue;
          if (!node.textContent.includes(containsText)) continue;
          seenToasts.add(node);
          clearTimeout(timer);
          obs.disconnect();
          resolve();
          return true;
        }
        return false;
      };

      if (check()) return;

      const obs = new MutationObserver(() => check());
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  // Bottom-up iteration: in row cuối list trước → label đầu list ở đỉnh stack
  // (thermal printer eject upward → top of tray = last printed). User pick top
  // label → ghép order đầu list, đóng gói tuần tự theo list order.
  for (let i = buttons.length - 1; i >= 0; i--) {
    const btn = buttons[i];
    btn.scrollIntoView({ block: 'center' });
    await wait(80);
    btn.click();
    await waitForFreshToast('Printed Successfully');
    count++;
    statusLine.textContent = count < total ? 'đang nhấn nút Print ...' : 'đã nhấn hết';
    countNum.textContent   = count;
  }

  waitLine.textContent = 'vẫn phải chờ nha bé ...';
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
// SECTION 14 — SPA NAVIGATION (event-driven, no polling)
// ============================================================

const _spaListeners = [];
function onSpaNav(cb) { _spaListeners.push(cb); }

function _fireSpaNav() {
  for (const cb of _spaListeners) {
    try { cb(); } catch (e) { console.warn('[SPX] spa nav cb', e); }
  }
}

['pushState', 'replaceState'].forEach(m => {
  const orig = history[m];
  history[m] = function (...args) {
    const r = orig.apply(this, args);
    _fireSpaNav();
    return r;
  };
});
window.addEventListener('popstate', _fireSpaNav);

onSpaNav(() => {
  _r3PrevTrue = false;
  _scanInput  = null; // input may be replaced after navigation
  // Clear R4 guard so we re-attach on (possibly reused) new-page input
  document.querySelector('.order-input input')?.removeAttribute('data-guard-attached');
  setTimeout(() => { checkR3(); tryAttachR4(); }, 1000);
});

// ============================================================
// SECTION 15 — UNIFIED OBSERVER (rAF-throttled, addedNodes-only)
// ============================================================

scanHeadNTailInputs();
createSpeaker();
checkR3();
tryAttachR4();

let _obsScheduled = false;
let _pendingMuts  = [];

function flushMutations() {
  _obsScheduled = false;
  const mutations = _pendingMuts;
  _pendingMuts = [];

  // Speaker: cheap fast-path if already cached
  if (!_speakerBtn?.isConnected) createSpeaker();

  scanToastNodes(mutations);

  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;

      if (node.matches('input[placeholder="Please Input"], input[placeholder="Please input or Scan"]')) {
        attachHeadNTail(node);
        if (node.closest('.order-input')) attachR4(node);
        continue;
      }

      // Heuristic: skip leaf text/icon nodes; only descend if the subtree
      // could plausibly contain an input.
      if (node.childElementCount > 0 && node.querySelector) {
        scanHeadNTailInputs(node);
        const r4Input = node.querySelector('.order-input input');
        if (r4Input) attachR4(r4Input);
      }
    }
  }

  debouncedR3();
}

const _MAX_PENDING = 2000; // safety cap if rAF is throttled (background tab)

const _mainObserver = new MutationObserver(mutations => {
  // Skip mutation batches with no added nodes (attribute/text changes).
  // Vue/React fire many of these — early-return saves CPU.
  let hasAdd = false;
  for (let i = 0; i < mutations.length; i++) {
    if (mutations[i].addedNodes.length) { hasAdd = true; break; }
  }
  if (!hasAdd) return;

  // Push, but cap to avoid retaining thousands of MutationRecord refs in
  // background tabs where rAF is throttled. Older entries get dropped.
  for (const m of mutations) _pendingMuts.push(m);
  if (_pendingMuts.length > _MAX_PENDING) {
    _pendingMuts.splice(0, _pendingMuts.length - _MAX_PENDING);
  }

  if (!_obsScheduled) {
    _obsScheduled = true;
    requestAnimationFrame(flushMutations);
  }
});

_mainObserver.observe(document.body, { childList: true, subtree: true });

console.log('[SPX] scan-job v3.6 loaded');
})();
