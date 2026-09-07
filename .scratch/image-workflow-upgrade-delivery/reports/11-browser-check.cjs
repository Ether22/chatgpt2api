const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43210';
const output = path.join(__dirname, '11-evidence');
const headers = { Authorization: 'Bearer ticket11-A' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(80); }
  throw Error(`Timeout: ${label}`);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const contexts = [];
  const errors = [];
  const metrics = {};
  const login = async (viewport = { width: 1440, height: 1000 }, key = 'ticket11-A') => {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    contexts.push(context);
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/login/`);
    await page.getByLabel('密钥', { exact: true }).fill(key);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/accounts/');
    await page.goto(`${origin}/image/`);
    return { context, page };
  };
  const { context, page } = await login();
  const get = async route => {
    const response = await context.request.get(origin + route, { headers });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  const post = async (route, data = {}) => {
    const response = await context.request.post(origin + route, { headers, data });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  const state = () => get('/ticket11/state');
  const seed = async data => { await post('/ticket11/seed', data); await page.reload(); };
  const confirm = () => page.getByRole('button', { name: '确认删除', exact: true }).click();
  const realImage = () => eventually(() => page.locator('img[alt^="Generated result"]').evaluateAll(images => images.some(image => image.complete && image.naturalWidth === 480)), 'decoded real generated PNG');
  const clean = async expected => {
    await eventually(async () => (await get('/api/image-cleanups')).stats.complete === expected, `cleanup complete ${expected}`, 120000);
  };
  try {
    await seed({ count: 6 });
    await realImage();
    const observer = await login({ width: 1120, height: 800 });
    await observer.page.locator('img[alt^="Generated result"]').first().waitFor();
    const first = await get('/api/image-conversations/a-0');
    const firstPaths = first.turns[0].images.map(image => new URL(image.url, origin).pathname.slice('/images/'.length));
    await page.getByRole('button', { name: '删除提示词记录', exact: true }).click();
    await confirm();
    await eventually(async () => (await get('/api/image-conversations/a-0')).turns[0].promptDeleted === true, 'prompt visibility committed');
    await realImage();
    assert.equal((await state()).local.length, 8);
    await page.getByRole('button', { name: '删除生成结果', exact: true }).click();
    assert.match(await page.getByRole('dialog').innerText(), /本轮全部生成结果/);
    let started = performance.now();
    await confirm();
    await eventually(async () => await page.getByRole('button', { name: '删除生成结果', exact: true }).count() === 0, 'turn disappears');
    metrics.turn_ui_ms = Math.round(performance.now() - started);
    await clean(3);
    await eventually(async () => await observer.page.locator('img[alt^="Generated result"]').count() === 0, 'second browser turn deletion');
    const afterTurn = await state();
    for (const rel of firstPaths) {
      assert(!afterTurn.local.includes(rel));
      assert(!afterTurn.thumbnails.includes(rel));
      assert(!afterTurn.thumbnails.includes(`${rel}.png`));
      assert(!afterTurn.tags[rel]);
    }
    assert((await get('/api/image-conversations/a-0')).turns[0].prompt.includes('Fixture'));
    await page.getByRole('button', { name: /Scope gallery a-1/ }).click();
    await realImage();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载', exact: true }).first().click();
    const original = await download;
    await original.saveAs(path.join(output, original.suggestedFilename()));
    assert((await fs.readFile(path.join(output, original.suggestedFilename()))).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    await observer.page.getByRole('button', { name: /Scope gallery a-1/ }).click();
    await observer.page.locator('img[alt^="Generated result"]').first().waitFor();
    const row = page.getByRole('button', { name: /Scope gallery a-1/ }).locator('..');
    await row.getByRole('button', { name: '删除会话', exact: true }).click();
    assert.match(await page.getByRole('dialog').innerText(), /仅删除这条会话/);
    await confirm();
    await clean(6);
    await eventually(async () => await observer.page.getByRole('button', { name: /Scope gallery a-1/ }).count() === 0, 'second browser deleted-conversation 404 recovery');
    assert.equal((await get('/api/image-conversations')).items.length, 1);
    assert.equal((await get('/api/image-references')).items.length, 1);
    await page.screenshot({ path: path.join(output, 'scope-deleted-desktop.png'), fullPage: true });

    // Hold a real old detail response across confirmation; it must never recreate the deleted conversation.
    await seed({ count: 6 });
    await realImage();
    await page.getByRole('button', { name: /Scope gallery a-1/ }).click();
    await eventually(async () => (await get('/api/image-conversations')).current_conversation_id === 'a-1', 'switch before stale detail');
    await page.getByRole('button', { name: '删除生成结果', exact: true }).waitFor();
    let releaseOld;
    let oldCaptured;
    const oldReady = new Promise(resolve => oldCaptured = resolve);
    const oldGate = new Promise(resolve => releaseOld = resolve);
    let armed = true;
    await page.route('**/api/image-conversations/a-0?*', async route => {
      const response = await route.fetch();
      if (armed) { armed = false; oldCaptured(); await oldGate; }
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: /Scope gallery a-0/ }).click();
    await oldReady;
    await page.getByRole('button', { name: /Scope gallery a-0/ }).locator('..').getByRole('button', { name: '删除会话', exact: true }).click();
    await confirm();
    releaseOld();
    await clean(3);
    await pause(800);
    assert.equal(await page.getByRole('button', { name: /Scope gallery a-0/ }).count(), 0);
    await page.unroute('**/api/image-conversations/a-0?*');
    metrics.old_response_suppressed = true;

    await seed({ count: 6, mode: 'both' });
    await realImage();
    await post('/ticket11/control', { delay: 2, fail: 'a-0-turn-0-1' });
    await page.getByRole('button', { name: /Scope gallery a-0/ }).locator('..').getByRole('button', { name: '删除会话', exact: true }).click();
    started = performance.now();
    await confirm();
    await eventually(async () => await page.getByRole('button', { name: /Scope gallery a-0/ }).count() === 0, 'slow remote immediate hide');
    metrics.remote_ui_ms = Math.round(performance.now() - started);
    await page.getByRole('button', { name: /^删除清理/ }).click();
    await eventually(async () => (await page.getByRole('dialog').innerText()).includes('等待 3'), 'visible pending jobs');
    await page.screenshot({ path: path.join(output, 'remote-pending.png'), fullPage: true });
    await eventually(async () => (await get('/api/image-cleanups')).stats.error === 1, 'partial remote failure');
    await clean(2);
    await post('/ticket11/restart');
    await page.reload();
    await page.setViewportSize({ width: 390, height: 700 });
    await page.getByRole('button', { name: /^删除清理/ }).click();
    await eventually(async () => (await page.getByRole('dialog').innerText()).includes('受控 WebDAV 目标副本暂时不可用'), 'durable visible reason after restart');
    await page.screenshot({ path: path.join(output, 'remote-failure-narrow.png'), fullPage: true });
    await post('/ticket11/control', { delay: 0, fail: '' });
    await page.getByRole('button', { name: '重试清理', exact: true }).click();
    await clean(3);
    assert.equal((await state()).remote_deletes.filter(rel => rel.includes('/a-0-')).length, 4);
    assert.equal((await state()).consumed, 0);
    await page.keyboard.press('Escape');

    // A deleted sent task remains a visible job while the real result is held outside the server.
    await seed({ count: 6 });
    await post('/ticket11/control', { hold: true });
    const late = await post('/api/image-conversations/turns', { request_id: 'browser-late', conversation_id: 'a-0', prompt: 'Late controlled task', model: 'gpt-image-2', count: 1 });
    await eventually(async () => (await state()).consumed === 1, 'upstream sent');
    await page.reload();
    await page.getByRole('button', { name: '清空当前身份全部历史', exact: true }).last().click();
    await confirm();
    await post('/ticket11/control', { hold: false });
    await clean(7);
    assert.equal((await state()).local.length, 2);
    assert.equal((await state()).consumed, 1);
    await page.getByRole('button', { name: /^删除清理/ }).click();
    await eventually(async () => (await page.getByRole('dialog').innerText()).includes('完成 7'), 'late cleanup summary after all history gone');
    await page.screenshot({ path: path.join(output, 'late-cleaned-narrow.png'), fullPage: true });
    await page.keyboard.press('Escape');

    // A real stored PNG survives a refused data checkpoint and failed unlink, but is never readable.
    await seed({ count: 6 });
    await post('/ticket11/control', { hold: true });
    const faultTurn = await post('/api/image-conversations/turns', { request_id: 'browser-fault', conversation_id: 'a-0', prompt: 'Late checkpoint fault', model: 'gpt-image-2', count: 1 });
    await eventually(async () => (await state()).consumed === 1, 'fault upstream sent');
    await page.reload();
    const faultDeletion = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url() === `${origin}/api/image-conversations`);
    await page.getByRole('button', { name: '清空当前身份全部历史', exact: true }).last().click();
    await confirm();
    assert.equal((await faultDeletion).status(), 200);
    await clean(6);
    await post('/ticket11/control', { hold: false, data_failure: true, unlink_failure: true });
    await eventually(async () => (await get('/api/image-cleanups')).stats.error > 0, 'checkpoint failure visible');
    await page.getByRole('button', { name: /^删除清理/ }).click();
    await eventually(async () => (await page.getByRole('dialog').innerText()).includes('受控迟到结果检查点写入失败'), 'actual checkpoint reason');
    await page.screenshot({ path: path.join(output, 'late-checkpoint-failure.png'), fullPage: true });
    await post('/ticket11/control', { data_failure: false, unlink_failure: false });
    await post('/ticket11/restart');
    await eventually(async () => (await state()).local.length === 2, 'restart cleans durable intended path');
    assert.equal((await state()).consumed, 1);
    await page.keyboard.press('Escape');

    // 3,200 distinct real originals, both thumbnail layouts and tags; unrelated owner/input remain.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await seed({ count: 3200 });
    await realImage();
    const before = await state();
    assert.equal(before.local.length, 3202);
    assert(before.thumbnails.length >= 6402);
    await post('/ticket11/measure');
    await page.getByRole('button', { name: '清空当前身份全部历史', exact: true }).first().click();
    assert.match(await page.getByRole('dialog').innerText(), /当前登录身份的全部会话/);
    const response = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url() === `${origin}/api/image-conversations`);
    started = performance.now();
    await confirm();
    await eventually(async () => await page.locator('img[alt^="Generated result"]').count() === 0, '3200 immediate UI');
    metrics.bulk_ui_ms = Math.round(performance.now() - started);
    assert.equal((await response).status(), 200);
    metrics.bulk_http_ms = Math.round(performance.now() - started);
    await clean(3200);
    metrics.bulk_total_ms = Math.round(performance.now() - started);
    const after = await state();
    const targets = before.local.filter(rel => !rel.includes('/references/') && !rel.includes('/b-0-'));
    assert.equal(targets.length, 3200);
    for (const rel of targets) {
      assert(!after.local.includes(rel)); assert(!after.remote.includes(rel)); assert(!after.tags[rel]);
      assert(!after.thumbnails.includes(rel)); assert(!after.thumbnails.includes(`${rel}.png`));
    }
    assert.equal(after.local.length, 2);
    assert.equal(after.consumed, 0);
    assert.equal(after.metrics.holder_builds, 2);
    assert.equal(after.metrics.directory_scans, 0);
    metrics.bulk_backend = after.metrics;
    metrics.bulk_files_gone = targets.length;
    await page.getByRole('button', { name: /^删除清理/ }).click();
    await eventually(async () => (await page.getByRole('dialog').innerText()).includes('完成 3200'), 'large cleanup completion UI');
    await page.screenshot({ path: path.join(output, '3200-complete.png'), fullPage: true });
    assert.deepEqual(errors, []);
    metrics.page_errors = errors;
    await fs.writeFile(path.join(output, 'browser.json'), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify(metrics, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
