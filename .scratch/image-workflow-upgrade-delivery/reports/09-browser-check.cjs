// Production UI + real HTTP/storage; only upstream and network fault boundaries controlled.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43190';
const output = path.join(__dirname, '09-evidence');
const headers = { Authorization: 'Bearer ticket09-A' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, name) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await sleep(100); }
  throw Error(`Timeout: ${name}`);
}
async function api(ctx, route, options = {}) {
  const response = await ctx.request.fetch(origin + route, { headers, ...options });
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
const detail = (ctx, id) => api(ctx, `/api/image-conversations/${id}?offset=0&limit=10`);
async function settled(ctx, id, count) {
  await eventually(async () => { const d = await detail(ctx, id); return d.turnCount === count && d.stats.running + d.stats.queued === 0; }, 'settled turns');
  return detail(ctx, id);
}
async function login(page) {
  await page.goto(origin + '/login/'); await page.getByLabel('密钥', { exact: true }).fill('ticket09-A');
  await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/accounts/');
  await page.goto(origin + '/image/');
}
const composer = page => page.getByPlaceholder('输入你想要生成的画面，也可直接粘贴图片');
const card = (page, id) => page.locator(`[data-turn-id="${id}"]`);
async function submitUI(page) {
  const response = page.waitForResponse(r => r.url().endsWith('/api/image-conversations/turns') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^(生成图片|编辑图片)$/ }).click();
  const result = await response; assert.equal(result.status(), 200, await result.text()); return result.json();
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); const errors = [], metrics = {};
  page.on('pageerror', error => errors.push(error.message));
  try {
    const md = `## [P01] 原名称｜1200x800\n参考图：无\n输出文件名：original.jpg\n### Prompt\n\x60\x60\x60\nOriginal MD prompt\n\x60\x60\x60\n`;
    const state = await api(ctx, '/api/image-imports/md', { method: 'PUT', multipart: { request_id: 'md', version: '0', file: { name: 'original-document.md', mimeType: 'text/markdown', buffer: Buffer.from(md) } } });
    const first = await api(ctx, '/api/image-imports/batches', { method: 'POST', data: { request_id: 'seed', version: state.version, md_version: state.md_version, model: 'gpt-image-2', quality: 'high', count: 1, entries: [{ key: state.candidates[0].key }] } });
    let history = await settled(ctx, first.id, 1); const original = history.turns[0];
    await api(ctx, '/api/image-imports', { method: 'DELETE', data: { request_id: 'clear', version: state.version } });
    await login(page); await card(page, original.id).waitFor();
    for (const invalid of ['', '0', '101', '1.5', '1e2', '-1', ' 2']) {
      await card(page, original.id).getByLabel('新轮数量', { exact: true }).fill(invalid);
      assert.equal(await card(page, original.id).getByRole('button', { name: '重新生成', exact: true }).isEnabled(), false);
    }
    await card(page, original.id).getByLabel('新轮数量', { exact: true }).fill('100');
    const started = Date.now();
    await card(page, original.id).getByRole('button', { name: '重新生成', exact: true }).click();
    history = await settled(ctx, first.id, 2); metrics.rerun100Ms = Date.now() - started;
    assert.equal(history.turns[1].count, 100); assert.equal(history.turns[1].images.length, 100);
    assert.deepEqual(history.turns[0], original); assert.deepEqual(history.turns[1].md, original.md);
    const rerun = history.turns[1]; await card(page, rerun.id).waitFor();
    await card(page, rerun.id).getByRole('button', { name: '复用配置', exact: true }).click();
    await page.getByText('提交将新增原条目的轮次', { exact: true }).waitFor();
    await composer(page).fill('Edited after reuse');
    const config = page.getByRole('button', { name: /^(自动|高|低|中) · / });
    await config.click(); await page.getByLabel('生成数量', { exact: true }).fill('1');
    await page.getByRole('spinbutton').nth(0).fill('900'); await page.getByRole('spinbutton').nth(1).fill('700');
    await config.click(); await submitUI(page);
    history = await settled(ctx, first.id, 3); const reused = history.turns[2];
    assert.equal(reused.sourceEntryId, original.sourceEntryId); assert.equal(reused.prompt, 'Edited after reuse');
    assert.equal(reused.size, '900x700'); assert.equal(reused.md.output_name, 'original.jpg');
    await card(page, reused.id).getByRole('button', { name: '删除提示词记录', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await card(page, reused.id).getByText('提示词已隐藏', { exact: true }).waitFor();
    await card(page, reused.id).getByRole('button', { name: '复用配置', exact: true }).click();
    assert.equal(await composer(page).inputValue(), 'Edited after reuse');
    await composer(page).fill('Again reused'); await submitUI(page);
    history = await settled(ctx, first.id, 4); assert.equal(new Set(history.turns.map(t => t.sourceEntryId)).size, 1);
    const latest = history.turns[3];
    // The server accepts the first request, but the browser loses its response; retry must reuse its ID.
    let dropped = false; const ids = [];
    await page.route('**/api/image-conversations/turns', async route => {
      ids.push(route.request().postDataJSON().request_id);
      if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); } else await route.continue();
    });
    await card(page, latest.id).getByRole('button', { name: '重新生成', exact: true }).click();
    await settled(ctx, first.id, 5);
    await page.getByText('提交失败', { exact: false }).first().waitFor({ timeout: 3000 }).catch(() => {});
    if (!await card(page, latest.id).count()) await page.getByRole('button', { name: '较早结果', exact: true }).click();
    await card(page, latest.id).getByRole('button', { name: '重新生成', exact: true }).click();
    await eventually(() => Promise.resolve(ids.length === 2), 'retry request');
    await page.unroute('**/api/image-conversations/turns'); assert.equal(ids[0], ids[1]);
    history = await settled(ctx, first.id, 5);
    if (await page.getByRole('button', { name: '最新结果', exact: true }).isEnabled()) await page.getByRole('button', { name: '最新结果', exact: true }).click();
    const lastId = history.turns[4].id;
    assert.equal((await api(ctx, '/ticket09-state')).count, 104);
    // Independent authenticated browser restores the actual MD metadata and all old pictures.
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 600 } }); const page2 = await ctx2.newPage();
    await login(page2); await card(page2, history.turns[4].id).waitFor();
    await card(page2, history.turns[4].id).getByLabel('新轮数量', { exact: true }).fill('1');
    await card(page2, history.turns[4].id).screenshot({ path: path.join(output, 'narrow-rerun.png') });
    const downloadEvent = page.waitForEvent('download');
    await card(page, lastId).getByRole('button', { name: '下载', exact: true }).first().click();
    const download = await downloadEvent;
    assert.match(download.suggestedFilename(), /original.*\.png$/);
    await download.saveAs(path.join(output, download.suggestedFilename()));
    await card(page, lastId).getByRole('button', { name: '复用配置', exact: true }).click();
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await eventually(() => composer(page).inputValue().then(v => v === ''), 'new composer');
    await composer(page).fill('New independent product'); const fresh = await submitUI(page);
    assert.notEqual(fresh.id, first.id); const freshTurn = (await settled(ctx, fresh.id, 1)).turns[0];
    assert.notEqual(freshTurn.sourceEntryId, original.sourceEntryId); assert.equal(freshTurn.md, undefined);
    await page.screenshot({ path: path.join(output, 'new-independent.png') });
    await ctx2.close(); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'browser.json'), JSON.stringify({ metrics, errors, retryRequestIds: ids, original: original.id, sourceEntryId: original.sourceEntryId, turns: history.turns.map(t => ({ id: t.id, count: t.count, sourceEntryId: t.sourceEntryId, md: t.md })) }, null, 2));
    console.log(JSON.stringify({ metrics, errors, result: 'PASS' }));
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }); throw error; }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
