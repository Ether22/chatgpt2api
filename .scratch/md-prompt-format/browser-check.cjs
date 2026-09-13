const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43280';
const root = path.resolve('.venv/integration-check');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/login/');
    await page.getByLabel('密钥', { exact: true }).fill('ticket08-A');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/accounts/');
    await page.goto(origin + '/image/');
    await page.getByRole('button', { name: '上传 MD 和参考图', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入 Prompt 包', exact: true });
    await page.getByLabel('选择 MD 文件', { exact: true }).setInputFiles(path.join(root, 'test/fixtures/image-imports/double-wall-glass-mug.md'));
    await dialog.getByRole('article').nth(18).waitFor();
    assert.equal(await dialog.getByRole('article').count(), 19);
    const buffer = await fs.readFile(path.join(root, 'data/ticket08/reference.png'));
    await page.getByLabel('选择导入参考图', { exact: true }).setInputFiles([4, 7, 3, 1].map(i => ({ name: `1 (${i}).jpg`, mimeType: 'image/png', buffer })));
    await page.getByLabel('批量生成数量', { exact: true }).fill('1');
    const submit = dialog.getByRole('button', { name: '生成已选条目（19 张）', exact: true });
    await submit.waitFor();
    await page.screenshot({ path: '.scratch/md-prompt-format/import-preview.png' });
    let attempts = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const requests = [];
    await context.route('**/api/image-imports/batches', async route => {
      requests.push(route.request().postDataJSON());
      if (++attempts === 1) return route.fulfill({ status: 503, json: { detail: '受控提交失败' } });
      await gate;
      return route.continue();
    });
    await submit.click();
    await dialog.getByText('受控提交失败', { exact: true }).waitFor();
    assert(await dialog.isVisible());
    await dialog.getByRole('button', { name: '重试上次提交（19 张）', exact: true }).click();
    await dialog.getByRole('button', { name: '提交中…', exact: true }).waitFor();
    assert(await dialog.isVisible());
    release();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    await page.screenshot({ path: '.scratch/md-prompt-format/after-submit.png' });
    await page.getByRole('button', { name: '上传 MD 和参考图', exact: true }).click();
    await dialog.getByRole('article').nth(18).waitFor();
    assert.equal(await dialog.getByRole('article').count(), 19);
    assert.deepEqual(errors, []);
    console.log('PASS: all 19 entries; references match; failure stays open; retry preserves request; success closes dialog; reopening preserves imports; no page errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
