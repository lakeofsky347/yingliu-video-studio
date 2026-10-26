import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {build} from 'tsdown';
import {chromium} from 'playwright-core';
import {ProjectHub} from '../src/host/project-hub.ts';
import {createProject} from '../src/core/index.ts';
import {detectEnvironment} from '../src/host/renderer.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {StudioSnapshot} from '../src/shared/types.ts';

const env=detectEnvironment();
test('preview keeps one live iframe, loads cached PNG thumbnails and does not render thumbnails during playback',{
  skip:!env.browserAvailable,timeout:60_000,
},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'preview-performance-'));
  const fixtureDirectory=path.resolve('artifacts/preview-test-'+randomUUID());await fs.mkdir(fixtureDirectory,{recursive:true});
  const context:HostContext={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No model calls in rendering tests');}},connection:{fetch:{register:()=>async()=>{}}},effect:()=>{}};
  const hub=new ProjectHub(context,{baseDirectory:directory});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,thumbnailRequests=0;
  const server=createServer(async(req,res)=>{
    try{
      if(req.url==='/rpc'&&req.method==='POST'){
        let body='';for await(const chunk of req)body+=String(chunk);thumbnailRequests++;
        const data=JSON.parse(body),value=await hub.call('thumbnails',data);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;
      }
      if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(fixtureDirectory,'fixture.js')));return;}
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>'+await fs.readFile('src/client/styles.css','utf8')+'</style><div id="root" class="vs-studio"></div><script type="module" src="/fixture.js"></script>');
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  try{
    const project=createProject('缩略图交互验收');project.shots=project.shots.slice(0,2);project.shotOrder=project.shots.map(shot=>shot.id);project.shots.forEach(shot=>shot.durationFrames=12);project.target={width:640,height:360,fps:{num:12,den:1},audioMode:'none'};project.targetDuration=2;
    const snapshot=await hub.call<StudioSnapshot>('create',{project});
    const entry=path.join(fixtureDirectory,'fixture.tsx');
    await fs.writeFile(entry,`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {Preview} from ${JSON.stringify(path.resolve('src/client/Preview.tsx'))};
      const snapshot=${JSON.stringify(snapshot)};const controller={api:{call:async(_endpoint,payload)=>{const response=await fetch('/rpc',{method:'POST',body:JSON.stringify(payload)});if(!response.ok)throw new Error(await response.text());return response.json();}},notify:message=>{throw new Error(message);}};
      function Fixture(){const [selected,setSelected]=useState(snapshot.project.shots[0]);return <><button onClick={()=>setSelected(snapshot.project.shots[1])}>选中第二镜头</button><Preview snapshot={snapshot} project={snapshot.project} selectedShot={selected} controller={controller}/></>;}
      createRoot(document.getElementById('root')).render(<Fixture/>);`);
    await build({entry:{fixture:entry},outDir:fixtureDirectory,clean:false,format:'esm',platform:'browser',inputOptions:{platform:'browser'},deps:{alwaysBundle:[/.*/]},dts:false,sourcemap:false,logLevel:'silent'});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:env.browserPath,headless:true});const page=await browser.newPage({viewport:{width:1100,height:650}}),errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);
    await page.waitForFunction(()=>document.querySelectorAll('.vs-keyframes img').length===3&&[...document.querySelectorAll<HTMLImageElement>('.vs-keyframes img')].every(image=>image.complete&&image.naturalWidth>0));
    assert.equal(await page.locator('iframe').count(),1);assert.equal(await page.locator('.vs-keyframes iframe').count(),0);assert.equal(thumbnailRequests,1);
    const {service}=await hub.resolveProject({projectId:snapshot.project!.id});assert.equal((service.renderer as any).browsers.size,0);
    await page.getByRole('button',{name:'播放',exact:true}).click();await page.waitForFunction(()=>Number(document.querySelector('[data-testid="current-frame"]')?.textContent)>=2);await page.getByRole('button',{name:'暂停',exact:true}).click();assert.equal(thumbnailRequests,1);
    await page.getByRole('button',{name:'选中第二镜头',exact:true}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll<HTMLImageElement>('.vs-keyframes img')].length===3&&[...document.querySelectorAll<HTMLImageElement>('.vs-keyframes img')].every(image=>image.complete&&image.naturalWidth>0));
    assert.equal(thumbnailRequests,2);assert.match(await page.locator('.vs-keyframes').innerText(),/F12/);assert.equal(await page.locator('iframe').count(),1);
    const screenshotRoot=process.env.VIDEO_STUDIO_TEST_ARTIFACTS?path.resolve(process.env.VIDEO_STUDIO_TEST_ARTIFACTS):fixtureDirectory;
    await fs.mkdir(screenshotRoot,{recursive:true});await page.screenshot({path:path.join(screenshotRoot,'preview-performance.png'),fullPage:true});assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await hub.dispose();await fs.rm(directory,{recursive:true,force:true});await fs.rm(fixtureDirectory,{recursive:true,force:true});}
});
