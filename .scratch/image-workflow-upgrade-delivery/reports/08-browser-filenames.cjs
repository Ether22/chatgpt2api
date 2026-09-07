const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin='http://127.0.0.1:43180',headers={Authorization:'Bearer ticket08-A'};
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}}),page=await context.newPage();
await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
await page.goto(origin+'/login/');await page.getByLabel('密钥',{exact:true}).fill('ticket08-A');await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/accounts/');await page.goto(origin+'/image/');
await page.getByRole('button',{name:'上传 MD 和参考图',exact:true}).click();await page.getByRole('button',{name:'点击或拖入一个 MD 文件',exact:true}).waitFor();
const name='长任务名称'.repeat(45),content=`## [P01] ${name}｜800x600\n参考图：无\n输出文件名：retained-output.jpg\n### Prompt\n~~~\nLong filename test\n~~~`;
await page.getByLabel('选择 MD 文件',{exact:true}).setInputFiles({name:'long-name.md',mimeType:'text/markdown',buffer:Buffer.from(content)});
await page.getByRole('article',{name:'条目 P01 '+name,exact:true}).waitFor();await page.getByLabel('批量生成数量',{exact:true}).fill('2');
const event=page.waitForResponse(r=>r.url().endsWith('/api/image-imports/batches'));await page.getByRole('button',{name:/^开始生成/}).click();const response=await event;assert.equal(response.status(),200);const saved=await response.json(),turn=saved.turns.at(-1);
await page.getByRole('button',{name:'完成',exact:true}).click();const latest=page.getByRole('button',{name:'最新结果',exact:true});if(await latest.isEnabled())await latest.click();
const row=page.locator(`[data-turn-id="${turn.id}"]`);await row.getByRole('button',{name:'下载',exact:true}).nth(1).waitFor();const names=[];
for(let i=0;i<2;i++){const downloadEvent=page.waitForEvent('download');await row.getByRole('button',{name:'下载',exact:true}).nth(i).click();const download=await downloadEvent;names.push(download.suggestedFilename());}
assert.notEqual(names[0],names[1]);assert.ok(names[0].endsWith('_1_retained-output.png'));assert.ok(names[1].endsWith('_2_retained-output.png'));assert.ok(names.every(n=>n.startsWith('P01_长任务名称')&&n.length<=180));
await fs.writeFile(path.join(__dirname,'08-evidence','long-filenames-result.json'),JSON.stringify({passed:true,names},null,2));console.log(JSON.stringify({passed:true,names},null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
