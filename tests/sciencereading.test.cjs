const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'sciencereading-official-download.user.js'), 'utf8');
const ID = 'B4D5A0AF3C41D4B6DE063010B0A0AE2D0000';
const ORIGIN = 'https://book.sciencereading.cn';
// Only public form structure is reproduced; no book contents, keys or sessions.
const detail = (id = ID, method = 'get') => `<title>航空无损检测概论</title>
  <form id="form1" method="${method}"><input name="id" value="${id}">
  <input name="readMark" value="0"><input name="extra" value="keep-me"></form>`;

function setup(t, overrides = {}) {
    const dom = new JSDOM('<!doctype html><title>科学文库</title><body><input id="bookName" value="航空无损检测概论"></body>', {
        url: `${ORIGIN}/shop/book/Booksimple/onlineRead.do?id=${overrides.id ?? ID}&readMark=0`,
        runScripts: 'outside-only',
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const requests = [], downloads = [], menu = [];
    const setTimeoutOriginal = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...args) => setTimeoutOriginal(fn, ms >= 1000 ? 1 : ms, ...args);
    w.scrollTo = () => { throw new Error('download must not scroll the reader'); };
    w.fetch = overrides.fetch || (async (url, options) => {
        requests.push({ url, options });
        if (url.includes('checkUserPermission.do')) {
            return { ok: true, url, text: async () => overrides.permission ?? 'true' };
        }
        assert.equal(url, `${ORIGIN}/shop/book/Booksimple/show.do?id=${ID}`);
        return { ok: true, url, text: async () => overrides.html ?? detail() };
    });
    w.GM_registerMenuCommand = (...args) => menu.push(args);
    if (!overrides.noDownload) {
        w.GM_download = options => {
            downloads.push(options);
            return overrides.manager?.(options, downloads.length) || { abort() {} };
        };
    }
    w.eval(source);
    const ui = w.document.getElementById('science-official-download')?.shadowRoot;
    return { w, ui, requests, downloads, menu, $: id => ui.getElementById(id) };
}

async function until(predicate, message = 'operation should settle') {
    for (let i = 0; i < 300; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.fail(message);
}
const finished = env => until(() => !env.$('download').disabled);

 test('uses official permission and GET form, then reports actual download-manager callbacks', async t => {
    const env = setup(t);
    env.$('download').click();
    await until(() => env.downloads.length === 1);
    const permission = env.requests[0];
    assert.equal(new URL(permission.url).pathname, '/shop/book/Booksimple/checkUserPermission.do');
    assert.equal(permission.options.method, 'POST');
    assert.equal(permission.options.body, `id=${ID}`);
    assert.equal(permission.options.credentials, 'same-origin');
    const job = env.downloads[0];
    const url = new URL(job.url);
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.pathname, '/shop/book/Booksimple/offlineDownload.do');
    assert.equal(url.searchParams.get('id'), ID);
    assert.equal(url.searchParams.get('readMark'), '1');
    assert.equal(url.searchParams.get('extra'), 'keep-me');
    assert.equal(job.name, '航空无损检测概论.pdf');
    assert.equal(job.saveAs, false);
    job.onprogress({ loaded: 512, total: 1024 });
    assert.equal(env.$('progress').value, 512);
    assert.equal(env.$('progress').max, 1024);
    job.onprogress({ loaded: 512, total: 0 });
    assert.equal(env.$('progress').hasAttribute('value'), false);
    assert.doesNotMatch(env.$('status').textContent, /已报告完成/);
    job.onload();
    await finished(env);
    assert.match(env.$('status').textContent, /下载管理器已报告完成/);
    assert.match(env.$('status').textContent, /未校验文件内容或页数/);
    assert.equal(env.requests.length, 2);
});

 test('repeated clicks do not create parallel book downloads', async t => {
    const env = setup(t);
    env.$('download').click(); env.$('download').click(); env.menu[0][1]();
    await until(() => env.downloads.length === 1);
    assert.equal(env.requests.length, 2);
    env.downloads[0].onload();
    await finished(env);
});

for (const permission of ['false', '<html>请登录</html>', '{"success":true}']) {
    test(`does not download when permission is not explicit true (${permission.slice(0, 12)})`, async t => {
        const env = setup(t, { permission });
        env.$('download').click();
        await finished(env);
        assert.equal(env.downloads.length, 0);
        assert.equal(env.requests.length, 1);
        assert.match(env.$('status').textContent, /尚未确认/);
    });
}

for (const [label, html] of [['wrong book', detail('ANOTHER')], ['changed method', detail(ID, 'post')], ['missing form', '<title>登录</title>']]) {
    test(`stops on ${label}`, async t => {
        const env = setup(t, { html });
        env.$('download').click();
        await finished(env);
        assert.equal(env.downloads.length, 0);
        assert.match(env.$('status').textContent, /表单/);
    });
}

 test('HTTP errors and cross-site login redirects are not download success', async t => {
    for (const response of [{ ok: false, status: 403 }, { ok: true, url: 'https://login.example.test/' }]) {
        const env = setup(t, { fetch: async () => response });
        env.$('download').click();
        await finished(env);
        assert.equal(env.downloads.length, 0);
        assert.match(env.$('status').textContent, /HTTP 403|登录/);
    }
});

 test('native fallback prepares a real link without popup automation or false completion', async t => {
    const env = setup(t, { noDownload: true });
    env.$('download').click(); await finished(env);
    assert.match(env.$('status').textContent, /未检测到油猴/);
    assert.equal(env.requests.length, 0);
    env.$('native').click(); await finished(env);
    assert.equal(env.$('native-link').hidden, false);
    assert.equal(new URL(env.$('native-link').href).pathname, '/shop/book/Booksimple/offlineDownload.do');
    assert.match(env.$('status').textContent, /请点击/);
    assert.doesNotMatch(env.$('status').textContent, /已报告完成/);
});

for (const [error, text] of [['not_enabled', '启用'], ['not_whitelisted', '扩展名'], ['not_permitted', '权限'], ['not_supported', '不支持']]) {
    test(`download setting error ${error} is actionable and not retried`, async t => {
        const env = setup(t, { manager: options => { queueMicrotask(() => options.onerror({ error })); } });
        env.$('download').click(); await finished(env);
        assert.equal(env.downloads.length, 1);
        assert.match(env.$('status').textContent, new RegExp(text));
    });
}

 test('transient network failure retries with a strict three-attempt cap', async t => {
    const env = setup(t, { manager: options => {
        queueMicrotask(() => options.onerror({ error: 'not_succeeded', details: { current: 'NETWORK_FAILED' } }));
    } });
    env.$('download').click(); await finished(env);
    assert.equal(env.downloads.length, 3);
    assert.match(env.$('status').textContent, /失败/);
});

 test('timeout can recover and synchronous callbacks do not leave a stale handle', async t => {
    const env = setup(t, { manager: (options, attempt) => {
        if (attempt === 1) options.ontimeout(); else options.onload();
        return { abort() { assert.fail('completed download must not be aborted'); } };
    } });
    env.$('download').click(); await finished(env);
    assert.equal(env.downloads.length, 2);
    assert.match(env.$('status').textContent, /已报告完成/);
    assert.equal(env.$('cancel').disabled, true);
});

 test('browser cancellation never automatically restarts a download', async t => {
    const env = setup(t, { manager: options => {
        queueMicrotask(() => options.onerror({ error: 'not_succeeded', details: { current: 'USER_CANCELED' } }));
    } });
    env.$('download').click(); await finished(env);
    assert.equal(env.downloads.length, 1);
    assert.match(env.$('status').textContent, /取消/);
});

 test('cancel aborts active transfer; late callbacks cannot overwrite cancellation', async t => {
    let aborted = false;
    const env = setup(t, { manager: options => ({ abort() {
        aborted = true; options.onerror({ error: 'not_succeeded' });
    } }) });
    env.$('download').click();
    await until(() => env.downloads.length === 1);
    env.$('cancel').click(); await finished(env);
    assert.equal(aborted, true);
    const status = env.$('status').textContent;
    env.downloads[0].onload();
    env.downloads[0].onprogress({ loaded: 100, total: 100 });
    assert.equal(env.$('status').textContent, status);
    assert.match(status, /取消/);
});

 test('cancel stops a pending permission check before downloading', async t => {
    const env = setup(t, { fetch: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }) });
    env.$('download').click(); env.$('cancel').click(); await finished(env);
    assert.equal(env.downloads.length, 0);
    assert.match(env.$('status').textContent, /取消/);
});

 test('collapse preserves the download, menu works, and duplicate initialization is ignored', async t => {
    const env = setup(t);
    env.$('toggle').click();
    assert.equal(env.$('body').hidden, true);
    assert.equal(env.$('toggle').getAttribute('aria-expanded'), 'false');
    env.menu[0][1]();
    await until(() => env.downloads.length === 1);
    env.w.eval(source);
    assert.equal(env.w.document.querySelectorAll('#science-official-download').length, 1);
    env.downloads[0].onload(); await finished(env);
});

 test('invalid book IDs are ignored', t => {
    const env = setup(t, { id: '%3Cscript%3E' });
    assert.equal(env.ui, undefined);
    assert.equal(env.requests.length, 0);
});

 test('filename is sanitized and remote HTML scripts are not executed', async t => {
    const html = detail().replace('<title>航空无损检测概论</title>', '<title>CON:book / test?.pdf</title><script>window.remoteCodeRan = true;</script>');
    const env = setup(t, { html });
    env.$('download').click(); await until(() => env.downloads.length === 1);
    assert.equal(env.downloads[0].name, 'CON_book _ test_.pdf');
    assert.equal(env.w.remoteCodeRan, undefined);
    env.downloads[0].onload(); await finished(env);
});
