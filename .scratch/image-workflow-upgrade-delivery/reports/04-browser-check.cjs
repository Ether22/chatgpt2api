// Production UI against 04-browser-server.py; local synthetic files and upstream only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43140';
const output = path.join(__dirname, '04-evidence');
const headers = key => ({ Authorization: `Bearer ticket04-${key}` });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function login(page, key) {
  await page.goto(`${origin}/login/`);
  await page.getByLabel('密钥', { exact: true }).fill(`ticket04-${key}`);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/accounts/');
  await page.goto(`${origin}/image/`);
  await page.getByRole('button', { name: /^自动 · / }).waitFor();
}

async function eventually(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await sleep(100);
  }
  throw Error('Timed out waiting for UI/API state');
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const errors = [], submissions = [], uploads = [], protectedReads = [];
  const timings = {};
  let page;
  async function context() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.route('**/*', async route => {
      const request = route.request();
      if (new URL(request.url()).origin !== origin) return route.abort();
      if (request.url().endsWith('/api/image-references') && request.method() === 'POST') await sleep(650);
      return route.continue();
    });
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (request.method() === 'POST' && request.url().endsWith('/api/image-references')) uploads.push(request.postDataBuffer().length);
        if (request.method() === 'POST' && request.url().endsWith('/api/image-conversations/turns')) submissions.push(request.postDataJSON());
        if (/\/(images|image-thumbnails)\/managed\//.test(request.url())) protectedReads.push(!!request.headers().authorization);
      });
    });
    return context;
  }
  try {
    const first = await context();
    page = await first.newPage();
    await login(page, 'A');
    const png = await fs.readFile(path.join(output, 'reference.png'));
    const gif = await fs.readFile(path.join(output, 'reference.gif'));
    await page.locator('textarea').fill('ordered immutable reference snapshot');
    const started = Date.now();
    await page.locator('input[type=file]').setInputFiles([
      { name: 'reference.png', mimeType: 'image/png', buffer: png },
      { name: 'original-wrong.png', mimeType: 'image/gif', buffer: gif },
    ]);
    await page.getByText('上传中 0%', { exact: true }).first().waitFor();
    timings.selectionFeedbackMs = Date.now() - started;
    assert(await page.getByRole('button', { name: '编辑图片', exact: true }).isDisabled());
    await page.screenshot({ path: path.join(output, 'upload-feedback.png') });
    await eventually(async () => await page.getByRole('button', { name: '编辑图片', exact: true }).isEnabled());
    assert.equal(uploads.length, 2);
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/image-conversations/turns') && response.request().method() === 'POST');
    const generationStarted = Date.now();
    await page.getByRole('button', { name: '编辑图片', exact: true }).click();
    const saved = await (await accepted).json();
    const conversationId = saved.id;
    const snapshot = saved.turns[0].referenceImages;
    assert.deepEqual(snapshot.map(image => image.name), ['reference.png', 'original-wrong.png']);
    assert.equal(submissions[0].count, 4);
    assert.deepEqual(submissions[0].referenceImages, snapshot.map(({ id }) => ({ id })));
    assert(!JSON.stringify(submissions).includes('data:'));
    async function detail(client = first, key = 'A') {
      return (await client.request.get(`${origin}/api/image-conversations/${conversationId}`, { headers: headers(key) })).json();
    }
    await eventually(async () => (await detail()).turns[0].images.every(image => image.status === 'success'));
    timings.fourSyntheticImagesMs = Date.now() - generationStarted;
    await eventually(async () => (await (await first.request.get(`${origin}/api/image-references`, { headers: headers('A') })).json()).items.length === 0);
    assert.equal(uploads.length, 2, 'No additional server upload for four outputs');
    assert.equal(submissions.length, 1);
    await page.getByRole('button', { name: '预览参考图 original-wrong.png', exact: true }).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载图片', exact: true }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'original-wrong.gif');
    const downloaded = path.join(output, 'downloaded-original.gif');
    await download.saveAs(downloaded);
    assert.deepEqual(await fs.readFile(downloaded), gif);
    await page.keyboard.press('Escape');

    const second = await context();
    page = await second.newPage();
    await login(page, 'A');
    const preview = page.getByRole('button', { name: '预览参考图 reference.png', exact: true });
    await preview.waitFor();
    await eventually(() => preview.locator('img').evaluate(image => image.complete && image.naturalWidth === 40));
    assert.deepEqual((await detail(second)).turns[0].referenceImages, snapshot);
    await page.screenshot({ path: path.join(output, 'restored-snapshot.png') });
    await page.getByRole('button', { name: '复用配置', exact: true }).first().click();
    await page.getByRole('button', { name: '移除参考图 reference.png', exact: true }).waitFor();
    assert.equal((await (await second.request.get(`${origin}/api/image-references`, { headers: headers('A') })).json()).items.length, 2);
    await page.getByRole('button', { name: '移除参考图 reference.png', exact: true }).click();
    await page.getByRole('button', { name: '移除参考图 original-wrong.png', exact: true }).click();
    assert.deepEqual((await detail(second)).turns[0].referenceImages, snapshot);
    assert.equal((await second.request.get(`${origin}${snapshot[0].url}`, { headers: headers('A') })).status(), 200);
    assert.equal((await second.request.get(`${origin}${snapshot[0].url}`, { headers: headers('B') })).status(), 404);
    assert.equal((await second.request.post(`${origin}/api/image-conversations/turns`, { headers: headers('B'), data: { ...submissions[0], request_id: 'stolen', conversation_id: null } })).status(), 404);

    const third = await context();
    page = await third.newPage();
    await login(page, 'B');
    let rejected = false;
    await page.route('**/api/image-references', async route => {
      if (route.request().method() === 'POST' && !rejected) {
        rejected = true;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: { error: 'controlled upload outage' } }) });
      }
      return route.fallback();
    });
    await page.locator('input[type=file]').setInputFiles({ name: 'retry.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: '重试上传 retry.png', exact: true }).click();
    await eventually(async () => (await (await third.request.get(`${origin}/api/image-references`, { headers: headers('B') })).json()).items.length === 1);
    await page.reload();
    await page.getByRole('button', { name: '移除参考图 retry.png', exact: true }).waitFor();
    await page.getByRole('button', { name: '移除参考图 retry.png', exact: true }).click();
    await eventually(async () => (await (await third.request.get(`${origin}/api/image-references`, { headers: headers('B') })).json()).items.length === 0);
    assert(errors.length === 0, JSON.stringify(errors));
    assert(protectedReads.length > 0 && protectedReads.every(Boolean));
    await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ timings, mainUploads: 2, mainOutputs: 4, submissionBytes: Buffer.byteLength(JSON.stringify(submissions[0])), protectedReads: protectedReads.length, errors, download: 'original-wrong.gif; exact original bytes', checks: ['immediate upload feedback', 'ready guard', 'one upload per file for four images', 'ordered ID-only submission', 'cross-browser snapshot', 'retain and release', 'cross-identity denial', 'failed upload retry', 'unsubmitted draft reload and final cleanup'] }, null, 2));
    console.log('PASS', JSON.stringify(timings));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})();
