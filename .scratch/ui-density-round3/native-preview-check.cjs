const assert=require('node:assert/strict');
const {chromium}=require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
const origin='http://127.0.0.1:43280',headers={Authorization:'Bearer ticket08-A'};
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
const context=await browser.newContext();await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
const source=await (await context.request.get(origin+'/api/images?limit=1',{headers})).json();
const bytes=await (await context.request.get(origin+new URL(source.items[0].url).pathname,{headers})).body();
const external='https://preview.example.test/image.png', data='data:image/png;base64,'+bytes.toString('base64');
await context.route('**/api/images?*',r=>r.fulfill({json:{...source,items:[external,data].map((url,i)=>({...source.items[0],rel:'native-'+i,url})),pagination:{...source.pagination,total:2,offset:0,limit:12,next_offset:null}}}));
const page=await context.newPage();let publicRead=false;
await page.route(external,r=>{assert.equal(r.request().headers().authorization,undefined);publicRead=true;return r.fulfill({contentType:'image/png',body:bytes});});
await page.goto(origin+'/login/');await page.getByLabel('密钥',{exact:true}).fill('ticket08-A');await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/accounts/');await page.goto(origin+'/image-manager/');
await page.locator('button:has(img)').first().click();const viewer=page.getByRole('dialog',{name:'图片预览'});
await page.waitForFunction(()=>document.querySelector('[role="dialog"] img')?.naturalWidth>0);
assert.equal(await viewer.locator('img').getAttribute('src'),external);assert(publicRead);
await viewer.getByRole('button',{name:'下一张',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[role="dialog"] img')?.src.startsWith('data:'));
assert(await viewer.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0));
console.log('PASS: public image without CORS and data URL decode; external host receives no identity key.');
} finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
