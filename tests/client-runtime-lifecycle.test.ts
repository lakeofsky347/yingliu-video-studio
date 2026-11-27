import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {build} from 'tsdown';
import {chromium} from 'playwright-core';
import {detectEnvironment} from '../src/host/renderer.ts';
import {createCodeProject} from './fixtures/production.ts';

const env=detectEnvironment();
async function browserFixture(mode:'preview'|'source',run:(page:Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newPage']>>)=>Promise<void>){
  const directory=path.resolve('artifacts/client-lifecycle-'+randomUUID());await fs.mkdir(directory,{recursive:true});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const server=createServer(async(req,res)=>{
    if(req.url?.startsWith('/frame')){res.setHeader('Content-Type','text/html');res.end(`<!doctype html><script>
      let last=0;addEventListener('message',event=>{if(event.data?.type==='video-studio/render')last=event.data.frame;if(event.data?.type==='test-frame')parent.postMessage({type:'video-studio/frame',frame:last,sceneId:'current'},'*');});parent.postMessage({type:'video-studio/ready'},'*');
    </script>`);return;}
    if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(directory,'fixture.js')));return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><div id="root" class="vs-studio"></div><script type="module" src="/fixture.js"></script>');
  });
  try{
    const project=createCodeProject('交互测试');project.shots=project.shots.slice(0,2);project.shotOrder=project.shots.map(shot=>shot.id);project.shots.forEach(shot=>shot.durationFrames=12);
    const entry=path.join(directory,'fixture.tsx');
    await fs.writeFile(entry,`import React,{useState,useLayoutEffect} from 'react';import {createRoot} from 'react-dom/client';
      import {Preview} from ${JSON.stringify(path.resolve('src/client/Preview.tsx'))};import {SourceEditor} from ${JSON.stringify(path.resolve('src/client/SourceEditor.tsx'))};
      const project=${JSON.stringify(project)},snapshot={project,previewUrl:location.origin+'/frame',previewRevision:0,audioUrl:null};
      const state={snapshot},drafts=new Map();window.commits=[];window.notifications=[];
      const controller={subscribe:()=>()=>{},getSnapshot:()=>state,confirmedRevision:0,getSourceDraft:id=>drafts.get(id),sourceDrafts:()=>[],readSource:id=>id===project.shots[0].id?Promise.resolve({html:'SOURCE_A',css:'CSS_A',js:'JS_A'}):new Promise(resolve=>window.resolveB=resolve),setSourceDraft:(id,source,revision)=>drafts.set(id,{source,baseRevision:revision}),api:{call:async()=>({frames:[]})},notify:value=>window.notifications.push(value)};
      window.recoveryCalls=[];
      controller.refreshMediaProject=async()=>{window.recoveryCalls.push('current');state.snapshot={...snapshot,project:{...project,revision:2},previewRevision:1};return true;};
      controller.refreshPreview=async()=>{window.recoveryCalls.push('prepare');state.snapshot={...state.snapshot,previewUrl:location.origin+'/frame/latest',previewRevision:2};window.acceptSavedPreview(state.snapshot);return true;};
      function Fixture(){const [selected,setSelected]=useState(project.shots[0]),[version,setVersion]=useState(0),[savedPreview,setSavedPreview]=useState(null);window.selectB=()=>setSelected(project.shots[1]);window.swapPreview=()=>setVersion(v=>v+1);window.acceptSavedPreview=setSavedPreview;
        useLayoutEffect(()=>{window.commits.push({selected:selected.id,value:document.querySelector('textarea')?.value??null});});
        return ${mode==='source'?'<SourceEditor controller={controller} selectedShot={selected} busy={false} version="fixed"/>':'<Preview controller={controller} project={savedPreview?.project??project} snapshot={savedPreview??{...snapshot,previewRevision:version}} busy={true}/>'};}
      addEventListener('message',event=>{if(event.data?.type==='video-studio/ready')window.readyEvents=(window.readyEvents??0)+1;});
      createRoot(document.getElementById('root')).render(<Fixture/>);`);
    await build({entry:{fixture:entry},outDir:directory,clean:false,format:'esm',platform:'browser',inputOptions:{platform:'browser'},deps:{alwaysBundle:[/.*/]},dts:false,sourcemap:false,logLevel:'silent'});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:env.browserPath,headless:true});const page=await browser.newPage();
    await page.clock.install();await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);await run(page);
  }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
}

test('source editor never presents the previous shot source during the first commit of a new identity',{skip:!env.browserAvailable,timeout:60_000},async()=>{
  await browserFixture('source',async page=>{
    await page.waitForFunction(()=>document.querySelector('textarea')?.value==='SOURCE_A');
    await page.evaluate(()=>{(window as any).selectB();});await page.waitForFunction(()=>typeof(window as any).resolveB==='function');
    const commits=await page.evaluate(()=>(window as any).commits);
    assert.equal(commits.at(-1).value,null,'A changed shot must not expose the previous saved source before effects run');
    assert.equal(await page.locator('textarea').count(),0);
    await page.evaluate(()=>(window as any).resolveB({html:'SOURCE_B',css:'CSS_B',js:'JS_B'}));
    await page.waitForFunction(()=>document.querySelector('textarea')?.value==='SOURCE_B');
  });
});

test('preview enables playback only after a real frame, rejects an old iframe and recovers after watchdog timeout',{skip:!env.browserAvailable,timeout:60_000},async()=>{
  await browserFixture('preview',async page=>{
    await page.waitForFunction(()=>(window as any).readyEvents>=1);
    assert.equal(await page.getByRole('button',{name:'播放',exact:true}).isDisabled(),true);
    await page.evaluate(()=>document.querySelector('iframe')!.contentWindow!.postMessage({type:'test-frame'},'*'));
    await page.waitForFunction(()=>!(document.querySelector('button[aria-label="播放"]') as HTMLButtonElement)?.disabled);
    await page.evaluate(()=>{(window as any).oldFrame=document.querySelector('iframe')!.contentWindow;(window as any).swapPreview();});
    await page.waitForFunction(()=>(window as any).readyEvents>=2);
    assert.equal(await page.getByRole('button',{name:'播放',exact:true}).isDisabled(),true);
    await page.evaluate(()=>{dispatchEvent(new MessageEvent('message',{source:(window as any).oldFrame,origin:location.origin,data:{type:'video-studio/frame',frame:0,sceneId:'stale'}}));dispatchEvent(new MessageEvent('message',{source:(window as any).oldFrame,origin:location.origin,data:{type:'video-studio/error',message:'STALE_ERROR'}}));});
    assert.equal(await page.getByRole('button',{name:'播放',exact:true}).isDisabled(),true);assert.equal(await page.getByText('STALE_ERROR',{exact:false}).count(),0);
    await page.clock.runFor(30_100);await page.getByRole('button',{name:'重新加载预览'}).waitFor();
    await page.getByRole('button',{name:'重新加载预览'}).click();await page.waitForFunction(()=>(window as any).readyEvents>=3);
    assert.deepEqual(await page.evaluate(()=>(window as any).recoveryCalls),['current','prepare']);
    assert.match((await page.locator('iframe').getAttribute('src'))??'',/\/frame\/latest\?render=manual$/);
    await page.evaluate(()=>document.querySelector('iframe')!.contentWindow!.postMessage({type:'test-frame'},'*'));
    await page.waitForFunction(()=>!(document.querySelector('button[aria-label="播放"]') as HTMLButtonElement)?.disabled);
    assert.equal(await page.getByRole('alert').count(),0);assert.equal(await page.locator('iframe').count(),1);
  });
});
