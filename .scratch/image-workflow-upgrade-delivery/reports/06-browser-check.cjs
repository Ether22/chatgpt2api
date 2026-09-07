// Real production UI / HTTP / temporary storage. Only transport faults and upstream are controlled.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43160';
const output = path.join(__dirname, '06-evidence');
const headers = { Authorization: 'Bearer ticket06-A' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const metrics = {}, errors = [], requests = [];
const fixtures = name => path.join(__dirname, '04-evidence', name);

async function eventually(check, description = 'UI/API state') {
  for (let i = 0; i < 250; i++) { if (await check()) return; await sleep(80); }
  throw Error(`Timed out: ${description}`);
}
async function login(page, key = 'A') {
  await page.goto(`${origin}/login/`);
  await page.getByLabel('密钥', { exact: true }).fill(`ticket06-${key}`);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/accounts/');
  await page.goto(`${origin}/image/`);
  await page.getByRole('button', { name: '上传 MD 和参考图', exact: true }).waitFor();
}
async function open(page) {
  await page.getByRole('button', { name: '上传 MD 和参考图', exact: true }).click();
  await page.getByRole('button', { name: '点击或拖入一个 MD 文件', exact: true }).waitFor();
  await eventually(() => page.getByRole('button', { name: '点击或拖入一个 MD 文件', exact: true }).isEnabled());
}
async function state(context) { return (await context.request.get(`${origin}/api/image-imports`, { headers })).json(); }
async function md(page, name, text) {
  await page.getByLabel('选择 MD 文件', { exact: true }).setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) });
}
async function add(page, files) { await page.getByLabel('选择导入参考图', { exact: true }).setInputFiles(files); }
async function ready(context, count) {
  await eventually(async () => { const s = await state(context); return s.references.length === count && s.references.every(r => r.reference); }, `${count} ready references`);
}
async function drag(page, name, files) {
  await page.getByRole('button', { name, exact: true }).evaluate((element, records) => {
    const transfer = new DataTransfer();
    for (const record of records) transfer.items.add(new File([Uint8Array.from(atob(record.data), c => c.charCodeAt(0))], record.name, { type: record.type }));
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, files);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const png = await fs.readFile(fixtures('reference.png'));
  const gif = await fs.readFile(fixtures('reference.gif'));
  let delayFile = '', loseFile = '', failCleanup = false, delayReservation = false;
  async function context() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      const body = req.postDataBuffer()?.toString() || '';
      if (url.pathname === '/api/image-imports/references' && req.method() === 'POST' && delayReservation) await sleep(500);
      if (url.pathname.startsWith('/api/image-imports/references/') && req.method() === 'PUT') {
        if (delayFile && body.includes(`filename="${delayFile}"`)) await sleep(1500);
        if (loseFile && body.includes(`filename="${loseFile}"`)) { loseFile = ''; await route.fetch(); return route.abort('failed'); }
      }
      if (failCleanup && url.pathname === '/api/image-imports' && req.method() === 'DELETE') {
        failCleanup = false;
        return route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ detail: { error: 'controlled cleanup transport failure' } }) });
      }
      return route.continue();
    });
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (request.url().includes('/api/image-imports')) requests.push({ method: request.method(), path: new URL(request.url()).pathname, bytes: request.postDataBuffer()?.length || 0 });
      });
    });
    return context;
  }
  try {
    const first = await context();
    let initial = await state(first);
    assert.equal((await first.request.delete(`${origin}/api/image-imports`, { headers, data: { request_id: crypto.randomUUID(), version: initial.version } })).status(), 200);
    const page = await first.newPage();
    await login(page);
    // Ordinary reference remains independently held through imports clear.
    await page.locator('input[type=file]').first().setInputFiles({ name: 'ordinary.png', mimeType: 'image/png', buffer: png });
    await eventually(async () => (await (await first.request.get(`${origin}/api/image-references`, { headers })).json()).items.length === 1);
    const ordinary = (await (await first.request.get(`${origin}/api/image-references`, { headers })).json()).items[0];
    await open(page);
    await md(page, 'first.md', '# First\nPrompt A');
    await eventually(async () => (await state(first)).md?.content.includes('Prompt A'));
    delayFile = 'one.png';
    const start = Date.now();
    await add(page, [{ name: 'one.png', mimeType: 'image/png', buffer: png }, { name: 'wrong.png', mimeType: 'image/gif', buffer: gif }]);
    await page.getByText('上传中 0%', { exact: true }).first().waitFor();
    metrics.selectionFeedbackMs = Date.now() - start;
    await page.screenshot({ path: path.join(output, 'upload-progress.png') });
    await ready(first, 2);
    delayFile = '';
    await page.getByRole('button', { name: '预览导入参考图 wrong.png', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载图片', exact: true }).click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), 'wrong.gif');
    const downloadedPath = path.join(output, 'downloaded-original.gif');
    await download.saveAs(downloadedPath);
    assert.deepEqual(await fs.readFile(downloadedPath), gif);
    await page.keyboard.press('Escape');
    await md(page, 'second.md', '# Second\nPrompt B');
    await eventually(async () => (await state(first)).md?.name === 'second.md');
    assert.equal((await state(first)).references.length, 2);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.reload();
    await open(page);
    await page.getByText('second.md', { exact: false }).waitFor();
    const second = await context();
    const otherPage = await second.newPage();
    await login(otherPage);
    await open(otherPage);
    await otherPage.getByRole('button', { name: '预览导入参考图 one.png', exact: true }).waitFor();
    await eventually(() => otherPage.getByRole('button', { name: '预览导入参考图 one.png', exact: true }).locator('img').evaluate(image => image.complete && image.naturalWidth > 0));
    await otherPage.screenshot({ path: path.join(output, 'restored-desktop.png') });
    const isolated = await context();
    const isolatedPage = await isolated.newPage();
    await login(isolatedPage, 'B');
    await open(isolatedPage);
    assert.equal(await isolatedPage.getByRole('list', { name: '导入参考图列表' }).locator('li').count(), 0);
    const ref = (await state(first)).references[0].reference;
    assert.equal((await isolated.request.get(`${origin}${ref.url}`, { headers: { Authorization: 'Bearer ticket06-B' } })).status(), 404);

    await md(otherPage, 'remote.md', '# Remote change');
    await eventually(async () => (await state(first)).md?.name === 'remote.md');
    await md(page, 'stale.md', '# Must not overwrite');
    await page.getByText(/素材版本冲突/).waitFor();
    assert.equal((await state(first)).md.name, 'remote.md');
    await page.getByRole('button', { name: '刷新素材', exact: true }).click();
    await page.getByText('remote.md', { exact: false }).waitFor();
    await drag(page, '点击或拖入一个 MD 文件', [{ name: 'drag.md', type: 'text/markdown', data: Buffer.from('# Drag replacement').toString('base64') }]);
    await eventually(async () => (await state(first)).md?.name === 'drag.md');
    // This browser still holds the pre-MD version, but non-conflicting references merge.
    await drag(otherPage, '点击或拖入参考图，支持分批追加', [{ name: 'extra.png', type: 'image/png', data: png.toString('base64') }]);
    await ready(first, 3);
    await add(otherPage, [{ name: 'one.png', mimeType: 'image/png', buffer: png }]);
    await otherPage.getByText(/同名参考图已存在/).waitFor();
    assert.equal((await state(first)).references.length, 3);
    // Clear from a stale browser is rejected and shows the current remote additions.
    await page.getByRole('button', { name: '清除上传内容', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '素材版本冲突' }).waitFor();
    assert.equal((await state(first)).references.length, 3);
    await page.getByRole('button', { name: '刷新素材', exact: true }).click();
    await page.getByRole('button', { name: '预览导入参考图 extra.png', exact: true }).waitFor();
    await page.getByRole('button', { name: '清除上传内容', exact: true }).click();
    await eventually(async () => (await state(first)).references.length === 0);
    assert.equal((await state(first)).md, null);
    assert.equal((await first.request.get(`${origin}${ordinary.url}`, { headers })).status(), 200);

    // Multipart arrives after clear: request IDs cancel both registered and queued files.
    delayFile = 'late.png'; delayReservation = true;
    await add(page, [{ name: 'late.png', mimeType: 'image/png', buffer: png }, { name: 'queued.png', mimeType: 'image/png', buffer: png }]);
    await page.getByText('late.png', { exact: true }).waitFor();
    await page.getByRole('button', { name: '清除上传内容', exact: true }).click();
    await eventually(async () => (await state(first)).references.length === 0);
    await sleep(1800);
    assert.equal((await state(first)).references.length, 0);
    assert.equal(await page.getByRole('list', { name: '导入参考图列表' }).locator('li').count(), 0);
    delayFile = ''; delayReservation = false;

    loseFile = 'lost.png';
    await add(page, [{ name: 'lost.png', mimeType: 'image/png', buffer: png }]);
    await page.getByRole('button', { name: '重试上传', exact: true }).waitFor();
    const lost = (await state(first)).references[0].reference;
    await page.getByRole('button', { name: '重试上传', exact: true }).click();
    await ready(first, 1);
    await eventually(async () => await page.getByRole('button', { name: '重试上传', exact: true }).count() === 0);
    assert.equal((await state(first)).references[0].reference.id, lost.id);
    failCleanup = true;
    await page.getByRole('button', { name: '清除上传内容', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'controlled cleanup transport failure' }).waitFor();
    await page.getByRole('button', { name: '重试清理', exact: true }).click();
    await eventually(async () => (await state(first)).references.length === 0);

    const bulkStarted = Date.now();
    await add(page, Array.from({ length: 48 }, (_, i) => ({ name: `long-reference-${i.toString().padStart(2, '0')}.png`, mimeType: 'image/png', buffer: png })));
    await eventually(async () => await page.getByRole('list', { name: '导入参考图列表' }).locator('li').count() === 48);
    metrics.bulkSelectionFeedbackMs = Date.now() - bulkStarted;
    await ready(first, 48);
    metrics.fortyEightSyntheticUploadsMs = Date.now() - bulkStarted;
    await page.setViewportSize({ width: 390, height: 600 });
    const dialog = page.getByRole('dialog').first();
    await eventually(async () => { const b = await dialog.boundingBox(); return b.x >= 0 && b.y >= 0 && b.x + b.width <= 391 && b.y + b.height <= 601; }, 'responsive dialog within viewport');
    const bounds = await dialog.boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 601, JSON.stringify(bounds));
    const list = page.getByRole('list', { name: '导入参考图列表' });
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.getByRole('button', { name: '移除导入参考图 long-reference-47.png', exact: true }).scrollIntoViewIfNeeded();
    assert(await page.getByRole('button', { name: '移除导入参考图 long-reference-47.png', exact: true }).isVisible());
    await page.screenshot({ path: path.join(output, 'narrow-long-list.png') });
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await open(page);
    assert.equal((await state(first)).references.length, 48);
    // Ordinary generation completion also leaves imports untouched.
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.locator('textarea').fill('ordinary generation retains shared materials');
    await page.getByRole('button', { name: '编辑图片', exact: true }).click();
    await eventually(async () => (await (await first.request.get(`${origin}/ticket06-consumption`)).json()).count >= 4);
    assert.equal((await state(first)).references.length, 48);
    assert.equal(errors.length, 0, errors.join('\n'));
    await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, metrics, errors, requests: requests.length, uploadRequests: requests.filter(r => r.method === 'PUT' && r.path.includes('/references/')).length }, null, 2));
    console.log(JSON.stringify({ passed: true, metrics, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
