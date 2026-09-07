// Regression: delayed A reservations must not resume under B after SPA logout/login.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43160';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const headers = key => ({ Authorization: `Bearer ticket06-${key}` });
async function signIn(page, key) {
  await page.getByLabel('密钥', { exact: true }).fill(`ticket06-${key}`);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/accounts/');
}
async function clear(context, key) {
  const current = await (await context.request.get(`${origin}/api/image-imports`, { headers: headers(key) })).json();
  assert.equal((await context.request.delete(`${origin}/api/image-imports`, { headers: headers(key), data: { request_id: crypto.randomUUID(), version: current.version } })).status(), 200);
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const errors = [], wrongIdentityRequests = [];
  try {
    for (const mode of ['unmount', 'other-tab']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await clear(context, 'A'); await clear(context, 'B');
    const png = await fs.readFile(path.join(__dirname, '04-evidence/reference.png'));
    let release, signal;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { signal = resolve; });
    let first = true;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/image-imports/references' && req.method() === 'POST') {
        if (req.headers().authorization !== 'Bearer ticket06-A') wrongIdentityRequests.push(req.postDataJSON().name);
        if (first) { first = false; const response = await route.fetch(); signal(); await gate; return route.fulfill({ response }); }
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/login/`);
    await signIn(page, 'A');
    // SPA link, so this document also remains alive through the later logout/login.
    await page.getByRole('link', { name: '生图', exact: true }).click();
    await page.getByRole('button', { name: '上传 MD 和参考图', exact: true }).click();
    await page.getByRole('button', { name: '点击或拖入参考图，支持分批追加', exact: true }).waitFor();
    for (let i = 0; i < 100 && !await page.getByRole('button', { name: '点击或拖入参考图，支持分批追加', exact: true }).isEnabled(); i++) await sleep(20);
    await page.getByLabel('选择导入参考图', { exact: true }).setInputFiles([
      { name: 'owner-a-first.png', mimeType: 'image/png', buffer: png },
      { name: 'owner-a-second.png', mimeType: 'image/png', buffer: png },
    ]);
    await Promise.race([entered, sleep(5000).then(() => { throw Error('Reservation did not start'); })]);
    let logoutPage = page;
    if (mode === 'other-tab') {
      logoutPage = await context.newPage();
      await logoutPage.goto(`${origin}/accounts/`);
    } else {
      await page.getByRole('button', { name: '完成', exact: true }).click();
    }
    await logoutPage.getByRole('button', { name: '退出', exact: true }).click();
    await logoutPage.waitForURL(/\/login\/?$/);
    await signIn(logoutPage, 'B');
    release();
    await sleep(1800);
    const b = await (await context.request.get(`${origin}/api/image-imports`, { headers: headers('B') })).json();
    assert.deepEqual(wrongIdentityRequests, [], 'Old A queue must never send registration with B credentials');
    assert.deepEqual(b.references, [], 'B must never inherit A file selection');
    if (mode === 'other-tab') {
      await page.getByRole('alert').filter({ hasText: '登录身份已变更' }).waitFor();
      assert.equal(await page.getByRole('list', { name: '导入参考图列表' }).locator('li').count(), 0);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode, passed: true, wrongIdentityRequests, errors }));
    await context.close();
    }
    await fs.writeFile(path.join(__dirname, '06-evidence/browser-identity.json'), JSON.stringify({ passed: true, scenarios: ['unmount', 'other-tab'], wrongIdentityRequests, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
