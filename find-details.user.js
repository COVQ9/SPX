// ==UserScript==
// @name         Find Details
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/find-details.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/find-details.user.js
// @version      3.34
// @description  Paste+Clear · Tracking modal · GDrive · AWB dual panel · Eye preview (native PDF) · Print Receipt → PDF overlay · styled eye/print buttons · HV detect (inbound scan, full IDB state, task scan)
// @match        https://sp.spx.shopee.vn/*
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // Skip inside iframes. This script *creates* the hidden eye-preview iframe
    // (pointing at /awb-printing); running again inside that iframe injects a
    // useless AWB dual-panel into the hidden DOM and double-patches window.open.
    // The parent re-assigns iframe.contentWindow.open in onload anyway, so the
    // in-iframe patch is never the one that fires for the preview pipeline.
    if (window.top !== window) return;

    const GDRIVE_LINK    = 'https://drive.google.com/drive/folders/17EdMQqhggtl-TEtkKRcRyVBVeL-476kc?usp=sharing';
    const GDRIVE_MESSAGE = `cho em gửi link cắt cam ạ >>> ${GDRIVE_LINK}`;
    const AWB_PATH      = '/order-management/awb-printing';
    const DROPOFF_PATH  = '/order-management/drop-off';
    const TICKET_PATH   = '/point-service-point-support/ticket-center';
    const INBOUND_PATH  = '/inbound-management/receive-task';
    const HV_SOUND_URL  = 'https://raw.githubusercontent.com/COVQ9/SPX/main/sounds/hv.mp3';
    const PDFJS_SRC     = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    const PDFJS_WORKER  = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const onAWBPage          = () => location.pathname.includes(AWB_PATH);
    const onDropoffPage      = () => location.pathname.includes(DROPOFF_PATH);
    const onTicketPage       = () => location.pathname.includes(TICKET_PATH);
    const onInboundPage      = () => location.pathname.includes(INBOUND_PATH);
    const onInboundListPage  = () => /\/inbound-management\/receive-task\/?$/.test(location.pathname);
    const getCurrentTaskId   = () => { const m = location.pathname.match(/\/receive-task\/(?:detail|create)\/([A-Z0-9]+)/); return m ? m[1] : null; };

    // ─── HV Detection ────────────────────────────────────────────────
    // Trigger: intercept /receive_task/order/add response → fetch label PDF
    // → extract text via pdf.js (ToUnicode) → if "HV" found → red+bold cell
    // + play hv.mp3. Works on all /inbound-management/receive-task/* pages.

    const _hvShipments = new Set(); // confirmed HV shipment IDs this session
    const _hvChecking  = new Set(); // IDs currently being checked (dedup)

    // ── IDB audio cache (hv.mp3) ──────────────────────────────────────
    const HV_IDB_NAME  = 'spx_fd_audio';
    const HV_IDB_STORE = 'mp3';
    const HV_IDB_KEY   = 'hv';
    const HV_FRESH_MS  = 24 * 60 * 60 * 1000;

    function _hvIdbOpen() {
        return new Promise((res, rej) => {
            const r = indexedDB.open(HV_IDB_NAME, 1);
            r.onupgradeneeded = () => r.result.createObjectStore(HV_IDB_STORE);
            r.onsuccess = () => res(r.result);
            r.onerror   = () => rej(r.error);
        });
    }
    function _hvIdbGet(key) {
        return _hvIdbOpen().then(db => new Promise((res, rej) => {
            const r = db.transaction(HV_IDB_STORE, 'readonly').objectStore(HV_IDB_STORE).get(key);
            r.onsuccess = () => { res(r.result); db.close(); };
            r.onerror   = () => { rej(r.error);  db.close(); };
        }));
    }
    function _hvIdbPut(key, val) {
        return _hvIdbOpen().then(db => new Promise((res, rej) => {
            const tx = db.transaction(HV_IDB_STORE, 'readwrite');
            tx.objectStore(HV_IDB_STORE).put(val, key);
            tx.oncomplete = () => { res();          db.close(); };
            tx.onerror    = () => { rej(tx.error);  db.close(); };
        }));
    }

    let _hvAudio = null; // preloaded Audio element (blob URL)

    async function _refreshHVAudio(cached) {
        if (cached?.checkedAt && Date.now() - cached.checkedAt < HV_FRESH_MS) return;
        try {
            const blob = await (await fetch(HV_SOUND_URL)).blob();
            const old  = _hvAudio?.src;
            _hvAudio = new Audio(URL.createObjectURL(blob));
            _hvAudio.preload = 'auto';
            if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
            _hvIdbPut(HV_IDB_KEY, { blob, checkedAt: Date.now() }).catch(() => {});
        } catch {}
    }

    async function _loadHVAudio() {
        try {
            const cached = await _hvIdbGet(HV_IDB_KEY).catch(() => null);
            if (cached?.blob) {
                _hvAudio = new Audio(URL.createObjectURL(cached.blob));
                _hvAudio.preload = 'auto';
                _refreshHVAudio(cached); // background freshness check
                return;
            }
            // Nothing cached — fetch and store
            const blob = await (await fetch(HV_SOUND_URL)).blob();
            _hvAudio = new Audio(URL.createObjectURL(blob));
            _hvAudio.preload = 'auto';
            _hvIdbPut(HV_IDB_KEY, { blob, checkedAt: Date.now() }).catch(() => {});
        } catch (e) {
            console.warn('[SPX] hv.mp3 load failed', e);
        }
    }

    // ── HV State IDB (spx_fd_hv) — persists detected HV shipments + tasks ──
    // Stores: 'shipments' (key=SPXVN...) · 'tasks' (key=DRT...)
    // Populated once per detection; read on every subsequent page load.
    const _hvTaskSet = new Set(); // DRT... IDs known to contain HV orders

    // ── Bearer token capture ─────────────────────────────────────────
    // Captures Authorization: Bearer ... from every outgoing request,
    // saves to IDB, decodes JWT exp, schedules a proactive refresh 5 min
    // before expiry by triggering a lightweight SPX call.
    const TOKEN_STORE        = 'token';
    const TOKEN_KEY          = 'bearer';
    const TOKEN_MARGIN_MS    = 5 * 60 * 1000;

    let _spxToken   = null;
    let _tokenTimer = null;

    function _decodeJwtExp(token) {
        try {
            const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return payload.exp ? payload.exp * 1000 : null;
        } catch { return null; }
    }

    async function _doTokenRefresh() {
        try { await _origFetch.call(window, '/sp-api/admin/auth/info', { method: 'GET' }); } catch {}
    }

    function _scheduleTokenRefresh(exp) {
        clearTimeout(_tokenTimer);
        if (!exp) return;
        const delay = exp - Date.now() - TOKEN_MARGIN_MS;
        if (delay > 0) _tokenTimer = setTimeout(_doTokenRefresh, delay);
    }

    function _captureToken(authHeader) {
        if (!authHeader?.startsWith('Bearer ')) return;
        const token = authHeader.slice(7);
        if (!token || token === _spxToken) return;
        _spxToken = token;
        const exp = _decodeJwtExp(token);
        _hvDbPut(TOKEN_STORE, TOKEN_KEY, { token, capturedAt: Date.now(), exp }).catch(() => {});
        _scheduleTokenRefresh(exp);
    }

    async function _loadStoredToken() {
        try {
            const stored = await _hvDbGet(TOKEN_STORE, TOKEN_KEY).catch(() => null);
            if (!stored?.token) return;
            if (stored.exp && stored.exp < Date.now()) { _doTokenRefresh(); return; }
            _spxToken = stored.token;
            _scheduleTokenRefresh(stored.exp);
        } catch {}
    }

    function _hvDbOpen() {
        return new Promise((res, rej) => {
            const r = indexedDB.open('spx_fd_hv', 3);
            r.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('shipments')) db.createObjectStore('shipments');
                if (!db.objectStoreNames.contains('tasks'))     db.createObjectStore('tasks');
                if (!db.objectStoreNames.contains('token'))     db.createObjectStore('token');
                if (!db.objectStoreNames.contains('scripts'))   db.createObjectStore('scripts');
            };
            r.onsuccess = () => res(r.result);
            r.onerror   = () => rej(r.error);
        });
    }
    function _hvDbGet(store, key) {
        return _hvDbOpen().then(db => new Promise((res, rej) => {
            const r = db.transaction(store, 'readonly').objectStore(store).get(key);
            r.onsuccess = () => { res(r.result); db.close(); };
            r.onerror   = () => { rej(r.error);  db.close(); };
        }));
    }
    function _hvDbPut(store, key, val) {
        return _hvDbOpen().then(db => new Promise((res, rej) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).put(val, key);
            tx.oncomplete = () => { res();          db.close(); };
            tx.onerror    = () => { rej(tx.error);  db.close(); };
        }));
    }
    function _hvDbGetAll(store) {
        return _hvDbOpen().then(db => new Promise((res, rej) => {
            const entries = [];
            const req = db.transaction(store, 'readonly').objectStore(store).openCursor();
            req.onsuccess = e => {
                const cur = e.target.result;
                if (cur) { entries.push({ key: cur.key, value: cur.value }); cur.continue(); }
                else { res(entries); db.close(); }
            };
            req.onerror = () => { rej(req.error); db.close(); };
        }));
    }

    // Load all known HV shipment + task IDs from IDB into memory at startup.
    async function loadHVState() {
        try {
            const [shipEntries, taskEntries] = await Promise.all([
                _hvDbGetAll('shipments').catch(() => []),
                _hvDbGetAll('tasks').catch(() => []),
            ]);
            // Backward compat: old entries had no isHV field (treat as HV)
            shipEntries.forEach(({ key, value }) => {
                if (!value || value.isHV !== false) _hvShipments.add(key);
            });
            taskEntries.forEach(({ key, value }) => {
                if (value?.hasHV) {
                    _hvTaskSet.add(key);
                    (value.hvShipments || []).forEach(sid => _hvShipments.add(sid));
                }
            });
        } catch {}
    }

    // Red+bold any task-ID cell on the list page that's in _hvTaskSet.
    function applyHVTaskStyles() {
        if (!_hvTaskSet.size) return;
        document.querySelectorAll('tr.ssc-table-row td').forEach(td => {
            const t = td.textContent?.trim();
            if (t && _hvTaskSet.has(t)) {
                td.style.color      = '#d4380d';
                td.style.fontWeight = '800';
            }
        });
    }

    let _pdfjsLib = null, _pdfjsLoading = null;

    // Fetch pdf.js + worker as text, with IDB cache (keyed by PDFJS_SRC version URL).
    // Blob-inject approach bypasses Edge Tracking Prevention: cross-origin <script>
    // tags from known trackers (cdnjs) are sandboxed and can't write window globals,
    // but a blob: URL is same-origin so window.pdfjsLib gets set correctly.
    async function _loadPdfJsTexts() {
        try {
            const cached = await _hvDbGet('scripts', 'pdfjs').catch(() => null);
            if (cached?.mainText && cached.url === PDFJS_SRC) {
                return { mainText: cached.mainText, workerText: cached.workerText };
            }
        } catch {}
        const [mainText, workerText] = await Promise.all([
            fetch(PDFJS_SRC).then(r => r.text()),
            fetch(PDFJS_WORKER).then(r => r.text()),
        ]);
        _hvDbPut('scripts', 'pdfjs', { url: PDFJS_SRC, mainText, workerText, cachedAt: Date.now() }).catch(() => {});
        return { mainText, workerText };
    }

    function getPdfJs() {
        if (_pdfjsLib) return Promise.resolve(_pdfjsLib);
        if (_pdfjsLoading) return _pdfjsLoading;
        _pdfjsLoading = (async () => {
            try {
                const { mainText, workerText } = await _loadPdfJsTexts();
                const mainUrl   = URL.createObjectURL(new Blob([mainText],   { type: 'application/javascript' }));
                const workerUrl = URL.createObjectURL(new Blob([workerText], { type: 'application/javascript' }));
                await new Promise((res, rej) => {
                    const s = document.createElement('script');
                    s.src = mainUrl;
                    s.onload  = () => { URL.revokeObjectURL(mainUrl); res(); };
                    s.onerror = (e) => { URL.revokeObjectURL(mainUrl); URL.revokeObjectURL(workerUrl); rej(e); };
                    document.head.appendChild(s);
                });
                _pdfjsLib = window.pdfjsLib;
                if (!_pdfjsLib) throw new Error('pdfjsLib undefined after blob inject');
                _pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
                return _pdfjsLib;
            } catch (e) {
                _pdfjsLoading = null; // allow retry on next call
                throw e;
            }
        })();
        return _pdfjsLoading;
    }

    function getStationId() {
        const m = document.cookie.match(/sp_user_point_id=(\d+)/);
        return m ? parseInt(m[1], 10) : 224;
    }

    async function extractPdfText(buf) {
        const lib = await getPdfJs();
        const pdf = await lib.getDocument({ data: buf }).promise;
        let text = '';
        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            text += content.items.map(i => i.str).join(' ');
        }
        return text;
    }

    function playHVSound() {
        if (_hvAudio) {
            _hvAudio.currentTime = 0;
            _hvAudio.play().catch(() => {});
        } else {
            // Fallback if IDB not ready yet
            try { new Audio(HV_SOUND_URL).play().catch(() => {}); } catch {}
        }
    }

    // Apply red+bold to every TD in the table whose text matches shipmentId.
    // Called at detection time AND in addEyeToRow for Vue re-renders.
    function applyHVStyle(shipmentId) {
        document.querySelectorAll('tr.ssc-table-row td').forEach(td => {
            if (td.textContent?.trim() === shipmentId) {
                td.style.color      = '#d4380d';
                td.style.fontWeight = '800';
            }
        });
    }

    // opts.sound = true  → play hv.mp3 (scan path)
    // opts.sound = false → silent (page-load / old-row inspection)
    async function checkHVAndNotify(shipmentId, opts) {
        if (!onInboundPage()) return;

        // Already confirmed in memory — just re-style (Vue re-render)
        if (_hvShipments.has(shipmentId)) { applyHVStyle(shipmentId); return; }
        if (_hvChecking.has(shipmentId))  return;
        _hvChecking.add(shipmentId);
        try {
            // ── Check IDB cache first — skip PDF entirely if already known ──
            const cached = await _hvDbGet('shipments', shipmentId).catch(() => null);
            if (cached !== undefined && cached !== null) {
                if (cached.isHV === false) return; // confirmed non-HV, skip PDF
                _hvShipments.add(shipmentId);
                applyHVStyle(shipmentId);
                const taskId = getCurrentTaskId();
                if (taskId) _hvTaskSet.add(taskId);
                if (opts?.sound !== false) playHVSound();
                return;
            }

            // ── First time: full PDF pipeline ────────────────────────────
            // Step 1: get print direction (default 1)
            let direction = 1;
            try {
                const r = await fetch(`/sp-api/admin/order/awb_print/print_direction?shipment_id=${shipmentId}`);
                const j = await r.json();
                if (j?.data?.direction != null) direction = j.data.direction;
            } catch {}

            // Step 2: get signed label URL
            const prevRes = await fetch('/api/awb_print/bidirection/preview', {
                method: 'POST',
                headers: { 'content-type': 'application/json;charset=UTF-8' },
                body: JSON.stringify({
                    station_id: getStationId(), station_type: 8, system_type: 1,
                    shipment_ids: [{ shipment_id: shipmentId, template_direction: direction }],
                    permission: 'point.order.awb_print.list_awb_printing',
                }),
            });
            const prevJson = await prevRes.json();
            const labelUrl = prevJson?.data?.available_list?.[0]?.shipping_label_url;
            if (!labelUrl) return;

            // Step 3: fetch PDF + extract text
            const pdfBuf = await (await fetch(labelUrl)).arrayBuffer();
            const text   = await extractPdfText(pdfBuf);

            if (/\bHV\b/.test(text)) {
                const taskId = getCurrentTaskId();
                const now    = Date.now();
                _hvShipments.add(shipmentId);
                applyHVStyle(shipmentId);
                if (opts?.sound !== false) playHVSound();
                _hvDbPut('shipments', shipmentId, { isHV: true, taskId, detectedAt: now }).catch(() => {});
                if (taskId) {
                    _hvTaskSet.add(taskId);
                    // Append shipment to task's hvShipments list (read-modify-write)
                    _hvDbGet('tasks', taskId).then(entry => {
                        const hvShipments = [...new Set([...(entry?.hvShipments || []), shipmentId])];
                        return _hvDbPut('tasks', taskId, { ...(entry || {}), hasHV: true, hvShipments, updatedAt: now });
                    }).catch(() => {
                        _hvDbPut('tasks', taskId, { hasHV: true, hvShipments: [shipmentId], updatedAt: now }).catch(() => {});
                    });
                }
                console.log('[SPX] HV detected (saved to IDB):', shipmentId, 'task:', taskId);
            } else {
                // Confirmed non-HV — save to skip future PDF checks
                _hvDbPut('shipments', shipmentId, { isHV: false, checkedAt: Date.now() }).catch(() => {});
            }
        } catch (e) {
            console.warn('[SPX] HV check error for', shipmentId, e);
        } finally {
            _hvChecking.delete(shipmentId);
        }
    }

    // ── Per-task detail page scanner ──────────────────────────────────
    // First visit to a receive-task detail/create page → silently scan all
    // SPXVN rows via PDF, then persist the task's HV state (including which
    // specific shipment IDs are HV) so future visits apply red+bold instantly.
    const _scannedDetailTasks = new Set();
    let   _scanDetailTimer    = null;

    function scheduleScanDetailPage() {
        clearTimeout(_scanDetailTimer);
        _scanDetailTimer = setTimeout(scanCurrentDetailPage, 1500);
    }

    async function scanCurrentDetailPage() {
        const taskId = getCurrentTaskId();
        if (!taskId || _scannedDetailTasks.has(taskId)) return;
        const taskState = await _hvDbGet('tasks', taskId).catch(() => null);
        if (taskState?.checkedAt) { _scannedDetailTasks.add(taskId); return; }
        const sids = new Set();
        document.querySelectorAll('tr.ssc-table-row td').forEach(td => {
            const t = td.textContent?.trim();
            if (/^SPXVN/.test(t)) sids.add(t);
        });
        if (!sids.size) return;
        _scannedDetailTasks.add(taskId);
        await Promise.all([...sids].map(sid => checkHVAndNotify(sid, { sound: false })));
        const hasHV       = [...sids].some(sid => _hvShipments.has(sid));
        const hvShipments = [...sids].filter(sid => _hvShipments.has(sid));
        _hvDbPut('tasks', taskId, { hasHV, checkedAt: Date.now(), orderCount: sids.size, hvShipments }).catch(() => {});
        if (hasHV) { _hvTaskSet.add(taskId); applyHVTaskStyles(); }
    }

    // Helper to parse shipment_id from /add response body (scan path → sound on)
    function _onAddResponse(json) {
        const sid = json?.data?.order_detail?.shipment_id;
        if (sid) checkHVAndNotify(sid, { sound: true });
    }

    // ─── Intercept fetch (HV detection + token capture) ──────────────
    const _origFetch = window.fetch;
    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
        // Capture bearer token from outgoing request headers
        const hdrs = args[1]?.headers;
        if (hdrs) {
            const auth = hdrs instanceof Headers
                ? hdrs.get('Authorization')
                : (hdrs.Authorization || hdrs.authorization);
            if (auth) _captureToken(auth);
        }
        const res = await _origFetch.apply(this, args);
        if (/receive_task\/order\/add(\?|$)/.test(url) && !/add_check/.test(url)) {
            res.clone().json().then(_onAddResponse).catch(() => {});
        }
        return res;
    };

    // Capture bearer token set via XHR.setRequestHeader (axios path)
    const _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name.toLowerCase() === 'authorization') _captureToken(value);
        return _xhrSetHeader.call(this, name, value);
    };

    // ─── Intercept window.open ────────────────────────────────────────
    const _origOpen = window.open;
    window.open = function (url, ...rest) {
        if (url && onAWBPage()) {
            showPDF(url);
            return null;
        }
        return _origOpen.call(this, url, ...rest);
    };

    // ─── Print Receipt interception (receive-task detail) ────────────
    // "Print Receipt" flow: SPX POSTs /e_receipt/print to mint the receipt
    // PDF, then POSTs that PDF to the local print proxy ("turtle",
    // printproxy.wms.shopeemobile.com:21317) which silently prints it.
    // We hijack it: capture the minted PDF URL → show it in the overlay,
    // and drop the proxy /api/print job so nothing auto-prints. The
    // health/version probes pass through, so SPX still takes the proxy
    // branch and never falls back to opening a file tab.
    //
    // The proxy job is identified by its OWN body, not a pre-set flag: the
    // e-receipt / handover doc always has `file_path` → /templatedownload/file/
    // while per-row "Print" buttons send AWB-label jobs (file_path →
    // /awb_print/label/print) that must still reach the printer. Matching the
    // request content is race-free — turtle skips its printer probe once
    // warmed, firing /api/print synchronously before any load listener could
    // set a flag, so a flag-based block lost the race intermittently.

    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._spxUrl = String(url || '');
        return _xhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const url = this._spxUrl || '';

        // Turtle print job — suppress only the e-receipt/handover doc (shown
        // in the overlay instead); AWB-label jobs pass through to the printer.
        // `(\?|$)` keeps the health probe /api/printer_list out of this branch.
        if (/printproxy\.wms\.shopeemobile\.com.*\/api\/print(\?|$)/.test(url)) {
            if (typeof body === 'string' && /templatedownload\/file\//.test(body)) {
                // fire `error` so SPX's handler resolves instead of hanging
                setTimeout(() => this.dispatchEvent(new Event('error')), 0);
                return;
            }
            return _xhrSend.call(this, body); // real printer job — let it run
        }

        // HV detection — also listen via XHR (axios fallback)
        if (/receive_task\/order\/add(\?|$)/.test(url) && !/add_check/.test(url)) {
            this.addEventListener('load', function () {
                try {
                    const raw = this.responseType === 'json' ? this.response : this.responseText;
                    _onAddResponse(typeof raw === 'string' ? JSON.parse(raw) : raw);
                } catch {}
            });
        }

        // Capture the freshly-minted receipt PDF and show it in the overlay.
        if (/\/e_receipt\/print(\?|$)/.test(url)) {
            this.addEventListener('load', () => {
                try {
                    const raw = this.responseType === 'json' ? this.response
                              : this.responseText;
                    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    if (j && j.retcode === 0 && j.data && j.data.url) {
                        showPDF(location.origin + j.data.url, { wide: true });
                    } else {
                        // Server refused to mint the receipt — surface it
                        // instead of leaving Print Receipt silently doing nothing.
                        const { box } = createOverlay({ initialText: '' });
                        box.style.color = '#d4380d';
                        box.textContent = 'Lỗi tạo phiếu thu: '
                            + ((j && (j.message || j.retmsg)) || 'retcode ' + (j && j.retcode));
                    }
                } catch (e) { console.warn('[SPX] e_receipt parse', e); }
            });
        }

        return _xhrSend.call(this, body);
    };

    // ─── SPA navigation hook ─────────────────────────────────────────
    ['pushState', 'replaceState'].forEach(method => {
        const orig = history[method];
        history[method] = function () {
            orig.apply(this, arguments);
            window.dispatchEvent(new Event('spx-nav'));
        };
    });

    // ─── Shared overlay helper (was 3 copies of overlay+box+esc+close) ─
    const OVERLAY_CSS = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999999;display:flex;justify-content:center;align-items:center;';
    const BOX_CSS     = 'position:relative;display:inline-block;background:#fff;border-radius:8px;padding:24px;font-size:16px;color:#888;';

    // open-2-end's QR header (#spx-qr / #spx-qr-label) sits at z-index max
    // (2147483647) — it renders above ANY overlay/modal. Hide it for the
    // lifetime of a popup; the returned fn restores the exact prior state.
    function suppressQR() {
        const els = ['spx-qr', 'spx-qr-label']
            .map(id => document.getElementById(id)).filter(Boolean);
        const prev = els.map(el => el.style.display);
        els.forEach(el => { el.style.display = 'none'; });
        return () => els.forEach((el, i) => { el.style.display = prev[i]; });
    }

    // Tracks the open overlay's close(). A replacement overlay must fully
    // close the previous one — merely removing its DOM node leaks the Esc
    // listener and skips suppressQR's restore, hiding open-2-end's QR header
    // permanently.
    let _activeOverlayClose = null;

    function createOverlay({ initialText = 'Đang tải...' } = {}) {
        if (_activeOverlayClose) {
            try { _activeOverlayClose(); }
            catch (e) { console.warn('[SPX] prev overlay close', e); }
        }
        document.getElementById('spx-pdf-overlay')?.remove(); // safety: orphan

        const overlay = document.createElement('div');
        overlay.id = 'spx-pdf-overlay';
        overlay.style.cssText = OVERLAY_CSS;

        const box = document.createElement('div');
        box.style.cssText = BOX_CSS;
        box.textContent = initialText;
        overlay.appendChild(box);

        const onCloseCbs = [suppressQR()]; // hide QR now, restore on close
        let closed = false;

        function close() {
            if (closed) return;
            closed = true;
            if (_activeOverlayClose === close) _activeOverlayClose = null;
            overlay.remove();
            document.removeEventListener('keydown', esc);
            for (const cb of onCloseCbs) { try { cb(); } catch (e) { console.warn('[SPX] onClose cb', e); } }
        }
        const esc = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', esc);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        document.body.appendChild(overlay);
        _activeOverlayClose = close;
        return { box, close };
    }

    // ─── Core: display PDF URL natively (browser PDFium viewer) ───────
    // SPX returns a real `application/pdf` URL — same-origin, no attachment
    // disposition — so we render it directly in an <iframe>. This drops the
    // whole PDF.js stack (lib + worker + canvas rasterization): faster, vector
    // (crisp barcodes at any zoom), multi-page, with built-in zoom/print.
    // opts.wide = dense multi-page A4 document (e.g. the Print Receipt
    // handover record) → big box, fit-to-width so the table is readable and
    // page 2 just scrolls. Default = compact A6 label (eye preview): an
    // <iframe> can't size to its PDF, so the box is set to the A6 ratio
    // (~0.71) +~56px toolbar, else the label floats in grey + overlaps the QR.
    function showPDF(url, opts) {
        const { box, close } = createOverlay({ initialText: '' });
        opts = opts || {};

        const size = opts.wide
            ? 'width:96vw;height:96vh;'
            : 'width:min(92vw,540px);height:min(94vh,818px);';
        box.style.cssText = 'position:relative;background:#fff;border-radius:8px;'
            + size + 'padding:0;overflow:hidden;';

        const iframe = document.createElement('iframe');
        // toolbar=1 keeps zoom/print; navpanes=0 hides the thumbnail sidebar.
        // view=FitH (fit width, scroll) for dense docs; view=Fit (whole page,
        // no scrollbar) for the single-page label.
        iframe.src = url + '#toolbar=1&navpanes=0&view=' + (opts.wide ? 'FitH' : 'Fit');
        iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';

        const closeBtn = document.createElement('div');
        closeBtn.innerHTML = '✖';
        // Bottom-right corner — clear of the PDF viewer toolbar at the top.
        closeBtn.style.cssText = 'position:absolute;bottom:0;right:0;width:88px;height:88px;border-top-left-radius:88px;background:#ff3b30;color:#fff;font-size:44px;display:flex;justify-content:center;align-items:center;cursor:pointer;z-index:2;';
        closeBtn.onclick = close; // close() also detaches the Esc listener

        box.textContent = '';
        box.append(iframe, closeBtn);
    }

    // ─── Drop-off / table preview: hidden iframe → intercept window.open ─
    // Persistent warm iframe: first preview pays ~1-3s cold-load tax; subsequent
    // previews skip iframe boot entirely (the SPX awb-printing app stays mounted
    // inside it, so we just re-fill input + re-click preview).
    let _awbIframe = null;
    let _awbIframeReady = null; // Promise<iframe> | null

    // Tear down the warm iframe so the next preview rebuilds it from scratch.
    // Must run on every failure path (load error, load timeout, SPX app never
    // mounting its input) — otherwise one bad load poisons the cached promise
    // and every later eye-preview fails until a full page reload.
    function discardAwbIframe() {
        try { _awbIframe?.remove(); } catch {}
        _awbIframe = null;
        _awbIframeReady = null;
    }

    function getAwbIframe(onPdfUrl) {
        if (_awbIframeReady) {
            // Refresh the open-trap to point at the *current* click's overlay.
            _awbIframeReady.then(iframe => {
                try { iframe.contentWindow.open = onPdfUrl; } catch {}
            });
            return _awbIframeReady;
        }
        _awbIframeReady = new Promise((resolve, reject) => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;width:0;height:0;border:none;opacity:0;pointer-events:none;';
            iframe.onerror = () => { discardAwbIframe(); reject(new Error('iframe load failed')); };
            iframe.onload = () => {
                try { iframe.contentWindow.open = onPdfUrl; }
                catch (e) { console.warn('[SPX] iframe contentWindow access', e); }
                resolve(iframe);
            };
            iframe.src = `https://sp.spx.shopee.vn${AWB_PATH}`;
            document.body.appendChild(iframe);
            _awbIframe = iframe;
        });
        return _awbIframeReady;
    }

    function previewViaHiddenIframe(awbCode) {
        const { box, close } = createOverlay();

        const onPdfUrl = (url) => {
            close(); // remove loading overlay; showPDF creates its own
            showPDF(url);
            return null;
        };

        const loadTimeout = setTimeout(() => {
            box.textContent = 'Lỗi: không tải được AWB (timeout 10s)';
            discardAwbIframe(); // stuck load — force a fresh iframe next time
        }, 10000);

        getAwbIframe(onPdfUrl).then(iframe => {
            clearTimeout(loadTimeout);
            tryFillAndPreview(iframe, awbCode, () => {
                box.textContent = 'Lỗi: không tìm thấy input AWB trong iframe';
                discardAwbIframe(); // broken/stale iframe — rebuild next time
            });
        }).catch(() => {
            clearTimeout(loadTimeout);
            box.textContent = 'Lỗi: không tải được AWB';
        });
    }

    function tryFillAndPreview(iframe, awbCode, onFail, retries = 25, interval = 300) {
        if (!iframe.isConnected) return; // overlay was closed

        try {
            const doc = iframe.contentDocument;
            if (!doc) throw new Error('no doc');
            const input      = doc.querySelector('div.ssc-input input[placeholder="Please input or Scan"]');
            const previewBtn = doc.querySelector('button.ssc-button.preview-btn');
            if (!input || !previewBtn) throw new Error('not ready');

            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(input, awbCode);
            input.dispatchEvent(new Event('input',  { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            setTimeout(() => previewBtn.click(), 80);
            return; // success
        } catch {}

        if (retries <= 0) {
            onFail ? onFail() : console.warn('[SPX] fill+preview exhausted for', awbCode);
            return;
        }
        setTimeout(() => tryFillAndPreview(iframe, awbCode, onFail, retries - 1, interval), interval);
    }

    // ─── DOM ready ───────────────────────────────────────────────────
    function domReady(fn) {
        if (document.readyState !== 'loading') fn();
        else document.addEventListener('DOMContentLoaded', fn);
    }

    domReady(() => {

        // ─── Styled eye / print buttons ──────────────────────────────
        // SPX renders the per-row eye + Print as bare text — no affordance,
        // no press feedback. Inject one stylesheet so both read as real,
        // tactile buttons (border/fill, hover lift, active scale-down).
        function injectButtonStyles() {
            if (document.getElementById('spx-fd-btn-styles')) return;
            const style = document.createElement('style');
            style.id = 'spx-fd-btn-styles';
            style.textContent = `
/* ── Unified button system ────────────────────────────────────────
   One look & feel for every injected/restyled button: 40px tall,
   soft-tinted fill, 1.5px border, crisp icon, inset bottom edge that
   reads as a physical key. Hover deepens the tint; :active sinks the
   shadow + drops 1px. Only the HUE changes per role:
     .spx-btn--blue  → safe actions  (eye / in tem / mở biên bản)
     .spx-btn--red   → destructive   (remove)
   Glyphs are CSS masks so they always follow the button's color. */
.spx-btn{
  display:inline-flex!important;align-items:center;justify-content:center;gap:8px!important;
  box-sizing:border-box!important;
  height:40px!important;padding:0 16px!important;min-width:0!important;
  font-size:13px!important;font-weight:700!important;line-height:1!important;
  font-family:inherit!important;letter-spacing:.02em!important;text-transform:none!important;
  border:1.5px solid transparent!important;border-radius:4px!important;
  text-decoration:none!important;
  cursor:pointer;
  -webkit-appearance:none!important;appearance:none!important;
  transition:background-color .12s ease,border-color .12s ease,color .12s ease,box-shadow .1s ease,transform .04s ease;
}
.spx-btn:hover{text-decoration:none!important;}
.spx-btn:hover *{text-decoration:none!important;}
.spx-btn:active{transform:translateY(1px);}
.spx-btn::before{
  content:"";flex:none;width:16px;height:16px;
  background-color:currentColor;
  -webkit-mask-repeat:no-repeat;-webkit-mask-position:center;-webkit-mask-size:contain;
          mask-repeat:no-repeat;        mask-position:center;        mask-size:contain;
}
.spx-btn-eye::before{-webkit-mask-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z'/><circle cx='12' cy='12' r='3.2'/></svg>");mask-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z'/><circle cx='12' cy='12' r='3.2'/></svg>");}
.spx-btn-print::before{-webkit-mask-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9V2h12v7'/><path d='M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2'/><path d='M6 14h12v8H6z'/></svg>");mask-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9V2h12v7'/><path d='M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2'/><path d='M6 14h12v8H6z'/></svg>");}
.spx-btn-receipt::before{-webkit-mask-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><path d='M14 2v6h6'/><path d='M16 13H8M16 17H8M10 9H8'/></svg>");mask-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><path d='M14 2v6h6'/><path d='M16 13H8M16 17H8M10 9H8'/></svg>");}
.spx-btn-remove::before{-webkit-mask-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.1' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M8 12h8'/></svg>");mask-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.1' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M8 12h8'/></svg>");}

/* Blue — safe actions */
.spx-btn--blue{
  color:#175cd3!important;background:#e0f2fe!important;border-color:#7cd4fd!important;
  box-shadow:inset 0 -2px 0 rgba(12,74,110,.14)!important;
}
.spx-btn--blue:hover{background:#bae6fd!important;border-color:#36bffa!important;}
.spx-btn--blue:active{background:#7cd4fd!important;border-color:#36bffa!important;box-shadow:inset 0 2px 4px rgba(12,74,110,.26)!important;}
.spx-btn--blue:focus-visible{outline:2px solid #2e90fa!important;outline-offset:2px;}

/* Action column: widen to fit both buttons on one line (original width
   172 px < 96+12+89 = 197 px needed). Widen the th/td at position 19
   (nth-child because there is an empty leading checkbox column).
   Also force the inner container to flex-row with nowrap + strip the
   SPX inline margin-right so gap handles spacing cleanly. */
th:nth-child(19),td:nth-child(19){width:260px!important;}
td .ssc-table-header-column-container{display:flex!important;align-items:center!important;flex-wrap:nowrap!important;gap:8px!important;}
button.spx-btn-print,button.spx-btn-remove{margin-right:0!important;}

/* Red — destructive */
.spx-btn--red{
  color:#b42318!important;background:#fee4e2!important;border-color:#fda29b!important;
  box-shadow:inset 0 -2px 0 rgba(122,29,18,.14)!important;
}
.spx-btn--red:hover{background:#fecdca!important;border-color:#f97066!important;}
.spx-btn--red:active{background:#f97066!important;color:#fff!important;border-color:#f04438!important;box-shadow:inset 0 2px 4px rgba(122,29,18,.3)!important;}
.spx-btn--red:focus-visible{outline:2px solid #f04438!important;outline-offset:2px;}`;
            (document.head || document.documentElement).appendChild(style);
        }
        injectButtonStyles();

        // Restyle + relabel SPX's bare text action buttons (per detail-table
        // row). Both adopt the unified .spx-btn system; the ssc classes carry
        // Vue's click handler so they're kept untouched. textContent only
        // swaps the text node — the ::before glyph is CSS. On a Vue
        // re-render the node is fresh ("Print"/"Remove" again) → reprocessed.
        const ACTION_MAP = {
            Print:  { classes: ['spx-btn', 'spx-btn-print',  'spx-btn--blue'], label: 'in tem' },
            Remove: { classes: ['spx-btn', 'spx-btn-remove', 'spx-btn--red'],  label: 'gỡ ra'  },
        };
        function styleActionBtn(btn) {
            const t = btn.textContent.trim();

            if (btn.classList.contains('spx-btn')) {
                // Node already has our classes but Vue may have patched the
                // text back to its native value (characterData — observer
                // skips it). Re-sync the label so it stays correct.
                if (t === 'Print')  { btn.textContent = 'in tem'; return; }
                if (t === 'Remove') { btn.textContent = 'gỡ ra';  return; }
                return;
            }

            // If the flag is set but our class is gone (Vue swapped className
            // entirely), clear the flag and fall through to re-apply.
            if (btn.dataset.spxStyled) delete btn.dataset.spxStyled;

            const spec = ACTION_MAP[t];
            if (!spec) return;
            btn.dataset.spxStyled = 'true';
            btn.classList.add(...spec.classes);
            btn.textContent = spec.label;
        }

        // The task-header "Print Receipt" button → restyle (unified system,
        // document glyph) + relabel "mở biên bản". Same swap-only approach.
        function relabelPrintReceipt(btn) {
            if (btn.dataset.spxRelabeled) return;
            if (btn.textContent.trim() !== 'Print Receipt') return;
            btn.dataset.spxRelabeled = 'true';
            btn.classList.add('spx-btn', 'spx-btn-receipt', 'spx-btn--blue');
            btn.textContent = 'mở biên bản';
        }

        // ─── Shared utility ──────────────────────────────────────────
        function makeBtn(text, color, className, extraStyle = {}) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = text;
            btn.className = `ssc-button ${className}`;
            Object.assign(btn.style, {
                backgroundColor: color, color: '#fff', border: 'none',
                cursor: 'pointer', padding: '6px 12px', borderRadius: '4px',
                ...extraStyle
            });
            return btn;
        }

        // ─── Feature 1 · Paste + Clear on input containers ───────────
        function addPasteClearButtons(container) {
            if (onAWBPage()) return;
            if (container.querySelector('.paste-btn')) return;
            const inputWrapper = container.querySelector('.ssc-input');
            if (!inputWrapper) return;
            const input = inputWrapper.querySelector('input');
            if (!input) return;

            Object.assign(container.style, { display: 'flex', alignItems: 'center', gap: '6px' });
            const pasteBtn = makeBtn('Paste', '#007bff', 'paste-btn');
            const clearBtn = makeBtn('Clear', '#dc3545', 'clear-btn');
            container.insertBefore(pasteBtn, inputWrapper);
            container.insertBefore(clearBtn, inputWrapper);

            pasteBtn.addEventListener('click', async () => {
                try {
                    input.value = await navigator.clipboard.readText();
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                } catch (e) { console.error('Clipboard error:', e); }
            });
            clearBtn.addEventListener('click', () => {
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
        }

        // ─── Feature 2 · Tracking + AWB modal ────────────────────────
        function replaceExportButton(btn) {
            if (!btn || btn.dataset.replaced) return;
            btn.dataset.replaced = 'true';

            const previewBtn = makeBtn('Check đường đi', '#0072ce', '', { fontWeight: 'bold' });
            const qrBtn      = makeBtn('Mở full tem',    '#8f2cff', '', { fontWeight: 'bold', marginLeft: '8px' });
            btn.replaceWith(previewBtn, qrBtn);

            previewBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const sel = window.getSelection().toString().trim();
                if (!sel) return alert('Select tracking first!');
                openModal(`https://spx.vn/track?${sel}`, false);
            });
            qrBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const sel = window.getSelection().toString().trim();
                if (!sel) return alert('Select tracking first!');
                openModal(`https://sp.spx.shopee.vn${AWB_PATH}`, true, sel);
            });
        }

        function openModal(url, enablePDFTrap, awbCode = '') {
            // Same single-overlay invariant as createOverlay: fully close any
            // open overlay first, else its suppressQR restore is skipped and
            // the QR header stays hidden.
            if (_activeOverlayClose) {
                try { _activeOverlayClose(); }
                catch (e) { console.warn('[SPX] prev overlay close', e); }
            }

            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;justify-content:center;align-items:center;';

            const modal = document.createElement('div');
            modal.style.cssText = 'width:80%;height:80%;background:#fff;border-radius:8px;overflow:hidden;position:relative;';

            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'width:100%;height:100%;border:none;';
            iframe.src = url;

            const restoreQR = suppressQR(); // hide QR header above this modal
            let modalClosed = false;
            const closeModal = () => {
                if (modalClosed) return;
                modalClosed = true;
                if (_activeOverlayClose === closeModal) _activeOverlayClose = null;
                overlay.remove();
                restoreQR();
            };
            _activeOverlayClose = closeModal;

            const closeBtn = document.createElement('div');
            closeBtn.innerHTML = '✖';
            closeBtn.style.cssText = 'position:absolute;top:0;right:0;width:60px;height:60px;border-bottom-left-radius:60px;background:#ff3b30;color:#fff;font-size:32px;display:flex;justify-content:center;align-items:center;cursor:pointer;z-index:1000000;';
            closeBtn.onclick = closeModal;
            overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
            modal.append(closeBtn, iframe);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            iframe.onload = () => {
                if (enablePDFTrap) {
                    try { iframe.contentWindow.open = u => { iframe.src = u; return null; }; } catch {}
                }
                if (awbCode) tryFillAndPreview(iframe, awbCode);
            };
        }

        // Row click → select + copy AWB
        document.body.addEventListener('click', (e) => {
            const tr = e.target.closest('tr.ssc-table-row-highlighted');
            if (!tr) return;
            const awbTd = Array.from(tr.querySelectorAll('td')).find(td => /^SPXVN.+/.test(td.textContent.trim()));
            if (!awbTd) return;
            const range = document.createRange();
            range.selectNodeContents(awbTd);
            const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
            navigator.clipboard.writeText(awbTd.textContent.trim());
        }, { passive: true });

        ['mouseenter', 'mouseover'].forEach(evt =>
            document.body.addEventListener(evt, (e) => {
                if (e.target.closest('button.ssc-button.batch-actions-btn')) e.stopPropagation();
            }, true)
        );

        // ─── Feature 3 · Paste GDrive link ───────────────────────────
        function addGDriveButton(footer) {
            if (!footer || footer.querySelector('.paste-link-btn')) return;
            const btn = makeBtn('Paste Link', '#28a745', 'paste-link-btn', { marginRight: '8px' });
            btn.addEventListener('click', () => {
                const textarea = document.querySelector('textarea.ssc-textarea');
                if (textarea) { textarea.value = GDRIVE_MESSAGE; textarea.dispatchEvent(new Event('input', { bubbles: true })); }
                else alert('Textarea not found!');
            });
            const cancelBtn = footer.querySelector('button');
            cancelBtn ? footer.insertBefore(btn, cancelBtn) : footer.appendChild(btn);
        }

        // ─── Feature 4 · AWB Dual Panel (awb-printing page) ──────────
        const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

        function initAWBDualPanel(origContainer) {
            if (!onAWBPage()) return;
            if (document.getElementById('spx-awb-panel')) return;
            const origInput   = origContainer.querySelector('input');
            const origPrint   = origContainer.querySelector('button.print-btn');
            const origPreview = origContainer.querySelector('button.preview-btn');
            if (!origInput || !origPrint || !origPreview) return;

            origContainer.style.cssText += ';opacity:0;pointer-events:none;position:absolute;';

            function triggerOrig(bigInput, origBtn) {
                nativeValueSetter.call(origInput, bigInput.value);
                origInput.dispatchEvent(new Event('input',  { bubbles: true }));
                origInput.dispatchEvent(new Event('change', { bubbles: true }));
                setTimeout(() => origBtn.click(), 50);
            }

            function makeBigBtn(text, bg) {
                const b = document.createElement('button');
                b.type = 'button'; b.textContent = text;
                b.style.cssText = `font-size:20px;padding:0 28px;height:80px;background:${bg};color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;white-space:nowrap;flex-shrink:0;`;
                return b;
            }

            function buildRow(mode) {
                const isPreview = mode === 'preview';
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:12px;';

                const pasteBtn  = makeBigBtn('Paste', '#007bff');
                const clearBtn  = makeBigBtn('Clear', '#dc3545');
                const actionBtn = makeBigBtn(isPreview ? 'Preview' : 'Print', isPreview ? '#d48806' : '#ee4d2d');

                const input = document.createElement('input');
                input.placeholder = isPreview ? 'nhập mã vận đơn để xem phiếu' : 'nhập mã vận đơn để in';
                input.style.cssText = 'font-size:26px;padding:0 22px;border:2px solid #d9d9d9;border-radius:8px;width:580px;height:80px;box-sizing:border-box;outline:none;transition:border-color .15s;flex-shrink:0;';
                input.addEventListener('focus', () => input.style.borderColor = '#40a9ff');
                input.addEventListener('blur',  () => input.style.borderColor = '#d9d9d9');

                const origBtn = isPreview ? origPreview : origPrint;
                const fire = () => triggerOrig(input, origBtn);
                pasteBtn.addEventListener('click', async () => { try { input.value = await navigator.clipboard.readText(); } catch {} });
                clearBtn.addEventListener('click', () => { input.value = ''; input.focus(); });
                actionBtn.addEventListener('click', fire);
                input.addEventListener('keydown', e => { if (e.key === 'Enter') fire(); });

                row.append(pasteBtn, clearBtn, input, actionBtn);
                return { row, input };
            }

            const { row: previewRow, input: previewInput } = buildRow('preview');
            const { row: printRow }                        = buildRow('print');

            const divider = document.createElement('hr');
            divider.style.cssText = 'border:none;border-top:2px solid #e8e8e8;width:calc(100% + 20px);margin:0 -10px;';

            const panel = document.createElement('div');
            panel.id = 'spx-awb-panel';
            panel.style.cssText = 'position:fixed;left:calc(220px + (100vw - 220px) / 2);top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;gap:48px;z-index:50;';
            panel.append(previewRow, divider, printRow);
            document.body.appendChild(panel);
            setTimeout(() => previewInput.focus(), 300);
        }

        // ─── Feature 5 · Eye button (table rows + ticket center) ─────
        // BUG (v3.13): closure-captured awbCode went stale when the framework
        // reused TR DOM nodes after sort/filter/data-update → eye preview
        // showed a different row's AWB (off-by-1 if a row was added/removed).
        // Now: re-resolve AWB from the live DOM at click time. The closure
        // value is kept only as a fallback for unexpected DOM layouts.
        function resolveAwbFromEye(btn, fallback) {
            const tr = btn.closest('tr.ssc-table-row');
            if (tr) {
                const td = Array.from(tr.querySelectorAll('td'))
                    .find(td => /^SPXVN\d+/.test(td.textContent?.trim() || ''));
                if (td) return td.textContent.trim();
            }
            // Ticket center: AWB sits in the sibling `.input-text` span.
            const span = btn.parentElement?.querySelector?.('.input-text');
            if (span && /^SPXVN\d+$/.test(span.textContent.trim())) return span.textContent.trim();
            return fallback;
        }

        function makeEyeBtn(awbCode) {
            const btn = document.createElement('button');
            btn.type = 'button';
            // Same unified button system as the restyled SPX buttons; the
            // eye glyph is a CSS mask supplied by .spx-btn-eye.
            btn.className = 'spx-btn spx-btn-eye spx-btn--blue';
            btn.textContent = 'xem tem';
            btn.title = 'Xem phiếu · ' + awbCode;
            btn.addEventListener('click', e => {
                e.stopPropagation();
                window._spxSkipWelcome = true;
                const live = resolveAwbFromEye(btn, awbCode);
                btn.title = live;
                previewViaHiddenIframe(live);
            });
            return btn;
        }

        function injectEyeIntoTd(td, awbCode, replace) {
            if (td.dataset.eyeInjected) return;
            td.dataset.eyeInjected = 'true';
            const eye = makeEyeBtn(awbCode);
            // replace → wipe the cell's native text (e.g. the meaningless
            // "Marketplace" in Order Account) and show only the centered eye.
            // Empty cell → center the eye. Non-empty cell (AWB-cell fallback)
            // → append inline so the existing content is preserved.
            if (replace || !td.firstChild) {
                td.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100%;"></div>';
                td.firstChild.appendChild(eye);
            } else {
                eye.style.marginLeft = '8px';
                eye.style.verticalAlign = 'middle';
                td.appendChild(eye);
            }
        }

        // BUG FIX: previously the dataset.eyeAdded flag was set ONLY after
        // an AWB code was found. Rows without SPXVN (header rows, empty rows,
        // collapsed rows) got re-iterated on every mutation — wasteful on
        // large tables. Now we mark eyeChecked first to dedupe the iteration.
        function addEyeToRow(tr) {
            if (tr.dataset.eyeChecked) return;
            tr.dataset.eyeChecked = 'true';

            const tds = Array.from(tr.querySelectorAll('td'));
            let awbCode = null, awbTd = null;
            for (const td of tds) {
                const t = td.textContent?.trim(); // textContent: no reflow
                if (/^SPXVN/.test(t)) { awbCode = t; awbTd = td; break; }
            }
            if (!awbCode) return;

            // HV: re-apply if already confirmed, or kick off a silent check
            if (onInboundPage()) checkHVAndNotify(awbCode, { sound: false });

            // Eye target column: dropoff=4, everything else=6 (Order Account).
            // Fall back to the AWB cell itself if that column is absent so the
            // eye still appears instead of silently vanishing.
            // Order Account (col 6): replace the cell's native text so only
            // the eye shows — the account name is noise for the operator.
            const isDropoff  = onDropoffPage();
            const eyeTdIndex = isDropoff ? 4 : 6;
            const targetTd   = tds[eyeTdIndex];
            if (targetTd) injectEyeIntoTd(targetTd, awbCode, !isDropoff);
            else          injectEyeIntoTd(awbTd, awbCode);
        }

        // Eye button on Ticket Center page — scans `.input-text` spans
        // directly for SPXVN codes. More robust than label-based matching
        // (works regardless of form layout / label text changes).
        function tryAddTicketEye(span) {
            if (!onTicketPage()) return;
            if (span.dataset.tmTicketEye) return;
            const text = span.textContent.trim();
            if (!/^SPXVN\d+$/.test(text)) return;
            span.dataset.tmTicketEye = 'true';
            console.log('[SPX] ticket eye attached:', text);

            const eyeBtn = makeEyeBtn(text);
            // Inline next to the AWB span
            eyeBtn.style.marginLeft = '8px';
            eyeBtn.style.verticalAlign = 'middle';
            span.parentElement.appendChild(eyeBtn);
        }

        // Failsafe interval — observer can miss timing when ticket detail
        // renders deep inside an unobserved subtree. Cheap (single
        // querySelectorAll on ticket pages only).
        setInterval(() => {
            if (!onTicketPage()) return;
            document.querySelectorAll('.input-text').forEach(tryAddTicketEye);
        }, 1500);

        // Widen the Action column (+50%: 172 → 260px). SPX uses table-layout:fixed
        // with colgroup col elements controlling widths — CSS on th/td is ignored.
        // Patching col inline style with !important beats SPX's inline assignment.
        // Two colgroup sets exist (frozen header + scroll body) → update all.
        function wideActionCol() {
            document.querySelectorAll('col:nth-child(19)').forEach(c => {
                if (c.style.getPropertyValue('width') !== '260px')
                    c.style.setProperty('width', '260px', 'important');
            });
        }
        wideActionCol();

        // Failsafe for row action buttons (Print / Remove): when a task
        // completes in-place, Vue patches the button's text back to its
        // native value via a characterData mutation the childList observer
        // never sees. styleActionBtn re-syncs on the class check.
        setInterval(() => {
            document.querySelectorAll('tr.ssc-table-row button.ssc-btn-type-text')
                .forEach(styleActionBtn);
        }, 1500);

        // Failsafe for the "Print Receipt" header button: Vue inserts the
        // node first, then patches its text in via a characterData mutation
        // the childList observer never sees — so the observer hook can land
        // on it while it's still blank. relabelPrintReceipt is idempotent
        // (dataset flag), so this poll is a no-op once it has fired.
        setInterval(() => {
            const b = document.querySelector('button.task-info-task-action');
            if (b) relabelPrintReceipt(b);
        }, 1500);

        // Load persisted HV state + preload audio + preload pdf.js on inbound pages
        loadHVState().then(applyHVTaskStyles);
        if (onInboundPage()) { _loadHVAudio(); getPdfJs().catch(() => {}); }
        _loadStoredToken();

        // ─── SPA cleanup ─────────────────────────────────────────────
        function onNavigate() {
            if (!onAWBPage()) document.getElementById('spx-awb-panel')?.remove();
            setTimeout(wideActionCol, 600);
            setTimeout(applyHVTaskStyles, 700);
            if (onInboundPage()) { _loadHVAudio(); getPdfJs().catch(() => {}); }
            if (onInboundPage() && !onInboundListPage()) scheduleScanDetailPage();
        }
        window.addEventListener('spx-nav', onNavigate);
        window.addEventListener('popstate', onNavigate);

        // ─── Unified MutationObserver ─────────────────────────────────
        function scan(root) {
            // Skip leaf nodes (no element children) — can't host targets we care about
            if (root instanceof HTMLElement && root.childElementCount === 0) return;

            root.querySelectorAll?.('.input-container').forEach(c =>
                onAWBPage() ? initAWBDualPanel(c) : addPasteClearButtons(c)
            );
            root.querySelectorAll?.('button.ssc-button.batch-actions-btn').forEach(replaceExportButton);
            const footer = root.querySelector?.('.dialog-footer');
            if (footer) addGDriveButton(footer);
            root.querySelectorAll?.('tr.ssc-table-row').forEach(addEyeToRow);
            root.querySelectorAll?.('tr.ssc-table-row button.ssc-btn-type-text').forEach(styleActionBtn);
            root.querySelectorAll?.('button.task-info-task-action').forEach(relabelPrintReceipt);
            if (root.querySelector?.('col')) wideActionCol();
            applyHVTaskStyles();
            if (onInboundPage() && !onInboundListPage()) scheduleScanDetailPage();
            if (onTicketPage()) {
                root.querySelectorAll?.('.input-text').forEach(tryAddTicketEye);
            }
        }

        new MutationObserver((mutations) => {
            // Skip mutation batches with no added nodes (Vue/React fire many
            // attribute/text changes — early-return saves CPU on busy SPAs).
            let hasAdd = false;
            for (let i = 0; i < mutations.length; i++) {
                if (mutations[i].addedNodes.length) { hasAdd = true; break; }
            }
            if (!hasAdd) return;

            for (const { addedNodes } of mutations) {
                for (const node of addedNodes) {
                    if (!(node instanceof HTMLElement)) continue;
                    if (node.matches('.input-container'))
                        onAWBPage() ? initAWBDualPanel(node) : addPasteClearButtons(node);
                    if (node.matches('button.ssc-button.batch-actions-btn')) replaceExportButton(node);
                    if (node.matches('.dialog-footer'))                       addGDriveButton(node);
                    if (node.matches('tr.ssc-table-row'))                     addEyeToRow(node);
                    if (node.matches('button.ssc-btn-type-text') && node.closest('tr.ssc-table-row')) styleActionBtn(node);
                    if (node.matches('button.task-info-task-action')) relabelPrintReceipt(node);
                    if (node.matches('.input-text'))                          tryAddTicketEye(node);
                    scan(node);
                }
            }
        }).observe(document.body, { childList: true, subtree: true });

        scan(document);

    }); // end domReady

    console.log('[SPX] find-details v3.34 loaded — pdf.js blob-inject (bypass Edge tracking prevention) + IDB script cache');
})();
