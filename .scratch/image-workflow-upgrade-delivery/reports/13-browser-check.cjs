// Production browser checks against 13-browser-server.py. All pixels and identities are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43230';
const dense = process.env.TICKET13_DENSE === '1';
const output = path.join(__dirname, '13-evidence', dense ? 'dense' : '');
const latestLabel = dense ? '第 15–16 / 16 轮' : '第 79–80 / 80 轮';
const previousLabel = dense ? '第 13–14 / 16 轮' : '第 77–78 / 80 轮';
const headers = { Authorization: 'Bearer ticket13-A' };

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    window.blobAudit = { live: new Set(), revoked: [], peak: 0 };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.blobAudit.live.add(url); window.blobAudit.peak = Math.max(window.blobAudit.peak, window.blobAudit.live.size); return url; };
    URL.revokeObjectURL = url => { window.blobAudit.live.delete(url); window.blobAudit.revoked.push(url); revoke(url); };
    window.longTasks = [];
    new PerformanceObserver(list => window.longTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ type: 'longtask', buffered: true });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [], reads = [], pending = [], protectedReads = [];
  const timings = {};
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (/\/(images|image-thumbnails)\/managed\//.test(response.url())) protectedReads.push({ url: response.url(), status: response.status() });
    if (!response.url().startsWith(origin + '/api/image')) return;
    const task = response.body().then(body => {
      let value;
      try { value = JSON.parse(body.toString()); } catch { return; }
      reads.push({ url: response.url(), bytes: body.length, turns: value.turns?.length,
        items: value.items?.length, offset: value.pagination?.offset,
        images: value.turns?.reduce((n, turn) => n + turn.images.length, 0) });
    }).catch(() => {});
    pending.push(task);
  });
  const pager = () => page.getByLabel('结果分页');
  const viewport = () => page.locator('.hide-scrollbar.overflow-y-auto');
  const ready = () => page.waitForFunction(() => {
    const viewport = document.querySelector('.hide-scrollbar.overflow-y-auto');
    if (!viewport) return false;
    const bounds = viewport.getBoundingClientRect();
    const visible = [...viewport.querySelectorAll('[data-image-frame]')].filter(frame => {
      const rect = frame.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom && rect.bottom > 0 && rect.top < innerHeight;
    });
    const loaded = visible.length > 0 && visible.every(frame => {
      const img = frame.querySelector('img');
      return img && img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0;
    });
    window.readyFrames = loaded ? (window.readyFrames || 0) + 1 : 0;
    return window.readyFrames >= 6;
  });
  const galleryReady = () => page.waitForFunction(() => [...document.querySelectorAll('button.cursor-zoom-in img')].every(img => img.complete && img.naturalWidth > 0));
  const readingPosition = () => viewport().evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const frame = [...element.querySelectorAll('[data-image-frame]')].find(frame => frame.getBoundingClientRect().bottom > bounds.top);
    return { scrollTop: element.scrollTop, turn: frame?.closest('[data-turn-id]')?.getAttribute('data-turn-id'), image: frame?.querySelector('img')?.alt };
  });
  try {
    assert.equal((await context.request.put(origin + '/api/image-conversations/current', { headers, data: { conversation_id: 'gallery-0' } })).status(), 200);
    await page.goto(origin + '/login/');
    await page.getByLabel('密钥', { exact: true }).fill('ticket13-A');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/accounts/');
    let start = Date.now();
    await page.goto(origin + '/image/');
    await pager().getByText(latestLabel).waitFor();
    await ready();
    timings.first_open_ms = Date.now() - start;
    if (await page.getByRole('button', { name: '加载更多会话', exact: true }).count()) {
      await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
      await page.getByRole('button', { name: /Large gallery 1/ }).waitFor();
      await ready();
    }
    assert.equal(await page.getByText(/^第 \d+ 轮$/).count(), 2);
    const initialBlobs = await page.evaluate(() => [...window.blobAudit.live]);
    assert(initialBlobs.length < 40, `Only viewport images should load: ${initialBlobs.length}`);
    await page.screenshot({ path: path.join(output, 'history-latest.png') });
    start = Date.now();
    await page.getByRole('button', { name: /Large gallery 1/ }).click();
    await page.waitForResponse(response => response.url().includes('/api/image-conversations/gallery-1?') && response.status() === 200);
    await ready();
    timings.switch_ms = Date.now() - start;
    await page.waitForFunction(urls => urls.every(url => !window.blobAudit.live.has(url)), initialBlobs);
    start = Date.now();
    await pager().getByRole('button', { name: '较早结果' }).click();
    await pager().getByText(previousLabel).waitFor();
    await ready();
    timings.previous_page_ms = Date.now() - start;
    assert.equal(await page.getByText(/^第 \d+ 轮$/).count(), 2);
    const beforeScroll = await page.evaluate(() => ({ revoked: window.blobAudit.revoked.length, live: [...window.blobAudit.live] }));
    timings.scroll_frames = await viewport().evaluate(async element => {
      const intervals = [];
      let prior = performance.now();
      for (let step = 0; step < 90; step++) {
        element.scrollTop = element.scrollHeight * step / 89;
        await new Promise(requestAnimationFrame);
        const now = performance.now(); intervals.push(now - prior); prior = now;
      }
      return { p95_ms: intervals.sort((a,b) => a-b)[Math.floor(intervals.length*.95)], max_ms: Math.max(...intervals) };
    });
    await page.waitForFunction(n => window.blobAudit.revoked.length > n, beforeScroll.revoked);
    await ready();
    await viewport().evaluate(element => { element.scrollTop = 0; });
    await ready();
    timings.visible_images_reloaded = true;
    await page.screenshot({ path: path.join(output, 'history-scrolled-back.png') });
    start = Date.now();
    await page.locator('textarea').fill('Still responsive after scrolling 3,200 results');
    assert.equal(await page.locator('textarea').inputValue(), 'Still responsive after scrolling 3,200 results');
    timings.input_ms = Date.now() - start;
    await viewport().evaluate(element => { element.scrollTop = 1200; });
    await ready();
    const savedPosition = await readingPosition();
    // Hold one real response; selecting back must invalidate it.
    let release, intercepted, finished, heldOnce = false;
    const held = new Promise(resolve => { intercepted = resolve; });
    const fulfilled = new Promise(resolve => { finished = resolve; });
    await page.route('**/api/image-conversations/gallery-0?*', async route => {
      if (heldOnce) return route.continue();
      heldOnce = true;
      const response = await route.fetch();
      const released = new Promise(resolve => { release = resolve; });
      intercepted();
      await released;
      await route.fulfill({ response });
      finished();
    });
    await page.getByRole('button', { name: /Large gallery 0/ }).click();
    await held;
    await page.getByRole('button', { name: /Large gallery 1/ }).click();
    release();
    await fulfilled;
    await page.unroute('**/api/image-conversations/gallery-0?*');
    await pager().getByText(previousLabel).waitFor();
    await ready();
    const returnedPosition = await readingPosition();
    assert.deepEqual({ turn: returnedPosition.turn, image: returnedPosition.image }, { turn: savedPosition.turn, image: savedPosition.image });
    assert(Math.abs(savedPosition.scrollTop - returnedPosition.scrollTop) <= 32, `Scroll within one text line after image decode: ${JSON.stringify({savedPosition, returnedPosition})}`);
    timings.return_position = { savedPosition, returnedPosition };
    timings.history_position_restored = true;
    assert(await page.getByRole('button', { name: /Large gallery 1/ }).evaluate(el => el.parentElement.className.includes('border-stone-900')));
    timings.stale_response_ignored = true;
    // Target lookup from an unloaded page is a small, identity checked request.
    const target = await context.request.get(origin + '/api/image-conversations/gallery-1?image_id=gallery-1-turn-002-3', { headers });
    const located = await target.json();
    assert.equal(located.pagination.offset, 2);
    assert(located.turns.some(turn => turn.images.some(image => image.id === 'gallery-1-turn-002-3')));
    assert.equal((await context.request.get(origin + '/api/image-conversations/gallery-1?image_id=gallery-1-turn-002-3', { headers: { Authorization: 'Bearer ticket13-B' } })).status(), 404);
    timings.target_bytes = (await target.body()).length;
    timings.blobs_after_scroll = await page.evaluate(() => ({ live: window.blobAudit.live.size, revoked: window.blobAudit.revoked.length, peak: window.blobAudit.peak }));
    start = Date.now();
    await page.goto(origin + '/image-manager/');
    await page.getByText('第 1 / 267 页，共 3200 张').waitFor();
    await galleryReady();
    timings.gallery_open_ms = Date.now() - start;
    assert.equal(await page.locator('button.cursor-zoom-in img').count(), 12);
    const oldGalleryBlobs = await page.evaluate(() => [...window.blobAudit.live]);
    start = Date.now();
    await page.getByLabel('图库下一页').click();
    await page.getByText('第 2 / 267 页，共 3200 张').waitFor();
    await galleryReady();
    timings.gallery_next_ms = Date.now() - start;
    await page.waitForFunction(urls => urls.every(url => !window.blobAudit.live.has(url)), oldGalleryBlobs);
    await page.screenshot({ path: path.join(output, 'gallery-page-2.png') });
    // Set one tag on 13 real existing results, then select all across two visual pages.
    const batch = await (await context.request.get(origin + '/api/images?limit=13', { headers })).json();
    for (const image of batch.items) {
      assert.equal((await context.request.post(origin + '/api/images/tags', { headers, data: { path: image.rel, tags: ['cross-page'] } })).status(), 200);
    }
    await page.getByRole('button', { name: '刷新', exact: true }).last().click();
    await page.getByText('cross-page', { exact: true }).first().click();
    await page.getByText('第 1 / 2 页，共 13 张').waitFor();
    await page.getByRole('button', { name: '全选结果', exact: true }).click();
    await page.getByText('已选 13 张', { exact: true }).waitFor();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载所选', exact: true }).click();
    const download = await downloadEvent;
    await download.saveAs(path.join(output, 'selected-13.zip'));
    timings.selected_download = { count: 13, bytes: (await fs.stat(path.join(output, 'selected-13.zip'))).size };
    // Filtering must occur before pagination, including the last matching result.
    await page.getByLabel('图库下一页').click();
    await page.getByText('第 2 / 2 页，共 13 张').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('button.cursor-zoom-in img').length === 1);
    await galleryReady();
    // Removing the active filter tag from the only last-page result must reload/clamp the page.
    await page.getByText('cross-page', { exact: true }).last().hover();
    // The tag chip's remove button is the X immediately beside its label.
    await page.getByText('cross-page', { exact: true }).last().getByRole('button').click();
    await page.getByText('第 1 / 1 页，共 12 张').waitFor();
    timings.tag_filter_updated_after_edit = true;
    await page.waitForFunction(() => document.querySelectorAll('button.cursor-zoom-in img').length === 12);
    await galleryReady();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'gallery-narrow.png') });
    assert(await page.getByLabel('图库上一页').isVisible());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '清除筛选条件', exact: true }).click();
    await page.getByRole('button', { name: '取消选择', exact: true }).click();
    await page.getByText('第 1 / 267 页，共 3200 张').waitFor();
    let rejected = false;
    await page.route('**/api/images?*', route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('paths_only') && url.searchParams.get('offset') === '100' && !rejected) {
        rejected = true;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'controlled selection interruption' }) });
      }
      return route.continue();
    });
    await page.getByRole('button', { name: '全选结果', exact: true }).click();
    await page.getByText('已选 100 张', { exact: true }).waitFor();
    await page.getByRole('button', { name: '全选结果', exact: true }).waitFor();
    assert(rejected);
    await page.unroute('**/api/images?*');
    await page.getByRole('button', { name: '全选结果', exact: true }).click();
    await page.getByText('已选 3200 张', { exact: true }).waitFor();
    timings.selection_failure_recovered = true;
    await page.getByRole('button', { name: '取消选择', exact: true }).click();
    // Server metadata pages remain reachable when the selected conversation is outside page one.
    for (let n = 0; n < 64; n++) assert.equal((await context.request.post(origin + '/api/image-conversations', { headers, data: { request_id: `empty-${n}` } })).status(), 200);
    await context.request.put(origin + '/api/image-conversations/current', { headers, data: { conversation_id: 'gallery-0' } });
    await page.goto(origin + '/image/');
    await pager().getByText(latestLabel).waitFor();
    await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('aside button')].some(button => button.textContent === '读取中…'));
    const middle = await (await context.request.get(origin + '/api/image-conversations?offset=30&limit=30', { headers })).json();
    assert.equal(middle.items.length, 30);
    const deleted = middle.items[10].id;
    assert.equal((await context.request.delete(origin + '/api/image-conversations/' + deleted, { headers })).status(), 200);
    await page.waitForResponse(async response => response.url().includes('/api/image-conversations?offset=0') && (await response.json()).pagination.total === 65);
    const nextPage = page.waitForResponse(response => response.url().includes('/api/image-conversations?offset=30&limit=30'));
    await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
    await nextPage;
    await page.waitForFunction(() => ![...document.querySelectorAll('aside button')].some(button => button.textContent === '读取中…'));
    while (await page.getByRole('button', { name: '加载更多会话', exact: true }).count()) {
      await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
      await page.waitForFunction(() => ![...document.querySelectorAll('aside button')].some(button => button.textContent === '读取中…'));
    }
    await page.getByRole('button', { name: /Large gallery 1/ }).waitFor();
    assert.equal(await page.locator('aside button.block.w-full').count(), 65);
    timings.deleted_middle_continuation_recovered = true;
    timings.more_conversations_reachable = true;
    await Promise.all(pending);
    assert(reads.filter(read => read.turns !== undefined).every(read => read.turns <= 2));
    assert(reads.filter(read => /\/api\/images\?/.test(read.url) && !read.url.includes('paths_only')).every(read => read.items <= 12));
    assert.deepEqual(errors, []);
    assert(protectedReads.length > 0 && protectedReads.every(read => read.status === 200));
    timings.long_tasks_ms = await page.evaluate(() => window.longTasks);
    await fs.writeFile(path.join(output, 'browser.json'), JSON.stringify({ timings, reads, protectedReads, errors }, null, 2));
    console.log(JSON.stringify(timings, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') });
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
