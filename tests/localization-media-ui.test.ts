import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {build} from 'tsdown';
import {chromium} from 'playwright-core';
import {detectEnvironment} from '../src/host/renderer.ts';

const environment=detectEnvironment();

test('model errors and notices switch language while custom history labels stay verbatim',{skip:!environment.browserAvailable,timeout:60_000},async()=>{
  const directory=path.resolve('artifacts/localization-media-'+randomUUID());
  await fs.mkdir(directory,{recursive:true});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const server=createServer(async(req,res)=>{
    if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(directory,'fixture.js')));return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>');
  });
  try{
    const entry=path.join(directory,'fixture.tsx');
    await fs.writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';
      import {ModelCenter} from ${JSON.stringify(path.resolve('src/client/ModelCenter.tsx'))};
      import {HistoryPanel} from ${JSON.stringify(path.resolve('src/client/TaskPanel.tsx'))};
      import {StudioRequestError} from ${JSON.stringify(path.resolve('src/client/controller.ts'))};
      import {setLocale} from ${JSON.stringify(path.resolve('src/client/i18n.ts'))};
      const connection={id:'connection',name:'用户连接：预览',protocol:'images',baseUrl:'https://example.com/v1',auth:'none',enabled:true,revision:1,requestTimeoutMs:90000,concurrency:1,hasKey:false};
      const catalog={version:1,connections:[connection],models:[],roles:[]};window.saves=0;
      const api={async call(endpoint){if(endpoint==='models.list')return catalog;if(endpoint==='models.connection.save'){window.saves++;return connection;}if(endpoint==='models.discover')throw new StudioRequestError('模型目录鉴权失败（HTTP 401），请检查 API Key 和权限。','MODEL_DISCOVERY_AUTH');throw new Error(endpoint);}};
      const state={history:{entries:[{id:'entry',label:'预览',revision:1,createdAt:'2026-11-16T00:00:00Z'}],cursor:0},canUndo:false,canRedo:false};
      const controller={subscribe:()=>()=>{},getSnapshot:()=>state,refreshHistory:async()=>{}};
      setLocale('en');createRoot(document.getElementById('root')).render(<><button data-testid="en" onClick={()=>setLocale('en')}>English</button><button data-testid="zh" onClick={()=>setLocale('zh')}>中文</button><ModelCenter api={api}/><HistoryPanel controller={controller}/></>);`);
    await build({entry:{fixture:entry},outDir:directory,clean:false,format:'esm',platform:'browser',inputOptions:{platform:'browser'},deps:{alwaysBundle:[/.*/]},dts:false,sourcemap:false,logLevel:'silent'});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:environment.browserPath,headless:true});
    const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);
    await page.getByLabel('Saved model connections',{exact:true}).selectOption('connection');
    assert.equal(await page.locator('.vs-history-list strong').textContent(),'预览');
    await page.getByRole('button',{name:'Fetch model list',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Could not fetch the model list. Model catalog authentication failed (HTTP 401). Check the API key and permissions.'}).waitFor();
    await page.getByTestId('zh').click();
    await page.getByRole('alert').filter({hasText:'拉取模型列表失败。模型目录鉴权失败（HTTP 401），请检查 API Key 和权限。'}).waitFor();
    await page.getByTestId('en').click();
    await page.getByRole('alert').filter({hasText:'Could not fetch the model list. Model catalog authentication failed (HTTP 401).'}).waitFor();
    assert.equal(await page.locator('.vs-history-list strong').textContent(),'预览');
    assert.equal(await page.evaluate(()=>(window as any).saves),0,'Language changes must not save model settings');
    await page.getByRole('button',{name:'Save connection',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Connection saved.'}).waitFor();
    await page.getByTestId('zh').click();
    await page.getByRole('status').filter({hasText:'连接已保存。'}).waitFor();
    await page.getByTestId('en').click();
    await page.getByRole('status').filter({hasText:'Connection saved.'}).waitFor();
    assert.equal(await page.getByLabel('Connection name',{exact:true}).inputValue(),'用户连接：预览');
    assert.equal(await page.locator('.vs-history-list strong').textContent(),'预览');
    assert.equal(await page.evaluate(()=>(window as any).saves),1);
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await fs.rm(directory,{recursive:true,force:true});
  }
});
