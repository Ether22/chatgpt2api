// Reuse the unchanged 13 browser assertions, on 05's port and evidence directory.
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '13-browser-check.cjs'), 'utf8')
  .replaceAll('127.0.0.1:43230', '127.0.0.1:43240').replaceAll('13-evidence', '14-pagination-evidence')
  // The metadata response precedes the selected-page response and React's continuation reset.
  .replace('    const nextPage = page.waitForResponse', "    await page.waitForFunction(() => [30, 31].includes(document.querySelectorAll('aside button.block.w-full').length));\n    const nextPage = page.waitForResponse");
new Function('require', '__dirname', source)(require, __dirname);
