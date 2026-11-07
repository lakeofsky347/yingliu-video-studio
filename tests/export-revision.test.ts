import {createCodeProject as createProject} from './fixtures/production.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';

import {ProjectStore} from '../src/host/store.js';
import {StudioService} from '../src/host/service.js';
import {VideoRenderer,detectEnvironment} from '../src/host/renderer.js';
import type {HostContext} from '../src/host/platform.js';
import type {SceneSource,StudioSnapshot} from '../src/shared/types.js';

const env=detectEnvironment(),exec=promisify(execFile),available=env.browserAvailable&&env.ffmpegAvailable&&env.ffprobeAvailable;
const digest=(source:SceneSource)=>createHash('sha256').update(JSON.stringify(source,null,2)+'\n').digest('hex');
function source(marker:string,background:string):SceneSource{return {
  html:'<section class="revision-scene"><h1></h1><p></p></section>',
  css:'.revision-scene{position:absolute;inset:0;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.revision-scene h1{position:absolute;left:7%;top:17%;width:46%;font-size:34px;line-height:1.25;white-space:pre-wrap;margin:0}.revision-scene p{position:absolute;left:7%;bottom:13%;font-size:17px;line-height:1.4}',
  js:`export function render(ctx){const {root,ctx2d:g,width:w,height:h,params:p}=ctx;g.fillStyle='${background}';g.fillRect(0,0,w,h);const image=ctx.assets.find(a=>a.kind==='image'&&a.image);if(!image)throw new Error('Test image did not decode');const s=Math.min(w*.31/image.image.naturalWidth,h*.78/image.image.naturalHeight);g.drawImage(image.image,w*.76-image.image.naturalWidth*s/2,h*.5-image.image.naturalHeight*s/2,image.image.naturalWidth*s,image.image.naturalHeight*s);root.querySelector('h1').textContent='${marker} · '+p.text;root.querySelector('p').textContent='中文、测试图片与本地音轨';g.fillStyle='#b8dcc8';g.fillRect(w*.07,h*.9,w*.86*ctx.progress,3);}`
};}
async function value(service:StudioService,endpoint:string,payload:unknown={}):Promise<any>{const result=await service.rpc(endpoint,payload);assert.equal(result.ok,true,result.ok?'':result.error.message);return result.ok?result.value:undefined;}
async function settled(service:StudioService):Promise<StudioSnapshot>{let snapshot=await service.snapshot();const deadline=Date.now()+30_000;while(snapshot.task?.status==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));snapshot=await service.snapshot();}assert.equal(snapshot.task?.status,'complete',JSON.stringify(snapshot.task));return snapshot;}

test('pinned source revision exports after source edit and physical shot deletion; restart exports second version without replacing the first',{skip:available?false:'Real media test requires executable Chromium, FFmpeg and ffprobe; export behavior was not verified.'},async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-export-revision-')),store=new ProjectStore({baseDirectory:base}),renderer=new VideoRenderer(store);let service:StudioService|undefined;
  try{
    const project=createProject('成片版本与完整源码快照');project.shots=project.shots.slice(0,2);project.shotOrder=project.shots.map(s=>s.id);project.target={width:640,height:360,fps:{num:12,den:1},audioMode:'mixed',quality:'standard'};project.targetDuration=2;for(const shot of project.shots)shot.durationFrames=12;
    project.shots[0]!.params.text='旧版本镜头一';project.shots[1]!.params.text='旧版本镜头二';const created=await store.create(project);
    const {stdout:png}=await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=64x64:d=0.1','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],{encoding:'buffer',maxBuffer:1_000_000});
    const image=await store.importImageOrText(created.root,{dataBase64:png.toString('base64'),mime:'image/png',name:'本地合成测试图片'});assert.equal(image.width,64);assert.equal(image.height,64);
    const tone=path.join(base,'验收测试音.wav');await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=0.5','-c:a','pcm_s16le',tone]);const audio=await store.importAudio(created.root,{path:tone,name:'本地合成验收音'},env);
    const first=structuredClone(created.project);first.revision++;first.assets.push(image,audio);for(const shot of first.shots)shot.assetIds=[image.id];first.audioClips=[{id:randomUUID(),assetId:audio.id,role:'music',startSeconds:0,trimStart:0,trimEnd:.5,volume:.2,fadeIn:.05,fadeOut:.05,loop:true}];
    const oldSources={[first.shots[0]!.id]:source('OLD-A','#24404c'),[first.shots[1]!.id]:source('OLD-B','#403148')},pinned=await store.commit(created.root,first,oldSources,{expectedRevision:created.project.revision,label:'固定待导出旧版本'});
    const before=await renderer.capture(created.root,pinned,env,17),next=structuredClone(pinned),survivor=next.shots[0]!,deleted=next.shots[1]!;next.revision++;survivor.durationFrames=24;survivor.params.text='新版本单一镜头';next.shots=[survivor];next.shotOrder=[survivor.id];delete next.extensions.graphEdges;const newSource=source('NEW-C','#203f25');const current=await store.commit(created.root,next,{[survivor.id]:newSource},{expectedRevision:pinned.revision,label:'改源码并删除第二镜头'});
    await fs.rm(path.join(created.root,deleted.sourcePath),{recursive:true,force:true});await assert.rejects(store.readSource(created.root,deleted),/镜头源码不存在/);assert.deepEqual(await store.readSource(created.root,deleted,pinned.revision),oldSources[deleted.id]);await assert.rejects(store.readSource(created.root,survivor,current.revision+1),/尚未提交/);
    const old=await renderer.export(created.root,pinned,env,new AbortController().signal,()=>{});assert.equal(old.revision,pinned.revision);assert.equal(old.frameCount,24);assert.equal(old.duration,2);assert.equal(old.qa?.audioStreams,1);const oldHash=(old.qa?.inputHashes as {path:string;sha256:string}[]).find(item=>item.path===survivor.sourcePath+'/source.json');assert.equal(oldHash?.sha256,digest(oldSources[survivor.id]!));assert.notEqual(oldHash?.sha256,digest(newSource));assert.equal((old.qa?.frames as {frame:number;sha256:string}[]).find(item=>item.frame===17)?.sha256,before.sha256);assert.equal((await renderer.capture(created.root,pinned,env,17)).sha256,before.sha256);
    const recorded=structuredClone(current);recorded.revision++;recorded.outputs.push(old);await store.commit(created.root,recorded,{}, {expectedRevision:current.revision,label:'保留旧版本成片'});await renderer.close();
    const ctx={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No cloud model in revision export test');}}} as unknown as HostContext;
    service=new StudioService(ctx,{baseDirectory:base});const restored=await value(service,'current') as StudioSnapshot;assert.equal(restored.project!.shots.length,1);assert.equal(restored.project!.outputs.length,1);assert.equal(restored.project!.outputs[0]!.revision,pinned.revision);assert.deepEqual(await service.store.readSource(created.root,survivor),newSource);
    await value(service,'export');const exported=await settled(service);assert.equal(exported.project!.outputs.length,2);const second=exported.project!.outputs[1]!;assert.equal(second.revision,recorded.revision);assert.equal(second.qa?.audioStreams,1);assert.equal((second.qa?.inputHashes as {path:string;sha256:string}[]).find(item=>item.path===survivor.sourcePath+'/source.json')?.sha256,digest(newSource));
    for(const output of exported.project!.outputs){assert.equal((await fetch(output.url!,{headers:{Range:'bytes=0-63'}})).status,206);await exec(env.ffmpegPath,['-v','error','-i',output.path,'-f','null','-']);}
    await service.dispose();service=new StudioService(ctx,{baseDirectory:base});const again=await value(service,'current') as StudioSnapshot;assert.equal(again.project!.outputs.length,2);assert.deepEqual(again.project!.outputs.map(item=>item.id),exported.project!.outputs.map(item=>item.id));const tasks=await value(service,'tasks');assert.ok(tasks.tasks.some((task:any)=>task.kind==='export'&&task.status==='complete'));
  }finally{await service?.dispose();await renderer.close();await fs.rm(base,{recursive:true,force:true});}
});
