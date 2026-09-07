// Controlled response loss against the isolated ticket 03 browser server.
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43130';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/login/`);
    await page.getByLabel('密钥', { exact: true }).fill('ticket03-B');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/accounts/');
    await page.goto(`${origin}/image/`);
    await page.getByRole('button', { name: /^自动 · / }).waitFor();
    const headers = { Authorization: 'Bearer ticket03-B' };
    const history = async () => (await context.request.get(`${origin}/api/image-conversations`, { headers })).json();
    const consumption = async () => (await (await context.request.get(`${origin}/ticket03-consumption`)).json()).count;
    for (const mode of ['lost-post', 'failed-get']) {
      for (const action of ['create', 'regenerate']) {
        const before = await history();
        const consumedBefore = await consumption();
        const endpoint = `${origin}/api/image-conversations${action === 'create' ? '' : '/turns'}`;
        const ids = [];
        let failRead = false;
        await page.route(`${origin}/api/image-conversations`, async route => {
          if (route.request().method() === 'GET' && failRead) return route.abort();
          return route.fallback();
        });
        await page.route(endpoint, async route => {
          if (route.request().method() !== 'POST') return route.fallback();
          ids.push(route.request().postDataJSON().request_id);
          const response = await route.fetch(); // The server really accepted the request.
          if (ids.length === 1) {
            if (mode === 'lost-post') return route.abort();
            failRead = true;
          }
          return route.fulfill({ response });
        });
        const button = () => page.getByRole('button', { name: action === 'create' ? '新建对话' : '全部重新生成', exact: true }).first();
        await button().click();
        await page.locator('[data-sonner-toast][data-type="error"]').last().waitFor();
        failRead = false;
        const accepted = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST' && response.ok());
        await button().click();
        await accepted;
        if (action === 'create') await page.getByRole('heading', { name: 'Turn ideas into images' }).waitFor();
        else await page.locator('[data-sonner-toast][data-type="success"]').last().waitFor();
        assert.equal(ids.length, 2);
        assert.equal(ids[0], ids[1], `${action}/${mode}: retry must keep the accepted request ID`);
        const after = await history();
        assert.equal(after.items.length, before.items.length + (action === 'create' ? 1 : 0));
        if (action === 'regenerate') {
          const previous = before.items.find(item => item.id === before.current_conversation_id);
          const current = after.items.find(item => item.id === previous.id);
          assert.equal(current.turns.length, previous.turns.length + 1);
          assert.equal(current.turns.at(-1).images.length, 1);
          await page.getByText('已完成', { exact: true }).last().waitFor();
        }
        assert.equal(await consumption(), consumedBefore + (action === 'regenerate' ? 1 : 0));
        await page.unrouteAll({ behavior: 'wait' });
        // Clear toast state and give each scenario one ordinary single-image source.
        await page.reload();
        await page.getByRole('button', { name: /^自动 · / }).waitFor();
        if (action === 'create') {
          await page.getByRole('button', { name: /^自动 · / }).click();
          await page.getByLabel('生成数量', { exact: true }).fill('1');
          await page.getByRole('button', { name: /^自动 · / }).click();
          await page.locator('textarea').fill(`Retry check ${mode}`);
          await page.getByRole('button', { name: '生成图片', exact: true }).click();
          await page.getByRole('button', { name: 'Generated result 1', exact: true }).waitFor();
          await page.reload();
          await page.getByRole('button', { name: '全部重新生成', exact: true }).waitFor();
        }
        console.log(`PASS ${action}/${mode}: one accepted operation after retry`);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
