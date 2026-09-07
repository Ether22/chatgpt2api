const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const output = path.join(__dirname, '17-evidence');
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const results = [];
  try {
    for (const viewport of [{width:1440,height:900}, {width:390,height:844}]) {
      const context = await browser.newContext({viewport});
      const errors = [];
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://127.0.0.1:43270') return route.abort();
        if (/^\/(api|auth|v1)\//.test(url.pathname)) {
          const response = await route.fetch({url: 'http://127.0.0.1:43271' + url.pathname + url.search});
          return route.fulfill({response});
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:43270/login/');
      await page.getByLabel('密钥', {exact:true}).fill('ticket17-browser-only');
      await page.getByRole('button', {name:'登录',exact:true}).click();
      const row = page.getByRole('row').filter({hasText:'normal@example.invalid'});
      await row.waitFor();
      assert.equal(await page.getByRole('button', {name:/删除|移除异常账号/}).count(), 0);
      assert.equal(await page.locator('svg[class*="lucide-trash"]').count(), 0);
      await row.getByRole('checkbox').check();
      await page.getByText('已选择 1 项', {exact:true}).waitFor();
      assert.equal(await page.getByRole('button', {name:/删除|移除异常账号/}).count(), 0);
      await page.screenshot({path:path.join(output, `accounts-${viewport.width}.png`), fullPage:true});
      await row.getByRole('button').filter({has:page.locator('svg.lucide-pencil')}).click();
      const dialog = page.getByRole('dialog');
      assert.equal(await dialog.getByRole('button', {name:/删除/}).count(), 0);
      await dialog.getByLabel('使用状态', {exact:true}).click();
      await page.getByRole('option', {name:viewport.width === 1440 ? '仅监控' : '正常使用',exact:true}).click();
      await dialog.getByRole('button', {name:'保存修改',exact:true}).click();
      await dialog.waitFor({state:'hidden'});
      await page.getByRole('button', {name:'一键刷新所有账号信息和额度',exact:true}).click();
      await row.getByText('限流', {exact:true}).waitFor();
      await page.reload();
      await row.waitFor();
      assert.equal(await page.getByRole('row').filter({hasText:'@example.invalid'}).count(), 2);
      await page.screenshot({path:path.join(output, `after-refresh-${viewport.width}.png`), fullPage:true});
      await page.goto('http://127.0.0.1:43270/settings/');
      await page.getByRole('tab', {name:'基础配置',exact:true}).waitFor();
      assert.equal(await page.getByText('自动移除异常账号', {exact:true}).count(), 0);
      assert.equal(await page.getByText('自动移除限流账号', {exact:true}).count(), 0);
      await page.getByText('刷新后自动尝试移除异常状态', {exact:true}).waitFor();
      await page.screenshot({path:path.join(output, `settings-${viewport.width}.png`), fullPage:true});
      assert.deepEqual(errors, []);
      results.push({viewport, accounts:2, deletionButtons:0, oldSettings:0, editAndRefresh:'passed', pageErrors:errors});
      await context.close();
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results,null,2));
    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
