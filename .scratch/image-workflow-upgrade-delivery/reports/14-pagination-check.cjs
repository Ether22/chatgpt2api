// Reuse ticket 13's browser checks with ticket 14's navigation metadata contract.
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '13-browser-check.cjs'), 'utf8')
  .replaceAll('127.0.0.1:43230', '127.0.0.1:43240').replaceAll('13-evidence', '14-pagination-evidence')
  // Detail pages hold at most two rounds; lightweight navigation pages hold ten.
  .replace('assert(reads.filter(read => read.turns !== undefined).every(read => read.turns <= 2));',
    "assert(reads.filter(read => read.turns !== undefined && !read.url.includes('navigation=true')).every(read => read.turns <= 2));\n    assert(reads.filter(read => read.url.includes('navigation=true')).every(read => read.turns <= 10));")
  // The metadata response precedes the selected-page response and React's continuation reset.
  .replace('    const nextPage = page.waitForResponse', "    await page.waitForFunction(() => [30, 31].includes(document.querySelectorAll('aside button.block.w-full').length));\n    const nextPage = page.waitForResponse");
new Function('require', '__dirname', source)(require, __dirname);
