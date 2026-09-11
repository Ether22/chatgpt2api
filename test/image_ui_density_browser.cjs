// Run against image_followup_browser_server.py in the isolated workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43280', headers = { Authorization: 'Bearer ticket08-A' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = 'state') { for (let n = 0; n < 200; n++) { if (await check()) return; await pause(60); } throw Error(`Timed out: ${label}`); }
(async () => {
  const output = path.resolve('.scratch/ui-reference-round4/evidence-order'); await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const api = async (url, data, method = 'POST') => {
      const response = await context.request.fetch(origin + url, { method, headers, data });
      assert.equal(response.status(), 200, await response.text()); return response.json();
    };
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    const original = await api('/api/accounts', undefined, 'GET');
    let items = ['normal', 'monitor', 'disabled', 'normal', 'normal'].map((mode, i) => ({ ...original.items[0], access_token: `density-${i}`,
      email: `density-${i}@example.test`, usage_mode: mode, status: i === 3 ? '异常' : '正常', quota: [10, 99999, 88888, 0, 70][i] }));
    let accountFailure = false, replyProgress, requests = [], operation = 'refresh';
    const stats = () => ({ total: 5, active: items.filter(item => item.status === '正常' && item.usage_mode === 'normal').length,
      limited: 0, abnormal: items.filter(item => item.status === '异常').length, disabled: 1,
      total_quota: items.filter(item => item.status === '正常' && item.usage_mode === 'normal').reduce((sum, item) => sum + item.quota, 0), monitor_quota: 99999 });
    await context.route('**/api/accounts', route => accountFailure ? route.fulfill({ status: 503, json: { detail: 'controlled account read failure' } }) : route.fulfill({ json: { items } }));
    await context.route(/\/api\/accounts\/(refresh|re-login)$/, route => {
      operation = route.request().url().endsWith('re-login') ? 're-login' : 'refresh';
      requests.push(route.request().postDataJSON().access_tokens);
      return route.fulfill({ json: { progress_id: 'density' } });
    });
    await context.route(/\/api\/accounts\/(refresh|re-login)\/progress\//, async route => {
      const response = await new Promise(resolve => { replyProgress = value => { replyProgress = null; resolve(value); }; });
      return route.fulfill(response);
    });
    await page.goto(origin + '/login/'); await page.getByLabel('密钥', { exact: true }).fill('ticket08-A');
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/accounts/');
    const quota = page.getByText('可用剩余额度', { exact: true }).locator('../..').locator(':scope > div').last();
    const expectQuota = value => until(async () => await quota.innerText() === value, `quota ${value}`);
    const all = page.getByRole('button', { name: '一键刷新所有账号信息和额度', exact: true });
    const start = async button => { await button.click(); await until(() => !!replyProgress); await expectQuota('0'); };
    const send = async (total_quota, processed, done = false, extra = {}) => {
      await until(() => !!replyProgress);
      replyProgress({ json: { total: 5, processed, done, total_quota, stats: stats(),
        result: done ? { items, errors: [], refreshed: 5, ...extra } : null } });
    };
    await expectQuota('80'); await start(all); assert.equal(requests.at(-1).length, 5);
    items[0].quota = 30; await send(30, 1); await expectQuota('30'); assert(await all.isDisabled());
    await page.screenshot({ path: path.join(output, 'quota-live.png') });
    await send(30, 2); await expectQuota('30');
    await send(100, 5, true); await until(() => all.isEnabled()); await expectQuota('100');
    const normalRow = page.locator('tbody tr').filter({ hasText: 'density-0@example.test' });
    await start(normalRow.getByRole('button', { name: '刷新账号', exact: true })); assert.equal(requests.at(-1).length, 1);
    await send(30, 1); await expectQuota('30'); await send(30, 1, true); await until(() => all.isEnabled()); await expectQuota('100');
    await normalRow.getByRole('checkbox').click();
    await start(page.getByRole('button', { name: '刷新选中账号信息和额度', exact: true })); assert.equal(requests.at(-1).length, 1);
    await send(30, 1); await expectQuota('30'); await send(30, 1, true); await until(() => all.isEnabled()); await expectQuota('100');
    // The automatic recovery phase adds to the verified first phase without resetting the card.
    await start(all); await send(100, 4); await expectQuota('100');
    await send(100, 5, true, { relogin_progress_id: 'auto-recovery' });
    await until(() => !!replyProgress); await expectQuota('100');
    items[3] = { ...items[3], status: '正常', quota: 8 };
    await send(8, 1); await expectQuota('108'); await send(8, 1, true);
    await until(() => all.isEnabled()); await expectQuota('108');
    items[3] = { ...items[3], status: '异常', quota: 0 };
    await page.getByRole('button', { name: '刷新', exact: true }).click(); await expectQuota('100');
    await normalRow.getByRole('checkbox').click();
    await page.locator('tbody tr').filter({ hasText: 'density-3@example.test' }).getByRole('checkbox').click();
    const recovery = page.getByRole('button', { name: '尝试恢复异常账号', exact: true });
    await start(recovery); assert.equal(operation, 're-login');
    items[3] = { ...items[3], status: '正常', quota: 6 };
    await send(6, 1); await expectQuota('6'); await send(6, 1, true);
    await until(() => recovery.isEnabled()); await expectQuota('106');
    await start(all); await send(30, 1); await expectQuota('30');
    await until(() => !!replyProgress); accountFailure = true;
    replyProgress({ status: 503, json: { detail: 'controlled progress failure' } });
    await until(() => all.isEnabled()); await expectQuota('106');
    accountFailure = false; items[0].quota = 20001;
    await page.getByRole('button', { name: '刷新', exact: true }).click(); await expectQuota('20,077');
    await page.mouse.move(1, 1);
    assert.equal(await normalRow.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');

    await page.goto(origin + '/settings/'); await page.getByText('图片二次确认等待时间', { exact: true }).waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const fields = await page.locator('label').evaluateAll(nodes => nodes.filter(node => ['图片轮询超时', '单账号图片并发', '图片超时继续等待时间', '图片二次确认等待时间'].includes(node.textContent)).map(node => {
        const r = node.parentElement.querySelector('input').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width };
      }));
      assert.equal(fields.length, 4);
      if (width > 1000) { assert.equal(fields[0].y, fields[1].y); assert.equal(fields[2].y, fields[3].y); assert.equal(fields[0].x, fields[2].x); }
      else assert(fields.every(field => field.x === fields[0].x && field.x + field.w <= width));
      await page.screenshot({ path: path.join(output, `settings-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const longPrompt = '左对齐的产品图片说明，保留完整构图与材质细节。'.repeat(60);
    const conversation = await api('/api/image-conversations', { request_id: `density-${Date.now()}` });
    await api('/api/image-conversations/turns', { request_id: `density-4-${Date.now()}`, conversation_id: conversation.id, prompt: longPrompt, count: 4 });
    await until(async () => !(await api(`/api/image-conversations/${conversation.id}/metadata`, undefined, 'GET')).stats.running);
    await api('/api/image-conversations/turns', { request_id: `density-6-${Date.now()}`, conversation_id: conversation.id, prompt: '六张紧凑排列', count: 6 });
    await until(async () => !(await api(`/api/image-conversations/${conversation.id}/metadata`, undefined, 'GET')).stats.running);
    await api('/api/image-conversations/current', { conversation_id: conversation.id }, 'PUT');
    await page.goto(origin + '/image/'); await until(async () => await page.locator('[data-turn-id]').count() === 2);
    assert.equal(await page.getByText(/^共 \d+ 轮$/).count(), 0);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const turns = page.locator('[data-turn-id]');
      let fourImageWidth;
      for (let i = 0; i < 2; i++) {
        const turn = turns.nth(i), imageStyles = [];
        for (const frame of await turn.locator('[data-image-frame]').all()) {
          await frame.scrollIntoViewIfNeeded();
          await until(() => frame.evaluate(node => { const img = node.querySelector('img'); return img?.complete && img.naturalWidth > 0; }), 'visible thumbnail loaded');
          imageStyles.push(await frame.locator('img').evaluate(img => ({
            background: getComputedStyle(img.parentElement).backgroundColor, radius: parseFloat(getComputedStyle(img).borderRadius),
            ratio: img.getBoundingClientRect().width / img.getBoundingClientRect().height, natural: img.naturalWidth / img.naturalHeight,
          })));
        }
        assert(imageStyles.every(img => img.background === 'rgba(0, 0, 0, 0)' && img.radius > 0 && Math.abs(img.ratio - img.natural) < .02));
        const frames = await turn.locator('[data-image-frame]').evaluateAll(nodes => nodes.map(node => {
          const r = node.getBoundingClientRect();
          const label = [...node.parentElement.querySelectorAll('span')].find(span => /^结果 \d+$/.test(span.textContent));
          return { x: r.x, y: r.y, w: r.width, h: r.height, ordinal: Number(label.textContent.match(/\d+/)[0]) };
        }));
        assert.equal(frames.length, i ? 6 : 4);
        assert(frames.every((frame, index) => Math.abs(frame.w / frame.h - imageStyles[index].natural) < .02), 'natural image geometry survives offscreen unloading');
        assert(frames.every(frame => frame.x + frame.w <= width && (width < 640 || frame.w > 224)), 'reference-size cards are larger and stay within the viewport');
        assert(await turn.locator('[data-image-id]').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), 'metadata and actions fit the cards');
        assert.equal(new Set(frames.map(frame => Math.round(frame.x))).size, i && width >= 1280 ? 3 : 2);
        const expectedOrder = Array.from({ length: frames.length }, (_, index) => index + 1);
        assert.deepEqual([...frames].sort((a, b) => Math.abs(a.y - b.y) < 1 ? a.x - b.x : a.y - b.y).map(frame => frame.ordinal), expectedOrder, 'visual reading order matches result numbers');
        if (i === 0) {
          fourImageWidth = frames[0].w;
          assert(Math.abs(frames[0].y - frames[1].y) < 1 && Math.abs(frames[2].y - frames[3].y) < 1, 'four results form rows 1 2 / 3 4');
          assert(frames[2].y >= Math.max(frames[0].y + frames[0].h, frames[1].y + frames[1].h), 'second row follows the complete first row');
        } else assert(Math.abs(frames[0].w - fourImageWidth) < 1, 'four-image and reference three-column layouts keep the same single-image width');
        await turn.evaluate(node => node.scrollIntoView({ block: 'start' }));
        await until(() => turn.locator('[data-image-frame]').evaluateAll(nodes => nodes.every(node => {
          const rect = node.getBoundingClientRect(), viewport = node.closest('.image-result-panel').getBoundingClientRect(), img = node.querySelector('img');
          return rect.bottom <= viewport.top || rect.top >= viewport.bottom || (img?.complete && img.naturalWidth > 0);
        })), 'onscreen images restored after scrolling');
        await page.screenshot({ path: path.join(output, `grid-${i ? 6 : 4}-${width}.png`) });
        if (width === 1440 && i === 0) {
          await page.setViewportSize({ width, height: 1800 });
          await turn.scrollIntoViewIfNeeded();
          await until(() => turn.locator('[data-image-frame]').evaluateAll(nodes => nodes.every(node => node.querySelector('img')?.complete)), 'four-image overview loaded');
          await turn.screenshot({ path: path.join(output, 'order-four-desktop.png') });
          await page.setViewportSize({ width, height: 1000 });
        }
      }
      const first = turns.first(); await first.scrollIntoViewIfNeeded();
      const prompt = first.locator('details').first(), summary = prompt.locator('summary');
      assert.equal(await prompt.getAttribute('open'), null);
      assert.equal(await summary.evaluate(node => getComputedStyle(node).textAlign), 'right');
      const collapsed = await prompt.evaluate(node => node.getBoundingClientRect().height);
      await summary.click(); assert(await prompt.evaluate(node => node.getBoundingClientRect().height) > collapsed);
      assert.equal(await prompt.locator('p').evaluate(node => getComputedStyle(node).textAlign), 'left');
      await summary.press('Enter'); assert.equal(await prompt.getAttribute('open'), null);
      await first.evaluate(node => node.scrollIntoView({ block: 'start' }));
      await until(() => first.locator('[data-image-frame]').first().evaluate(node => {
        const img = node.querySelector('img'); return img?.complete && img.naturalWidth > 0;
      }));
      await page.screenshot({ path: path.join(output, `results-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const last = page.locator('[data-turn-id]').last(); await last.scrollIntoViewIfNeeded();
    await last.locator('[data-image-frame] button').first().click();
    const viewer = page.getByRole('dialog', { name: '图片预览', exact: true });
    const ready = () => viewer.getByRole('button', { name: '下载图片', exact: true }).isEnabled();
    await until(ready); assert.equal(await viewer.getByRole('link', { name: '打开原图' }).count(), 0);
    const imageSrc = () => viewer.locator('img').getAttribute('src');
    const initial = await imageSrc();
    await viewer.locator('img').dblclick();
    const retainedTransform = await viewer.locator('img').getAttribute('style');
    let reads = [], imageMode = 'hold';
    await page.route('**/images/managed/**', async route => {
      if (imageMode === 'hold') await new Promise(resolve => reads.push({ url: route.request().url(), release: resolve }));
      if (imageMode === 'fail') return route.fulfill({ status: 503, body: 'controlled image failure' });
      if (imageMode === 'deny') return route.fulfill({ status: 403, body: 'controlled permission change' });
      return route.continue();
    });
    await page.keyboard.press('ArrowRight'); await until(() => reads.length === 1);
    assert.equal(await imageSrc(), initial); assert(await viewer.locator('img').evaluate(img => img.complete && img.naturalWidth > 0));
    assert.equal(await viewer.locator('img').getAttribute('style'), retainedTransform, 'pending image keeps the old zoom and position');
    assert(await viewer.getByRole('button', { name: '删除当前生成结果' }).isDisabled()); assert(!await ready());
    await page.screenshot({ path: path.join(output, 'lightbox-loading.png') });
    await page.keyboard.press('Delete'); assert.equal(await page.getByRole('dialog').count(), 1);
    await page.keyboard.press('ArrowRight'); await until(() => reads.length === 2);
    reads[1].release(); await until(ready); const third = await imageSrc(); assert.notEqual(third, initial);
    await until(async () => await viewer.getByRole('button', { name: '重置缩放', exact: true }).innerText() === '100%');
    reads[0].release(); await pause(200); assert.equal(await imageSrc(), third);
    imageMode = 'fail'; await viewer.getByRole('button', { name: '下一张', exact: true }).click();
    await viewer.getByRole('alert').waitFor(); assert.equal(await imageSrc(), third);
    imageMode = 'pass'; await viewer.getByRole('button', { name: '重试加载', exact: true }).click(); await until(ready);
    const deleted = await imageSrc(); imageMode = 'hold'; reads = [];
    await viewer.getByRole('button', { name: '删除当前生成结果' }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await until(async () => await viewer.locator('img').count() === 0 || await imageSrc() !== deleted, 'deleted image hidden');
    imageMode = 'pass'; reads.forEach(read => read.release()); await until(ready);
    imageMode = 'deny'; await viewer.getByRole('button', { name: '上一张', exact: true }).click();
    await viewer.getByRole('alert').waitFor(); assert.equal(await viewer.locator('img').count(), 0);
    imageMode = 'pass'; await viewer.getByRole('button', { name: '重试加载', exact: true }).click(); await until(ready);
    imageMode = 'hold'; reads = []; await viewer.getByRole('button', { name: '上一张', exact: true }).click(); await until(() => reads.length > 0);
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('chatgpt2api'); open.onerror = reject; open.onsuccess = () => {
        const db = open.result, tx = db.transaction('auth', 'readwrite'); tx.objectStore('auth').put('ticket08-B', 'chatgpt2api_auth_key');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject;
      };
    }));
    reads.forEach(read => read.release()); await viewer.getByRole('alert').waitFor();
    assert.equal(await viewer.locator('img').count(), 0, 'identity change clears retained image');
    await viewer.getByRole('button', { name: '关闭', exact: true }).click();
    assert.deepEqual(errors, []);
    console.log('PASS: zero-start successful quota accumulation, whole-pool completion, automatic and manual recovery, failed reconciliation; settings alignment; 4/6-image responsive grids and prompt folding; decoded image handoff, stale requests, retry, deletion, revoked access and identity change.');
  } catch (error) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') });
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
