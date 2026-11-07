import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JobHooks, JobSpec } from '@deepseek-ai/dsh-jobs';
import type { HostContext } from '../src/host/platform.ts';
import { ProjectHub } from '../src/host/project-hub.ts';
import { createSessionTools } from '../src/host/session-tools.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';

const context:HostContext={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('Session tools must not invoke a second model');}},connection:{fetch:{register:()=>async()=>{}}},effect:()=>{}};
function execution(name:string,sessionId:string,signal=new AbortController().signal):ToolRunContext{return {name,callId:'test-call',rootCallId:'test-call',arguments:{},token:Symbol('test'),agent:{id:sessionId,options:{provider:'existing-route',model:'existing-model'}},signal};}
async function run(tools:ToolDefinition[],name:string,args:object,sessionId:string,signal?:AbortSignal){const tool=tools.find(item=>item.name===name)!;return await tool.execute(args,execution(name,sessionId,signal)) as Record<string,any>;}
async function checkpoint<T>(event:Promise<T>,label:string):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([event,new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${label}`)),5000);})]);}finally{clearTimeout(timer);}}

test('existing sessions own separate projects; restart restores bindings and focus does not redirect another project',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-session-hub-'));let hub=new ProjectHub(context,{baseDirectory:base});
  try{
    let tools=createSessionTools(context,hub);
    const a=await run(tools,'video_project',{action:'create',title:'会话 A',topic:'A 的影片'},'session-A');
    const b=await run(tools,'video_project',{action:'create',title:'会话 B',topic:'B 的影片'},'session-B');
    assert.notEqual(a.projectId,b.projectId);assert.equal((await hub.call<StudioSnapshot>('current')).project,null);
    assert.equal((await run(tools,'video_project',{action:'get'},'session-A')).title,'会话 A');
    assert.equal((await run(tools,'video_project',{action:'get'},'session-B')).title,'会话 B');
    await hub.call('focus',{projectId:a.projectId,shotId:a.shots[1].id,frame:45,sessionId:'session-A'});
    const focused=await hub.call<StudioSnapshot>('current');assert.equal(focused.project!.id,a.projectId);assert.deepEqual(focused.focus,{shotId:a.shots[1].id,frame:45});
    assert.equal((await run(tools,'video_project',{action:'get'},'session-B')).projectId,b.projectId);
    await hub.dispose();hub=new ProjectHub(context,{baseDirectory:base});tools=createSessionTools(context,hub);
    assert.equal((await run(tools,'video_project',{action:'get'},'session-A')).projectId,a.projectId);
    assert.equal((await run(tools,'video_project',{action:'get'},'session-B')).projectId,b.projectId);
    const index=JSON.parse(await readFile(join(base,'sessions.json'),'utf8'));assert.equal(index.bindings['session-A'].currentProjectId,a.projectId);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('session model reads manual parameters and revision before applying a local shot/source change',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-session-edit-')),hub=new ProjectHub(context,{baseDirectory:base}),tools=createSessionTools(context,hub);
  try{
    const created=await run(tools,'video_project',{action:'create',title:'手动与对话编辑'},'session-edit');
    await hub.call('production.set',{projectId:created.projectId,expectedRevision:created.revision,mode:'code_animation'});
    const before=await hub.call<StudioSnapshot>('current',{projectId:created.projectId}),shotId=before.project!.shots[1]!.id;
    before.project!.shots[1]!.params.text='用户刚刚手动改过';await hub.call('save',{project:before.project});
    const current=await run(tools,'video_project',{action:'get'},'session-edit');assert.equal(current.shots[1].params.text,'用户刚刚手动改过');assert.ok(current.revision>created.revision);
    await assert.rejects(run(tools,'video_update',{expectedRevision:created.revision,update:{title:'过期修改'}},'session-edit'),/已被用户修改/);
    const updated=await run(tools,'video_update',{expectedRevision:current.revision,update:{shotPatches:[{id:shotId,patch:{params:{...current.shots[1].params,text:'会话合并后的文字'}}}],sources:[{shotId,source:{html:'<div class="custom"></div>',css:'.custom { color:red; }',js:'export function render(ctx) { ctx.root.querySelector(".custom").textContent = ctx.params.text; }'}}]}},'session-edit');
    assert.equal(updated.shots[1].params.text,'会话合并后的文字');assert.deepEqual(updated.shots[0],current.shots[0]);assert.deepEqual(updated.shots[2],current.shots[2]);
    const inspected=await run(tools,'video_inspect',{shotId,includeSource:true},'session-edit');assert.match(inspected.inspection.source.js,/ctx.params.text/);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('durable session images and text file references become portable project assets',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-session-assets-')),textPath=join(base,'会话说明.md');await writeFile(textPath,'这是会话中的文字素材');
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCZkAAAAASUVORK5CYII=','base64');
  const ctx:HostContext={...context,attachments:{async readImage(ref){assert.equal(ref.attachmentId,'session-image');return {data:image};},fileHostPath(ref){assert.equal(ref.attachmentId,'session-text');return textPath;}}};
  const hub=new ProjectHub(ctx,{baseDirectory:base}),tools=createSessionTools(ctx,hub);
  try{
    const created=await run(tools,'video_project',{action:'create',title:'会话附件'},'session-assets');
    const result=await run(tools,'video_update',{imports:[{attachment:{attachmentId:'session-image',mediaType:'image/png',bytes:image.length,width:1,height:1,name:'会话图片.png'}},{attachment:{attachmentId:'session-text',bytes:33,name:'会话说明.md'}}],update:{}},'session-assets');
    assert.equal(result.assets.length,2);assert.equal(result.assets[0].kind,'image');assert.equal(result.assets[1].text,'这是会话中的文字素材');
    assert.deepEqual(await readFile(join(created.root,result.assets[0].path)),image);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('new project services share the DSH model catalog and explicitly configured global speech settings',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-session-settings-'));
  const ctx:HostContext={...context,llm:{...context.llm,listProviders:()=>[{id:'existing-route',name:'DSH 会话模型'}],listModels:async()=>[{id:'existing-model',name:'现有模型',inputModalities:['text','image']}]}},hub=new ProjectHub(ctx,{baseDirectory:base});
  try{
    const catalog=await hub.call<StudioSnapshot>('catalog');assert.equal(catalog.providers[0]!.models[0]!.id,'existing-model');
    const a=await hub.call<StudioSnapshot>('create',{title:'模型目录 A',select:false}),b=await hub.call<StudioSnapshot>('create',{title:'模型目录 B',select:false});
    assert.deepEqual(a.providers,catalog.providers);assert.deepEqual(b.providers,catalog.providers);
    // This tests configuration sharing; it never invokes a speech provider.
    const configured=await hub.call<StudioSnapshot>('tts',{projectId:a.project!.id,endpoint:'https://tts.example/v1',model:'fixture-model',enabled:true,voice:'fixture-voice',speed:1});
    assert.ok(configured.project);assert.equal(configured.tts!.voice,'fixture-voice');
    const second=await hub.call<StudioSnapshot>('current',{projectId:b.project!.id});assert.deepEqual(second.tts,configured.tts);assert.deepEqual(second.providers,catalog.providers);
    assert.equal(second.tts!.apiKey,undefined);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('background render is a session-owned DSH job with progress and cancel after renderer cleanup',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-session-jobs-'));let hooks:JobHooks|undefined,ownerId:string|undefined;const progress:string[]=[];
  const ctx:HostContext={...context,jobs:{start(spec:JobSpec){ownerId=spec.owner;hooks=spec.run({id:'video-test-1',append:()=>{},updateProgress:line=>progress.push(line)});return 'video-test-1';}}};
  const hub=new ProjectHub(ctx,{baseDirectory:base}),tools=createSessionTools(ctx,hub);
  try{
    const project=await run(tools,'video_project',{action:'create'},'session-job'),located=await hub.resolveProject({projectId:project.projectId});let cleaned=false,entered!:()=>void;const checking=new Promise<void>(resolve=>entered=resolve);
    await hub.call('production.set',{projectId:project.projectId,expectedRevision:project.revision,mode:'code_animation'});
    located.service.renderer.check=async(_root,_project,_settings,signal)=>{
      assert.ok(signal);
      entered();
      await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});cleaned=true;signal.throwIfAborted();return {ok:true,errors:[],frames:[]};
    };
    const response=await run(tools,'video_render',{action:'check'},'session-job');assert.equal(response.jobId,'video-test-1');assert.equal(ownerId,'session-job');
    // Durable task creation can take longer under parallel media tests. Cancel after acquisition.
    await checkpoint(checking,'renderer.check entry');hooks!.cancel('cancel test');const outcome=await hooks!.done;
    assert.equal(outcome.status,'killed');assert.equal(cleaned,true);assert.ok(progress.length);
    const cancelled=await hub.call<StudioSnapshot>('current',{projectId:project.projectId});assert.equal(cancelled.task!.status,'cancelled');assert.equal(JSON.parse(await readFile(cancelled.task!.logPath!,'utf8')).status,'cancelled');
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('session-owned job cancelled during preview setup skips renderer acquisition and records cancellation',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-session-early-cancel-'));let hooks:JobHooks|undefined,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const ctx:HostContext={...context,jobs:{start(spec){hooks=spec.run({id:'video-early-cancel',append:()=>{},updateProgress:()=>{}});return 'video-early-cancel';}}},hub=new ProjectHub(ctx,{baseDirectory:base}),tools=createSessionTools(ctx,hub);
  try{
    const project=await run(tools,'video_project',{action:'create'},'session-early-cancel'),located=await hub.resolveProject({projectId:project.projectId});let entered!:()=>void,cancelled!:()=>void,checks=0;const preparing=new Promise<void>(resolve=>entered=resolve),abortDelivered=new Promise<void>(resolve=>cancelled=resolve);
    const rpc=located.service.rpc.bind(located.service);located.service.rpc=async(endpoint,payload)=>{const result=await rpc(endpoint,payload);if(endpoint==='cancel')cancelled();return result;};
    located.service.renderer.preview=async()=>{entered();await gate;return 'http://127.0.0.1:1/fixture-preview';};located.service.renderer.check=async()=>{checks++;return {ok:true,errors:[],frames:[]};};
    const response=await run(tools,'video_render',{action:'check'},'session-early-cancel');assert.equal(response.jobId,'video-early-cancel');await checkpoint(preparing,'preview setup entry');hooks!.cancel('cancel before resource acquisition');await checkpoint(abortDelivered,'owned task cancellation');release();
    const outcome=await hooks!.done;assert.equal(outcome.status,'killed');assert.equal(checks,0,'a cancelled setup must not start a renderer check');const snapshot=await hub.call<StudioSnapshot>('current',{projectId:project.projectId});assert.equal(snapshot.task!.status,'cancelled');assert.equal(JSON.parse(await readFile(snapshot.task!.logPath!,'utf8')).status,'cancelled');
  }finally{release();await hub.dispose();await rm(base,{recursive:true,force:true});}
});
