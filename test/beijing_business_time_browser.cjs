// Run the fixture server first; only its origin is allowed through the browser.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const origin = 'http://127.0.0.1:43281';
  const evidence = path.resolve('test/.beijing-evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const results = [];
  try {
    for (const timezoneId of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
      const context = await browser.newContext({ timezoneId, viewport: { width: 1280, height: 900 } });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      // Keep the real API row and also verify explicit UTC input at the UI boundary.
      await context.route(origin + '/api/auth/users', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.items.push({ id: 'utc-input', name: 'utc-http-input', enabled: true, created_at: '2026-09-07T16:00:01Z', last_used_at: '2026-09-07T15:59:59Z' });
        await route.fulfill({ response, json: data });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(origin + '/login/');
      await page.getByLabel('密钥', { exact: true }).fill('chatgpt2api');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL('**/accounts/');
      await page.goto(origin + '/settings/');
      await page.getByRole('tab', { name: '用户密钥', exact: true }).click();
      await page.getByText('midnight-key', { exact: true }).waitFor();
      const keyText = await page.getByRole('tabpanel').innerText();
      assert.match(keyText, /创建时间 2026\/09\/08 00:00:01/);
      assert.match(keyText, /最近使用 2026\/09\/08 00:00:01/);
      assert.match(keyText, /最近使用 2026\/09\/07 23:59:59/);
      await page.screenshot({ path: path.join(evidence, timezoneId.replaceAll('/', '-') + '-keys.png') });
      await page.getByRole('tab', { name: '备份', exact: true }).click();
      await page.getByText(/backup-20260908T000001\+0800-/).first().waitFor();
      const backupText = await page.getByRole('tabpanel').innerText();
      assert.match(backupText, /2026\/09\/08 00:00:01/);
      await page.getByRole('button', { name: '查看详情', exact: true }).click();
      await page.getByRole('dialog').getByText('2026/09/08 00:00:01', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(evidence, timezoneId.replaceAll('/', '-') + '-backup.png') });
      await page.keyboard.press('Escape');
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: '下载', exact: true }).click(),
      ]);
      assert.match(download.suggestedFilename(), /^backup-20260908T000001\+0800-.*\.tar\.gz$/);
      await page.goto(origin + '/logs/');
      await page.getByRole('cell', { name: '2026/09/08 00:00:01', exact: true }).waitFor();
      await page.getByRole('button', { name: '查看详情', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('2026/09/07 23:59:59', { exact: true }).waitFor();
      await dialog.getByText('2026/09/08 00:00:01', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(evidence, timezoneId.replaceAll('/', '-') + '-logs.png') });
      results.push({ timezoneId, key: '2026/09/08 00:00:01', backup: '2026/09/08 00:00:01', logStart: '2026/09/07 23:59:59', logEnd: '2026/09/08 00:00:01' });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
