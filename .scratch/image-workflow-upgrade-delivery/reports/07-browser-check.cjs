// Production UI + real imports/auth/reference storage. Only synthetic upstream/transport are controlled.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43170';
const output = path.join(__dirname, '07-evidence');
const headers = { Authorization: 'Bearer ticket07-A' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const metrics = {}, errors = [];
async function eventually(check, name = 'state') {
  for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(80); }
  throw Error(`Timeout: ${name}`);
}
async function state(context) { return (await context.request.get(`${origin}/api/image-imports`, { headers })).json(); }
async function login(page, key = 'A') {
  await page.goto(`${origin}/login/`);
  await page.getByLabel('密钥', { exact: true }).fill(`ticket07-${key}`);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/accounts/');
  await page.goto(`${origin}/image/`);
}
async function open(page) {
  await page.getByRole('button', { name: '上传 MD 和参考图', exact: true }).click();
  await eventually(() => page.getByRole('button', { name: '点击或拖入一个 MD 文件', exact: true }).isEnabled());
}
async function md(page, content) {
  await page.getByLabel('选择 MD 文件', { exact: true }).setInputFiles({ name: 'browser.md', mimeType: 'text/markdown', buffer: Buffer.from(content) });
}
const synthetic = `# Global text must stay out of Prompt
## [P01-A] First
参考图：first.png
### Prompt
~~~text
Keep 无需生成 inside the actual prompt.
~~~
## [P01-A] Second｜640x480
参考图：second.png
### Prompt
\`\`\`text
Second actual prompt.
\`\`\`
## [SUB99] Invalid
## [PASS] 直通
`;

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  let releaseUpload;
  const blockedUpload = new Promise(resolve => { releaseUpload = resolve; });
  async function context() {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.route('**/*', async route => {
      const request = route.request();
      if (new URL(request.url()).origin !== origin) return route.abort();
      if (request.method() === 'PUT' && request.url().includes('/references/') && request.postDataBuffer()?.includes(Buffer.from('filename="second.png"'))) await blockedUpload;
      await route.continue();
    });
    ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return ctx;
  }
  try {
    const first = await context(), page = await first.newPage();
    await login(page); await open(page);
    const fixtures = path.resolve(__dirname, '../../../test/fixtures/image-imports');
    for (const file of ['fairness-cup.md', 'food-containers.md']) {
      const text = await fs.readFile(path.join(fixtures, file), 'utf8');
      const started = Date.now();
      await md(page, text);
      await eventually(async () => (await state(first)).md?.content === text);
      await eventually(async () => await page.getByRole('region', { name: 'MD 条目预览' }).getByRole('article').count() === 19);
      metrics[`${file}-upload-parse-render-ms`] = Date.now() - started;
      const candidate = page.getByRole('article').first();
      await candidate.locator('summary').click();
      assert((await candidate.locator('pre').innerText()).length > 500);
      await candidate.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${file}.png`) });
    }
    await md(page, synthetic);
    await eventually(async () => (await state(first)).candidates.length === 3);
    let s = await state(first);
    assert.equal(new Set(s.candidates.map(c => c.key)).size, 3);
    const png = await fs.readFile(path.join(__dirname, '04-evidence/reference.png'));
    await page.getByLabel('选择导入参考图', { exact: true }).setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: png });
    await eventually(async () => (await state(first)).references[0]?.reference);
    await page.getByLabel('选择导入参考图', { exact: true }).setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: png });
    await eventually(async () => (await state(first)).references.length === 2);
    let row = page.getByRole('article', { name: '条目 P01-A First', exact: true });
    await row.getByRole('button', { name: '修正此条', exact: true }).click();
    await row.getByLabel('目标尺寸', { exact: true }).fill('1600x1600');
    await row.getByRole('button', { name: '保存并校验', exact: true }).click();
    await eventually(async () => (await state(first)).candidates[0].config.size === '1600x1600');
    row = page.getByRole('article', { name: '条目 P01-A Second', exact: true });
    await row.getByRole('button', { name: '修正此条', exact: true }).click();
    await row.getByLabel('文档标识', { exact: true }).fill('P01-B');
    await row.getByRole('button', { name: '保存并校验', exact: true }).click();
    await eventually(async () => (await state(first)).candidates[1].status === 'pending');
    s = await state(first);
    assert.deepEqual(s.candidates.map(c => c.status), ['ready', 'pending', 'error']);
    assert.equal(s.candidates[0].config.document_id, 'P01-A');
    assert.equal(s.candidates[0].config.prompt, 'Keep 无需生成 inside the actual prompt.');
    await page.getByRole('article', { name: '条目 P01-B Second', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'one-ready-one-uploading.png') });
    releaseUpload();
    await eventually(async () => (await state(first)).candidates[1].status === 'ready');
    row = page.getByRole('article', { name: '条目 SUB99 Invalid', exact: true });
    await row.getByRole('button', { name: '跳过此条', exact: true }).click();
    await eventually(async () => (await state(first)).candidates[2].skipped);
    assert.equal((await state(first)).candidates[2].status, 'error');

    // A different browser edits while this form is open: no stale overwrite.
    row = page.getByRole('article', { name: '条目 P01-A First', exact: true });
    await row.getByRole('button', { name: '修正此条', exact: true }).click();
    await row.getByLabel('Prompt', { exact: true }).fill('local attempted stale change');
    s = await state(first);
    const change = await first.request.patch(`${origin}/api/image-imports/candidates/${s.candidates[0].key}`, {
      headers, data: { request_id: 'other-browser-edit', version: s.version, md_version: s.md_version, changes: { name: 'New remote name' } },
    });
    assert.equal(change.status(), 200);
    await row.getByRole('button', { name: '保存并校验', exact: true }).click();
    row = page.getByRole('article', { name: '条目 P01-A New remote name', exact: true });
    await row.getByRole('alert').waitFor();
    assert((await row.getByRole('alert').innerText()).includes('版本冲突'));
    assert.equal((await state(first)).candidates[0].config.prompt, 'Keep 无需生成 inside the actual prompt.');
    await row.getByRole('button', { name: '重新载入此条', exact: true }).click();
    await row.getByLabel('Prompt', { exact: true }).fill('Confirmed corrected prompt');
    await row.getByRole('button', { name: '保存并校验', exact: true }).click();
    await eventually(async () => (await state(first)).candidates[0].config.prompt === 'Confirmed corrected prompt');

    for (const viewport of [{ width: 390, height: 600 }, { width: 320, height: 360 }]) {
      await page.setViewportSize(viewport);
      const dialog = page.getByRole('dialog').first();
      await eventually(async () => { const b = await dialog.boundingBox(); return b.x >= 0 && b.y >= 0 && b.x + b.width <= viewport.width + 1 && b.y + b.height <= viewport.height + 1; });
      row = page.getByRole('article', { name: '条目 SUB99 Invalid', exact: true });
      await row.getByRole('button', { name: '修正此条', exact: true }).click();
      await row.getByLabel('目标尺寸', { exact: true }).fill('640x480');
      await row.getByLabel('Prompt', { exact: true }).fill('narrow viewport correction');
      if (viewport.width === 390) {
        await row.getByLabel('参考图声明', { exact: true }).selectOption('files');
        await row.getByRole('button', { name: '保存并校验', exact: true }).click();
        await eventually(async () => (await state(first)).candidates[2].config.prompt === 'narrow viewport correction');
        assert.equal((await state(first)).candidates[2].status, 'error');
        assert.equal((await state(first)).candidates[2].config.reference_names, null);
        await row.getByRole('button', { name: '修正此条', exact: true }).click();
      }
      await row.getByLabel('参考图声明', { exact: true }).selectOption('none');
      await row.getByRole('button', { name: '保存并校验', exact: true }).scrollIntoViewIfNeeded();
      const submit = await row.getByRole('button', { name: '保存并校验', exact: true }).boundingBox();
      assert(submit.y >= 0 && submit.y + submit.height <= viewport.height);
      await page.screenshot({ path: path.join(output, `correction-${viewport.width}.png`) });
      await row.getByRole('button', { name: '保存并校验', exact: true }).click();
      await eventually(async () => (await state(first)).candidates[2].status === 'ready');
      for (const name of ['刷新素材', '清除上传内容', '完成']) {
        const b = await page.getByRole('button', { name, exact: true }).boundingBox();
        assert(b.y >= 0 && b.y + b.height <= viewport.height, name);
      }
      assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    }
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.reload(); await open(page);
    await page.getByRole('article', { name: '条目 P01-A New remote name', exact: true }).waitFor();
    const second = await context(), page2 = await second.newPage();
    await login(page2); await open(page2);
    await page2.getByRole('article', { name: '条目 P01-A New remote name', exact: true }).waitFor();
    assert.equal((await state(second)).candidates[2].skipped, true);
    await page2.screenshot({ path: path.join(output, 'second-browser-restored.png') });
    const third = await context(), page3 = await third.newPage();
    await login(page3, 'B'); await open(page3);
    assert.equal(await page3.getByRole('article').count(), 0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const oldKey = (await state(first)).candidates[0].key;
    await md(page, synthetic);
    await eventually(async () => (await state(first)).candidates[0].key !== oldKey);
    s = await state(first);
    assert.equal(s.candidates[0].config.name, 'First');
    assert.equal(s.candidates[0].config.size, '');
    assert.equal(s.candidates[2].skipped, false);
    assert.equal(s.references.length, 2);
    assert.equal((await (await first.request.get(`${origin}/ticket07-consumption`)).json()).count, 0);
    assert.equal(errors.length, 0, errors.join('\n'));
    await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, metrics, errors, consumption: 0 }, null, 2));
    console.log(JSON.stringify({ passed: true, metrics, errors, consumption: 0 }, null, 2));
  } finally { releaseUpload(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
