// Run after the two ticket09 browser checks against their isolated server.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43190', output = path.join(__dirname, '09-evidence');
const headers = { Authorization: 'Bearer ticket09-A' };
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage();
  async function get(url) { const r = await ctx.request.get(origin + url, { headers }); assert.equal(r.status(), 200); return r.json(); }
  try {
    const history = await get('/api/image-conversations');
    const source = history.items.find(c => c.title === 'Original two references');
    const target = history.items.find(c => c.title === 'New independent product');
    const original = (await get(`/api/image-conversations/${source.id}?offset=0&limit=10`)).turns[1];
    await page.goto(origin + '/login/'); await page.getByLabel('密钥', { exact: true }).fill('ticket09-A');
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/accounts/'); await page.goto(origin + '/image/');
    await page.getByRole('button', { name: /^Original two references/ }).click();
    await page.locator(`[data-turn-id="${original.id}"]`).getByRole('button', { name: '复用配置', exact: true }).click();
    await page.getByText('提交将新增原条目的轮次', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^New independent product/ }).click();
    await page.getByText('提交将新增原条目的轮次', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('textarea').inputValue(), original.prompt);
    const pending = page.waitForResponse(r => r.url().endsWith('/api/image-conversations/turns') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '编辑图片', exact: true }).click(); const accepted = await pending;
    assert.equal(accepted.status(), 200); const body = accepted.request().postDataJSON();
    assert.equal(body.conversation_id, target.id); assert.equal(body.source_turn_id, undefined);
    const saved = (await accepted.json()).turns.at(-1); assert.notEqual(saved.sourceEntryId, original.sourceEntryId); assert.equal(saved.md, undefined);
    for (const [width, height] of [[390, 600], [320, 360]]) {
      await page.setViewportSize({ width, height });
      const input = page.locator(`[data-turn-id="${saved.id}"]`).getByLabel('新轮数量', { exact: true });
      await input.scrollIntoViewIfNeeded(); await input.click(); await input.fill('7');
      const box = await input.boundingBox(); assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
      await page.screenshot({ path: path.join(output, `controls-${width}x${height}.png`) });
    }
    await fs.writeFile(path.join(output, 'switch.json'), JSON.stringify({ result: 'PASS', targetConversation: target.id, sourceConversation: source.id, independentSource: saved.sourceEntryId, originalSource: original.sourceEntryId, widths: [390, 320] }, null, 2));
    console.log('PASS switching conversation clears lineage; 390/320px controls reachable');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
