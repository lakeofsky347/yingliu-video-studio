import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createProject,compileSpec,defaultSceneSource} from '../src/core/index.ts';
import {VideoRenderer,detectEnvironment} from '../src/host/renderer.ts';
import {ProjectStore} from '../src/host/store.ts';
import {StudioService} from '../src/host/service.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {StudioSnapshot} from '../src/shared/types.ts';
import type {Page} from 'playwright-core';

const env=detectEnvironment(),exec=promisify(execFile);
const mediaAvailable=env.browserAvailable&&env.ffmpegAvailable&&env.ffprobeAvailable;

async function pixels(bytes:Buffer):Promise<string>{
  // Compression is intentionally different between CDP's fast PNG and the generic screenshot.
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'render-pixel-'));
  try{
    const file=path.join(directory,'frame.png');await fs.writeFile(file,bytes);
    return (await exec(env.ffmpegPath,['-v','error','-i',file,'-f','hash','-hash','sha256','-'])).stdout.trim();
  }finally{await fs.rm(directory,{recursive:true,force:true});}
}

test('lossless capture matches the generic screenshot; media is loaded per shot and video decoders are released',{
  skip:!mediaAvailable,timeout:60_000,
},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'render-lazy-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
  let connection:any;
  try{
    const videoFile=path.join(directory,'fixture.mp4'),imageFile=path.join(directory,'fixture.png');
    await exec(env.ffmpegPath,['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=12:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-y',videoFile]);
    await exec(env.ffmpegPath,['-v','error','-f','lavfi','-i','testsrc2=size=160x90:duration=1','-frames:v','1','-y',imageFile]);
    let project=createProject('按镜头解码');project.target={width:320,height:180,fps:{num:12,den:1},audioMode:'none'};
    project.shots.forEach(shot=>shot.durationFrames=4);project.targetDuration=1;
    const created=await store.create(project),image=await store.importAsset(created.root,{path:imageFile},env),videoA=await store.importAsset(created.root,{path:videoFile},env),videoB=await store.importAsset(created.root,{path:videoFile},env);
    project=created.project;project.assets.push(image,videoA,videoB);project.shots[0]!.assetIds=[image.id];
    project.videoClips=[{id:'clip-a',shotId:project.shots[1]!.id,assetId:videoA.id,trimStart:0,speed:1,fit:'contain',audio:'mute'},{id:'clip-b',shotId:project.shots[2]!.id,assetId:videoB.id,trimStart:0,speed:1,fit:'cover',audio:'mute'}];
    const source=defaultSceneSource();source.html+='<span data-reset hidden>clean</span><script>window.unexpectedScript=true;</script>';
    source.js=source.js.replace('export function render(ctx) {',`export function render(ctx) {
      const marker=ctx.root.querySelector('[data-reset]');
      if(marker.textContent!=='clean'||ctx.params.text==='MUTATED'||ctx.ctx2d.globalAlpha!==1||ctx.ctx2d.getTransform().e!==0)throw new Error('Frame state leaked');
      marker.textContent='changed';`).replace('  g.restore();','  g.restore();ctx.params.text="MUTATED";g.globalAlpha=.1;g.translate(10,0);');
    project.revision++;project=await store.commit(created.root,project,{[project.shots[0]!.id]:source});
    const url=await renderer.preview(created.root,project),spec=compileSpec(project),errors:unknown[]=[];
    connection=await (renderer as any).openPage(url,spec,env,errors);
    const page:Page=connection.page,requests:string[]=[];
    page.on('request',request=>requests.push(new URL(request.url()).pathname));
    await page.evaluate(()=>{const original=document.createElement.bind(document);(window as any).testVideos=[];document.createElement=((...args:any[])=>{const element=original(...args as [string]);if(args[0]==='video')(window as any).testVideos.push(element);return element;}) as typeof document.createElement;});
    assert.equal(await page.evaluate(()=>(window as any).testVideos.length),0,'A manual capture page must not create offscreen video decoders');
    for(const [index,frame] of [0,2,4,6,8,10,2].entries()){
      const actual=await (renderer as any).frame(page,spec,frame);
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      const reference=await page.screenshot({type:'png'});
      assert.equal(await pixels(actual.buffer),await pixels(reference),'Pixels differ at frame '+frame);
      if(index<=1)assert.ok(!requests.some(url=>url.endsWith('.mp4')),'Unvisited video shots must not load their media');
      if(frame===4)assert.equal(await page.evaluate(()=>(window as any).testVideos.length),1);
      if(frame===8)assert.equal(await page.evaluate(()=>(window as any).testVideos[0].getAttribute('src')),null,'The previous video decoder must be unloaded on a cut');
    }
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>(window as any).unexpectedScript),undefined,'Cloning static scene markup must not activate its scripts');
    connection.removeAbort();await connection.browser.close();connection=undefined;
    const checked=await renderer.check(created.root,project,env);assert.equal(checked.ok,true,JSON.stringify(checked.errors));
  }finally{if(connection){connection.removeAbort();await connection.browser.close();}await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('thumbnail batches use one browser, cache immutable PNGs and invalidate after a source revision',{
  skip:!env.browserAvailable,timeout:60_000,
},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'render-thumbnails-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
  try{
    let project=createProject('静态缩略图');project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);project.shots[0]!.durationFrames=12;
    project.target={width:640,height:360,fps:{num:12,den:1},audioMode:'none'};project.targetDuration=1;
    const created=await store.create(project);project=created.project;
    let launches=0;const open=(renderer as any).openPage.bind(renderer);
    t.mock.method(renderer as any,'openPage',async(...args:unknown[])=>{launches++;return open(...args);});
    const [first,concurrent]=await Promise.all([renderer.thumbnails(created.root,project,env,[0,5,11]),renderer.thumbnails(created.root,project,env,[0,5,11])]);
    assert.equal(launches,1);assert.deepEqual(first,concurrent);assert.equal((renderer as any).browsers.size,0,'No thumbnail browser may remain resident');
    const bytes=await fs.readFile(first[0]!.path);assert.equal(bytes.readUInt32BE(16),320);assert.equal(bytes.readUInt32BE(20),180);
    const cached=await renderer.thumbnails(created.root,project,env,[0,5,11]);assert.equal(launches,1);assert.deepEqual(cached,first);assert.equal((await fetch(cached[0]!.url)).status,200);
    await assert.rejects(renderer.thumbnails(created.root,project,env,[0,1,2,3]),/1–3/);
    await assert.rejects(renderer.thumbnails(created.root,project,env,[-1]),/valid/);
    const signal=new AbortController();signal.abort();await assert.rejects(renderer.thumbnails(created.root,project,env,[0],signal.signal),/cancelled/);
    const source=defaultSceneSource();source.js='export function render(ctx){ctx.ctx2d.fillStyle="#ff0000";ctx.ctx2d.fillRect(0,0,ctx.width,ctx.height);}';
    project.revision++;project=await store.commit(created.root,project,{[project.shots[0]!.id]:source});
    const changed=await renderer.thumbnails(created.root,project,env,[0,5,11]);assert.equal(launches,2);assert.notEqual(changed[1]!.url,first[1]!.url);assert.notEqual(changed[1]!.sha256,first[1]!.sha256);
    const cancelled=new AbortController();const opening=(renderer as any).openPage.bind(renderer);
    t.mock.method(renderer as any,'openPage',async(...args:unknown[])=>{const connection=await opening(...args);cancelled.abort();return connection;});
    await assert.rejects(renderer.thumbnails(created.root,project,env,[1],cancelled.signal),/cancelled/);assert.equal((renderer as any).browsers.size,0);
  }finally{await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('thumbnail RPC checks the requested revision before starting a render',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'render-thumbnail-rpc-'));
  const ctx={llm:{listProviders:()=>[],listModels:async()=>[]}} as unknown as HostContext;
  const service=new StudioService(ctx,{baseDirectory:directory,restoreRecent:false});
  try{
    const created=await service.rpc('create',{});assert.equal(created.ok,true);if(!created.ok)return;
    const snapshot=created.value as StudioSnapshot;
    const result=await service.rpc('thumbnails',{expectedRevision:snapshot.project!.revision+1,frames:[0]});
    assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'REVISION_CONFLICT');
  }finally{await service.dispose();await fs.rm(directory,{recursive:true,force:true});}
});

test('bounded PNG decoding preserves fractional frame rates and exact frame counts',{
  skip:!mediaAvailable,timeout:60_000,
},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'render-fractional-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
  try{
    const project=createProject('分数帧率');project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);project.shots[0]!.durationFrames=6;
    project.target={width:160,height:90,fps:{num:30000,den:1001},audioMode:'none'};project.targetDuration=6*1001/30000;
    const created=await store.create(project),result=await renderer.export(created.root,created.project,env,new AbortController().signal,()=>{});
    assert.equal(result.frameCount,6);assert.equal(result.qa?.fps,'30000/1001');assert.equal(result.qa?.status,'PASS');assert.equal(result.qa?.coldReload,'PASS');
  }finally{await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});
