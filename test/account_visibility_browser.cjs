// Run against `python -m test.account_visibility_browser_server` after building web.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = 'http://127.0.0.1:43260';
const evidence = path.resolve('.scratch/image-workflow-upgrade-delivery/reports/16-evidence');
const headers = { Authorization: 'Bearer ticket-16-browser' };

(async () => {
  await fs.mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    const row = letter => page.locator('tbody tr').filter({ hasText: `${letter}@example.test` });
    const order = async expected => {
      await page.waitForFunction(expected => Array.from(document.querySelectorAll('tbody tr')).map(row => row.cells[5].textContent.trim()).join(',') === expected,
        expected.map(letter => `${letter}@example.test`).join(','));
    };
    const showHidden = () => page.getByRole('checkbox', { name: /显示隐藏账号/ });
    const saveDone = () => page.waitForFunction(() => !document.querySelector('[role="status"]')?.textContent.includes('正在保存'));
    const login = async target => {
      await target.goto(`${base}/login/`);
      await target.getByLabel('密钥', { exact: true }).fill('ticket-16-browser');
      await target.getByRole('button', { name: '登录', exact: true }).click();
      await target.waitForURL('**/accounts/');
    };
    await login(page);
    await order(['m', 'n', 'a', 'd']);
    await page.screenshot({ path: path.join(evidence, 'default.png'), fullPage: true });
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: /导出/ }).click();
    const download = await downloadReady;
    assert.match(await fs.readFile(await download.path(), 'utf8'), /qa-b/);

    await page.getByRole('button', { name: '排序 n@example.test', exact: true }).dragTo(row('m'), { targetPosition: { x: 80, y: 4 } });
    await order(['n', 'm', 'a', 'd']);
    await saveDone();
    await page.getByRole('button', { name: '排序 a@example.test', exact: true }).dragTo(row('m'), { targetPosition: { x: 80, y: 4 } });
    await page.getByText('只能在监控组或其余账号组内部排序', { exact: true }).waitFor();
    await order(['n', 'm', 'a', 'd']);
    const handle = page.getByRole('button', { name: '排序 a@example.test', exact: true });
    await handle.focus();
    await handle.press('ArrowDown');
    await order(['n', 'm', 'd', 'a']);
    await saveDone();
    assert.equal(await handle.evaluate(element => element === document.activeElement), true);
    await showHidden().check();
    await order(['n', 'm', 'b', 'd', 'a']);
    await row('b').getByRole('button', { name: '取消隐藏账号', exact: true }).click();
    await row('b').getByRole('button', { name: '隐藏账号', exact: true }).waitFor();
    await row('m').getByRole('button', { name: '隐藏账号', exact: true }).click();
    await row('m').getByText('已隐藏', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'show-hidden.png'), fullPage: true });
    await showHidden().uncheck();
    await order(['n', 'b', 'd', 'a']);
    await page.reload();
    await order(['n', 'b', 'd', 'a']);

    assert.equal((await context.request.post(`${base}/qa/rotate`, { headers })).status(), 200);
    assert.equal((await context.request.post(`${base}/qa/reload`, { headers })).status(), 200);
    await page.reload();
    await order(['n', 'b', 'd', 'a']);
    await showHidden().check();
    await order(['n', 'm', 'b', 'd', 'a']);
    assert.match(await row('m').textContent(), /qa-m-rotated/);
    await row('m').getByRole('button', { name: '取消隐藏账号', exact: true }).click();
    await row('m').getByRole('button', { name: '隐藏账号', exact: true }).waitFor();
    await row('d').locator('button:has(svg.lucide-pencil)').click();
    await page.getByLabel('使用状态', { exact: true }).click();
    await page.getByRole('option', { name: '仅监控', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: /保存/ }).click();
    await order(['n', 'm', 'd', 'b', 'a']);
    await page.reload();
    await order(['n', 'm', 'd', 'b', 'a']);
    await page.screenshot({ path: path.join(evidence, 'reloaded-order.png'), fullPage: true });

    const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await second.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const narrow = await second.newPage();
    await login(narrow);
    await narrow.getByRole('button', { name: '排序 n@example.test', exact: true }).waitFor();
    const emails = await narrow.locator('tbody tr td:nth-child(6)').allTextContents();
    assert.deepEqual(emails, ['n@example.test', 'm@example.test', 'd@example.test', 'b@example.test', 'a@example.test']);
    await narrow.getByRole('button', { name: '排序 n@example.test', exact: true }).focus();
    await narrow.keyboard.press('ArrowDown');
    await narrow.waitForFunction(() => document.querySelector('tbody tr')?.textContent.includes('m@example.test'));
    await narrow.screenshot({ path: path.join(evidence, 'narrow-keyboard.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: default hide, full export, group drag/rejection, keyboard/focus, restore, token rotation, service reload, usage group change, independent narrow browser.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
