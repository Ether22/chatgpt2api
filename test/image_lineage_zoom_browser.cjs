// Run against image_followup_browser_server.py in the isolated workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43280', headers = { Authorization: 'Bearer ticket08-A' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = 'state') { for (let n = 0; n < 220; n++) { if (await check()) return; await pause(60); } throw Error(`Timed out: ${label}`); }
(async () => {
  const output = path.resolve('.scratch/ui-lineage-zoom/evidence'); await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const api = async (url, data, method = 'POST') => {
      const response = await context.request.fetch(origin + url, { method, headers, data });
      assert.equal(response.status(), 200, await response.text()); return response.json();
    };
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    const conversation = await api('/api/image-conversations', { request_id: `lineage-${Date.now()}` });
    const cid = conversation.id;
    const create = async (prompt, extra = {}) => {
      const saved = await api('/api/image-conversations/turns', { request_id: `${prompt}-${Date.now()}`, conversation_id: cid, prompt, count: 1, ...extra });
      return saved.turns.at(-1);
    };
    const a = await create('来源 A'), b = await create('来源 B');
    await create('A 第二次', { source_turn_id: a.id });
    const imports = await api('/api/image-imports', undefined, 'GET');
    const uploaded = await context.request.put(origin + '/api/image-imports/md', { headers, multipart: {
      request_id: `zoom-md-${Date.now()}`, version: String(imports.version),
      file: { name: 'zoom.md', mimeType: 'text/markdown', buffer: Buffer.from('## [ZOOM-01] 来源 MD｜800x600\n参考图：无\nPrompt: MD 来源') },
    } });
    assert.equal(uploaded.status(), 200, await uploaded.text()); const state = await uploaded.json();
    const batch = await api('/api/image-imports/batches', { request_id: `zoom-batch-${Date.now()}`, conversation_id: cid,
      version: state.version, md_version: state.md_version, model: 'gpt-image-2', count: 1, entries: [{ key: state.candidates[0].key }] });
    const m = batch.turns.at(-1);
    for (let n = 0; n < 7; n++) await create(`独立来源 ${n}`);
    await create('A 第三次', { source_turn_id: a.id });
    await create('MD 第二次', { source_turn_id: m.id });
    const finished = async () => { const { stats } = await api(`/api/image-conversations/${cid}/metadata`, undefined, 'GET'); return stats.running + stats.queued === 0; };
    await until(finished, 'synthetic rounds finished');
    const readAll = async () => {
      const turns = []; let offset = 0;
      while (offset !== null) { const next = await api(`/api/image-conversations/${cid}?offset=${offset}&limit=10`, undefined, 'GET'); turns.push(...next.turns); offset = next.pagination.next_offset; }
      return turns;
    };
    const expectedOrder = turns => {
      const groups = new Map();
      for (const turn of turns) { if (!groups.has(turn.sourceEntryId)) groups.set(turn.sourceEntryId, []); groups.get(turn.sourceEntryId).push(turn.id); }
      return [...groups.values()].flat();
    };
    let turns = await readAll(); assert(turns.length > 10);
    await api('/api/image-conversations/current', { conversation_id: cid }, 'PUT');
    await page.goto(origin + '/login/'); await page.getByLabel('密钥', { exact: true }).fill('ticket08-A');
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/accounts/');
    await page.goto(origin + '/image/');
    const order = () => page.locator('[data-turn-id]').evaluateAll(nodes => nodes.map(node => node.dataset.turnId));
    await until(async () => (await order()).length === turns.length);
    assert.deepEqual(await order(), expectedOrder(turns), 'ordinary and MD repeats group across all pages');
    const first = page.locator(`[data-turn-id="${a.id}"]`), reading = page.locator(`[data-turn-id="${b.id}"]`);
    assert(await first.getByText('第 1 次', { exact: true }).isVisible() || await first.getByText('第 1 次', { exact: true }).count());
    assert.equal(await page.getByText('初次生成', { exact: true }).count(), 0);
    let releaseSubmission, submitted;
    await context.route('**/api/image-conversations/turns', async route => {
      submitted = route.request().postDataJSON();
      await new Promise(resolve => { releaseSubmission = resolve; });
      await route.continue();
    });
    await first.getByRole('button', { name: '重新生成', exact: true }).click();
    await until(() => !!releaseSubmission); assert.equal(submitted.source_turn_id, a.id);
    await reading.evaluate(node => node.scrollIntoView({ block: 'start' }));
    await until(() => reading.locator('img').evaluateAll(nodes => nodes.length && nodes.every(img => img.complete)), 'reading image loaded');
    await reading.evaluate(node => node.scrollIntoView({ block: 'start' }));
    await pause(350);
    const readingTop = () => reading.evaluate(node => node.getBoundingClientRect().top - node.closest('.image-result-panel').getBoundingClientRect().top);
    const before = await readingTop(); releaseSubmission();
    await until(async () => (await order()).length === turns.length + 1, 'new repeat inserted');
    await until(finished);
    await until(async () => await page.locator('[data-turn-id]').getByText('已完成', { exact: true }).count() === (turns.length + 1) * 2, 'completion reached the rendered list');
    turns = await readAll();
    assert.deepEqual(await order(), expectedOrder(turns));
    assert(Math.abs(await readingTop() - before) <= 3, 'new repeat and image completion preserve the reader anchor');
    const latestId = turns.at(-1).id;
    const newRound = page.locator(`[data-turn-id="${latestId}"]`);
    assert.equal(await newRound.getByText('第 4 次', { exact: true }).count(), 1);
    await page.screenshot({ path: path.join(output, 'reading-position.png') });
    await context.unroute('**/api/image-conversations/turns');
    await page.reload(); await until(async () => (await order()).length === turns.length);
    assert.deepEqual(await order(), expectedOrder(turns), 'grouping survives reload');
    await page.locator('[data-turn-id]').last().evaluate(node => node.scrollIntoView({ block: 'start' })); await pause(100);
    await page.getByRole('button', { name: '滚动到最新消息', exact: true }).click();
    await until(() => newRound.evaluate(node => Math.abs(node.getBoundingClientRect().top - node.closest('.image-result-panel').getBoundingClientRect().top) < 5), 'latest button finds inserted round');
    await page.screenshot({ path: path.join(output, 'latest-in-source.png') });
    await first.locator('[data-image-frame]').scrollIntoViewIfNeeded();
    await first.locator('[data-image-frame] button').click();
    const viewer = page.getByRole('dialog', { name: '图片预览', exact: true }), reset = viewer.getByRole('button', { name: '重置缩放', exact: true });
    await until(() => viewer.getByRole('button', { name: '下载图片' }).isEnabled());
    const transform = () => viewer.locator('img').evaluate(img => { const m = new DOMMatrix(getComputedStyle(img).transform); return { scale: m.a, x: m.e, y: m.f, width: img.offsetWidth, height: img.offsetHeight }; });
    const canvas = await viewer.locator('[data-image-canvas]').boundingBox();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.wheel(0, 3000); await pause(200); assert.equal(await reset.innerText(), '100%');
    await page.mouse.move(canvas.x + canvas.width / 2 + 20, canvas.y + canvas.height / 2 + 10);
    await page.mouse.wheel(0, -400); await until(async () => Number((await reset.innerText()).replace('%', '')) > 100);
    await pause(180); const zoomed = await transform(); assert(zoomed.scale > 1 && zoomed.scale < 4);
    assert(Math.abs(zoomed.x + 20 * (zoomed.scale - 1)) < 2 && Math.abs(zoomed.y + 10 * (zoomed.scale - 1)) < 2, 'wheel keeps the point beneath the mouse fixed');
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2); await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width / 2 + 65, canvas.y + canvas.height / 2 + 40, { steps: 6 }); await page.mouse.up();
    await pause(180); const panned = await transform(); assert(panned.x - zoomed.x > 30 && panned.y - zoomed.y > 15);
    assert(await viewer.isVisible(), 'drag release does not close preview');
    await page.mouse.move(100, 100); await pause(80); assert.deepEqual(await transform(), panned, 'mouse release ends dragging');
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2); await page.mouse.wheel(0, -5000);
    await until(async () => await reset.innerText() === '400%');
    await page.mouse.down(); await page.mouse.move(3000, 2000, { steps: 8 }); await page.mouse.up(); await pause(180);
    const limited = await transform(); assert(Math.abs(limited.x) <= limited.width * 1.5 + 1 && Math.abs(limited.y) <= limited.height * 1.5 + 1, 'pan is bounded by image dimensions');
    await page.screenshot({ path: path.join(output, 'zoom-pan.png') });
    await reset.click(); await pause(180); assert.deepEqual(await transform(), { scale: 1, x: 0, y: 0, width: limited.width, height: limited.height });
    const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + 20, cy + 10); await pause(80);
    assert.equal((await transform()).scale, 1); assert.equal((await transform()).x, 0);
    await page.mouse.wheel(0, -400);
    await until(async () => (await transform()).scale > 2, 'zoom while holding from 100%');
    const heldZoom = await transform();
    assert(Math.abs(heldZoom.x + 20 * (heldZoom.scale - 1)) < 2 && Math.abs(heldZoom.y + 10 * (heldZoom.scale - 1)) < 2, 'held wheel preserves mouse focal point');
    await page.mouse.move(cx + 45, cy + 25, { steps: 3 }); await pause(80);
    const heldPan = await transform();
    assert.equal(heldPan.scale, heldZoom.scale, 'continued drag keeps the new scale');
    assert(Math.abs(heldPan.x - heldZoom.x - 25) < 2 && Math.abs(heldPan.y - heldZoom.y - 15) < 2, 'continued drag starts at the wheel position without jumping');
    await page.mouse.wheel(0, 5000); await until(async () => (await transform()).scale === 1);
    assert.equal((await transform()).x, 0); assert.equal((await transform()).y, 0);
    await page.mouse.wheel(0, -300); await until(async () => (await transform()).scale > 1.5);
    const rezoomed = await transform();
    await page.mouse.move(cx + 60, cy + 35, { steps: 3 }); await page.mouse.up(); await pause(180);
    const continued = await transform(); assert.equal(continued.scale, rezoomed.scale);
    assert(Math.abs(continued.x - rezoomed.x - 15) < 2 && Math.abs(continued.y - rezoomed.y - 10) < 2, 'shrink and rezoom continue in the same held drag');
    await page.mouse.move(cx, cy); await pause(80); assert.deepEqual(await transform(), continued, 'release ends simultaneous drag and zoom');
    await reset.click(); await pause(180);
    await viewer.locator('img').dblclick(); await until(async () => await reset.innerText() === '250%');
    await viewer.locator('img').dblclick(); await until(async () => await reset.innerText() === '100%');
    await page.mouse.move(canvas.width / 2, canvas.height / 2); await page.mouse.wheel(0, -400); await pause(180);
    await page.mouse.wheel(0, 5000); await until(async () => await reset.innerText() === '100%'); await pause(180);
    assert.equal((await transform()).x, 0); assert.equal((await transform()).y, 0);
    await page.mouse.wheel(0, -300); await pause(180);
    await viewer.getByRole('button', { name: '关闭', exact: true }).click();
    await first.locator('[data-image-frame] button').click(); await until(() => viewer.getByRole('button', { name: '下载图片' }).isEnabled());
    assert.equal(await reset.innerText(), '100%');
    await page.setViewportSize({ width: 320, height: 360 }); await pause(100);
    const toolbar = await viewer.getByRole('button', { name: '关闭', exact: true }).locator('../..').boundingBox();
    assert(toolbar.x >= 0 && toolbar.x + toolbar.width <= 320 && toolbar.y >= 0 && toolbar.y + toolbar.height <= 360);
    const touch = await context.newCDPSession(page), mobileImage = await viewer.locator('img').boundingBox();
    const touchX = mobileImage.x + mobileImage.width / 2, touchY = mobileImage.y + mobileImage.height / 2;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX - 20, y: touchY, id: 1 }, { x: touchX + 20, y: touchY, id: 2 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchX - 40, y: touchY, id: 1 }, { x: touchX + 40, y: touchY, id: 2 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(async () => Number((await reset.innerText()).replace('%', '')) > 150, 'existing touch pinch still zooms');
    await reset.click(); await pause(180); await touch.detach();
    const fitted = await viewer.locator('img').boundingBox(), mobileCanvas = await viewer.locator('[data-image-canvas]').boundingBox();
    assert(fitted.x >= mobileCanvas.x && fitted.y >= mobileCanvas.y && fitted.x + fitted.width <= mobileCanvas.x + mobileCanvas.width + 1 && fitted.y + fitted.height <= mobileCanvas.y + mobileCanvas.height + 1, '100% fits the complete image inside the mobile canvas');
    await page.screenshot({ path: path.join(output, 'preview-mobile.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: paged source grouping, stable attempt labels, preserved reading anchor, latest-round navigation; wheel bounds, simultaneous drag/zoom from 100%, reset, double-click and small-screen preview.');
  } catch (error) {
    const page = browser.contexts()[0]?.pages()[0]; if (page) await page.screenshot({ path: path.join(output, 'failure.png') });
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
