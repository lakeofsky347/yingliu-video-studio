import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {StudioService} from '../src/host/service.js';
import {detectEnvironment} from '../src/host/renderer.js';
import type {HostContext} from '../src/host/platform.js';
import type {StudioSnapshot} from '../src/shared/types.js';

const env=detectEnvironment(),available=env.ffmpegAvailable&&env.ffprobeAvailable,exec=promisify(execFile);
function context(credentials=new Map<string,string>()):HostContext{return {llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No chat model invocation in audio tests');}},get:(name:string)=>name==='credentials'?{async set(ref:string,value:string){credentials.set(ref,value);},async unset(ref:string){credentials.delete(ref);},async resolve(ref:string){const value=credentials.get(ref);return value?{value}:undefined;}}:undefined} as unknown as HostContext;}
async function value(service:StudioService,endpoint:string,payload:unknown={}):Promise<StudioSnapshot>{const result=await service.rpc(endpoint,payload);assert.equal(result.ok,true,result.ok?'':result.error.message);return (result.ok?result.value:undefined) as StudioSnapshot;}
async function settled(service:StudioService):Promise<StudioSnapshot>{let snapshot=await service.snapshot();const deadline=Date.now()+15_000;while(snapshot.task?.status==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,15));snapshot=await service.snapshot();}assert.notEqual(snapshot.task?.status,'running','audio task timed out');return snapshot;}
async function create(service:StudioService,title='声音服务验收'):Promise<StudioSnapshot>{let snapshot=await value(service,'create',{productionMode:'code_animation',title});const project=structuredClone(snapshot.project!);project.shots=project.shots.slice(0,2);project.shotOrder=project.shots.map(shot=>shot.id);project.target={width:320,height:180,fps:{num:10,den:1},audioMode:'none'};project.targetDuration=2;for(const shot of project.shots)shot.durationFrames=10;return value(service,'save',{project});}
async function wave(file:string,seconds=1):Promise<void>{await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration='+seconds,'-c:a','pcm_s16le',file]);}

test('service uses credential store without key echo; actual system narration updates metadata, one voice, preview and restart',{skip:!available||process.platform!=='darwin'},async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-audio-service-say-')),credentials=new Map<string,string>();let service=new StudioService(context(credentials),{baseDirectory:base});
  try{
    const created=await create(service),shotId=created.project!.shots[0]!.id,key='synthetic-audio-key-never-echo';
    let configured=await value(service,'tts',{endpoint:'local:say',model:'system',voice:'Tingting',speed:1,enabled:true,apiKey:key});assert.equal(credentials.get('DSH_VIDEO_STUDIO_TTS_API_KEY'),key);assert.equal(configured.tts?.apiKey,undefined);assert.equal(configured.ttsConfigured,true);assert.equal(JSON.stringify(configured).includes(key),false);assert.equal((await fs.readFile(path.join(base,'tts.json'),'utf8')).includes(key),false);
    configured=await value(service,'tts',{apiKey:''});assert.equal(credentials.has('DSH_VIDEO_STUDIO_TTS_API_KEY'),false);assert.equal(configured.ttsConfigured,false);await value(service,'tts',{apiKey:key});
    await value(service,'audio',{action:'synthesize',shotId,text:'这是一次中文配音测试。'});let produced=await settled(service);assert.equal(produced.task?.status,'complete',produced.task?.error);
    const asset=produced.project!.assets.find(item=>item.kind==='audio')!,voice=produced.project!.audioClips![0]!;assert.ok(asset.duration!>1);assert.equal(asset.sampleRate,48000);assert.equal(asset.channels,2);assert.equal(voice.shotId,shotId);assert.equal(voice.role,'voice');assert.equal(produced.project!.target.audioMode,'mixed');assert.ok(produced.project!.shots[0]!.durationFrames/10>=asset.duration!);assert.equal(produced.project!.shots[0]!.narration,'这是一次中文配音测试。');assert.ok(produced.audioUrl);
    const originalAudio=produced.audioUrl!,originalBytes=Buffer.from(await (await fetch(originalAudio)).arrayBuffer());assert.ok(originalBytes.length>1000);
    const clipId=produced.project!.audioClips![0]!.id;produced=await value(service,'audio',{action:'update',clipId,patch:{volume:.3}});assert.notEqual(produced.audioUrl,originalAudio);assert.equal(new URL(produced.audioUrl!).searchParams.get('revision'),String(produced.project!.revision));assert.deepEqual(Buffer.from(await (await fetch(originalAudio)).arrayBuffer()),originalBytes);
    await value(service,'audio',{action:'synthesize',shotId,text:'修改后的旁白只播放一次。'});produced=await settled(service);assert.equal(produced.task?.status,'complete',produced.task?.error);assert.equal(produced.project!.audioClips!.filter(clip=>clip.role==='voice'&&clip.shotId===shotId).length,1);
    const root=produced.root!,project=produced.project!;assert.equal((await fs.readFile(path.join(root,'project.json'),'utf8')).includes(key),false);assert.equal((await fs.readFile(path.join(base,'tts.json'),'utf8')).includes(key),false);
    await service.dispose();service=new StudioService(context(credentials),{baseDirectory:base});const restored=await value(service,'current');assert.equal(restored.project!.id,project.id);assert.deepEqual(restored.project!.audioClips,JSON.parse(JSON.stringify(project.audioClips)));assert.equal(restored.project!.shots[0]!.narration,'修改后的旁白只播放一次。');assert.ok(restored.audioUrl);assert.equal((await fetch(restored.audioUrl!)).status,200);assert.equal(restored.tts?.apiKey,undefined);
  }finally{await service.dispose();await fs.rm(base,{recursive:true,force:true});}
});

test('audio mutations reject atomically; locked narration reports duration gap and trimmed offsets drive fitting',{skip:!available},async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-audio-service-policy-')),service=new StudioService(context(),{baseDirectory:base});
  try{
    const created=await create(service),shotId=created.project!.shots[0]!.id,file=path.join(base,'voice.wav');await wave(file,2);const imported=await value(service,'import',{path:file}),assetId=imported.project!.assets[0]!.id;
    let good=await value(service,'audio',{action:'add',assetId,shotId,role:'voice',trimStart:.2,trimEnd:.6,startSeconds:.1});assert.equal(good.project!.shots[0]!.durationFrames,10,'trimmed narration should not extend a one-second shot');
    const clipId=good.project!.audioClips![0]!.id,before=structuredClone(good.project),beforeUrl=good.audioUrl;
    const invalid=await service.rpc('audio',{action:'update',clipId,patch:{volume:-1}});assert.equal(invalid.ok,false);let current=await service.snapshot();assert.deepEqual(current.project,before);assert.equal(current.audioUrl,beforeUrl);
    good=await value(service,'apply',{extensions:{lockDuration:true}});const locked=structuredClone(good.project);
    const tooLong=await service.rpc('audio',{action:'add',assetId,shotId,role:'voice',startSeconds:.7,trimStart:0,trimEnd:.5,fitDuration:false});assert.equal(tooLong.ok,false);if(!tooLong.ok)assert.match(tooLong.error.message,/时长|配音|旁白/);assert.deepEqual((await service.snapshot()).project,locked);
    const moved=await service.rpc('audio',{action:'update',clipId,patch:{startSeconds:.8}});assert.equal(moved.ok,false);assert.deepEqual((await service.snapshot()).project,locked);
    const shortened=await service.rpc('apply',{shotPatches:[{id:shotId,patch:{durationFrames:3}}]});assert.equal(shortened.ok,false);assert.deepEqual((await service.snapshot()).project,locked);
    const shortSave=structuredClone(locked!);shortSave.shots[0]!.durationFrames=3;const saved=await service.rpc('save',{project:shortSave});assert.equal(saved.ok,false);assert.deepEqual((await service.snapshot()).project,locked);
    const failedImport=await service.rpc('audio',{action:'import',path:file,shotId,role:'voice'});assert.equal(failedImport.ok,false);assert.deepEqual((await service.snapshot()).project,locked,'a failed import and bind must not leave an unsaved asset');
    good=await value(service,'apply',{extensions:{lockDuration:false}});
    const fit=await value(service,'audio',{action:'add',assetId,shotId,role:'voice',startSeconds:.6,trimStart:0,trimEnd:.7});assert.ok(fit.project!.shots[0]!.durationFrames>=16,'voice start + selected duration + reading tail must fit');
    const removed=await value(service,'audio',{action:'remove',clipId:fit.project!.audioClips!.at(-1)!.id});assert.ok(removed.audioUrl);
    const draft=structuredClone(removed.project!);draft.shotOrder=[];draft.extensions.graphEdges=[];const broken=await value(service,'save',{project:draft});assert.equal(broken.previewUrl,null);assert.equal(broken.audioUrl,null,'a broken graph must not keep playing a previous project mix');
  }finally{await service.dispose();await fs.rm(base,{recursive:true,force:true});}
});

test('apply validates every source before changing existing scene files',{skip:!available},async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-audio-service-apply-')),service=new StudioService(context(),{baseDirectory:base});
  try{
    const created=await create(service),shot=created.project!.shots[0]!,original=await service.store.readSource(created.root!,shot),project=structuredClone(created.project);
    const result=await service.rpc('apply',{sources:[{shotId:shot.id,source:{...original,js:original.js+'\n// must not be partially committed'}},{shotId:'unknown-shot',source:original}]});assert.equal(result.ok,false);assert.deepEqual((await service.snapshot()).project,project);assert.deepEqual(await service.store.readSource(created.root!,shot),original);
  }finally{await service.dispose();await fs.rm(base,{recursive:true,force:true});}
});

test('failed or cancelled synthesis keeps project assets, narration, clips and audio unchanged',{skip:!available},async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-audio-service-cancel-')),service=new StudioService(context(),{baseDirectory:base});let requested:()=>void=()=>{};const received=new Promise<void>(resolve=>{requested=resolve;});
  const server=createServer(async(req,res)=>{for await(const _ of req){}requested();if(req.url==='/v1/audio/speech')return;res.writeHead(500);res.end();});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  try{
    const created=await create(service),shotId=created.project!.shots[0]!.id;await value(service,'tts',{endpoint:'http://127.0.0.1:'+address.port+'/v1',model:'fixture',voice:'fixture',speed:1,enabled:true});
    const before=await service.snapshot();await value(service,'audio',{action:'synthesize',shotId,text:'等待取消的旁白'});await received;await value(service,'cancel');const cancelled=await settled(service);assert.equal(cancelled.task?.status,'cancelled');assert.deepEqual(cancelled.project,before.project);assert.equal(cancelled.audioUrl,before.audioUrl);
    await value(service,'tts',{endpoint:'http://127.0.0.1:'+address.port+'/fail',model:'fixture',voice:'fixture',speed:1,enabled:true});await value(service,'audio',{action:'synthesize',shotId,text:'测试明确失败'});const failed=await settled(service);assert.equal(failed.task?.status,'failed');assert.deepEqual(failed.project,before.project);assert.equal(failed.audioUrl,before.audioUrl);
  }finally{await service.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(base,{recursive:true,force:true});}
});
