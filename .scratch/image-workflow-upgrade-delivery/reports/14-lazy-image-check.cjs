// Coalesce real observer records to reproduce slow-frame delivery, keeping real PNG reads/decodes.
const fs = require('node:fs');
let source = fs.readFileSync(require('node:path').join(__dirname, '13-browser-check.cjs'), 'utf8')
  .replaceAll('127.0.0.1:43230', '127.0.0.1:43240')
  .replaceAll('13-evidence', '14-lazy-evidence')
  .replace('await context.addInitScript(() => {', `await context.addInitScript(() => {
    const NativeObserver = IntersectionObserver;
    window.coalescedVisible = 0;
    window.holdLazy = false;
    window.lazyObservers = new Set();
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) {
        let queued = [];
        super((entries, observer) => {
          if (options?.rootMargin !== '400px') return callback(entries, observer);
          if (window.holdLazy) queued.push(...entries);
          else callback(entries, observer);
        }, options);
        this.flush = () => {
          if (!queued.length) return;
          const batch = queued; queued = [];
          if (!batch[0].isIntersecting && batch.at(-1).isIntersecting) window.coalescedVisible++;
          callback(batch, this);
        };
        window.lazyObservers.add(this);
      }
      disconnect() { window.lazyObservers.delete(this); super.disconnect(); }
    };
  `)
  .replace('const savedPosition = await readingPosition();', `const savedPosition = await readingPosition();
    await viewport().evaluate(async element => {
      window.holdLazy = true;
      element.scrollTop = 0;
      await new Promise(resolve => setTimeout(resolve, 100));
      element.scrollTop = 1200;
      await new Promise(resolve => setTimeout(resolve, 100));
      window.holdLazy = false;
      window.lazyObservers.forEach(observer => observer.flush());
    });
    await ready();`);
// The existing flow checks every visible image after scroll-away/back and rapid conversation return.
source = source.slice(0, source.indexOf('    // Target lookup from an unloaded page')) + `
    const coalescedVisible = await page.evaluate(() => window.coalescedVisible);
    assert(coalescedVisible > 0, 'Must exercise a real false-to-true observer batch');
    console.log(JSON.stringify({ coalescedVisible, return_position: timings.return_position }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await browser.close(); }
})();`;
new Function('require', '__dirname', source)(require, __dirname);
