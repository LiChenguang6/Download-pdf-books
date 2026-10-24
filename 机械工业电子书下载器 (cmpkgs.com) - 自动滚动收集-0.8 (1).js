// ==UserScript==
// @name         机械工业电子书下载器 (cmpkgs.com) - 自动滚动收集
// @namespace    https://qinlili.bid
// @version      0.8
// @description  自动滚动收集所有PDF页面并合并为完整PDF
// @author       qinlili (修改版)
// @match        https://dcd.cmpkgs.com/*
// @require      https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';
    const LOG_PREFIX = '[PDF-DL]';
    const log = (...args) => console.log(LOG_PREFIX, ...args);

    const state = {
        capturedPages: new Map(),
        collecting: false,
        lastRequestedPage: null,
        captureWaiters: [],
        scrollContainer: null,
    };

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const downloadBlob = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `book_${Date.now()}.pdf`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        log('已触发下载:', a.download);
    };

    // ---------- pdf-lib ----------
    const getPdfLib = () => {
        try { if (typeof PDFLib !== 'undefined' && PDFLib && PDFLib.PDFDocument) return PDFLib; } catch(e) {}
        try { if (window.PDFLib && window.PDFLib.PDFDocument) return window.PDFLib; } catch(e) {}
        return null;
    };
    const ensurePdfLib = () => new Promise((resolve, reject) => {
        const existing = getPdfLib();
        if (existing) return resolve(existing);
        const urls = [
            'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
            'https://fastly.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
            'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
        ];
        let idx = 0;
        const tryNext = () => {
            if (idx >= urls.length) return reject(new Error('所有 CDN 均无法加载 pdf-lib'));
            const url = urls[idx++];
            log('尝试加载 pdf-lib:', url);
            const s = document.createElement('script');
            s.src = url;
            s.onload = () => { const lib = getPdfLib(); lib ? resolve(lib) : tryNext(); };
            s.onerror = () => tryNext();
            (document.head || document.documentElement).appendChild(s);
        };
        tryNext();
    });

    // ---------- 页码 ----------
    const detectCurrentPage = () => {
        const t = document.body ? document.body.innerText : '';
        const m = t.match(/(\d+)\s*\/\s*(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    };
    const detectTotalPages = () => {
        const t = document.body ? document.body.innerText : '';
        const m = t.match(/(\d+)\s*\/\s*(\d+)/);
        return m ? parseInt(m[2], 10) : null;
    };

    // ---------- 保存一页 ----------
    const savePage = (pageNum, data) => {
        if (!pageNum || !data || data.length === 0) return;
        if (state.capturedPages.has(pageNum)) return;
        state.capturedPages.set(pageNum, new Uint8Array(data));
        log(`✔ 捕获第 ${pageNum} 页（共 ${state.capturedPages.size}）`);
        updateStatus(`已捕获 ${state.capturedPages.size} 页，最新: 第 ${pageNum} 页`);
        const ws = state.captureWaiters.splice(0);
        ws.forEach(r => r(pageNum));
    };

    // ---------- 网络层拦截（仅记页码） ----------
    const installNetworkInterceptor = () => {
        const origFetch = window.fetch;
        window.fetch = function(...args) {
            try {
                const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
                if (url) {
                    const m = String(url).match(/\/(\d+)\.pdf/);
                    if (m) state.lastRequestedPage = parseInt(m[1], 10);
                }
            } catch(e) {}
            return origFetch.apply(this, args);
        };
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            try {
                const m = String(url).match(/\/(\d+)\.pdf/);
                if (m) state.lastRequestedPage = parseInt(m[1], 10);
            } catch(e) {}
            return origOpen.apply(this, arguments);
        };
        log('网络拦截器已安装');
    };

    // ---------- Hook getDocument ----------
    let _hooked = false;
    const hookLib = (lib) => {
        if (_hooked || !lib || !lib.getDocument) return false;
        const origGetDocument = lib.getDocument;
        lib.getDocument = function(src) {
            try {
                let data = null;
                if (src instanceof Uint8Array) data = src;
                else if (src && src.data instanceof Uint8Array) data = src.data;

                if (data && data.length > 0) {
                    let pageNum = state.lastRequestedPage;
                    if (!pageNum || state.capturedPages.has(pageNum)) {
                        const dp = detectCurrentPage();
                        if (dp && !state.capturedPages.has(dp)) pageNum = dp;
                    }
                    if (!pageNum) pageNum = state.capturedPages.size + 1;
                    savePage(pageNum, data);
                }
            } catch(e) { log('捕获异常:', e); }
            return origGetDocument.apply(this, arguments);
        };
        _hooked = true;
        log('getDocument Hook 已安装（抢占模式）');
        return true;
    };

    // ---------- 抢占 pdfjsLib 赋值 ----------
    const hijackPdfjsLib = () => {
        try {
            const desc = Object.getOwnPropertyDescriptor(window, 'pdfjsLib');
            if (desc && desc.configurable === false) {
                log('pdfjsLib 不可配置，改用轮询');
                return false;
            }
            let _val = window.pdfjsLib;
            Object.defineProperty(window, 'pdfjsLib', {
                configurable: true,
                get() { return _val; },
                set(v) {
                    _val = v;
                    log('⚡ pdfjsLib 被赋值，立即 Hook');
                    try { hookLib(v); } catch(e) { log('hook 失败:', e); }
                }
            });
            // 已存在则立即 hook
            if (_val) hookLib(_val);
            return true;
        } catch(e) {
            log('defineProperty 失败:', e.message);
            return false;
        }
    };

    // 轮询兜底
    const waitForPdfjsLib = () => {
        if (_hooked) return;
        if (hookLib(window.pdfjsLib)) return;
        const t = setInterval(() => {
            if (hookLib(window.pdfjsLib)) clearInterval(t);
        }, 100);
    };

    // ---------- 滚动容器 ----------
    const findScrollContainer = () => {
        if (state.scrollContainer && document.contains(state.scrollContainer)) return state.scrollContainer;
        let el = document.querySelector('.pdf-single-view') ||
                 document.querySelector('[class*="pdf-single"]') ||
                 document.querySelector('[class*="pdfViewer"]');
        if (el && el.scrollHeight > el.clientHeight + 100) {
            state.scrollContainer = el;
            return el;
        }
        let best = null, bestDiff = 0;
        document.querySelectorAll('div').forEach(d => {
            const diff = d.scrollHeight - d.clientHeight;
            if (diff > 500 && d.clientHeight > 200 && diff > bestDiff) {
                bestDiff = diff; best = d;
            }
        });
        if (!best) {
            const d = document.scrollingElement || document.documentElement;
            if (d.scrollHeight - d.clientHeight > 500) best = d;
        }
        state.scrollContainer = best;
        return best;
    };

    const scrollToTop = async () => {
        const c = findScrollContainer();
        if (c) { c.scrollTop = 0; if (c.scrollTo) c.scrollTo(0, 0); }
        if (window.scrollTo) window.scrollTo(0, 0);
        await sleep(1500);
        log('已回到顶部，当前页:', detectCurrentPage());
    };

    // ---------- 翻页 ----------
    const tryNavigate = async () => {
        const before = state.capturedPages.size;
        const c = findScrollContainer();
        if (c) {
            const step = Math.max(c.clientHeight * 0.85, 700);
            c.scrollTop = c.scrollTop + step;
            await sleep(1200);
            if (state.capturedPages.size > before) return 'scroll';
        }
        for (const key of ['PageDown', 'ArrowRight', 'ArrowDown']) {
            const code = key === 'PageDown' ? 34 : key === 'ArrowRight' ? 39 : 40;
            const o = { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true };
            document.dispatchEvent(new KeyboardEvent('keydown', o));
            document.dispatchEvent(new KeyboardEvent('keyup', o));
            window.dispatchEvent(new KeyboardEvent('keydown', o));
            window.dispatchEvent(new KeyboardEvent('keyup', o));
            await sleep(1000);
            if (state.capturedPages.size > before) return key;
        }
        return null;
    };

    // ---------- 收集 ----------
    const autoCollect = async () => {
        if (state.collecting) { alert('已经在收集中'); return; }
        state.collecting = true;
        // 不要清空！保留初次加载捕获到的页面
        // state.capturedPages.clear();
        state.lastRequestedPage = null;

        const total = detectTotalPages();
        log('总页数:', total);

        log('回到顶部...');
        updateStatus('回到顶部...');
        await scrollToTop();
        await sleep(1500);

        updateStatus(`开始收集，已有 ${state.capturedPages.size} 页，总页数 ${total || '?'}`);

        let fails = 0;
        const maxFails = 15;

        while (state.collecting) {
            const before = state.capturedPages.size;
            const method = await tryNavigate();
            log('导航:', method, '| 捕获:', state.capturedPages.size);

            if (state.capturedPages.size === before) {
                fails++;
                if (fails >= maxFails) { log('连续失败，停止'); break; }
                const cur = detectCurrentPage();
                if (total && cur && cur >= total) { log('已到最后一页'); break; }
            } else {
                fails = 0;
            }
            await sleep(200);
        }

        state.collecting = false;
        log('收集结束，共捕获', state.capturedPages.size, '页');

        if (state.capturedPages.size === 0) { alert('未捕获到任何页面'); return; }
        if (confirm(`已捕获 ${state.capturedPages.size} 页，是否合并并下载？`)) {
            await doMergeAndDownload();
        }
    };

    // ---------- 合并 ----------
    const doMergeAndDownload = async () => {
        try {
            updateStatus('加载 pdf-lib...');
            const LibRef = await ensurePdfLib();
            if (!LibRef) { alert('pdf-lib 加载失败'); return; }
            const { PDFDocument } = LibRef;

            const entries = [...state.capturedPages.entries()]
                .filter(([k, v]) => typeof k === 'number' && v instanceof Uint8Array)
                .sort((a, b) => a[0] - b[0]);

            log('开始合并', entries.length, '页...');
            updateStatus(`合并中... (${entries.length} 页)`);

            const merged = await PDFDocument.create();
            for (const [pageNum, data] of entries) {
                try {
                    const srcDoc = await PDFDocument.load(data, { ignoreEncryption: true });
                    const pages = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
                    pages.forEach(p => merged.addPage(p));
                    if (pageNum % 50 === 0) log(`已合并到第 ${pageNum} 页`);
                } catch (e) {
                    log(`第 ${pageNum} 页合并失败:`, e.message);
                }
            }

            const bytes = await merged.save();
            downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${document.title || 'book'}_merged.pdf`);
            updateStatus('✅ 完成！');
        } catch (e) {
            log('合并失败:', e);
            alert('合并失败: ' + e.message);
        }
    };

    // ---------- UI ----------
    let statusEl = null;
    const updateStatus = (text) => { if (statusEl) statusEl.textContent = text; };

    const addUI = () => {
        if (document.getElementById('pdf-dl-panel')) return;
        const c = document.createElement('div');
        c.id = 'pdf-dl-panel';
        c.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;align-items:flex-end;font-family:-apple-system,sans-serif;';

        statusEl = document.createElement('div');
        statusEl.textContent = '就绪';
        statusEl.style.cssText = 'padding:6px 10px;background:rgba(0,0,0,0.75);color:#fff;border-radius:4px;font-size:12px;max-width:320px;';

        const mk = (t, bg, fn) => {
            const b = document.createElement('button');
            b.textContent = t;
            b.style.cssText = `padding:8px 14px;background:${bg};color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
            b.onclick = fn;
            return b;
        };

        c.appendChild(statusEl);
        c.appendChild(mk('▶ 自动收集并合并', '#2c7be5', autoCollect));
        c.appendChild(mk('⏹ 停止', '#c0392b', () => { state.collecting = false; updateStatus('已停止'); }));
        c.appendChild(mk('🔗 只合并已捕获', '#16a085', doMergeAndDownload));
        c.appendChild(mk('📚 回到第一页', '#8e44ad', async () => { updateStatus('回到第一页...'); await scrollToTop(); updateStatus('已到第一页'); }));
        c.appendChild(mk('🗑 清空已捕获', '#7f8c8d', () => { if (confirm('确定清空？')) { state.capturedPages.clear(); updateStatus('已清空'); } }));
        c.appendChild(mk('ℹ 状态', '#555', () => {
            const keys = [...state.capturedPages.keys()].sort((a, b) => a - b);
            alert(
                `已捕获: ${state.capturedPages.size} 页\n` +
                `当前页码: ${detectCurrentPage()}\n` +
                `总页数: ${detectTotalPages()}\n` +
                `最后请求页: ${state.lastRequestedPage}\n` +
                `pdf-lib: ${getPdfLib() ? '已加载' : '未加载'}\n` +
                `已捕获页码: ${keys.slice(0, 30).join(', ')}${keys.length > 30 ? '...' : ''}`
            );
        }));

        document.body.appendChild(c);
    };

    // ---------- 启动 ----------
    // 关键：先抢占 pdfjsLib
    hijackPdfjsLib();
    installNetworkInterceptor();
    waitForPdfjsLib();
    ensurePdfLib().catch(e => log('预热 pdf-lib 失败:', e.message));

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addUI);
    } else {
        addUI();
    }
    log('脚本已启动 (v0.8 抢占模式)');
})();