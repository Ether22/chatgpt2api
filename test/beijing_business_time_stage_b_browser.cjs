// Run the stage B fixture server first; no external browser traffic is allowed.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const origin = 'http://127.0.0.1:43282';
  const evidence = path.resolve('test/.beijing-evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const results = [];
  try {
    for (const timezoneId of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
      const context = await browser.newContext({ timezoneId, viewport: { width: 1500, height: 1000 } });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(origin + '/login/');
      await page.getByLabel('密钥', { exact: true }).fill('chatgpt2api');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL('**/accounts/');
      const row = page.getByRole('row').filter({ hasText: 'midnight@example.test' });
      await row.waitFor();
      assert.match(await row.innerText(), /2026\/09\/08 00:00:01 北京时间/);
      assert.match(await row.innerText(), /2026\/09\/07 23:59:59 北京时间/);
      const legacy = page.getByRole('row').filter({ hasText: 'legacy@example.test' });
      assert.match(await legacy.innerText(), /2026-09-07 16:00:01/);
      await page.screenshot({ path: path.join(evidence, timezoneId.replaceAll('/', '-') + '-accounts-b.png') });
      await page.goto(origin + '/image/');
      await page.getByText('2026/09/08 00:00:01 北京时间', { exact: true }).first().waitFor();
      await page.waitForFunction(() => [...document.images].some(image => image.complete && image.naturalWidth === 24));
      await page.screenshot({ animations: 'disabled', path: path.join(evidence, timezoneId.replaceAll('/', '-') + '-conversations-b.png') });
      await page.goto(origin + '/image-manager/');
      await page.getByText('2026/09/08 00:00:01 北京时间', { exact: true }).first().waitFor();
      await page.waitForFunction(() => [...document.images].some(image => image.complete && image.naturalWidth === 24));
      await page.screenshot({ animations: 'disabled', path: path.join(evidence, timezoneId.replaceAll('/', '-') + '-gallery-b.png') });
      results.push({ timezoneId, accounts: true, legacyUnchanged: true, conversations: true, gallery: true });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(evidence, 'results-b.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
