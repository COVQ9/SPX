// ==UserScript==
// @name         HV notify test
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Test: intercept fetch+XHR → cảnh báo toast khi notify_high_value: true
// @match        https://sp.spx.shopee.vn/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
'use strict';

const TARGET = 'order/add';

function onJSON(data) {
    if (data?.data?.notify_high_value === true) showHVToast();
}

/* ── fetch ── */
const _fetch = window.fetch;
window.fetch = async function (...args) {
    const res = await _fetch(...args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (url.includes(TARGET)) res.clone().json().then(onJSON).catch(() => {});
    return res;
};

/* ── XHR ── */
const _open = XMLHttpRequest.prototype.open;
const _send = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._spxUrl = url;
    return _open.call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.send = function (...args) {
    if (this._spxUrl?.includes(TARGET)) {
        this.addEventListener('load', function () {
            try { onJSON(JSON.parse(this.responseText)); } catch {}
        });
    }
    return _send.apply(this, args);
};

/* ── Toast ── */
function showHVToast() {
    let el = document.getElementById('spx-hv-toast');
    if (!el) {
        el = Object.assign(document.createElement('div'), { id: 'spx-hv-toast' });
        Object.assign(el.style, {
            position     : 'fixed',
            top          : '50%',
            left         : '50%',
            transform    : 'translate(-50%, -50%)',
            zIndex       : '2147483647',
            padding      : '18px 32px',
            background   : '#ff4d00',
            color        : '#fff',
            fontSize     : '22px',
            fontWeight   : '800',
            borderRadius : '12px',
            boxShadow    : '0 8px 32px rgba(0,0,0,0.45)',
            fontFamily   : 'system-ui, sans-serif',
            textAlign    : 'center',
            opacity      : '0',
            transition   : 'opacity 0.25s',
            pointerEvents: 'none',
        });
        document.body.appendChild(el);
    }
    el.textContent = '⚠️ HÀNG GIÁ TRỊ CAO';
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 5000);
}

console.log('[HV-test] v1.2 loaded — watching fetch + XHR on', TARGET);
})();