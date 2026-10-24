// ==UserScript==
// @name         科学文库：官方整书后台下载
// @namespace    https://github.com/LiChenguang6/Download-pdf-books
// @version      1.0.0
// @description  使用科学文库官方离线下载入口保存整书，无需自动翻页；保留官方文件格式和阅读方式。
// @match        https://book.sciencereading.cn/shop/book/Booksimple/onlineRead.do*
// @match        https://book.sciencereading.cn/shop/book/Booksimple/show.do*
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @connect      book.sciencereading.cn
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
    'use strict';

    const PREFIX = '/shop/book/Booksimple/';
    const ORIGIN = 'https://book.sciencereading.cn';
    const bookId = new URL(location.href).searchParams.get('id');
    if (location.origin !== ORIGIN || !bookId || !/^[\w-]{1,128}$/.test(bookId)) return;
    if (document.getElementById('science-official-download')) return;

    const detailURL = new URL(`${PREFIX}show.do`, ORIGIN);
    detailURL.searchParams.set('id', bookId);
    let currentJob = null;
    let activeDownload = null;

    const host = document.createElement('div');
    host.id = 'science-official-download';
    const ui = host.attachShadow({ mode: 'open' });
    ui.innerHTML = `
        <style>
            :host { position:fixed; right:16px; bottom:16px; z-index:2147483647;
                font:14px/1.6 system-ui,sans-serif; color:#202b3c; text-align:left; }
            section { width:min(340px,calc(100vw - 32px)); background:#fff;
                border:1px solid #ccd5e1; border-radius:12px; box-shadow:0 5px 24px #0002; }
            header { display:flex; align-items:center; justify-content:space-between;
                padding:10px 14px; border-bottom:1px solid #e5eaf0; }
            h2 { margin:0; font-size:15px; }
            #body { padding:12px 14px; }
            p { margin:0 0 10px; overflow-wrap:anywhere; }
            .muted { color:#536174; font-size:12px; }
            .actions { display:flex; flex-wrap:wrap; gap:8px; }
            button,a { font:inherit; }
            button { cursor:pointer; border:1px solid #ccd5e1; border-radius:6px;
                background:#f5f7fa; color:inherit; padding:6px 10px; }
            #download { background:#1859c9; border-color:#1859c9; color:white; }
            button:disabled { opacity:.55; cursor:default; }
            a { color:#1859c9; }
            #toggle { border:0; padding:0 6px; background:none; }
            progress { width:100%; height:8px; margin:10px 0; }
            [hidden] { display:none !important; }
            #status { margin:10px 0 0; }
        </style>
        <section aria-label="科学文库官方下载助手">
            <header><h2>官方整书下载</h2><button id="toggle" aria-expanded="true" aria-label="折叠下载面板">收起</button></header>
            <div id="body">
                <p id="title"></p>
                <p class="muted">直接下载官方离线文件，无需翻页。文件通常需 KXReader 打开；以网站标注的有效期为准。</p>
                <div class="actions">
                    <button id="download">后台下载整书</button>
                    <button id="native">网站原生下载</button>
                    <a id="native-link" target="_blank" rel="noopener noreferrer" hidden>点击开始原生下载</a>
                    <button id="cancel" disabled>取消</button>
                </div>
                <progress id="progress" hidden></progress>
                <p id="status" role="status" aria-live="polite">登录具有下载权限的账号后点击下载。下载期间无需保持页面在前台。</p>
                <p class="muted" style="margin:10px 0 0"><a id="detail" target="_blank" rel="noopener noreferrer">打开图书详情页</a></p>
            </div>
        </section>`;
    document.body.appendChild(host);
    const $ = id => ui.getElementById(id);
    const title = document.getElementById('bookName')?.value || document.title || '科学文库图书';
    $('title').textContent = title;
    $('detail').href = detailURL.href;

    const setStatus = text => { $('status').textContent = text; };
    const setBusy = busy => {
        $('download').disabled = busy;
        $('native').disabled = busy;
        $('cancel').disabled = !busy;
    };
    const canceled = () => new DOMException('已取消下载', 'AbortError');
    const checkCanceled = signal => { if (signal.aborted) throw canceled(); };
    const formatBytes = n => `${(n / 1024 / 1024).toFixed(1)} MB`;
    const fileName = value => {
        const clean = Array.from(String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
            .replace(/[.\s]+$/g, '')).slice(0, 120).join('') || '科学文库图书';
        const safe = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean) ? `_${clean}` : clean;
        return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
    };

    async function readText(url, options, signal) {
        const response = await fetch(url, {
            ...options, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'follow',
        });
        if (!response.ok) throw new Error(`网站请求失败（HTTP ${response.status}），请稍后重试或使用原生下载。`);
        // A login redirect must never be mistaken for a successful permission check.
        if (new URL(response.url || url, ORIGIN).origin !== ORIGIN) {
            throw new Error('网站跳转到了登录或其他站点，请在详情页完成登录后重试。');
        }
        return response.text();
    }

    async function prepare(signal) {
        setStatus('正在核对账号下载权限…');
        const permission = await readText(new URL(`${PREFIX}checkUserPermission.do`, ORIGIN).href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ id: bookId }).toString(),
        }, signal);
        checkCanceled(signal);
        if (permission.trim() !== 'true') {
            throw new Error('网站尚未确认当前账号有下载权限。请打开详情页登录，并确认能看到官方“下载”按钮后重试。');
        }

        setStatus('正在读取官方整书下载表单…');
        const html = await readText(detailURL.href, { method: 'GET' }, signal);
        checkCanceled(signal);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const form = doc.getElementById('form1');
        const idField = form?.querySelector('input[name="id"]');
        const readMarkField = form?.querySelector('input[name="readMark"]');
        if (!form || idField?.value !== bookId || !readMarkField) {
            throw new Error('图书下载表单不匹配，可能已退出登录或网站已改版。请使用详情页官方下载按钮。');
        }
        if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') {
            throw new Error('网站下载表单已变更，请使用详情页的官方下载按钮。');
        }
        // This is the endpoint and readMark value used by the site's offlineDownload()
        // after checkUserPermission succeeds. Do not query reader APIs or DRM keys.
        const downloadURL = new URL(`${PREFIX}offlineDownload.do`, ORIGIN);
        for (const [name, value] of new FormData(form)) {
            if (typeof value === 'string') downloadURL.searchParams.append(name, value);
        }
        downloadURL.searchParams.set('id', bookId);
        downloadURL.searchParams.set('readMark', '1');
        return { url: downloadURL.href, name: fileName(doc.title || title) };
    }

    function delay(ms, signal) {
        return new Promise((resolve, reject) => {
            checkCanceled(signal);
            const onAbort = () => { clearTimeout(timer); reject(canceled()); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function managerDownload(target, signal) {
        return new Promise((resolve, reject) => {
            checkCanceled(signal);
            let settled = false;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                activeDownload = null;
                error ? reject(error) : resolve();
            };
            const onAbort = () => {
                // Reject before aborting: some managers invoke onerror synchronously.
                const handle = activeDownload;
                finish(canceled());
                try { handle?.abort?.(); } catch (_) { /* already stopped */ }
            };
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                const handle = GM_download({
                    url: target.url,
                    name: target.name,
                    saveAs: false,
                    onprogress: event => {
                        if (settled || signal.aborted) return;
                        const loaded = Number(event.loaded) || 0;
                        const total = Number(event.total) || 0;
                        $('progress').hidden = false;
                        if (total > 0) {
                            $('progress').max = total;
                            $('progress').value = Math.min(loaded, total);
                            setStatus(`正在下载整书：${formatBytes(loaded)} / ${formatBytes(total)}。可以切换到其他标签页。`);
                        } else {
                            $('progress').removeAttribute('value');
                            setStatus(`正在下载整书：已传输 ${formatBytes(loaded)}。可以切换到其他标签页。`);
                        }
                    },
                    onload: () => finish(),
                    ontimeout: () => finish(Object.assign(new Error('下载请求超时。'), { retryable: true })),
                    onerror: result => {
                        const code = String(result?.error || 'unknown');
                        const detail = String(result?.details?.current || result?.details?.message || '');
                        const messages = {
                            not_enabled: '请在油猴设置中启用“下载”功能，再重试；也可使用网站原生下载。',
                            not_whitelisted: '请在油猴下载设置中允许 pdf 扩展名，再重试。',
                            not_permitted: '请授予油猴浏览器下载权限，再重试。',
                            not_supported: '当前油猴或浏览器不支持后台下载，请使用网站原生下载。',
                        };
                        if (/cancel|abort|interrupted_by_user/i.test(`${code} ${detail}`)) {
                            finish(canceled());
                        } else {
                            finish(Object.assign(new Error(messages[code] || '下载管理器报告失败，请检查浏览器下载记录或使用网站原生下载。'), {
                                retryable: code === 'not_succeeded' && /network|timeout|connection/i.test(detail),
                            }));
                        }
                    },
                });
                if (!settled) activeDownload = handle;
            } catch (_) {
                finish(new Error('无法调用油猴下载功能，请检查扩展设置，或使用网站原生下载。'));
            }
        });
    }

    async function start(native = false) {
        if (currentJob) return;
        const job = new AbortController();
        currentJob = job;
        setBusy(true);
        $('progress').hidden = true;
        $('native-link').hidden = true;
        $('progress').removeAttribute('value');
        try {
            if (!native && typeof GM_download !== 'function') {
                throw new Error('未检测到油猴后台下载接口，请使用 Tampermonkey，或点击“网站原生下载”。');
            }
            const target = await prepare(job.signal);
            checkCanceled(job.signal);
            if (native) {
                // Keep the final navigation on a real user click, so popup blockers
                // do not discard it after the asynchronous permission requests.
                $('native-link').href = target.url;
                $('native-link').hidden = false;
                setStatus('官方下载入口已准备好，请点击“点击开始原生下载”，随后查看浏览器下载记录。此模式不提供脚本进度。');
                return;
            }
            for (let attempt = 0; ; attempt++) {
                checkCanceled(job.signal);
                setStatus(attempt ? `重新请求官方文件（第 ${attempt + 1} 次，共最多 3 次）…` : '正在请求官方整书文件…');
                try {
                    await managerDownload(target, job.signal);
                    break;
                } catch (error) {
                    if (error.name === 'AbortError' || !error.retryable || attempt >= 2) throw error;
                    setStatus('网络传输中断，稍后重新下载。原下载的续传请在浏览器下载管理器中操作。');
                    await delay(1500 * (2 ** attempt), job.signal);
                }
            }
            checkCanceled(job.signal);
            setStatus('下载管理器已报告完成。请核对文件大小并用 KXReader 打开；脚本未校验文件内容或页数。');
        } catch (error) {
            setStatus(error.name === 'AbortError' ? '取消请求已发出，请在浏览器下载记录中确认。需要继续时可在下载管理器操作，或重新下载。' : error.message);
        } finally {
            if (currentJob === job) {
                currentJob = null;
                activeDownload = null;
                setBusy(false);
                $('progress').hidden = true;
            }
        }
    }

    $('download').addEventListener('click', () => { void start(); });
    $('native').addEventListener('click', () => { void start(true); });
    $('cancel').addEventListener('click', () => { currentJob?.abort(); });
    $('toggle').addEventListener('click', () => {
        const folded = !$('body').hidden;
        $('body').hidden = folded;
        $('toggle').textContent = folded ? '展开' : '收起';
        $('toggle').setAttribute('aria-expanded', String(!folded));
        $('toggle').setAttribute('aria-label', folded ? '展开下载面板' : '折叠下载面板');
    });
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('科学文库：后台下载当前整书', () => { void start(); });
    }
})();
