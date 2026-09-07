// Production UI and real temporary HTTP/storage; upstream images and slow upload are controlled.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43180';
const output = path.join(__dirname, '08-evidence');
const headers = { Authorization: 'Bearer ticket08-A' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const metrics = {}, errors = [], submissions = [];
async function eventually(check, name = 'state') {
  for (let i = 0; i < 350; i++) { if (await check()) return; await sleep(80); }
  throw Error(`Timeout: ${name}`);
}
async function get(ctx, route, auth = headers) {
  const r = await ctx.request.get(origin + route, { headers: auth }); assert.equal(r.status(), 200); return r.json();
}
const state = ctx => get(ctx, '/api/image-imports');
const diagnostic = ctx => get(ctx, '/ticket08-state');
const detail = (ctx, id) => get(ctx, `/api/image-conversations/${id}?offset=0&limit=10`);
async function login(page, key = 'A') {
  await page.goto(`${origin}/login/`);
  await page.getByLabel('密钥', { exact: true }).fill(`ticket08-${key}`);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/accounts/'); await page.goto(`${origin}/image/`);
}
async function open(page) {
  await page.getByRole('button', { name: '上传 MD 和参考图', exact: true }).click();
  await eventually(() => page.getByRole('button', { name: '点击或拖入一个 MD 文件', exact: true }).isEnabled());
}
async function md(page, content, name = 'browser.md') {
  await page.getByLabel('选择 MD 文件', { exact: true }).setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(content) });
  await eventually(() => page.getByRole('article').count().then(n => n > 0));
}
async function start(page) {
  const response = page.waitForResponse(r => r.url().endsWith('/api/image-imports/batches') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^开始生成/ }).click();
  const result = await response;
  assert.equal(result.status(), 200, await result.text());
  await page.getByRole('status').filter({ hasText: '已接受' }).waitFor();
  return result.json();
}
const synthetic = `## [P01] 主图｜1200x800
参考图：无
输出文件名：main.jpg
### Prompt
~~~text
First actual prompt.
~~~
## [SUB01] 细节｜800x600
参考图：slow.png
### Prompt
~~~text
Second actual prompt.
~~~
## [SUB02] 不选｜800x600
参考图：无
### Prompt
~~~text
Unselected prompt.
~~~
`;
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  async function context() {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await ctx.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      if (route.request().method() === 'POST' && route.request().url().endsWith('/api/image-imports/batches')) submissions.push(route.request().postDataJSON());
      await route.continue();
    });
    ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return ctx;
  }
  try {
    const first = await context(), page = await first.newPage();
    await login(page); await open(page);
    const began = Date.now(); await md(page, synthetic);
    await eventually(async () => (await state(first)).candidates.length === 3);
    metrics.parseAndRenderMs = Date.now() - began;
    assert.equal(await page.getByLabel('批量生成数量', { exact: true }).inputValue(), '4');
    for (const value of ['0', '101', '1.5', '1e2', '-1']) {
      await page.getByLabel('批量生成数量', { exact: true }).fill(value);
      assert.equal(await page.getByRole('button', { name: /^开始生成/ }).isEnabled(), false);
    }
    await page.getByLabel('批量生成数量', { exact: true }).fill('1');
    await page.getByLabel('SUB01 单条数量', { exact: true }).fill('2');
    await page.getByLabel('选择 SUB02', { exact: true }).uncheck();
    await page.getByLabel('选择导入参考图', { exact: true }).setInputFiles(path.resolve(__dirname, '../../../data/ticket08/slow.png'));
    await eventually(async () => (await diagnostic(first)).upload_entered, 'slow upload reached server');
    await eventually(async () => (await state(first)).candidates[1].status === 'pending');
    const accepted = await start(page), cid = accepted.id;
    assert.equal(submissions[0].entries.length, 2);
    assert.deepEqual(submissions[0].entries.map(e => e.count ?? submissions[0].count), [1, 2]);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await eventually(async () => (await detail(first, cid)).turns[0].images[0].status === 'success', 'ready A completes while B uploads');
    let history = await detail(first, cid);
    assert.equal(history.turns.length, 2);
    assert.equal(history.turns[1].images.every(i => i.status === 'loading'), true);
    assert.equal((await diagnostic(first)).count, 1);
    const inputStart = Date.now();
    await page.getByPlaceholder('输入你想要生成的画面，也可直接粘贴图片').fill('Independent ordinary while B waits');
    metrics.inputWhilePendingMs = Date.now() - inputStart;
    await page.getByRole('button', { name: '生成图片', exact: true }).click();
    await eventually(async () => (await detail(first, cid)).turns.length === 3);
    await eventually(async () => (await diagnostic(first)).count === 2);
    await page.screenshot({ path: path.join(output, 'a-success-b-pending-independent.png') });
    await first.close();
    const second = await context(), page2 = await second.newPage();
    await login(page2);
    assert.equal((await detail(second, cid)).turns[1].images[0].status, 'loading');
    await second.request.post(origin + '/ticket08-release-upload');
    await eventually(async () => (await detail(second, cid)).turns.every(t => t.images.every(i => i.status === 'success')), 'B completes after browser closed');
    history = await detail(second, cid);
    assert.equal((await diagnostic(second)).count, 4);
    assert.equal(history.turns[1].referenceImages[0].name, 'slow.png');
    await page2.reload();
    await page2.getByRole('button', { name: '较早结果', exact: true }).click();
    await page2.locator(`[data-turn-id="${history.turns[1].id}"]`).waitFor();
    const bTurn = page2.locator(`[data-turn-id="${history.turns[1].id}"]`);
    await bTurn.getByRole('button', { name: '下载', exact: true }).first().waitFor();
    const downloadEvent = page2.waitForEvent('download');
    await bTurn.getByRole('button', { name: '下载', exact: true }).first().click();
    const downloaded = await downloadEvent;
    assert.equal(downloaded.suggestedFilename(), 'SUB01_细节_1.png');
    await downloaded.saveAs(path.join(output, downloaded.suggestedFilename()));
    const bytes = await fs.readFile(await downloaded.path());
    const raw = await second.request.get(new URL(history.turns[1].images[0].url, origin).href, { headers });
    assert.deepEqual(bytes, await raw.body());
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.notDeepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [800, 600]);
    metrics.originalDimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    await page2.screenshot({ path: path.join(output, 'restored-result-with-reference.png') });
    await second.request.post(origin + '/ticket08-restart');
    assert.deepEqual((await detail(second, cid)).turns, history.turns);
    await open(page2);
    await page2.getByRole('button', { name: '取消全选', exact: true }).click();
    await page2.getByLabel('选择 P01', { exact: true }).check();
    await page2.getByLabel('批量生成数量', { exact: true }).fill('100');
    const current = await state(second);
    await md(page2, synthetic.replace('First actual prompt.', 'Updated future prompt.'), 'replacement.md');
    await eventually(async () => (await state(second)).md_version !== current.md_version);
    assert.equal(await page2.getByLabel('批量生成数量', { exact: true }).inputValue(), '100');
    await page2.reload(); await open(page2);
    assert.equal(await page2.getByLabel('选择 SUB01', { exact: true }).isChecked(), false);
    assert.equal(await page2.getByLabel('批量生成数量', { exact: true }).inputValue(), '100');
    const hundredStart = Date.now(); await start(page2);
    await page2.getByRole('button', { name: '完成', exact: true }).click();
    await eventually(async () => { const h = await detail(second, cid); return h.turns.length === 4 && h.turns[3].images.every(i => i.status === 'success'); }, 'count 100 actual results');
    metrics.hundredSyntheticResultsMs = Date.now() - hundredStart;
    const updated = await detail(second, cid);
    assert.equal(updated.turns[3].count, 100);
    assert.equal(updated.turns[3].sourceEntryId, history.turns[0].sourceEntryId);
    assert.equal(updated.turns[0].prompt, 'First actual prompt.');
    assert.equal(updated.turns[3].prompt, 'Updated future prompt.');
    assert.equal(updated.turns[3].md.document_name, 'replacement.md');
    await page2.reload();
    await page2.getByRole('button', { name: '最新结果', exact: true }).waitFor();
    if (await page2.getByRole('button', { name: '最新结果', exact: true }).isEnabled()) await page2.getByRole('button', { name: '最新结果', exact: true }).click();
    const newTurn = page2.locator(`[data-turn-id="${updated.turns[3].id}"]`);
    await newTurn.getByRole('button', { name: '下载', exact: true }).first().waitFor();
    const namedEvent = page2.waitForEvent('download');
    await newTurn.getByRole('button', { name: '下载', exact: true }).first().click();
    const named = await namedEvent;
    assert.equal(named.suggestedFilename(), 'P01_主图_1_main.png');
    await named.saveAs(path.join(output, named.suggestedFilename()));
    await open(page2); await page2.getByLabel('批量生成数量', { exact: true }).fill('1');
    const materials = await state(second);
    const otherEdit = await second.request.patch(`${origin}/api/image-imports/candidates/${encodeURIComponent(materials.candidates[0].key)}`, {
      headers, data: { request_id: 'other-browser-edit', version: materials.version, md_version: materials.md_version, changes: { name: 'Changed by other browser' } },
    });
    assert.equal(otherEdit.status(), 200);
    const conflictEvent = page2.waitForResponse(r => r.url().endsWith('/api/image-imports/batches'));
    await page2.getByRole('button', { name: /^开始生成/ }).click();
    assert.equal((await conflictEvent).status(), 409);
    await page2.getByRole('button', { name: '刷新素材', exact: true }).click();
    await page2.getByRole('article', { name: '条目 P01 Changed by other browser', exact: true }).waitFor();
    await page2.getByRole('button', { name: '准备新的提交', exact: true }).click();
    await start(page2);
    let dropped = false;
    await page2.route('**/api/image-imports/batches', async route => {
      if (!dropped) { dropped = true; const result = await route.fetch(); assert.equal(result.status(), 200); await route.abort('failed'); }
      else await route.continue();
    });
    await page2.getByRole('button', { name: /^开始生成/ }).click();
    await page2.getByRole('button', { name: '重试本次提交', exact: true }).waitFor();
    const retryResponse = page2.waitForResponse(r => r.url().endsWith('/api/image-imports/batches'));
    await page2.getByRole('button', { name: '重试本次提交', exact: true }).click();
    assert.equal((await retryResponse).status(), 200);
    await eventually(async () => (await detail(second, cid)).turns.every(t => t.images.every(i => i.status === 'success')));
    assert.equal((await detail(second, cid)).turns.length, 6);
    assert.equal((await diagnostic(second)).count, 106);
    await page2.unroute('**/api/image-imports/batches');
    for (const viewport of [{ width: 390, height: 600 }, { width: 320, height: 360 }]) {
      await page2.setViewportSize(viewport);
      const button = page2.getByRole('button', { name: /^开始生成/ });
      assert.equal(await button.isVisible(), true);
      await eventually(async () => { const bounds = await button.boundingBox(); return bounds.y >= 0 && bounds.y + bounds.height <= viewport.height; }, 'responsive footer inside viewport');
      await page2.getByLabel('SUB02 单条数量', { exact: true }).scrollIntoViewIfNeeded();
      await page2.getByLabel('SUB02 单条数量', { exact: true }).fill('3');
      assert.equal(await page2.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page2.screenshot({ path: path.join(output, `selection-${viewport.width}x${viewport.height}.png`) });
    }
    const third = await context(), page3 = await third.newPage();
    await login(page3, 'B'); await open(page3);
    assert.equal(await page3.getByRole('article').count(), 0);
    assert.equal((await get(third, '/api/image-conversations', { Authorization: 'Bearer ticket08-B' })).items.length, 0);
    assert.equal(errors.length, 0, errors.join('\n'));
    await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, metrics, errors, submissions, consumption: (await diagnostic(second)).count }, null, 2));
    console.log(JSON.stringify({ passed: true, metrics, errors, consumption: (await diagnostic(second)).count }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
