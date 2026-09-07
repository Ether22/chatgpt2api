const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43210';
const headers = { Authorization: 'Bearer ticket11-A' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, message) {
  for (let i = 0; i < 120; i++) { if (await check()) return; await pause(100); }
  throw Error(message);
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const pages = [];
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      if (i === 0) assert.equal((await context.request.post(`${origin}/ticket11/seed`, { data: { count: 6 } })).status(), 200);
      const page = await context.newPage();
      await page.goto(`${origin}/login/`);
      await page.getByLabel('密钥', { exact: true }).fill('ticket11-A');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL('**/accounts/');
      await page.goto(`${origin}/image/`);
      await page.locator('img[alt^="Generated result"]').first().waitFor();
      pages.push(page);
    }
    const [actor, observer] = pages;
    await observer.locator('img[alt^="Generated result"]').first().click();
    await observer.getByRole('dialog', { name: '图片预览' }).waitFor();
    await actor.getByRole('button', { name: /Scope gallery a-1/ }).click();
    await eventually(async () => (await (await actor.request.get(`${origin}/api/image-conversations`, { headers })).json()).current_conversation_id === 'a-1', 'server selection B');
    await actor.getByRole('button', { name: /Scope gallery a-0/ }).locator('..').getByRole('button', { name: '删除会话', exact: true }).click();
    await actor.getByRole('button', { name: '确认删除', exact: true }).click();
    await eventually(async () => await observer.getByRole('button', { name: /Scope gallery a-0/ }).count() === 0, 'observer removes A');
    await eventually(async () => await observer.getByRole('dialog', { name: '图片预览' }).count() === 0, 'Deleted A viewer must close even when fallback B has detail');
    await observer.screenshot({ path: path.join(__dirname, '11-evidence', 'deleted-viewer-closed.png'), fullPage: true });
    assert.equal((await actor.request.post(`${origin}/ticket11/seed`, { data: { count: 6 } })).status(), 200);
    await actor.reload(); await observer.reload();
    await observer.locator('img[alt^="Generated result"]').first().click();
    await observer.getByRole('dialog', { name: '图片预览' }).waitFor();
    await actor.getByRole('button', { name: '删除生成结果', exact: true }).click();
    await actor.getByRole('button', { name: '确认删除', exact: true }).click();
    await eventually(async () => await observer.getByRole('dialog', { name: '图片预览' }).count() === 0, 'Deleted turn viewer must follow refreshed result membership');
    console.log('Cross-browser fallback viewer regression passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
