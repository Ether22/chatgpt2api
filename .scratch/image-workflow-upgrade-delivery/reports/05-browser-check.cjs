const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'http://127.0.0.1:43150';
const output = path.join(__dirname, '05-evidence');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check) { for (let i=0; i<200; i++) { if(await check()) return; await sleep(100); } throw Error('Timed out'); }
async function login(page, who) {
  await page.goto(origin+'/login/');
  await page.getByLabel('密钥', {exact:true}).fill('ticket05-'+who);
  await page.getByRole('button', {name:'登录',exact:true}).click();
  await page.waitForURL('**/accounts/');
  await page.goto(origin+'/image/');
  await page.getByRole('button', {name:'上传 MD 和参考图',exact:true}).waitFor();
}
async function logout(page) { await page.getByRole('button', {name:'退出',exact:true}).click(); await page.waitForURL('**/login/'); }
(async()=>{
  await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch({headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});
  await context.route('**/*', route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addInitScript(() => {
    window.errorToastPeak = 0;
    new MutationObserver(() => { window.errorToastPeak = Math.max(window.errorToastPeak, document.querySelectorAll('[data-sonner-toast][data-type=error]').length); }).observe(document, {subtree:true,childList:true});
  });
  const page=await context.newPage(); page.setDefaultTimeout(15000);
  const errors=[], uploads=[], taskReads=[], detailReads=[], statuses=[];
  context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response', r => { if(r.url().endsWith('/api/image-tasks/query')) void r.json().then(body=>statuses.push(...body.items.map(item=>({id:item.id,status:item.status})))).catch(()=>{}); });
  page.on('request',r=>{
    if(r.url().endsWith('/api/image-tasks/query')) taskReads.push(r.url());
    if(/\/api\/image-conversations\/[^/?]+\?/.test(r.url())) detailReads.push(r.url());
  });
  context.on('request',r=>{if(r.url().endsWith('/api/image-references')&&r.method()==='POST') uploads.push({auth:r.headers().authorization,body:r.postDataBuffer()?.toString()});});
  const png=await fs.readFile(path.join(__dirname,'04-evidence','reference.png'));
  const files=['one.png','two.png'].map(name=>({name,mimeType:'image/png',buffer:png}));
  const refs=who=>context.request.get(origin+'/api/image-references',{headers:{Authorization:'Bearer ticket05-'+who}}).then(r=>r.json());
  await login(page,'A');
  let release, entered=false;
  await page.route('**/api/image-references',async route=>{
    if(route.request().method()!=='POST') return route.continue();
    const response=await route.fetch(); entered=true;
    await new Promise(resolve=>release=resolve); await route.fulfill({response}).catch(()=>{});
  });
  await page.locator('input[type=file]').first().setInputFiles(files);
  await eventually(()=>entered);
  await page.locator('textarea').fill('A private queued prompt');
  await logout(page);
  // SPA login preserves the original pending JS context.
  await page.getByLabel('密钥',{exact:true}).fill('ticket05-B');
  await page.getByRole('button',{name:'登录',exact:true}).click(); await page.waitForURL('**/accounts/');
  await page.getByRole('link',{name:'生图',exact:true}).click();
  await page.getByRole('button',{name:'上传 MD 和参考图',exact:true}).waitFor();
  release(); await sleep(1500);
  assert.equal(uploads.length,1); assert.equal(uploads[0].auth,'Bearer ticket05-A');
  assert.equal((await refs('B')).items.length,0); assert.equal(await page.locator('textarea').inputValue(),'');
  assert.equal(await page.getByLabel(/预览参考图/).count(),0);
  await page.unroute('**/api/image-references');
  // A second tab changes the shared identity during a second serial upload queue.
  await logout(page); await login(page,'A');
  entered=false;
  await page.route('**/api/image-references',async route=>{
    if(route.request().method()!=='POST') return route.continue();
    const response=await route.fetch(); entered=true;
    await new Promise(resolve=>release=resolve); await route.fulfill({response}).catch(()=>{});
  });
  await page.locator('input[type=file]').first().setInputFiles(files.map(f=>({...f,name:'cross-'+f.name})));
  await eventually(()=>entered);
  const other=await context.newPage();
  await other.goto(origin+'/image/'); await other.getByRole('button',{name:'退出',exact:true}).waitFor(); await logout(other); await login(other,'B');
  await eventually(()=>page.locator('textarea').inputValue().then(v=>v===''));
  await sleep(1300); release(); await sleep(700);
  assert.equal(uploads.length,2); assert.equal((await refs('B')).items.length,0);
  assert.equal(await page.getByLabel(/预览参考图/).count(),0); await other.close(); await page.unroute('**/api/image-references');
  // Three independent turns are accepted while earlier work is still running.
  const beforeDetails=detailReads.length;
  for(const prompt of ['first slow round','second slow round','controlled-error']) {
    await page.locator('textarea').fill(prompt); await page.getByRole('button',{name:'生成图片',exact:true}).click();
    await eventually(()=>page.locator('textarea').inputValue().then(v=>v===''));
  }
  await page.getByText('失败详情',{exact:true}).first().waitFor();
  await sleep(3500);
  const history=await (await context.request.get(origin+'/api/image-conversations',{headers:{Authorization:'Bearer ticket05-B'}})).json();
  const conversation=await (await context.request.get(origin+'/api/image-conversations/'+history.current_conversation_id+'?offset=0&limit=10',{headers:{Authorization:'Bearer ticket05-B'}})).json();
  assert.equal(conversation.turns.length,3);
  assert(conversation.turns[1].createdAt < conversation.turns[0].images[0].updatedAt);
  assert(taskReads.length>0);
  const detailsAfterComplete=detailReads.length; await sleep(4500); assert.equal(detailReads.length,detailsAfterComplete);
  assert.equal(await page.evaluate(()=>window.errorToastPeak),1);
  await page.getByText('失败详情',{exact:true}).first().click();
  await page.getByRole('button',{name:'复制失败详情',exact:true}).first().click();
  const copied=await page.evaluate(()=>navigator.clipboard.readText());
  assert(JSON.parse(copied).task_id); assert(!copied.includes('hidden-secret'));
  await page.screenshot({path:path.join(output,'errors-and-concurrent-rounds.png')});
  await page.setViewportSize({width:390,height:844});
  assert(await page.getByText('controlled timeout Authorization: [REDACTED]',{exact:true}).first().evaluate(element => { const box=element.getBoundingClientRect(), card=element.closest('div.overflow-auto').getBoundingClientRect(); return box.height>10 && box.top>=card.top && box.bottom<=card.bottom; }));
  await page.screenshot({path:path.join(output,'errors-narrow.png')});
  await page.setViewportSize({width:1440,height:1000});
  // Make this selected conversation fall outside the first metadata page.
  for(let n=0;n<31;n++) await context.request.post(origin+'/api/image-conversations',{headers:{Authorization:'Bearer ticket05-B'},data:{request_id:'metadata-page-'+n}});
  await sleep(2300);
  const currentId=conversation.id;
  await context.request.put(origin+'/api/image-conversations/current',{headers:{Authorization:'Bearer ticket05-B'},data:{conversation_id:currentId}});
  const remotePage=await context.newPage(); await remotePage.goto(origin+'/image/');
  await remotePage.getByRole('button',{name:'继续等待',exact:true}).first().waitFor();
  const oldErrors=await page.getByText('失败详情',{exact:true}).count();
  const taskId=JSON.parse(copied).task_id;
  await remotePage.getByRole('button',{name:'继续等待',exact:true}).first().click();
  await eventually(()=>statuses.some(item=>item.id===taskId&&item.status==='running'));
  await eventually(()=>statuses.some(item=>item.id===taskId&&item.status==='success'));
  await eventually(async()=>await page.getByText('失败详情',{exact:true}).count()===oldErrors-1);
  await page.screenshot({path:path.join(output,'remote-resume-synchronized.png')});
  await remotePage.close();

  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'metrics.json'),JSON.stringify({uploads:uploads.map(u=>({auth:u.auth})),taskReads:taskReads.length,detailReads:detailReads.length-beforeDetails,turns:conversation.turns.length,remoteResume:statuses.filter(item=>item.id===JSON.parse(copied).task_id),copied:JSON.parse(copied),errors},null,2));
  await browser.close(); console.log('PASS identity queues, cross-tab switch, concurrent turns, incremental reads, coalesced errors, copy');
})().catch(error=>{console.error(error);process.exit(1)});
