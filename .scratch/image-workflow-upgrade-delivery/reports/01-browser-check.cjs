// Run against 01-browser-server.py after building web/out. No real accounts or upstream calls.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const origin = 'http://127.0.0.1:43110';
const output = path.join(__dirname, '01-evidence');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const submissions = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/image-tasks\/(generations|edits)$/.test(request.url())) submissions.push(request);
  });
  try {
    await page.goto(`${origin}/login/`);
    await page.getByLabel('密钥', { exact: true }).fill('ticket01-browser-only');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/accounts/');
    await page.goto(`${origin}/image/`);
    const settings = page.getByRole('button', { name: /^自动 · / });
    await settings.waitFor();
    await page.screenshot({ path: path.join(output, 'initial.png') });
    assert.match(await settings.textContent(), / · 4 张$/, 'First visit must default to four images');
    console.log('PASS first visit defaults to four images');

    const prompt = page.locator('textarea');
    const count = page.getByLabel('生成数量', { exact: true });
    const submit = page.getByRole('button', { name: /^(生成图片|编辑图片)$/ });
    await prompt.fill('数量校验，不应提交非法值');
    for (const value of ['', '0', '101', '-1', '1.5', '1e2', '0x10', ' 4 ', 'abc', '１２']) {
      await settings.click();
      await count.fill(value);
      assert.equal(await submit.isDisabled(), true, `Invalid count ${JSON.stringify(value)} must disable submit`);
      if (value === '1e2') await page.screenshot({ path: path.join(output, 'invalid-count.png') });
      await prompt.click({ position: { x: 8, y: 8 } });
      await prompt.press('Enter');
      await page.getByText('生成数量必须为 1–100 的纯数字整数', { exact: true }).first().waitFor();
      assert.equal(await prompt.inputValue(), '数量校验，不应提交非法值', 'Enter must preserve the invalid draft');
      assert.equal(submissions.length, 0, 'Invalid count must not create HTTP tasks');
    }
    console.log('PASS empty, out-of-range, fractional, signed, exponent, hex, whitespace, letters and full-width digits reject button/Enter submission');

    const reference = { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') };
    await settings.click();
    await count.fill('7');
    await page.locator('input[type=file]').setInputFiles(reference);
    await page.getByRole('button', { name: '预览参考图 reference.png', exact: true }).waitFor();
    assert.equal(await count.inputValue(), '7', 'Upload must preserve manual count');
    await prompt.fill('上传后重新输入');
    assert.match(await settings.textContent(), / · 7 张$/);
    await page.reload();
    await settings.waitFor();
    assert.match(await settings.textContent(), / · 7 张$/, 'Reload must restore the user count');
    console.log('PASS seven remains selected after upload, rerender and reload');

    await settings.click();
    await count.fill('4');
    const longPrompt = [
      '任务 01：长 Prompt 折叠验证。',
      '第 2 行：使用合成几何图片，不调用真实上游。',
      '第 3 行：四张图片按行读取，尺寸不同也保留编号。',
      '第 4 行：折叠时轮次标识和参考图仍可辨认。',
      '第 5 行：展开后可以读取完整描述。',
      '第 6 行：收起后恢复两行预览。',
    ].join('\n');
    await prompt.fill(longPrompt);
    await page.locator('input[type=file]').setInputFiles(reference);
    await submit.click();
    await page.getByText('结果 4', { exact: true }).waitFor();
    await page.getByText('结果 4', { exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Generated result 4', exact: true }).waitFor();
    assert.equal(submissions.length, 4, 'Four images must create four real task requests');
    const displayedPrompt = page.getByText(longPrompt, { exact: true });
    const lineCount = () => displayedPrompt.evaluate(element => element.clientHeight / parseFloat(getComputedStyle(element).lineHeight));
    assert.ok((await lineCount()) <= 2.1, 'Long prompt starts at two visible lines');
    await page.getByRole('button', { name: '展开 Prompt', exact: true }).click();
    assert.ok((await lineCount()) >= 6, 'Expanded prompt contains all six lines');
    await page.getByRole('button', { name: '收起 Prompt', exact: true }).click();
    assert.ok((await lineCount()) <= 2.1, 'Collapse restores two lines');
    assert.equal(await page.getByText('第 1 轮', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '预览参考图 reference.png', exact: true }).isVisible(), true);
    console.log('PASS long prompt expands/collapses while round label and reference remain visible');

    for (const [width, height, columns] of [[1440, 1400, 3], [1000, 1200, 2], [600, 1100, 3], [390, 844, 3]]) {
      await page.setViewportSize({ width, height });
      await page.getByText('结果 4', { exact: true }).scrollIntoViewIfNeeded();
      const tiles = page.getByRole('button', { name: /^Generated result [1-4]$/ });
      await tiles.last().waitFor();
      const boxes = await tiles.evaluateAll(elements => elements.map(element => ({
        name: element.querySelector('img').alt,
        x: element.getBoundingClientRect().x,
        y: element.getBoundingClientRect().y,
      })));
      assert.equal(boxes.length, 4);
      assert.equal(boxes.filter(box => Math.abs(box.y - boxes[0].y) < 2).length, columns);
      assert.deepEqual([...boxes].sort((a, b) => Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y).map(box => box.name),
        ['Generated result 1', 'Generated result 2', 'Generated result 3', 'Generated result 4'], `${width}px must read 1,2,3,4 by row`);
      await displayedPrompt.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `results-${width}.png`) });
      console.log(`PASS ${width}px: ${columns} columns in row-major order`);
    }

    await page.setViewportSize({ width: 1440, height: 1100 });
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载', exact: true }).first().click();
    const download = await downloadEvent;
    const downloadPath = await download.path();
    assert.equal((await fs.readFile(downloadPath)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    console.log(`PASS original PNG download: ${download.suggestedFilename()}`);

    for (const value of ['1', '100']) {
      await page.getByRole('button', { name: '新建对话', exact: true }).click();
      await settings.click();
      await count.fill(value);
      await prompt.fill(`数量边界 ${value}`);
      const before = submissions.length;
      await submit.click();
      await page.getByText(`结果 ${value}`, { exact: true }).waitFor();
      await page.getByText(`结果 ${value}`, { exact: true }).scrollIntoViewIfNeeded();
      await page.getByRole('button', { name: `Generated result ${value}`, exact: true }).waitFor();
      assert.equal(submissions.length - before, Number(value));
      assert.equal(await page.getByRole('button', { name: '展开 Prompt', exact: true }).count(), 0, 'Short prompt needs no disclosure');
      console.log(`PASS count ${value}: exact number of real task submissions and successful last result`);
    }
    console.log('PASS ticket 01 browser acceptance');
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
