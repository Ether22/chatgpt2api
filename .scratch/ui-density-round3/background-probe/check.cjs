const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const runtime = 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/';
const { chromium } = require(runtime + 'playwright');
const { PNG } = require(runtime + 'pngjs');

(async () => {
  const root = path.resolve(__dirname, '../../..');
  const css = await fs.readFile(path.join(root, '.venv/integration-check/web/out/_next/static/chunks/0z3muh~wtix4p.css'), 'utf8');
  const layout = await fs.readFile(path.join(root, 'web/src/app/layout.tsx'), 'utf8');
  const mainClass = layout.match(/<main className="([^"]+)"/)[1];
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const reports = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    for (const theme of ['light', 'dark']) {
      for (const variant of ['current', 'main-fixed', 'all-fixed']) {
        for (const rows of [3, 20, 100]) {
          const fixes = variant === 'main-fixed' ? 'main{background-attachment:fixed}' : variant === 'all-fixed' ? 'html,body,main{background-attachment:fixed}' : '';
          const html = `<!doctype html><html class="${theme === 'dark' ? 'dark' : ''}"><head><meta charset="utf-8"><style>${css}</style><style>${fixes}</style></head><body class="antialiased" style="font-family:sans-serif"><main class="${mainClass}"><div class="mx-auto box-border flex min-h-screen max-w-[1440px] flex-col gap-2 pt-[env(safe-area-inset-top)] sm:gap-5 sm:pt-0"><nav style="height:48px">离线合成：${rows} 行，${variant}</nav><section style="height:300px"><h1>号池管理背景验证</h1><div style="margin-top:24px;height:180px" class="rounded-2xl border border-white/80 bg-white/90">合成指标卡；无应用脚本、无网络</div></section><section class="rounded-2xl border border-white/80 bg-white/90" style="overflow:hidden"><div style="height:150px">合成账户列表</div>${Array.from({length:rows}, (_,i)=>`<div class="bg-white border-b border-stone-100/80" style="height:77px;padding:24px">合成账号 ${i+1}</div>`).join('')}<div style="height:75px">分页</div></section></div></main></body></html>`;
          await page.setContent(html);
          const styles = await page.evaluate(() => Object.fromEntries(['html','body','main'].map(tag => { const el = document.querySelector(tag); const s = getComputedStyle(el); return [tag,{height:el.getBoundingClientRect().height,backgroundImage:s.backgroundImage,attachment:s.backgroundAttachment}]; })));
          for (const position of ['top','bottom']) {
            await page.evaluate(p => window.scrollTo(0,p === 'bottom' ? document.documentElement.scrollHeight : 0), position);
            const file = `${theme}-${variant}-${rows}-${position}.png`;
            const bytes = await page.screenshot({ path: path.join(__dirname,file) });
            const png = PNG.sync.read(bytes);
            const samples = [[8,100],[8,500],[8,900],[1430,500]].map(([x,y]) => ({x,y,rgba:Array.from(png.data.subarray((y*png.width+x)*4,(y*png.width+x)*4+4))}));
            reports.push({theme,variant,rows,position,styles,samples,file});
          }
        }
      }
    }
    await fs.writeFile(path.join(__dirname,'results.json'),JSON.stringify(reports,null,2));
    for (const theme of ['light','dark']) {
      const fixed = reports.filter(r => r.theme === theme && r.variant === 'all-fixed' && r.position === 'top');
      for (const report of fixed) assert.deepEqual(report.samples,fixed[0].samples,`${theme}: page height changes fixed first-screen background`);
      const unfixed = reports.filter(r => r.theme === theme && r.variant === 'current' && r.position === 'top');
      assert.notDeepEqual(unfixed[0].samples,unfixed[2].samples,`${theme}: probe does not reproduce page-height background change`);
    }
    console.log('PASS: both themes reproduce page-height background change; fixing all three layers makes first-screen pixels identical at 3, 20, and 100 rows.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
