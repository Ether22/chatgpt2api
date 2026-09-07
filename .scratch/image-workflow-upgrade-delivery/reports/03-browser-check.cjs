// Run against 03-browser-server.py after building web/out. All data is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const origin = 'http://127.0.0.1:43130';
const output = path.join(__dirname, '03-evidence');
const headers = key => ({ Authorization: `Bearer ticket03-${key}` });

async function login(page, key) {
  await page.goto(`${origin}/login/`);
  await page.getByLabel('密钥', { exact: true }).fill(`ticket03-${key}`);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/accounts/');
  await page.goto(`${origin}/image/`);
  await page.getByRole('button', { name: /^自动 · / }).waitFor();
}

async function history(context, key = 'A') {
  const response = await context.request.get(`${origin}/api/image-conversations`, { headers: headers(key) });
  assert.equal(response.status(), 200);
  return response.json();
}

async function setCount(page, value) {
  await page.getByRole('button', { name: /^自动 · / }).click();
  await page.getByLabel('生成数量', { exact: true }).fill(value);
  await page.getByRole('button', { name: /^自动 · / }).click();
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const contexts = [];
  const errors = [];
  const submissions = [];
  const protectedReads = [];
  const timings = {};
  async function newContext() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    contexts.push(context);
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    context.on('page', page => {
      page.setDefaultTimeout(30000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (request.method() === 'POST' && request.url().endsWith('/api/image-conversations/turns')) submissions.push(request.postDataJSON());
        if (/\/(images|image-thumbnails)\/managed\//.test(request.url())) protectedReads.push({ url: request.url(), authorized: !!request.headers().authorization });
      });
    });
    return context;
  }
  let page;
  try {
    const first = await newContext();
    page = await first.newPage();
    await page.goto(`${origin}/version`);
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('chatgpt2api', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('auth'); request.result.createObjectStore('image_conversations'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const tx = database.transaction('image_conversations', 'readwrite');
        tx.objectStore('image_conversations').put([{ id: 'legacy-only', title: 'OLD LOCAL HISTORY MUST NOT MIGRATE', turns: [] }], 'items');
        tx.oncomplete = () => { database.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }));
    await login(page, 'A');
    assert.match(await page.getByRole('button', { name: /^自动 · / }).textContent(), / · 4 张$/);
    assert.equal(await page.getByText('OLD LOCAL HISTORY MUST NOT MIGRATE').count(), 0);
    assert.equal((await history(first)).items.length, 0);
    await page.getByText('剩余额度', { exact: true }).waitFor();
    assert.match(await page.getByText('剩余额度', { exact: true }).locator('..').textContent(), /剩余额度\s*3$/);
    console.log('PASS default four; old IndexedDB history ignored; only normal healthy quota counted');

    const prompt = ['服务器会话恢复验收。', '第二行：合成图，不调用真实上游。', '第三行：保持提交配置。', '第四行：图片按行排序。', '第五行：跨浏览器可见。', '第六行：身份隔离。'].join('\n');
    await page.locator('textarea').fill(prompt);
    await page.getByRole('button', { name: '生成图片', exact: true }).click();
    await page.getByText('结果 4', { exact: true }).waitFor();
    await page.getByText('结果 4', { exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Generated result 4', exact: true }).waitFor();
    assert.equal(submissions.length, 1, 'One complete round submission, not one request per image');
    assert.equal(submissions[0].count, 4);
    const firstHistory = await history(first);
    const conversationId = firstHistory.current_conversation_id;
    const firstTurn = firstHistory.items[0].turns[0];
    assert.equal(firstTurn.images.length, 4);
    assert.ok(firstTurn.images.every(image => image.status === 'success' && !image.b64_json));
    const imageUrl = firstTurn.images[0].url;
    const text = page.getByText(prompt, { exact: true });
    assert.ok(await text.evaluate(element => element.clientHeight <= parseFloat(getComputedStyle(element).lineHeight) * 2.1));
    await page.getByRole('button', { name: '展开 Prompt', exact: true }).click();
    assert.ok(await text.evaluate(element => element.clientHeight >= parseFloat(getComputedStyle(element).lineHeight) * 6));
    await page.getByRole('button', { name: '收起 Prompt', exact: true }).click();
    for (const [width, height, columns] of [[1440, 1400, 3], [1000, 1200, 2], [600, 1100, 3], [390, 844, 3]]) {
      await page.setViewportSize({ width, height });
      await page.getByText('结果 4', { exact: true }).scrollIntoViewIfNeeded();
      const tiles = page.getByRole('button', { name: /^Generated result [1-4]$/ });
      await page.waitForFunction(() => [...document.querySelectorAll('img[alt^="Generated result"]')].every(img => img.complete && img.naturalWidth > 0));
      const boxes = await tiles.evaluateAll(elements => elements.map(element => ({ name: element.querySelector('img').alt, x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y })));
      assert.equal(boxes.length, 4);
      assert.equal(boxes.filter(box => Math.abs(box.y - boxes[0].y) < 2).length, columns);
      assert.deepEqual([...boxes].sort((a, b) => Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y).map(box => box.name), ['Generated result 1', 'Generated result 2', 'Generated result 3', 'Generated result 4']);
      await page.screenshot({ path: path.join(output, `restored-${width}.png`) });
    }
    console.log('PASS four saved results, prompt collapse, authorized image pixels and four responsive widths');

    const second = await newContext();
    const secondPage = await second.newPage();
    await login(secondPage, 'A');
    await secondPage.getByText(prompt, { exact: true }).waitFor();
    await secondPage.getByRole('button', { name: 'Generated result 4', exact: true }).waitFor();
    assert.equal((await history(second)).current_conversation_id, conversationId);
    await secondPage.screenshot({ path: path.join(output, 'second-browser.png') });
    console.log('PASS independent browser restores same current conversation and results');

    for (const count of ['1', '100']) {
      await secondPage.getByRole('button', { name: '新建对话', exact: true }).click();
      await secondPage.getByRole('heading', { name: 'Turn ideas into images' }).waitFor();
      await setCount(secondPage, count);
      await secondPage.locator('textarea').fill(`服务器数量边界 ${count}`);
      const before = submissions.length;
      const started = Date.now();
      await secondPage.getByRole('button', { name: '生成图片', exact: true }).click();
      if (count === '100') await secondPage.locator('textarea').fill('生成期间仍可输入，不应被保存响应清空');
      await secondPage.getByText(`结果 ${count}`, { exact: true }).waitFor();
      await secondPage.getByText(`结果 ${count}`, { exact: true }).scrollIntoViewIfNeeded();
      await secondPage.getByRole('button', { name: `Generated result ${count}`, exact: true }).waitFor();
      await secondPage.getByText('已完成', { exact: true }).last().waitFor();
      const saved = await history(second);
      const turn = saved.items.find(item => item.id === saved.current_conversation_id).turns[0];
      assert.equal(turn.images.length, Number(count));
      assert.ok(turn.images.every(image => image.status === 'success'), JSON.stringify(turn.images.filter(image => image.status !== 'success')));
      assert.equal(submissions.length - before, 1);
      if (count === '100') assert.equal(await secondPage.locator('textarea').inputValue(), '生成期间仍可输入，不应被保存响应清空');
      timings[count] = Date.now() - started;
      await secondPage.screenshot({ path: path.join(output, `count-${count}.png`) });
    }
    console.log(`PASS one and all 100 results with responsive input: ${JSON.stringify(timings)}`);

    await secondPage.setViewportSize({ width: 1440, height: 1100 });
    const downloadEvent = secondPage.waitForEvent('download');
    await secondPage.getByRole('button', { name: '下载', exact: true }).last().click();
    const download = await downloadEvent;
    assert.equal((await fs.readFile(await download.path())).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await secondPage.goto(`${origin}/image-manager/`);
    await secondPage.waitForFunction(() => [...document.querySelectorAll('img')].some(img => img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0));
    await secondPage.screenshot({ path: path.join(output, 'private-gallery.png') });
    console.log('PASS original download and authenticated gallery thumbnails');

    await secondPage.goto(`${origin}/image/`);
    await secondPage.getByRole('button', { name: 'Generated result 100', exact: true }).waitFor();
    const oldBlob = await secondPage.locator('img[alt^="Generated result"]').last().getAttribute('src');
    await secondPage.getByRole('button', { name: '退出', exact: true }).click();
    await secondPage.waitForURL('**/login/');
    await login(secondPage, 'B');
    assert.equal((await history(second, 'B')).items.length, 0);
    assert.equal(await secondPage.getByRole('button', { name: /^Generated result / }).count(), 0);
    assert.equal(await secondPage.getByText(prompt, { exact: true }).count(), 0);
    assert.equal((await second.request.get(imageUrl, { headers: headers('B') })).status(), 404);
    assert.equal((await second.request.get(imageUrl)).status(), 401);
    if (oldBlob) assert.equal(await secondPage.evaluate(src => fetch(src).then(() => true, () => false), oldBlob), false);
    await secondPage.screenshot({ path: path.join(output, 'identity-B-empty.png') });
    console.log('PASS logout A/login B clears history and revokes loaded Blob URLs');

    const reference = { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') };
    await setCount(secondPage, '1');
    await secondPage.locator('input[type=file]').setInputFiles(reference);
    await secondPage.getByRole('button', { name: '预览参考图 reference.png', exact: true }).waitFor();
    await secondPage.locator('textarea').fill('普通参考图入口保持可用');
    await secondPage.getByRole('button', { name: '编辑图片', exact: true }).click();
    await secondPage.getByRole('button', { name: 'Generated result 1', exact: true }).waitFor();
    const edited = (await history(second, 'B')).items[0].turns[0];
    assert.equal(edited.mode, 'edit');
    assert.equal(edited.referenceImages[0].name, 'reference.png');
    console.log('PASS existing ordinary reference-image entry');
    assert.ok(protectedReads.length > 0 && protectedReads.every(item => item.authorized), 'All page-managed image requests carry authorization');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ timings, submissions: submissions.length, protectedReads: protectedReads.length, pageErrors: errors }, null, 2));
    console.log('PASS ticket 03 browser acceptance');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
