const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43140';
const headers = { Authorization: 'Bearer ticket04-B' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check) {
  for (let i = 0; i < 60; i++) { if (await check()) return; await sleep(100); }
  throw Error('state did not settle');
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), results = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const png = await fs.readFile(path.join(__dirname, '04-evidence/reference.png'));
  const list = async () => (await (await context.request.get(`${origin}/api/image-references`, { headers })).json()).items;
  const remove = name => page.getByRole('button', { name: `移除参考图 ${name}`, exact: true });
  async function upload(name) {
    await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: png });
    await eventually(async () => !(await page.getByText(/上传中 \d+%/).count()));
  }
  async function check(name, test) {
    try { await test(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
    await page.unrouteAll({ behavior: 'wait' });
    for (const ref of await list()) await context.request.delete(`${origin}/api/image-references/${ref.id}`, { headers });
    await page.reload();
    await page.getByRole('button', { name: /^自动 · / }).waitFor();
  }
  try {
    await page.goto(`${origin}/login/`);
    await page.getByLabel('密钥', { exact: true }).fill('ticket04-B');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/accounts/');
    await page.goto(`${origin}/image/`);
    await page.getByRole('button', { name: /^自动 · / }).waitFor();
    await check('failed submit then remove releases ordinary input', async () => {
      await upload('failed-submit.png');
      await page.locator('textarea').fill('controlled failed submit');
      await page.route('**/api/image-conversations/turns', route => route.fulfill({ status: 507, json: { detail: { error: 'controlled save failure' } } }));
      const rejected = page.waitForResponse('**/api/image-conversations/turns');
      await page.getByRole('button', { name: '编辑图片', exact: true }).click();
      await rejected;
      await remove('failed-submit.png').click();
      await eventually(async () => (await list()).length === 0);
    });
    await check('remove during failed submit flushes deferred release', async () => {
      await upload('inflight-submit.png');
      await page.locator('textarea').fill('controlled pending submit');
      let finish;
      const gate = new Promise(resolve => { finish = resolve; });
      await page.route('**/api/image-conversations/turns', async route => { await gate; await route.fulfill({ status: 507, json: { detail: { error: 'controlled delayed failure' } } }); });
      await page.getByRole('button', { name: '编辑图片', exact: true }).click();
      await remove('inflight-submit.png').click();
      finish();
      await eventually(async () => (await list()).length === 0);
    });
    await check('retain waits for earlier delayed release', async () => {
      const uploaded = await context.request.post(`${origin}/api/image-references`, { headers, multipart: { request_id: `race-${Date.now()}`, file: { name: 'history-race.png', mimeType: 'image/png', buffer: png } } });
      const reference = await uploaded.json();
      const saved = await context.request.post(`${origin}/api/image-conversations/turns`, { headers, data: { request_id: `turn-${Date.now()}`, prompt: 'race history', count: 1, referenceImages: [{ id: reference.id }] } });
      assert.equal(saved.status(), 200);
      await page.reload();
      await remove('history-race.png').waitFor();
      let finish, started;
      const gate = new Promise(resolve => { finish = resolve; });
      const sent = new Promise(resolve => { started = resolve; });
      let deleted = false, retainBeforeDelete = false;
      await page.route(`**/api/image-references/${reference.id}`, async route => {
        if (route.request().method() !== 'DELETE') return route.fallback();
        started(); await gate;
        const response = await route.fetch(); deleted = true; await route.fulfill({ response });
      });
      await page.route(`**/api/image-references/${reference.id}/retain`, route => { if (!deleted) retainBeforeDelete = true; return route.fallback(); });
      await remove('history-race.png').click(); await sent;
      await page.getByRole('button', { name: '复用配置', exact: true }).last().click();
      await sleep(300); finish();
      await remove('history-race.png').waitFor();
      await eventually(async () => (await list()).some(item => item.id === reference.id));
      assert.equal(retainBeforeDelete, false);
    });
    await check('lost upload response can be removed without reload', async () => {
      await page.route('**/api/image-references', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        await route.fetch(); await route.abort('failed');
      });
      await upload('lost-response.png');
      await page.getByRole('button', { name: '重试上传 lost-response.png', exact: true }).waitFor();
      await remove('lost-response.png').click();
      await eventually(async () => (await list()).length === 0);
    });
    await check('cancel in-flight upload exposes cleanup failure and retries', async () => {
      let finish, started;
      const gate = new Promise(resolve => { finish = resolve; });
      const sent = new Promise(resolve => { started = resolve; });
      await page.route('**/api/image-references', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        started(); await gate; await route.fallback();
      });
      let rejected = false;
      await page.route('**/api/image-references/uploads/*', route => {
        if (!rejected) { rejected = true; return route.fulfill({ status: 503, json: { detail: { error: 'controlled cleanup failure' } } }); }
        return route.fallback();
      });
      await page.locator('input[type=file]').setInputFiles({ name: 'cancelled.png', mimeType: 'image/png', buffer: png });
      await sent;
      await remove('cancelled.png').click(); finish();
      await page.getByRole('button', { name: '重试移除 cancelled.png', exact: true }).waitFor({ timeout: 6500 });
      await remove('cancelled.png').click();
      await eventually(async () => (await list()).length === 0);
    });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(__dirname, '04-evidence/browser-races.json'), JSON.stringify({ results, errors }, null, 2));
    console.log(JSON.stringify(results));
    assert(results.every(item => item.passed));
  } finally { await browser.close(); }
})();
