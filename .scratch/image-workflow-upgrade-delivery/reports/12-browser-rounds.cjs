// Real HTTP/storage and production Chrome; only upstream bytes are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43220', headers = { Authorization: 'Bearer ticket12-A' };
const output = path.join(__dirname, '12-evidence');
const downloadRoot = path.resolve(__dirname, '../../../data/ticket12-downloads', String(Date.now()));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(check, label) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await pause(100); }
  throw Error('Timed out: ' + label);
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    const page = await context.newPage(), errors = [], metrics = {};
    page.on('pageerror', e => errors.push(e.message));
    const get = async route => { const r = await context.request.get(origin + route, { headers }); assert.equal(r.status(), 200); return r.json(); };
    const post = async (route, data) => { const r = await context.request.post(origin + route, { headers, data }); assert.equal(r.status(), 200, await r.text()); return r.json(); };
    const read = id => get(`/api/image-conversations/${id}?offset=0&limit=10`);
    await page.goto(origin + '/login/'); await page.getByLabel('密钥', { exact: true }).fill('ticket12-A');
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/accounts/');
    await page.goto(origin + '/image/');
    async function mdRound(prompt, count, doc) {
      await page.getByRole('button', { name: '上传 MD 和参考图', exact: true }).click();
      await eventually(() => page.getByRole('button', { name: '点击或拖入一个 MD 文件', exact: true }).isEnabled(), 'MD input ready');
      await page.getByLabel('选择 MD 文件', { exact: true }).setInputFiles({ name: 'download.md', mimeType: 'text/markdown', buffer: Buffer.from(`## [${doc}] 任务名称｜800x600\n参考图：无\n输出文件名：original-output.jpg\n### Prompt\n~~~\n${prompt}\n~~~`) });
      await page.waitForTimeout(500); await page.screenshot({path:path.join(output, 'md-debug.png')});
      await page.getByRole('article', { name: `条目 ${doc} 任务名称`, exact: true }).waitFor();
      await page.getByLabel('批量生成数量', { exact: true }).fill(String(count));
      const response = page.waitForResponse(r => r.url().endsWith('/api/image-imports/batches') && r.request().method() === 'POST');
      await page.getByRole('button', { name: /^开始生成/ }).click();
      const r = await response; assert.equal(r.status(), 200, await r.text()); const saved = await r.json();
      await page.getByRole('button', { name: '完成', exact: true }).click();
      return { conversation: saved.id, turn: saved.turns.at(-1).id };
    }
    const small = await mdRound('Formats-' + Date.now(), 3, 'P01');
    await eventually(async () => (await read(small.conversation)).turns.find(t => t.id === small.turn).images.filter(i => i.status === 'success').length === 3, 'three formats');
    await page.reload();
    const row = page.locator(`[data-turn-id="${small.turn}"]`);
    await row.getByRole('img', { name: 'Generated result 1', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '图片预览', exact: true });
    await page.screenshot({path:path.join(output,'desktop-viewer.png')});
    const events = [];
    page.on('download', d => events.push(d));
    async function batch(expected, folder, target) {
      const snapshot = (await read(target.conversation)).turns.find(t => t.id === target.turn);
      const ordinalByHash = new Map();
      for (const image of snapshot.images.filter(i => i.status === "success")) {
        const response = await context.request.get(image.url, { headers }); assert.equal(response.status(), 200);
        ordinalByHash.set(createHash("sha256").update(await response.body()).digest("hex"), image.ordinal);
      }
      events.length = 0; const began = Date.now();
      await dialog.getByRole('button', { name: '下载本轮成功图片', exact: true }).click();
      try { await eventually(() => events.length === expected, 'all actual browser downloads'); } catch (error) { console.error({actual:events.length,expected,text:await dialog.innerText()}); await page.screenshot({path:path.join(output,'batch-failure.png')}); throw error; }
      await dialog.getByRole('status').filter({ hasText: `已请求 ${expected}/${expected} 张` }).waitFor();
      const originals = (await get('/ticket12-state')).originals, names = [], ordinals = [];
      await fs.mkdir(path.join(downloadRoot, folder), { recursive: true });
      for (const d of events) {
        const name = d.suggestedFilename(), file = path.join(downloadRoot, folder, name);
        assert.equal(await d.failure(), null); await d.saveAs(file);
        const bytes = await fs.readFile(file), hash = createHash('sha256').update(bytes).digest('hex'), known = originals[hash];
        const ordinal = ordinalByHash.get(hash); assert.ok(ordinal, 'download belongs to current round');
        assert.ok(known, 'unchanged original bytes');
        const ext = { PNG: 'png', JPEG: 'jpg', GIF: 'gif', WEBP: 'webp' }[known.format];
        assert.ok(name.endsWith(`_${ordinal}_original-output.${ext}`), name);
        names.push(name); ordinals.push(ordinal);
      }
      assert.equal(new Set(names).size, expected);
      assert.equal((await fs.readdir(path.join(downloadRoot, folder))).length, expected);
      metrics[folder] = { directory: path.join(downloadRoot, folder), count: expected, elapsedMs: Date.now() - began, names, ordinals };
    }
    await batch(3, 'formats', small);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Delete'); await page.getByRole('button', { name: '确认删除', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 1); assert.equal(await page.getByRole('button', { name: '确认删除', exact: true }).count(), 0);
    await page.keyboard.press('Delete'); await page.keyboard.press('Enter');
    await dialog.getByText(/图片 3（2\/2）/).waitFor();
    await eventually(async () => (await read(small.conversation)).turns.find(t => t.id === small.turn).images.length === 2, 'delete persisted');
    await batch(2, 'deleted-middle', small);
    assert.deepEqual(metrics['deleted-middle'].ordinals, [1, 3]);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const large = await mdRound('Round100-' + Date.now(), 100, 'SUB01');
    await eventually(async () => (await read(large.conversation)).turns.find(t => t.id === large.turn).images.filter(i => i.status === 'success').length === 98, '98 success with one pending one error');
    await page.reload();
    await page.locator(`[data-turn-id="${large.turn}"] [data-image-frame]`).first().scrollIntoViewIfNeeded();
    await page.locator(`[data-turn-id="${large.turn}"]`).getByRole('img', { name: 'Generated result 1', exact: true }).click();
    await batch(98, 'round100', large);
    assert.equal(metrics.round100.ordinals.length, 98);
    assert.ok(metrics.round100.names.every(name => name.startsWith('SUB01_任务名称_')));
    // A newly completed member is included without reopening the viewer.
    await post('/ticket12-release-result', {});
    await eventually(async () => /99/.test(await dialog.getByRole('button', { name: '下载本轮成功图片', exact: true }).innerText()), 'new success added to round');
    await page.setViewportSize({ width: 320, height: 360 });
    await dialog.locator('summary').click();
    const lastRetry = dialog.getByRole('button', { name: '再次下载', exact: true }).last();
    await lastRetry.scrollIntoViewIfNeeded(); assert.ok(await lastRetry.isVisible());
    const retryBox = await lastRetry.boundingBox(); assert.ok(retryBox.y >= 0 && retryBox.y + retryBox.height <= 360);
    await page.screenshot({ path: path.join(output, 'batch-low-height.png') });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'rounds.json'), JSON.stringify({ passed: true, errors, metrics }, null, 2));
    console.log(JSON.stringify({ passed: true, formats: 3, afterMiddleDelete: 2, mixed100: 98, errors, elapsedMs: metrics.round100.elapsedMs }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
