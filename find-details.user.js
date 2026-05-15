// ==UserScript==
// @name         Find Details
// @namespace    http://tampermonkey.net/
// @version      3.27
// @description  Paste+Clear · Tracking modal · GDrive · AWB dual panel · Eye preview (native PDF) · Print Receipt → PDF overlay
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
    const onAWBPage     = () => location.pathname.includes(AWB_PATH);
    const onDropoffPage = () => location.pathname.includes(DROPOFF_PATH);
    const onTicketPage  = () => location.pathname.includes(TICKET_PATH);

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
            btn.textContent = '👁';
            btn.title = awbCode;
            btn.style.cssText = 'padding:0;font-size:20px;line-height:1;background:transparent;border:none;cursor:pointer;display:block;margin:0 auto;';
            btn.addEventListener('click', e => {
                e.stopPropagation();
                window._spxSkipWelcome = true;
                const live = resolveAwbFromEye(btn, awbCode);
                btn.title = live;
                previewViaHiddenIframe(live);
            });
            return btn;
        }

        function injectEyeIntoTd(td, awbCode) {
            if (td.dataset.eyeInjected) return;
            td.dataset.eyeInjected = 'true';
            const eye = makeEyeBtn(awbCode);
            // Empty target cell → center the eye; non-empty cell (AWB-cell
            // fallback, or layouts that render content here) → append so the
            // existing content is not destroyed.
            if (!td.firstChild) {
                td.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100%;"></div>';
                td.firstChild.appendChild(eye);
            } else {
                eye.style.cssText += 'display:inline-block;margin-left:8px;vertical-align:middle;';
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

            // Eye target column: dropoff=4, everything else=6 (Order Account).
            // Fall back to the AWB cell itself if that column is absent so the
            // eye still appears instead of silently vanishing.
            const eyeTdIndex = onDropoffPage() ? 4 : 6;
            injectEyeIntoTd(tds[eyeTdIndex] || awbTd, awbCode);
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
            // Inline next to the AWB span (override table-style block layout)
            eyeBtn.style.cssText += 'display:inline-block;margin:0 0 0 8px;vertical-align:middle;';
            span.parentElement.appendChild(eyeBtn);
        }

        // Failsafe interval — observer can miss timing when ticket detail
        // renders deep inside an unobserved subtree. Cheap (single
        // querySelectorAll on ticket pages only).
        setInterval(() => {
            if (!onTicketPage()) return;
            document.querySelectorAll('.input-text').forEach(tryAddTicketEye);
        }, 1500);

        // ─── SPA cleanup ─────────────────────────────────────────────
        function onNavigate() {
            if (!onAWBPage()) document.getElementById('spx-awb-panel')?.remove();
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
                    if (node.matches('.input-text'))                          tryAddTicketEye(node);
                    scan(node);
                }
            }
        }).observe(document.body, { childList: true, subtree: true });

        scan(document);

    }); // end domReady

    console.log('[SPX] find-details v3.27 loaded — race-free print block + overlay/iframe recovery + audit fixes');
})();
