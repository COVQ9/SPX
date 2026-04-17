// ==UserScript==
// @name         Find Details
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/Find%20Details.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/Find%20Details.user.js
// @version      3.8
// @description  Paste+Clear · Tracking modal · GDrive link · AWB dual panel · Drop-off PNG preview
// @match        https://sp.spx.shopee.vn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const GDRIVE_LINK  = 'https://drive.google.com/drive/folders/17EdMQqhggtl-TEtkKRcRyVBVeL-476kc?usp=sharing';
    const AWB_PATH     = '/order-management/awb-printing';
    const DROPOFF_PATH  = '/order-management/drop-off';
    const onAWBPage      = () => location.pathname.includes(AWB_PATH);
    const onDropoffPage  = () => location.pathname.includes(DROPOFF_PATH);

    // ─── Intercept window.open ────────────────────────────────────────
    // Armed on AWB page to capture PDF URLs
    const _origOpen = window.open;
    window.open = function (url, ...rest) {
        if (url && onAWBPage()) {
            showPDFAsImage(url);
            return null;
        }
        return _origOpen.call(this, url, ...rest);
    };

    // ─── SPA navigation hook ─────────────────────────────────────────
    ['pushState', 'replaceState'].forEach(method => {
        const orig = history[method];
        history[method] = function () {
            orig.apply(this, arguments);
            window.dispatchEvent(new Event('spx-nav'));
        };
    });

    // ─── PDF.js — GM-cached, never hits CDN again after first load ────
    const PDFJS_VER   = '4.3.136';
    const PDFJS_CDN   = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.min.mjs`;
    const WORKER_CDN  = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.worker.min.mjs`;
    let _pdfjsLib     = null;
    let _workerBlobUrl = null;

    async function getOrCache(gmKey, cdnUrl) {
        let src = GM_getValue(gmKey, null);
        if (!src) {
            src = await (await fetch(cdnUrl)).text();
            GM_setValue(gmKey, src);
        }
        return src;
    }

    async function getPDFJS() {
        if (_pdfjsLib) return _pdfjsLib;
        const [libSrc, workerSrc] = await Promise.all([
            getOrCache(`pdfjs_lib_${PDFJS_VER}`,    PDFJS_CDN),
            getOrCache(`pdfjs_worker_${PDFJS_VER}`, WORKER_CDN)
        ]);
        _workerBlobUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
        const libBlob  = URL.createObjectURL(new Blob([libSrc],    { type: 'text/javascript' }));
        const mod      = await import(libBlob);
        URL.revokeObjectURL(libBlob);
        mod.GlobalWorkerOptions.workerSrc = _workerBlobUrl;
        _pdfjsLib = mod;
        return mod;
    }

    // ─── Core: render PDF URL → PNG overlay ──────────────────────────
    async function showPDFAsImage(url) {
        document.getElementById('spx-pdf-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'spx-pdf-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)',
            zIndex: '999999', display: 'flex', justifyContent: 'center', alignItems: 'center'
        });
        const close = () => { overlay.remove(); document.removeEventListener('keydown', _esc); };
        const _esc = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', _esc);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        const box = document.createElement('div');
        Object.assign(box.style, {
            position: 'relative', display: 'inline-block',
            background: '#fff', borderRadius: '8px',
            padding: '24px', fontSize: '16px', color: '#888'
        });
        box.textContent = 'Đang tải...';
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        try {
            const pdfjsLib = await getPDFJS();
            const pdf      = await pdfjsLib.getDocument(url).promise;
            const page     = await pdf.getPage(1);
            const scale    = 4;
            const viewport = page.getViewport({ scale });
            const canvas   = document.createElement('canvas');
            canvas.width   = viewport.width;
            canvas.height  = viewport.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

            const img = document.createElement('img');
            img.src = canvas.toDataURL('image/png');
            Object.assign(img.style, {
                width:     (viewport.width  / 2) + 'px',
                maxHeight: '85vh',
                maxWidth:  '90vw',
                height:    'auto',
                borderRadius: '6px', display: 'block'
            });

            const closeBtn = document.createElement('div');
            closeBtn.innerHTML = '✖';
            Object.assign(closeBtn.style, {
                position: 'absolute', top: 0, right: 0,
                width: '44px', height: '44px', borderBottomLeftRadius: '44px',
                background: '#ff3b30', color: '#fff', fontSize: '22px',
                display: 'flex', justifyContent: 'center', alignItems: 'center', cursor: 'pointer'
            });
            closeBtn.onclick = close;

            box.textContent = '';
            box.style.padding = '0';
            box.append(closeBtn, img);
        } catch (e) {
            box.textContent = 'Lỗi: ' + e.message;
        }
    }

    // ─── Drop-off preview: hidden iframe → intercept window.open ─────
    function previewViaHiddenIframe(awbCode) {
        // Show loading overlay immediately
        document.getElementById('spx-pdf-overlay')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'spx-pdf-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)',
            zIndex: '999999', display: 'flex', justifyContent: 'center', alignItems: 'center'
        });

        // Hidden iframe loads awb-printing, fills AWB, triggers preview
        const iframe = document.createElement('iframe');

        const close = () => {
            overlay.remove(); iframe.remove();
            document.removeEventListener('keydown', _esc);
        };
        const _esc = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', _esc);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        const box = document.createElement('div');
        Object.assign(box.style, {
            position: 'relative', display: 'inline-block',
            background: '#fff', borderRadius: '8px',
            padding: '24px', fontSize: '16px', color: '#888'
        });
        box.textContent = 'Đang tải...';
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        iframe.src = `https://sp.spx.shopee.vn${AWB_PATH}`;
        iframe.style.cssText = 'position:fixed;width:0;height:0;border:none;opacity:0;pointer-events:none;';
        document.body.appendChild(iframe);

        const onFail = () => { box.textContent = 'Lỗi: không tải được AWB'; };

        iframe.onload = () => {
            try {
                // Intercept window.open inside the iframe
                iframe.contentWindow.open = (url) => {
                    iframe.remove();
                    overlay.remove(); // remove loading box; showPDFAsImage creates its own
                    document.removeEventListener('keydown', _esc);
                    showPDFAsImage(url);
                    return null;
                };
            } catch {}
            tryFillAndPreview(iframe, awbCode, onFail);
        };
    }

    function tryFillAndPreview(iframe, awbCode, onFail, retries = 25, interval = 300) {
        const retry = () => {
            if (retries > 0 && iframe.isConnected)
                setTimeout(() => tryFillAndPreview(iframe, awbCode, onFail, retries - 1, interval), interval);
            else if (!iframe.isConnected) return; // overlay already closed
            else { iframe.remove(); if (onFail) onFail(); } // retries exhausted
        };
        try {
            const doc        = iframe.contentDocument;
            if (!doc) return retry();
            const input      = doc.querySelector('div.ssc-input input[placeholder="Please input or Scan"]');
            const previewBtn = doc.querySelector('button.ssc-button.preview-btn');
            if (!input || !previewBtn) return retry();

            // Fill using native setter for Vue reactivity
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(input, awbCode);
            input.dispatchEvent(new Event('input',  { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            setTimeout(() => previewBtn.click(), 80);
        } catch { retry(); }
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
            const overlay = document.createElement('div');
            Object.assign(overlay.style, {
                position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
                backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 999999,
                display: 'flex', justifyContent: 'center', alignItems: 'center'
            });
            const modal = document.createElement('div');
            Object.assign(modal.style, {
                width: '80%', height: '80%', background: '#fff',
                borderRadius: '8px', overflow: 'hidden', position: 'relative'
            });
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'width:100%;height:100%;border:none;';
            iframe.src = url;

            const closeBtn = document.createElement('div');
            closeBtn.innerHTML = '✖';
            Object.assign(closeBtn.style, {
                position: 'absolute', top: 0, right: 0,
                width: '60px', height: '60px', borderBottomLeftRadius: '60px',
                background: '#ff3b30', color: '#fff', fontSize: '32px',
                display: 'flex', justifyContent: 'center', alignItems: 'center',
                cursor: 'pointer', zIndex: 1000000
            });
            closeBtn.onclick = () => overlay.remove();
            overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
            modal.append(closeBtn, iframe);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            iframe.onload = () => {
                if (enablePDFTrap) {
                    try { iframe.contentWindow.open = u => { iframe.src = u; return null; }; } catch {}
                }
                if (awbCode) tryFillAWB(iframe, awbCode);
            };
        }

        function tryFillAWB(iframe, awbCode, retries = 20, interval = 300) {
            const retry = () => {
                if (retries > 0 && iframe.isConnected)
                    setTimeout(() => tryFillAWB(iframe, awbCode, retries - 1, interval), interval);
            };
            try {
                const doc = iframe.contentDocument;
                if (!doc) return retry();
                const input      = doc.querySelector('div.ssc-input input[placeholder="Please input or Scan"]');
                const previewBtn = doc.querySelector('button.ssc-button.preview-btn');
                if (!input || !previewBtn) return retry();
                const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(input, awbCode);
                input.dispatchEvent(new Event('input',  { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                setTimeout(() => previewBtn.click(), 80);
            } catch { retry(); }
        }

        // Row click → select + copy AWB
        document.body.addEventListener('click', (e) => {
            const tr = e.target.closest('tr.ssc-table-row-highlighted');
            if (!tr) return;
            const awbTd = Array.from(tr.querySelectorAll('td')).find(td => /^SPXVN.+/.test(td.innerText.trim()));
            if (!awbTd) return;
            const range = document.createRange();
            range.selectNodeContents(awbTd);
            const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
            navigator.clipboard.writeText(awbTd.innerText.trim());
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
                if (textarea) { textarea.value = GDRIVE_LINK; textarea.dispatchEvent(new Event('input', { bubbles: true })); }
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
                Object.assign(b.style, {
                    fontSize: '20px', padding: '0 28px', height: '80px',
                    background: bg, color: '#fff', border: 'none',
                    borderRadius: '8px', cursor: 'pointer',
                    fontWeight: '600', whiteSpace: 'nowrap', flexShrink: '0'
                });
                return b;
            }

            function buildRow(mode) {
                const isPreview = mode === 'preview';
                const row = document.createElement('div');
                Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '12px' });

                const pasteBtn  = makeBigBtn('Paste', '#007bff');
                const clearBtn  = makeBigBtn('Clear', '#dc3545');
                const actionBtn = makeBigBtn(isPreview ? 'Preview' : 'Print', isPreview ? '#d48806' : '#ee4d2d');

                const input = document.createElement('input');
                input.placeholder = isPreview ? 'nhập mã vận đơn để xem phiếu' : 'nhập mã vận đơn để in';
                Object.assign(input.style, {
                    fontSize: '26px', padding: '0 22px',
                    border: '2px solid #d9d9d9', borderRadius: '8px',
                    width: '580px', height: '80px',
                    boxSizing: 'border-box', outline: 'none',
                    transition: 'border-color .15s', flexShrink: '0'
                });
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
            Object.assign(divider.style, {
                border: 'none', borderTop: '2px solid #e8e8e8',
                width: 'calc(100% + 20px)', margin: '0 -10px'
            });

            const panel = document.createElement('div');
            panel.id = 'spx-awb-panel';
            Object.assign(panel.style, {
                position: 'fixed',
                left: 'calc(220px + (100vw - 220px) / 2)', top: '50%',
                transform: 'translate(-50%, -50%)',
                display: 'flex', flexDirection: 'column', gap: '48px',
                zIndex: '50'
            });
            panel.append(previewRow, divider, printRow);
            document.body.appendChild(panel);
            setTimeout(() => previewInput.focus(), 300);
        }

        // ─── Feature 5 · Eye button in table rows ────────────────────
        function makeEyeBtn(awbCode) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = '👁';
            btn.title = awbCode;
            Object.assign(btn.style, {
                padding: '0', fontSize: '20px', lineHeight: '1',
                background: 'transparent', border: 'none',
                cursor: 'pointer', display: 'block', margin: '0 auto'
            });
            btn.addEventListener('click', e => {
                e.stopPropagation();
                window._spxSkipWelcome = true;
                previewViaHiddenIframe(awbCode);
            });
            return btn;
        }

        function injectEyeIntoTd(td, awbCode) {
            if (td.dataset.eyeInjected) return;
            td.dataset.eyeInjected = 'true';
            td.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100%;"></div>';
            td.firstChild.appendChild(makeEyeBtn(awbCode));
        }

        function addEyeToRow(tr) {
            if (tr.dataset.eyeAdded) return;
            const tds = Array.from(tr.querySelectorAll('td'));

            // Find AWB code from any td
            let awbCode = null;
            for (const td of tds) {
                const t = td.innerText?.trim();
                if (/^SPXVN/.test(t)) { awbCode = t; break; }
            }
            if (!awbCode) return;

            // Eye target column: dropoff=4, everything else=6 (Order Account)
            const eyeTdIndex = onDropoffPage() ? 4 : 6;
            if (!tds[eyeTdIndex]) return;
            tr.dataset.eyeAdded = 'true';
            injectEyeIntoTd(tds[eyeTdIndex], awbCode);
        }

        // ─── SPA cleanup ─────────────────────────────────────────────
        function onNavigate() {
            if (!onAWBPage()) document.getElementById('spx-awb-panel')?.remove();
        }
        window.addEventListener('spx-nav', onNavigate);
        window.addEventListener('popstate', onNavigate);

        // ─── Unified MutationObserver ─────────────────────────────────
        function scan(root) {
            root.querySelectorAll?.('.input-container').forEach(c =>
                onAWBPage() ? initAWBDualPanel(c) : addPasteClearButtons(c)
            );
            root.querySelectorAll?.('button.ssc-button.batch-actions-btn').forEach(replaceExportButton);
            const footer = root.querySelector?.('.dialog-footer');
            if (footer) addGDriveButton(footer);
            root.querySelectorAll?.('tr.ssc-table-row').forEach(addEyeToRow);
        }

        new MutationObserver((mutations) => {
            for (const { addedNodes } of mutations) {
                for (const node of addedNodes) {
                    if (!(node instanceof HTMLElement)) continue;
                    if (node.matches('.input-container'))
                        onAWBPage() ? initAWBDualPanel(node) : addPasteClearButtons(node);
                    if (node.matches('button.ssc-button.batch-actions-btn')) replaceExportButton(node);
                    if (node.matches('.dialog-footer'))                       addGDriveButton(node);
                    if (node.matches('tr.ssc-table-row'))                     addEyeToRow(node);
                    scan(node);
                }
            }
        }).observe(document.body, { childList: true, subtree: true });

        scan(document);

    }); // end domReady

})();