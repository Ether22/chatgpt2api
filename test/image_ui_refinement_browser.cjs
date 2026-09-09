// Run in the isolated workspace after image_gallery_migration_browser.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43280';
const headers = { Authorization: 'Bearer ticket08-A' };
const output = path.resolve('.scratch/ui-refinement-round2/evidence');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 250; n++) { if (await check()) return; await pause(80); } throw Error('Timed out'); }
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const get = async url => { const response = await context.request.get(origin + url, { headers }); assert.equal(response.status(), 200); return response.json(); };
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const accounts = await get('/api/accounts');
    accounts.items = Array.from({ length: 35 }, (_, i) => ({ ...accounts.items[0], access_token: `ui-${i}`, email: `ui-${i}@example.test`, display_order: i,
      status: i === 2 ? '异常' : '正常', usage_mode: i === 1 ? 'disabled' : 'normal', image_inflight: i < 3 ? 1 : 0 }));
    await context.route('**/api/accounts', route => route.fulfill({ json: accounts }));
    await page.goto(origin + '/login/');
    await page.getByLabel('密钥', { exact: true }).fill('ticket08-A');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/accounts/');
    const pageSize = page.getByRole('combobox', { name: '账号每页条数', exact: true });
    await until(async () => await page.locator('tbody tr').count() === 10);
    for (const size of [20, 50, 100, 10]) {
      await pageSize.click(); await page.getByRole('option', { name: `${size} / 页`, exact: true }).click();
      await page.reload();
      await until(async () => (await pageSize.innerText()).includes(String(size)) && await page.locator('tbody tr').count() === Math.min(size, 35));
    }
    await page.getByRole('button', { name: '2', exact: true }).click();
    await pageSize.click(); await page.getByRole('option', { name: '20 / 页', exact: true }).click();
    await page.getByText('1 / 2 页', { exact: true }).waitFor();
    const status = page.getByRole('combobox', { name: '账号状态筛选', exact: true });
    await status.click();
    assert.equal(await page.getByRole('option', { name: '上游停用', exact: true }).count(), 0);
    await page.getByRole('option', { name: '在途', exact: true }).click();
    await until(async () => await page.locator('tbody tr').count() === 3);
    assert.equal(await page.getByRole('checkbox', { name: '仅看在途账号' }).count(), 0);
    await page.getByPlaceholder('搜索邮箱').fill('ui-1@');
    await until(async () => await page.locator('tbody tr').count() === 1);
    await page.getByPlaceholder('搜索邮箱').fill('');
    await page.screenshot({ path: path.join(output, 'account-filter.png') });
    await status.click(); await page.getByRole('option', { name: '异常', exact: true }).click();
    await until(async () => await page.locator('tbody tr').count() === 1);
    await page.getByRole('button', { name: '移除异常账号', exact: true }).click();
    const removal = page.getByRole('dialog');
    assert.match(await removal.innerText(), /ui-2@example.test/);
    await removal.getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(() => localStorage.setItem('chatgpt2api.accounts.page-size', 'invalid'));
    await page.reload(); await until(async () => (await pageSize.innerText()).includes('10'));

    const imagePage = await get('/api/images?limit=100');
    assert(imagePage.items.length >= 26);
    const rels = Array.from({ length: 350 }, (_, i) => imagePage.items[i]?.rel || `synthetic-only/image-${i}.png`);
    let release, mode = 'hold', offsets = [];
    await context.route('**/api/images?*', async route => {
      const query = new URL(route.request().url()).searchParams;
      const offset = Number(query.get('offset') || 0), limit = Number(query.get('limit'));
      const pathsOnly = query.get('paths_only') === 'true';
      if (pathsOnly) {
        offsets.push(offset);
        if (offset === 100 && mode === 'hold') await new Promise(resolve => { release = resolve; });
        if (offset === 100 && mode === 'fail') return route.fulfill({ status: 503, json: { detail: 'controlled selection failure' } });
      }
      return route.fulfill({ json: { ...imagePage,
        items: pathsOnly ? rels.slice(offset, offset + limit).map(rel => ({ rel })) : imagePage.items.slice(offset, offset + limit),
        pagination: { ...imagePage.pagination, total: 350, offset, limit, next_offset: offset + limit < 350 ? offset + limit : null }
      } });
    });
    await page.goto(origin + '/image-manager/');
    const all = page.getByRole('checkbox', { name: '全选结果', exact: true });
    const cancel = page.getByRole('button', { name: '取消全部选择', exact: true });
    await until(() => all.isEnabled()); await all.click();
    const progress = page.getByRole('status').filter({ hasText: '正在全选，已选 100 / 350 张' });
    await progress.waitFor(); await until(() => !!release);
    assert.equal(await progress.evaluate(node => getComputedStyle(node).cursor), 'default');
    assert.equal(await progress.locator('svg.animate-spin').count(), 1);
    assert(await cancel.isEnabled());
    await page.screenshot({ path: path.join(output, 'selecting-100-of-350.png') });
    await cancel.click(); release(); release = null; await pause(200);
    assert.equal(await all.getAttribute('data-state'), 'unchecked');
    assert.deepEqual(offsets, [0, 100]);
    assert.equal(await page.getByText(/^已选 \d+ 张$/).count(), 0);
    offsets = []; mode = 'hold'; await all.click(); await progress.waitFor(); await until(() => !!release); release(); release = null;
    await until(async () => await all.getAttribute('data-state') === 'checked');
    assert.deepEqual(offsets, [0, 100, 200, 300]);
    await page.getByText('已选 350 张', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'selected-350.png') });
    await cancel.click(); mode = 'fail'; await all.click();
    await page.getByText(/选择未完成，已保留 100 张/).waitFor();
    assert.equal(await all.getAttribute('data-state'), 'indeterminate');
    await cancel.click(); await context.unroute('**/api/images?*'); await page.reload();

    await until(async () => await page.locator('button:has(img)').count() === 12);
    await page.locator('button:has(img)').nth(5).click();
    const viewer = page.getByRole('dialog', { name: '图片预览', exact: true });
    await until(async () => await viewer.locator('img').evaluate(img => img.complete && img.naturalWidth > 0));
    const prev = await viewer.getByRole('button', { name: '上一张', exact: true }).boundingBox();
    const next = await viewer.getByRole('button', { name: '下一张', exact: true }).boundingBox();
    assert(prev.x < 60 && next.x > 1340 && Math.abs(prev.y + prev.height / 2 - 500) < 2);
    const toolbar = viewer.getByRole('button', { name: '关闭', exact: true }).locator('../..');
    let box = await toolbar.boundingBox(); assert(box.width < 1200 && box.height < 100 && box.y > 880);
    await page.mouse.move(1, 999); await page.waitForFunction(() => !document.querySelector('[data-sonner-toast]'));
    await page.screenshot({ path: path.join(output, 'lightbox-desktop.png') });
    await page.keyboard.press('ArrowRight'); await viewer.getByText(/图片 7（7\/26）/).waitFor();
    await viewer.locator('img').dblclick(); assert.equal(await viewer.getByRole('button', { name: '上一张', exact: true }).count(), 0);
    await viewer.locator('img').dblclick();
    await page.setViewportSize({ width: 320, height: 360 });
    box = await toolbar.boundingBox(); assert(box.x >= 0 && box.x + box.width <= 320 && box.y >= 0 && box.y + box.height <= 360);
    const download = page.waitForEvent('download'); await viewer.getByRole('button', { name: '下载图片' }).click(); await download;
    assert.equal(await viewer.locator('details').getAttribute('open'), null);
    const imageBox = await viewer.locator('img').boundingBox();
    box = await toolbar.boundingBox(); assert(imageBox.y + imageBox.height <= box.y + 1, 'Small-screen toolbar must not cover the image');
    await page.screenshot({ path: path.join(output, 'lightbox-small.png') });
    await viewer.getByText('下载明细与逐张重试', { exact: true }).click();
    box = await toolbar.boundingBox(); assert(box.y >= 0 && box.y + box.height <= 360);
    await viewer.getByRole('button', { name: '关闭', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.goto(origin + '/image/');
    await page.getByRole('button', { name: '上传 MD 和参考图', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入 Prompt 包', exact: true });
    await until(() => dialog.getByRole('button', { name: /选择或拖入 Markdown/ }).isEnabled());
    const md = '## [P01] 主图｜1600x1600\nPrompt: synthetic missing reference declaration\n';
    await page.getByLabel('选择 MD 文件', { exact: true }).setInputFiles({ name: '声明修正.md', mimeType: 'text/markdown', buffer: Buffer.from(md) });
    const row = dialog.getByRole('article', { name: '条目 P01 主图', exact: true });
    await row.getByRole('button', { name: '修正', exact: true }).click();
    const referenceMode = row.getByRole('combobox', { name: '参考图声明', exact: true });
    assert.deepEqual(await referenceMode.locator('option').allTextContents(), ['明确无参考图', '使用以下文件，按行匹配']);
    assert.equal(await referenceMode.inputValue(), 'files');
    await row.getByRole('button', { name: '保存并校验', exact: true }).click();
    assert(await page.getByLabel('选择 P01', { exact: true }).isDisabled());
    await row.getByRole('button', { name: '修正', exact: true }).click();
    await referenceMode.selectOption('none');
    await row.getByRole('button', { name: '保存并校验', exact: true }).click();
    await until(async () => !(await page.getByLabel('选择 P01', { exact: true }).isDisabled()));
    await row.getByRole('button', { name: '修正', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'reference-options.png') });
    await row.getByRole('button', { name: '取消修正', exact: true }).click();
    await page.getByLabel('选择 P01', { exact: true }).check();
    await page.getByLabel('批量生成数量', { exact: true }).fill('1');
    await dialog.getByRole('button', { name: '生成已选条目（1 张）', exact: true }).click();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: '结果定位导航' }).filter({ visible: true });
    await navigation.getByRole('button', { name: '展开或收起 P01 · 主图', exact: true }).click();
    await navigation.getByRole('button', { name: /^第 1 次 ·/ }).click();
    const navBox = await navigation.boundingBox(); assert(navBox.width <= 208);
    const sourceBox = await navigation.locator('[data-navigation-source]').filter({ hasText: 'P01 · 主图' }).locator(':scope > div').first().boundingBox();
    assert(sourceBox.height <= 34);
    await page.screenshot({ path: path.join(output, 'compact-navigation.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: account page-size persistence, in-flight status filter, abnormal removal scope, cancellable 350-image selection and partial failure, compact lightbox and navigation, reference declaration correction.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
