const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43190';
const output = path.join(__dirname, '09-evidence');
const headers = { Authorization: 'Bearer ticket09-A' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label) { for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(100); } throw Error(label); }
async function api(ctx, url, options = {}) { const r = await ctx.request.fetch(origin + url, { headers, ...options }); assert.equal(r.status(), 200, await r.text()); return r.json(); }
let png;
async function upload(ctx, id) { return api(ctx, '/api/image-references', { method: 'POST', multipart: { request_id: id, file: { name: `${id}.png`, mimeType: 'image/png', buffer: png } } }); }
const card = (page, id) => page.locator(`[data-turn-id="${id}"]`);
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    png = await fs.readFile(path.join(output, 'P01_原名称_1_original.png'));
    const conversation = await api(ctx, '/api/image-conversations', { method: 'POST', data: { request_id: 'reference-conversation' } });
    const one = await upload(ctx, 'one'), two = await upload(ctx, 'two');
    const seed = await api(ctx, '/api/image-conversations/turns', { method: 'POST', data: { request_id: 'reference-seed', conversation_id: conversation.id, prompt: 'Original two references', count: 1, referenceImages: [{ id: one.id }, { id: two.id }] } });
    const original = seed.turns[0];
    for (const ref of [one, two]) await api(ctx, `/api/image-references/${ref.id}`, { method: 'DELETE' });
    const old = await upload(ctx, 'old-draft');
    await page.goto(origin + '/login/'); await page.getByLabel('密钥', { exact: true }).fill('ticket09-A');
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/accounts/'); await page.goto(origin + '/image/');
    const composer = page.locator('textarea');
    await page.getByRole('button', { name: '移除参考图 old-draft.png', exact: true }).waitFor();
    await composer.fill('Keep my previous draft');
    let lost = false;
    await page.route(`**/api/image-references/${two.id}/retain`, async route => { lost = true; await route.fetch(); await route.abort('failed'); });
    await card(page, original.id).getByRole('button', { name: '复用配置', exact: true }).click();
    await eventually(async () => lost && (await api(ctx, '/api/image-references')).items.length === 1, 'partial retains rolled back');
    assert.equal(await composer.inputValue(), 'Keep my previous draft');
    assert.deepEqual((await api(ctx, '/api/image-references')).items.map(r => r.id), [old.id]);
    assert.equal(await page.getByText('提交将新增原条目的轮次', { exact: true }).count(), 0);
    await page.unroute(`**/api/image-references/${two.id}/retain`);
    await card(page, original.id).getByRole('button', { name: '复用配置', exact: true }).click();
    await page.getByText('提交将新增原条目的轮次', { exact: true }).waitFor();
    assert.equal(await composer.inputValue(), 'Original two references');
    await page.getByRole('button', { name: '移除参考图 one.png', exact: true }).click();
    await page.locator('input[type=file]').first().setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: '编辑图片', exact: true }).waitFor();
    await eventually(() => page.getByRole('button', { name: '编辑图片', exact: true }).isEnabled(), 'replacement ready');
    await composer.fill('Changed references and prompt');
    const submitted = page.waitForResponse(r => r.url().endsWith('/api/image-conversations/turns') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '编辑图片', exact: true }).click();
    assert.equal((await submitted).status(), 200);
    await eventually(async () => { const d = await api(ctx, `/api/image-conversations/${conversation.id}?offset=0&limit=10`); return d.turnCount === 2 && d.stats.running + d.stats.queued === 0; }, 'reused reference turn');
    const history = await api(ctx, `/api/image-conversations/${conversation.id}?offset=0&limit=10`);
    assert.equal(history.turns[1].sourceEntryId, original.sourceEntryId);
    assert.deepEqual(history.turns[0].referenceImages.map(r => r.name), ['one.png', 'two.png']);
    assert.deepEqual(history.turns[1].referenceImages.map(r => r.name), ['two.png', 'replacement.png']);
    assert.equal(history.turns[0].prompt, 'Original two references');
    for (const ref of history.turns[0].referenceImages) {
      const r = await ctx.request.get(origin + ref.url, { headers }); assert.equal(r.status(), 200); assert.deepEqual(await r.body(), png);
    }
    await page.screenshot({ path: path.join(output, 'references-reused.png') });
    // A delayed successful retain must not overwrite a newly created conversation's composer.
    let entered, release; const started = new Promise(resolve => { entered = resolve; }); const hold = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/image-references/${one.id}/retain`, async route => { const response = await route.fetch(); entered(); await hold; await route.fulfill({ response }); });
    await card(page, original.id).getByRole('button', { name: '复用配置', exact: true }).click(); await started;
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await eventually(() => page.getByText('Turn ideas into images', { exact: true }).isVisible(), 'new conversation');
    await composer.fill('New draft after switching'); release();
    await eventually(async () => (await api(ctx, '/api/image-references')).items.length === 0, 'stale retain released');
    assert.equal(await composer.inputValue(), 'New draft after switching');
    assert.equal(await page.getByText('提交将新增原条目的轮次', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'reference-races.json'), JSON.stringify({ result: 'PASS', errors, partialLostResponseRolledBack: true, staleConversationRetainReleased: true, originalReferenceIds: history.turns[0].referenceImages.map(r => r.id), changedReferenceIds: history.turns[1].referenceImages.map(r => r.id) }, null, 2));
    console.log('PASS reference replacement, partial retain loss, stale conversation reuse');
  } catch (error) { await page.screenshot({ path: path.join(output, 'reference-failure.png') }); throw error; }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
