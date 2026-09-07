const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin='http://127.0.0.1:43151',headers={Authorization:'Bearer ticket05-A'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let n=0;n<150;n++){if(await check())return;await sleep(100)}throw Error('Timed out');}
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await context.newPage(),errors=[],mutations=[];
 page.on('pageerror',e=>errors.push(e.message));
 const png=await fs.readFile(path.join(__dirname,'04-evidence','reference.png'));
 const uploaded=await (await context.request.post(origin+'/api/image-references',{headers,multipart:{request_id:'seed-reference',file:{name:'guard-reference.png',mimeType:'image/png',buffer:png}}})).json();
 const created=await (await context.request.post(origin+'/api/image-conversations/turns',{headers,data:{request_id:'guard-round',prompt:'guard original prompt',count:1,referenceImages:[{id:uploaded.id}]}})).json();
 const read=()=>context.request.get(origin+'/api/image-conversations/'+created.id,{headers}).then(r=>r.json());
 await until(async()=>(await read()).turns[0].images[0].status==='success');
 async function login(who){await page.goto(origin+'/login/');await page.getByLabel('密钥',{exact:true}).fill('ticket05-'+who);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/accounts/');await page.goto(origin+'/image/');await page.getByRole('button',{name:'上传 MD 和参考图',exact:true}).waitFor();}
 async function switchTo(who){await page.getByRole('button',{name:'退出',exact:true}).click();await page.waitForURL('**/login/');await page.getByLabel('密钥',{exact:true}).fill('ticket05-'+who);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/accounts/');await page.getByRole('link',{name:'生图',exact:true}).click();await page.getByRole('button',{name:'上传 MD 和参考图',exact:true}).waitFor();}
 page.on('request',r=>{if(r.url().includes('/api/image-references')&&r.method()!=='GET')mutations.push({method:r.method(),url:r.url(),auth:r.headers().authorization});});
 await login('A');
 let release,entered=false;
 await page.route('**/api/image-references/*/retain',async route=>{const response=await route.fetch();entered=true;await new Promise(resolve=>release=resolve);await route.fulfill({response}).catch(()=>{});});
 const join=page.getByRole('button',{name:'加入编辑',exact:true}).first();
 await join.click();await until(()=>entered);await join.click();
 await page.getByLabel('移除参考图 guard-reference.png',{exact:true}).click();
 await switchTo('B');release();await sleep(1800);
 assert.equal(mutations.length,1);assert.equal(mutations[0].auth,'Bearer ticket05-A');
 assert.equal(await page.locator('textarea').inputValue(),'');
 assert.equal(await page.getByLabel(/预览参考图/).count(),0);
 await page.unroute('**/api/image-references/*/retain');
 // An old generated-result download completes only after the identity switch.
 await switchTo('A');
 await page.getByRole('button',{name:'加入编辑',exact:true}).last().waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-image-frame] img')].every(i=>i.complete&&i.naturalWidth>0));
 const result=(await read()).turns[0].images[0].url;
 entered=false;
 await page.route('**'+new URL(result,origin).pathname,async route=>{const response=await route.fetch();entered=true;await new Promise(resolve=>release=resolve);await route.fulfill({response}).catch(()=>{});});
 await page.getByRole('button',{name:'加入编辑',exact:true}).last().click();await until(()=>entered);
 await switchTo('B');release();await sleep(1800);
 assert.equal(mutations.length,1);assert.equal(await page.getByLabel(/预览参考图/).count(),0);
 assert.equal(await page.locator('textarea').inputValue(),'');
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(__dirname,'05-evidence','reference-guards.json'),JSON.stringify({queuedRetainAndReleaseBlocked:true,lateResultAppendBlocked:true,mutations,errors},null,2));
 await browser.close();console.log('PASS queued retain/release and late append identity guards');
})().catch(error=>{console.error(error);process.exit(1)});
