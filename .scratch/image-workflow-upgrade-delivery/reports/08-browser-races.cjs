// Supplement main flow: switch conversation during pending upload; stale accepted reply after identity change.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin='http://127.0.0.1:43180', headers={Authorization:'Bearer ticket08-A'};
async function eventually(fn) { for(let i=0;i<250;i++){ if(await fn())return; await new Promise(r=>setTimeout(r,80)); } throw Error('Timed out'); }
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}), errors=[];
  await context.route('**/*', r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  const get=async route=>(await context.request.get(origin+route,{headers})).json();
  async function login(page,key='A'){
    await page.goto(origin+'/login/'); await page.getByLabel('密钥',{exact:true}).fill('ticket08-'+key);
    await page.getByRole('button',{name:'登录',exact:true}).click(); await page.waitForURL('**/accounts/'); await page.goto(origin+'/image/');
  }
  async function open(page){await page.getByRole('button',{name:'上传 MD 和参考图',exact:true}).click();await eventually(()=>page.getByRole('button',{name:'点击或拖入一个 MD 文件',exact:true}).isEnabled());}
  try{
    const page=await context.newPage(); await login(page);
    const original=(await get('/api/image-conversations')).current_conversation_id;
    const before=(await get(`/api/image-conversations/${original}/metadata`)).turnCount;
    const content='## [P01] Pending source｜800x600\n参考图：not-arrived.png\n### Prompt\n~~~text\nPending across conversations\n~~~';
    let state=await get('/api/image-imports');
    const bytes=await fs.readFile(path.resolve(__dirname,'../../../data/ticket08/slow.png'));
    assert.equal((await context.request.post(origin+'/api/image-imports/references',{headers,data:{request_id:'races-upload',version:state.version,name:'not-arrived.png',size:bytes.length}})).status(),200);
    await open(page);
    await page.getByLabel('选择 MD 文件',{exact:true}).setInputFiles({name:'races.md',mimeType:'text/markdown',buffer:Buffer.from(content)});
    await page.getByRole('article',{name:'条目 P01 Pending source',exact:true}).waitFor();
    await page.getByLabel('批量生成数量',{exact:true}).fill('1');
    const acceptedEvent=page.waitForResponse(r=>r.url().endsWith('/api/image-imports/batches'));
    await page.getByRole('button',{name:/^开始生成/}).click(); assert.equal((await acceptedEvent).status(),200);
    await page.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('button',{name:'新建对话',exact:true}).click();
    await eventually(async()=>(await get('/api/image-conversations')).current_conversation_id!==original);
    const next=(await get('/api/image-conversations')).current_conversation_id;
    await page.getByPlaceholder('输入你想要生成的画面，也可直接粘贴图片').fill('Independent new conversation');
    await page.getByRole('button',{name:'生成图片',exact:true}).click();
    await eventually(async()=>{const h=await get(`/api/image-conversations/${next}`);return h.turns.length===1&&h.turns[0].images[0].status==='success';});
    const waiting=(await get(`/api/image-conversations/${original}`)).turns.at(-1);
    assert.equal(waiting.images[0].status,'loading');
    await page.screenshot({path:path.join(__dirname,'08-evidence','independent-conversation-pending.png')});
    await context.request.post(origin+'/ticket08-restart');
    assert.equal((await get(`/api/image-conversations/${original}`)).turns.at(-1).images[0].status,'loading');
    assert.equal((await context.request.put(origin+'/api/image-imports/references/races-upload',{headers,multipart:{file:{name:'not-arrived.png',mimeType:'image/png',buffer:bytes}}})).status(),200);
    await eventually(async()=>(await get(`/api/image-conversations/${original}`)).turns.at(-1).images[0].status==='success');
    assert.equal((await get(`/api/image-conversations/${original}/metadata`)).turnCount,before+1);
    assert.equal((await get('/api/image-conversations')).current_conversation_id,next);
    await open(page);
    let releaseResponse, notifyAccepted;
    const held=new Promise(r=>{releaseResponse=r;}), arrived=new Promise(r=>{notifyAccepted=r;});
    let submitted;
    await page.route('**/api/image-imports/batches',async route=>{
      submitted={body:route.request().postDataJSON(),authorization:route.request().headers().authorization};
      const response=await route.fetch(); assert.equal(response.status(),200); notifyAccepted();
      await held; await route.fulfill({response}).catch(()=>{});
    });
    await page.getByRole('button',{name:/^开始生成/}).click(); await arrived;
    const otherTab=await context.newPage(); await otherTab.goto(origin+'/accounts/');
    await otherTab.getByRole('button',{name:'退出',exact:true}).click();
    await otherTab.getByLabel('密钥',{exact:true}).waitFor();
    await login(otherTab,'B');
    releaseResponse();
    await eventually(async()=>(await get(`/api/image-conversations/${next}/metadata`)).turnCount===2);
    assert.equal(submitted.authorization,'Bearer ticket08-A');
    assert.equal(submitted.body.conversation_id,next);
    await page.reload();
    await eventually(()=>page.getByRole('button',{name:'上传 MD 和参考图',exact:true}).isVisible());
    await open(page); assert.equal(await page.getByRole('article').count(),0);
    const bHistory=await (await context.request.get(origin+'/api/image-conversations',{headers:{Authorization:'Bearer ticket08-B'}})).json();
    assert.equal(bHistory.items.length,0);
    await page.screenshot({path:path.join(__dirname,'08-evidence','late-reply-identity-b.png')});
    assert.deepEqual(errors,[]);
    const result={passed:true,errors,switchedFrom:original,switchedTo:next,acceptedAuthorization:submitted.authorization,pendingResumedAfterRestart:true};
    await fs.writeFile(path.join(__dirname,'08-evidence','races-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
