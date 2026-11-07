import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ProjectHub} from '../src/host/project-hub.ts';
import {detectEnvironment} from '../src/host/renderer.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {Asset,StudioSnapshot} from '../src/shared/types.ts';
import {createSessionTools} from '../src/host/session-tools.ts';

function context():HostContext{return {llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('Unexpected model request');}},connection:{fetch:{register:()=>async()=>{}}},effect:()=>{}};}
async function fixture(run:(hub:ProjectHub)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'video-policy-host-')),hub=new ProjectHub(context(),{baseDirectory:directory});try{await run(hub);}finally{await hub.dispose();await rm(directory,{recursive:true,force:true});}}

test('configured video models cannot be called from code mode, including direct service entry',async()=>fixture(async hub=>{
  let requests=0;const server=createServer((_req,res)=>{requests++;res.end('{}');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const baseUrl='http://127.0.0.1:'+(server.address() as {port:number}).port;
    await hub.models.saveConnection({id:'video',name:'local video fixture',protocol:'video-gateway',baseUrl,auth:'none'});
    await hub.models.saveModel({id:'v',connectionId:'video',model:'fixture',inputModalities:['text'],outputModalities:['video']});await hub.models.bindRole('video','v');
    const {project}=await hub.call<StudioSnapshot>('create',{title:'code only',productionMode:'code_animation',sessionId:'owner'});
    const request={projectId:project!.id,expectedRevision:project!.revision,shotId:project!.shots[0]!.id,operation:'text-to-video' as const,prompt:'do not submit'};
    await assert.rejects(hub.call('media.generate',request,{callerSessionId:'owner'}),/不允许视频/);
    await assert.rejects(hub.media.generate(request),/不允许视频/);
    assert.equal((await hub.media.list()).length,0);assert.equal(requests,0);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}));

test('model mode forbids source mutation and incomplete export, without code fallback',async()=>fixture(async hub=>{
  const {project}=await hub.call<StudioSnapshot>('create',{title:'model only',productionMode:'model_video'}),id=project!.id,shotId=project!.shots[0]!.id;
  await assert.rejects(hub.call('saveSource',{projectId:id,expectedRevision:project!.revision,shotId,source:{html:'',css:'',js:'export function render(){}'},check:false}),/不允许执行自由动画/);
  await assert.rejects(hub.call('generate',{projectId:id,kind:'scenes',provider:'unused',model:'unused'}),/不允许执行自由动画/);
  await assert.rejects(hub.call('export',{projectId:id}),/尚未采用视频/);
  assert.equal((await hub.call<StudioSnapshot>('current',{projectId:id})).project!.revision,project!.revision);
}));

test('generic updates and agent calls cannot forge mode, provenance or mixed permission',async()=>fixture(async hub=>{
  const {project}=await hub.call<StudioSnapshot>('create',{title:'trusted policy',productionMode:'code_animation',sessionId:'owner'}),id=project!.id;
  await assert.rejects(hub.call('production.set',{projectId:id,expectedRevision:project!.revision,mode:'model_video'},{callerSessionId:'owner'}),/不能自行授权/);
  const forged=structuredClone(project!);forged.productionPolicy!.mode='model_video';
  await assert.rejects(hub.call('save',{projectId:id,expectedRevision:project!.revision,project:forged}),/普通保存不能更改/);
  await assert.rejects(hub.call('apply',{projectId:id,expectedRevision:project!.revision,productionPolicy:{mode:'hybrid'}}),/普通更新不能修改/);
  await assert.rejects(hub.call('apply',{projectId:id,expectedRevision:project!.revision,extensions:{mediaApplications:{forged:{assetIds:['fake'],revision:1}}}}),/不能伪造/);
  await assert.rejects(hub.call('apply',{projectId:id,expectedRevision:project!.revision,assets:[{id:'fake',kind:'video',name:'fake',description:'',path:'assets/fake.mp4',generation:{taskId:'fake'}}]}),/新媒体必须通过导入/);
  const created=await hub.call<StudioSnapshot>('create',{title:'agent attempt',productionMode:'model_video',sessionId:'agent'},{callerSessionId:'agent'});
  assert.equal(created.project!.productionPolicy!.mode,'unresolved');
}));

const mediaEnvironment=detectEnvironment(),exec=promisify(execFile);
test('save and apply preserve probed video identity while allowing names and descriptions',{
  skip:!mediaEnvironment.ffmpegAvailable||!mediaEnvironment.ffprobeAvailable,
},async()=>fixture(async hub=>{
  const file=join(hub.baseDirectory,'real-one-second.mp4');
  await exec(mediaEnvironment.ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=64x64:r=30:d=1','-c:v','libx264','-pix_fmt','yuv420p',file]);
  let {project}=await hub.call<StudioSnapshot>('create',{title:'probed metadata',productionMode:'model_video'});const id=project!.id;
  ({project}=await hub.call<StudioSnapshot>('production.set',{projectId:id,expectedRevision:project!.revision,mode:'model_video',allowImportedVideo:true}));
  ({project}=await hub.call<StudioSnapshot>('import',{projectId:id,expectedRevision:project!.revision,path:file}));
  const asset=project!.assets.find(item=>item.kind==='video')!;
  assert.ok(asset.duration!>=.9&&asset.duration!<=1.1);assert.equal(asset.frameCount,30);assert.equal(asset.hasAudio,false);
  ({project}=await hub.call<StudioSnapshot>('video.clip.save',{projectId:id,expectedRevision:project!.revision,clip:{shotId:project!.shots[0]!.id,assetId:asset.id,trimStart:0,speed:1,fit:'contain',audio:'mute'}}));
  const baseline=structuredClone(project!),revision=baseline.revision;
  const changes:Partial<Asset>[]=[
    {duration:10},{frameCount:300},{fps:{num:60,den:1}},{hasAudio:true},
    {path:'assets/replacement.mp4'},{originalPath:'assets/replacement-original.mp4'},
    {sourceSha256:'0'.repeat(64)},{provenance:{origin:'model_generation',usage:'production'}},
  ];
  for(const change of changes){
    const forged=structuredClone(baseline);Object.assign(forged.assets.find(item=>item.id===asset.id)!,change);
    for(const endpoint of ['save','apply'])await assert.rejects(hub.call(endpoint,{projectId:id,expectedRevision:revision,...(endpoint==='save'?{project:forged}:{assets:forged.assets})}),/不能修改媒体来源、用途、文件身份或探测元数据/,endpoint+' must reject '+Object.keys(change).join(','));
  }
  const unchanged=(await hub.call<StudioSnapshot>('current',{projectId:id})).project!;
  assert.equal(unchanged.revision,revision);assert.deepEqual(unchanged.assets,baseline.assets);
  const renamed=structuredClone(baseline),renamedAsset=renamed.assets.find(item=>item.id===asset.id)!;renamedAsset.name='用户命名的镜头';renamedAsset.description='普通名称和说明可以编辑';
  ({project}=await hub.call<StudioSnapshot>('save',{projectId:id,expectedRevision:revision,project:renamed}));
  assert.equal(project!.assets.find(item=>item.id===asset.id)!.name,'用户命名的镜头');
  const editedAssets=structuredClone(project!.assets);editedAssets.find(item=>item.id===asset.id)!.description='工具更新后的说明';
  ({project}=await hub.call<StudioSnapshot>('apply',{projectId:id,expectedRevision:project!.revision,assets:editedAssets}));
  const edited=project!.assets.find(item=>item.id===asset.id)!;
  assert.equal(edited.name,'用户命名的镜头');assert.equal(edited.description,'工具更新后的说明');
  assert.deepEqual({...edited,name:asset.name,description:asset.description},asset);
}));

test('scoped hybrid preserves the original route elsewhere and undo cannot resurrect authorization',async()=>fixture(async hub=>{
  let {project}=await hub.call<StudioSnapshot>('create',{title:'scoped',productionMode:'code_animation'});const id=project!.id,second=project!.shots[1]!.id;
  ({project}=await hub.call<StudioSnapshot>('production.set',{projectId:id,expectedRevision:project!.revision,mode:'hybrid',baseMode:'code_animation',shotIds:[second],operations:['code','video']}));
  assert.equal(project!.productionPolicy!.hybridGrants![0]!.shotIds.join(','),second);
  await assert.rejects(hub.media.generate({projectId:id,expectedRevision:project!.revision,shotId:project!.shots[0]!.id,operation:'text-to-video',prompt:'not allowed'}),/不允许视频/);
  await hub.call('saveSource',{projectId:id,expectedRevision:project!.revision,shotId:project!.shots[0]!.id,source:{html:'',css:'',js:'export function render(){}'},check:false});
  ({project}=await hub.call<StudioSnapshot>('current',{projectId:id}));
  ({project}=await hub.call<StudioSnapshot>('production.set',{projectId:id,expectedRevision:project!.revision,mode:'code_animation'}));
  ({project}=await hub.call<StudioSnapshot>('undo',{projectId:id,expectedRevision:project!.revision}));
  assert.equal(project!.productionPolicy!.mode,'code_animation');assert.equal(project!.productionPolicy!.hybridGrants,undefined);
}));

test('tools expose policy receipts, source-backed director validation and capability inspection',async()=>fixture(async hub=>{
  const tools=createSessionTools(context(),hub);assert.ok(tools.some(t=>t.name==='video_director'));assert.ok(tools.some(t=>t.name==='video_workflow'));
  const rules=await hub.call<{version:string;rules:unknown[]}>('director.rules');assert.ok(rules.rules.length>=6);
  const result=await hub.call<{ok:boolean}>('director.validate',{plan:{}});assert.equal(result.ok,false);
  const {project}=await hub.call<StudioSnapshot>('create',{title:'unresolved'});assert.equal(project!.productionPolicy!.mode,'unresolved');
}));
