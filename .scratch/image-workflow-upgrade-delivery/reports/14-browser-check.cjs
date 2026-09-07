// Real production UI and real PNGs, with only synthetic upstream/storage fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43240';
const dense = process.env.TICKET13_DENSE === '1';
const output = path.join(__dirname, '14-evidence', dense ? 'dense' : 'normal');
const headers = { Authorization: 'Bearer ticket13-A' };
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    window.blobs = { live: new Set(), peak: 0, revoked: 0 };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.blobs.live.add(url); window.blobs.peak = Math.max(window.blobs.peak, window.blobs.live.size); return url; };
    URL.revokeObjectURL = url => { window.blobs.live.delete(url); window.blobs.revoked++; revoke(url); };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [], navigation = [], details = [], metrics = {};
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', async response => {
    if (!response.url().includes('/api/image-conversations/gallery-')) return;
    try {
      const body = await response.body(); const json = JSON.parse(body);
      if (response.url().includes('navigation=true')) navigation.push({ bytes: body.length, json });
      else if (json.turns?.length) details.push({ url: response.url(), turns: json.turns.length });
    } catch {}
  });
  const login = async p => {
    await p.goto(origin + '/login/');
    await p.getByLabel('密钥', { exact: true }).fill('ticket13-A');
    await p.getByRole('button', { name: '登录', exact: true }).click();
    await p.waitForURL('**/accounts/');
    await p.goto(origin + '/image/');
  };
  const viewport = page.locator('.hide-scrollbar.overflow-y-auto');
  const nav = () => page.getByRole('navigation', { name: '结果定位导航' }).filter({ visible: true });
  const group = (n) => nav().locator(`[data-navigation-source="gallery-0-source-${String(n).padStart(3, '0')}"]`);
  const ready = async () => page.waitForFunction(() => {
    const root = document.querySelector('.hide-scrollbar.overflow-y-auto');
    if (!root) return false;
    const bounds = root.getBoundingClientRect();
    const frames = [...root.querySelectorAll('[data-image-frame]')].filter(e => {
      const r = e.getBoundingClientRect(); return r.top < bounds.bottom && r.bottom > bounds.top;
    });
    return frames.length && frames.every(e => { const img = e.querySelector('img'); return img?.complete && img.naturalWidth === 480; });
  });
  const targetVisible = async id => {
    const element = page.locator(`[data-image-id="${id}"]`);
    await element.waitFor(); await ready();
    await page.waitForFunction(id => {
      const item = document.querySelector(`[data-image-id="${id}"]`);
      const root = document.querySelector('.hide-scrollbar.overflow-y-auto');
      return item && Math.abs(item.getBoundingClientRect().top - root.getBoundingClientRect().top) < 3;
    }, id);
  };
  try {
    await context.request.put(origin + '/api/image-conversations/current', { headers, data: { conversation_id: 'gallery-0' } });
    let start = Date.now(); await login(page); await ready();
    await group(0).waitFor(); metrics.first_open_and_login_ms = Date.now() - start;
    assert.equal(await nav().locator('[data-navigation-source]').count(), 8);
    assert(await group(0).innerText().then(t => t.includes('SUB00 · MD item 0')));
    assert(await group(1).innerText().then(t => t.includes('Source 1')));
    await group(0).getByRole('button', { name: '展开或收起 SUB00 · MD item 0', exact: true }).click();
    const last = dense ? 2 : 10;
    assert.equal(await group(0).getByRole('button', { name: /次 · \d+ 张/ }).count(), last);
    await group(0).getByRole('button', { name: '展开或收起第 1 次图片', exact: true }).click();
    const target = 'gallery-0-turn-000-9';
    start = Date.now(); await group(0).locator(`[data-navigation-image="${target}"]`).click();
    await targetVisible(target); metrics.cross_page_target_ms = Date.now() - start;
    await group(0).locator(`[data-navigation-image="${target}"][aria-current="location"]`).waitFor();
    const offset = await viewport.evaluate(e => e.scrollTop);
    await group(0).getByRole('button', { name: '展开或收起 SUB00 · MD item 0', exact: true }).click();
    assert.equal(await viewport.evaluate(e => e.scrollTop), offset);
    assert.match(await group(0).innerText(), /当前位置 · 第 1 次 · 图片 10/);
    await group(0).getByRole('button', { name: /^SUB00 · MD item 0/ }).click();
    const latestTurn = dense ? '008' : '072';
    await page.locator(`[data-turn-id="gallery-0-turn-${latestTurn}"]`).waitFor();
    await page.waitForFunction(tid => {
      const e = document.querySelector(`[data-turn-id="${tid}"]`), r = document.querySelector('.hide-scrollbar.overflow-y-auto');
      return e && Math.abs(e.getBoundingClientRect().top - r.getBoundingClientRect().top) < 3;
    }, `gallery-0-turn-${latestTurn}`);
    await ready();
    // Manual movement must update the active source and image without clicking navigation.
    const manual = `gallery-0-turn-${latestTurn}-12`;
    await viewport.evaluate((root, id) => { const e = root.querySelector(`[data-image-id="${id}"]`); root.scrollTop += e.getBoundingClientRect().top - root.getBoundingClientRect().top; }, manual);
    await ready();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-navigation-source]')].some(e => /当前位置.*图片 13/.test(e.textContent)));
    metrics.manual_highlight = true;
    // Expand the whole metadata outline. Scrolling it cannot move the result viewport.
    for (const button of await nav().getByRole('button', { name: /^展开或收起 (SUB|Source)/ }).all()) {
      if (await button.getAttribute('aria-expanded') === 'false') await button.click();
    }
    const before = await viewport.evaluate(e => e.scrollTop);
    await nav().hover(); await page.mouse.wheel(0, 20000); await page.waitForTimeout(150);
    assert.equal(await viewport.evaluate(e => e.scrollTop), before);
    assert(await nav().evaluate(e => e.scrollTop + e.clientHeight >= e.scrollHeight - 2));
    metrics.independent_scroll = true;
    metrics.scroll_frames = await viewport.evaluate(async root => {
      const times = []; let previous = performance.now();
      for (let n = 0; n < 90; n++) {
        root.scrollTop = root.scrollHeight * n / 89; await new Promise(requestAnimationFrame);
        const now = performance.now(); times.push(now - previous); previous = now;
      }
      times.sort((a,b) => a-b); return { p95_ms: times[Math.floor(times.length*.95)], max_ms: times.at(-1) };
    });
    start = Date.now(); await page.locator('textarea').fill('Navigation remains responsive'); metrics.input_ms = Date.now() - start;
    await page.screenshot({ path: path.join(output, 'desktop.png') });
    // Independent browser restores the selected server conversation and complete outline.
    const second = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const other = await second.newPage(); await login(other);
    await other.locator('[data-navigation-source="gallery-0-source-000"]').waitFor();
    assert.equal(await other.locator('[data-navigation-source]').count(), 8);
    await second.close();
    // Low height: complete numeric input and send control can each scroll fully into view.
    await page.setViewportSize({ width: 320, height: 360 });
    await page.getByRole('button', { name: '定位', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('navigation').evaluate(e => { e.scrollTop = e.scrollHeight; });
    await dialog.getByText('Source 7', { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.locator('.image-result-panel').scrollIntoViewIfNeeded();
    assert(await page.locator('.image-result-panel').evaluate(e => e.clientHeight >= 240));
    await viewport.evaluate(e => { e.scrollTop += 180; });
    await ready();
    await page.screenshot({ path: path.join(output, 'results-320x360.png') });
    await page.getByRole('button', { name: /自动.*张/ }).click();
    const count = page.getByRole('textbox', { name: '生成数量', exact: true });
    await count.scrollIntoViewIfNeeded();
    assert(await count.evaluate(e => { const r=e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left>=0 && r.right<=innerWidth; }));
    await count.fill('7'); assert.equal(await count.inputValue(), '7');
    await page.screenshot({ path: path.join(output, 'composer-320x360.png') });
    await page.locator('textarea').click();
    await page.getByRole('button', { name: '生成图片', exact: true }).scrollIntoViewIfNeeded();
    assert(await page.getByRole('button', { name: '生成图片', exact: true }).evaluate(e => { const r=e.getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight; }));
    await page.getByRole('button', { name: '定位', exact: true }).click();
    await dialog.getByRole('navigation').evaluate(e => { e.scrollTop = e.scrollHeight; });
    await page.screenshot({ path: path.join(output, 'drawer-320x360.png') });
    await page.keyboard.press('Escape');
    metrics.low_height = true;
    // Public deletion + polling cannot leave a ghost image/round in navigation.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await context.request.delete(origin + '/api/image-conversations/gallery-0/turns/gallery-0-turn-000/images/gallery-0-turn-000-9', { headers });
    await group(0).getByRole('button', { name: '展开或收起第 1 次图片', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-navigation-image="gallery-0-turn-000-9"]'));
    await context.request.patch(origin + '/api/image-conversations/gallery-0', { headers, data: { turns: [{ id: 'gallery-0-turn-000', promptDeleted: true, resultsDeleted: true }] } });
    await group(0).getByRole('button', { name: /^第 1 次 ·/ }).waitFor({ state: 'detached' });
    assert(await group(0).getByRole('button', { name: /^第 2 次 ·/ }).count());
    await context.request.delete(origin + '/api/image-conversations/gallery-0', { headers });
    await group(0).waitFor({ state: 'detached' });
    metrics.deletions = true;
    metrics.blobs = await page.evaluate(() => ({ live: window.blobs.live.size, peak: window.blobs.peak, revoked: window.blobs.revoked }));
    assert(metrics.blobs.peak < 80);
    assert(details.every(read => read.turns <= 2));
    assert(navigation.every(read => read.json.turns.length <= 10 && read.json.turns.every(t => !t.prompt && !t.referenceImages && t.images.every(i => !i.url && !i.b64_json))));
    metrics.navigation_bytes = navigation.reduce((n,r) => n+r.bytes,0);
    metrics.navigation_requests = navigation.length;
    metrics.detail_requests = details.length;
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify(metrics));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }); throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
