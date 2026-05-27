// ==UserScript==
// @name         Scan Job
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/scan-job.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/scan-job.user.js
// @version      3.22
// @description  All-in-one: error sounds (unified loadAudio cache), auto-focus (scan-page-scoped), head-n-tail typing, fire2 on session focus, R4 overflow guard, Alt+P print — operator-aware audio, event-driven SPA
// @match        https://sp.spx.shopee.vn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
'use strict';

// Skip inside iframes. find-details creates a hidden iframe pointing at
// /awb-printing for the eye-preview pipeline; without this guard, scan-job
// loads inside that iframe and plays welcome.mp3 on every eye click (each
// fresh iframe = fresh audio context → tryUnlockAudio fires welcome).
// scan-job's features (welcome, scan focus, session audio, R4, Alt+P) are all
// human-facing on the top tab — nothing in an iframe needs them.
if (window.top !== window) return;

const _docEl = document.documentElement;
if (!_docEl.SpxShared) { console.warn('[SPX] scan-job: SpxShared not ready, aborting'); return; }
const { idb, loadAudio } = _docEl.SpxShared;

// ============================================================
// SECTION 1 — CONSTANTS
// ============================================================

const GH             = "https://github.com/tasuaongvang/spx/raw/refs/heads/main/";
const SILENT_URL     = "https://github.com/anars/blank-audio/raw/master/1-second-of-silence.mp3";
const SILENT_KEY     = "audio_silent";
const DEFAULT_SUFFIX = 'tsov';
const FRESH_WINDOW   = 24 * 60 * 60 * 1000; // 24h

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
// SECTION 2 — AUDIO CONSTANTS + SILENT INIT
// ============================================================

const IDB_NAME  = 'spx_audio';
const IDB_STORE = 'mp3';

const _silentAudio = new Audio();
loadAudio(SILENT_KEY, SILENT_URL, _silentAudio).catch(() => {});

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
COMMON_FILES.forEach((f, i) => loadAudio(f, GH + f, SFX[f], i * 150).catch(() => {}));

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
  { pattern: /just missed!/i,                              audio: SFX["missed.mp3"]           },
  { pattern: /ready!/i,                                    audio: SFX["ready.mp3"]            },
  { pattern: /service point server error/i,                audio: SFX["network.mp3"]          },
];

// ============================================================
// SECTION 4 — OPERATOR DETECTION (cached 24h)
// ============================================================

const OPERATOR_KEY = 'operator_suffix';

async function detectOperator() {
  const cached = await idb.get(IDB_NAME, 1, IDB_STORE, OPERATOR_KEY).catch(() => null);
  if (cached?.suffix && Date.now() - cached.checkedAt < FRESH_WINDOW) {
    return cached.suffix;
  }

  let suffix = DEFAULT_SUFFIX;
  try {
    const res   = await fetch('/sp-api/current_user?ignore_point_list_flag=true');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json  = await res.json();
    const email = (json?.data?.email || json?.data?.account || json?.email || json?.account || '').toLowerCase().trim();
    suffix = OPERATOR_MAP[email] || DEFAULT_SUFFIX;
  } catch {}

  const _opRec = { suffix, checkedAt: Date.now() };
  idb.put(IDB_NAME, 1, IDB_STORE, OPERATOR_KEY, _opRec)
    .then(() => window.NeonSync?.coldSync('spx_audio_cache', OPERATOR_KEY, _opRec))
    .catch(() => {});
  return suffix;
}

async function initOperatorAudio() {
  const suffix      = await detectOperator();
  const welcomeFile = `welcome_${suffix}.mp3`;
  const rokFile     = `rok_${suffix}.mp3`;

  await Promise.all([
    loadAudio(welcomeFile, GH + welcomeFile, welcomeAudio, 0).catch(() => null),
    loadAudio(rokFile,     GH + rokFile,     rokAudio,     200).catch(() => null),
  ]);

  operatorAudioReady = true;
  if (welcomePending && audioUnlocked) {
    playAudio(welcomeAudio);
    welcomePending = false;
  }
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
  _docEl._spxEnqueueSound?.(() => new Promise(resolve => {
    audioObj.currentTime = 0;
    const done = () => { audioObj.onended = null; audioObj.onerror = null; resolve(); };
    audioObj.onended = done;
    audioObj.onerror = done;
    try { audioObj.play().catch(done); } catch { done(); }
  }));
}

function tryUnlockAudio() {
  if (audioUnlocked) return;
  new Audio(_silentAudio.src || SILENT_URL).play()?.then(() => {
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

  // Measurement dialog open (Edit flow) — user is typing weight/dimensions, don't steal focus.
  const measureDlg = document.querySelector('.ssc-dialog-content.large');
  if (measureDlg && isVisible(measureDlg) &&
      measureDlg.querySelector('.ssc-dialog-title span')?.textContent.trim() === 'Measurement') return;

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
const _refocusIv = setInterval(refocusInput, 1500);

// ============================================================
// SECTION 9 — HEAD-N-TAIL TYPING
// ============================================================

const _getExtraChar = _docEl.SpxShared.getExtraChar;

let _extraChar = _getExtraChar();
const _extraCharIv = setInterval(() => { _extraChar = _getExtraChar(); }, 60 * 60 * 1000); // refresh hourly

let _hntSuspend = false;
let _scanInput  = null; // cached for refocus (avoid querySelectorAll churn)

function attachHeadNTail(input) {
  if (!input || input.dataset.headtailAttached) return;
  input.dataset.headtailAttached = "1";
  // Cache only if it's the actual scan input — other Shopee pages have
  // 'Please Input' placeholders too; we don't want refocus to chase them.
  if (input.closest('section.order-input')) {
    _scanInput = input;
    input.addEventListener('focus', tryFireSessionAudio, { once: true });
  }

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
// SECTION 10 — SESSION ENTRY AUDIO (fire2 khi vào phiên)
// ============================================================

let _sessionFireDone = false;

function isReceiveTaskSession() {
  return /\/receive-task\/(create|detail)\//.test(location.pathname);
}

function tryFireSessionAudio() {
  if (_sessionFireDone || !isReceiveTaskSession()) return;
  _sessionFireDone = true;
  playAudio(SFX["fire2.mp3"]);
}

const isVisible = _docEl.SpxShared.isVisible;

// ============================================================
// SECTION 11 — R4 X guard
// ============================================================

function attachR4(input) {
  if (!input || input.hasAttribute('data-guard-attached')) return;
  input.setAttribute('data-guard-attached', 'true');

  let _r4Debounced = false;
  input.addEventListener('input', () => {
    if (input.value.length > 17) {
      input.value = input.value.slice(0, 17);
      if (!_r4Debounced) {
        _r4Debounced = true;
        playAudio(SFX["slowdown.mp3"]);
        setTimeout(() => { _r4Debounced = false; }, 400);
      }
    }
  });
}

function tryAttachR4() {
  const inp = document.querySelector('.order-input input');
  if (inp) attachR4(inp);
}

// ============================================================
// SECTION 12 — ALT+P PRINT ALL
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

let _printRunning = false;

async function printAll() {
  if (_printRunning) return;
  _printRunning = true;
  try { await _printAll(); } finally { _printRunning = false; }
}

async function _printAll() {
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
      let obs = null;
      const done = () => { if (obs) { obs.disconnect(); obs = null; } resolve(); };
      const timer = setTimeout(done, timeoutMs);

      const check = () => {
        for (const node of document.querySelectorAll('div.ssc-message .ssc-message-content')) {
          if (seenToasts.has(node)) continue;
          if (!node.textContent.includes(containsText)) continue;
          seenToasts.add(node);
          clearTimeout(timer);
          done();
          return true;
        }
        return false;
      };

      if (check()) return;

      obs = new MutationObserver(() => check());
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
// SECTION 13 — SPA NAVIGATION (event-driven, no polling)
// ============================================================

const _spaListeners = [];
function onSpaNav(cb) { _spaListeners.push(cb); }

function _fireSpaNav() {
  for (const cb of _spaListeners) {
    try { cb(); } catch (e) { console.warn('[SPX] spa nav cb', e); }
  }
}

window.addEventListener('spx-nav', _fireSpaNav);

onSpaNav(() => {
  _scanInput       = null; // input may be replaced after navigation
  _sessionFireDone = false;
  // Clear R4 guard so we re-attach on (possibly reused) new-page input
  document.querySelector('.order-input input')?.removeAttribute('data-guard-attached');
  setTimeout(() => { tryAttachR4(); }, 1000);
});

// ============================================================
// SECTION 14 — UNIFIED OBSERVER (rAF-throttled, addedNodes-only)
// ============================================================

scanHeadNTailInputs();
createSpeaker();
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

document.documentElement.SpxShared?.addUnloadCleanup?.(() => {
    clearInterval(_refocusIv);
    clearInterval(_extraCharIv);
    _mainObserver.disconnect();
    _pendingMuts.length = 0;
});

console.log('[SPX] scan-job v3.23 loaded — R4: debounce slowdown.mp3 on scanner burst');
})();
