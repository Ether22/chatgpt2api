const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43220';
const output = path.join(__dirname, '12-evidence');
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/login/');
    await page.getByLabel('密钥', { exact: true }).fill('ticket12-B');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/accounts/'); await page.goto(origin + '/image/');
    await page.getByPlaceholder('输入你想要生成的画面，也可直接粘贴图片').fill('Ticket12 download');
    await page.getByRole('button', { name: /自动 · 1:1/ }).click();
    await page.getByLabel('生成数量', { exact: true }).fill('1');
    await page.getByRole('button', { name: /自动 · 1:1/ }).click();
    await page.getByRole('button', { name: '生成图片', exact: true }).click();
    await page.waitForTimeout(3000); await page.screenshot({path:path.join(output,'before.png')});
    await page.locator('[data-image-frame] button').first().click();
    await page.setViewportSize({width:320,height:360});
    const dialog = page.getByRole('dialog', { name: '图片预览' });
    await dialog.getByRole('button', { name: '下载本轮成功图片', exact: true }).waitFor({ timeout: 5000 });
    const downloadEvent = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载本轮成功图片', exact: true }).click();
    const download = await downloadEvent;
    await download.saveAs(path.join(output, download.suggestedFilename()));
    assert.equal(await download.failure(), null);
    const img = await dialog.locator('img').boundingBox();
    for (const name of ['下载图片', '下载本轮成功图片', '删除当前生成结果', '关闭']) {
      const box = await dialog.getByRole('button', { name, exact: true }).boundingBox();
      assert.ok(box.y >= img.y + img.height && box.y + box.height <= 360, name);
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'low-height.png') });
    console.log('PASS one round original download and reachable bottom controls');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
