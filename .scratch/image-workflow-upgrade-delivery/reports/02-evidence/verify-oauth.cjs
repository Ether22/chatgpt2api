const { chromium } = require('C:/Users/ForestHill/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try {
    const size = {width:Number(process.argv[2]) || 1280,height:Number(process.argv[3]) || 600};
    const context = await browser.newContext({viewport:size,permissions:['clipboard-read','clipboard-write']});
    const authorizeUrl = 'https://example.invalid/authorize?state=' + 'synthetic-02-'.repeat(180);
    let finishBody;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      let json;
      if (url.pathname === '/auth/login') json = {role:'admin',subject_id:'test-02',name:'Test 02'};
      else if (url.pathname === '/api/accounts') json = {items:[]};
      else if (url.pathname === '/v1/models') json = {data:[]};
      else if (url.pathname === '/api/accounts/oauth/start') json = {session_id:'synthetic-02',authorize_url:authorizeUrl,expires_in:'600',redirect_uri_prefix:'https://example.invalid/callback'};
      else if (url.pathname === '/api/accounts/oauth/finish') {finishBody = route.request().postDataJSON(); json = {items:[],added:1};}
      if (json) return route.fulfill({json});
      if (url.origin === 'http://127.0.0.1:43120') return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror',e=>console.log('pageerror',e.message));
    await page.goto('http://127.0.0.1:43120/login/');
    await page.getByLabel('密钥',{exact:true}).fill('ticket-02-only');
    await page.getByRole('button',{name:'登录',exact:true}).click();
    console.log('logged in');
    await page.getByRole('button',{name:'导入',exact:true}).click();
    console.log('import open');
    await page.getByRole('button',{name:/OAuth 登录已有账号（带自动刷新）/}).click();
    console.log('oauth open');
    await page.getByRole('button',{name:'打开授权页面',exact:true}).click();
    console.log('started');
    for (const other of context.pages()) if (other !== page) await other.close();
    await page.bringToFront();
    await page.getByRole('button',{name:'复制授权 URL',exact:true}).waitFor();
    const results=[];
    for (const scenario of [size]) {
      await page.waitForTimeout(350);
      const dialog = page.getByRole('dialog');
      const box = await dialog.boundingBox();
      const item={size,box}; results.push(item);
      console.log('viewport',item);
      console.log('window',await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,viewport:document.querySelector('meta[name="viewport"]')?.content})));
      console.log('css',await dialog.evaluate(e=>{const s=getComputedStyle(e);return {width:s.width,minWidth:s.minWidth,maxHeight:s.maxHeight,padding:s.padding,visual:visualViewport.width}}));
      if (process.argv.includes('--baseline')) {
        await page.screenshot({path:'data/oauth-before.png'});
        assert.ok(box.y>=0 && box.y+box.height<=size.height,'dialog must fit viewport');
      }
      assert.ok(box.y>=0 && box.y+box.height<=size.height+1,'dialog must fit viewport');
      assert.ok(box.x>=0 && box.x+box.width<=size.width+1,'dialog must fit width');
      await page.getByRole('button',{name:'复制授权 URL',exact:true}).click();
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),authorizeUrl);
      await page.getByPlaceholder('https://platform.openai.com/auth/callback?code=...&state=...').fill('synthetic-callback-02');
      const seen = new Set();
      for(let i=0;i<12;i++) {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(100);
        const focus = await page.evaluate(()=>{const e=document.activeElement; const r=e.getBoundingClientRect(); return {text:e.textContent,placeholder:e.getAttribute('placeholder'),top:r.top,bottom:r.bottom};});
        if (!(focus.top>=0 && focus.bottom<=size.height+1)) { console.log('focus failure',size,{...focus,text:focus.text?.slice(0,80)}); await page.screenshot({path:'data/oauth-focus-failure.png'}); }
        assert.ok(focus.top>=0 && focus.bottom<=size.height+1,'focused control visible');
        seen.add(focus.text || focus.placeholder);
      }
      assert.ok(seen.has('取消') && seen.has('完成导入') && seen.has('复制授权 URL'),'keyboard reaches required actions');
      const footer = await dialog.locator('[data-slot="dialog-footer"]').boundingBox();
      assert.ok(footer.y>=0 && footer.y+footer.height<=size.height+1,'footer visible');
      item.keyboard = 'pass'; item.clipboard = 'full URL matches';
      await page.screenshot({path:`data/oauth-${size.width}x${size.height}.png`});
    }
    await page.getByRole('button',{name:'完成导入',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.deepEqual(finishBody,{session_id:'synthetic-02',callback:'synthetic-callback-02'});
    await page.getByRole('button',{name:'导入',exact:true}).click();
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    fs.writeFileSync(`data/oauth-results-${size.width}x${size.height}.json`, JSON.stringify({results,finishBody,cancel:'pass'},null,2));
    console.log(JSON.stringify({results,finishBody,cancel:'pass'}));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
