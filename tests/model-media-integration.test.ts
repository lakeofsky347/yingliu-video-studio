import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import type {JobHooks} from '@deepseek-ai/dsh-jobs';
import type {ToolRunContext} from '@deepseek-ai/dsh-tools';
import {ProjectHub} from '../src/host/project-hub.ts';
import {modelSecrets,type HostContext} from '../src/host/platform.ts';
import {createSessionTools} from '../src/host/session-tools.ts';
import type {StudioSnapshot} from '../src/shared/types.ts';
import type {MediaTask} from '../src/jobs/contracts.ts';
import type {WorkflowRecord} from '../src/workflows/contracts.ts';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCZkAAAAASUVORK5CYII=';
function host(values=new Map<string,string>()):HostContext{return {llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No text-model calls');}},get:name=>name==='credentials'?{resolve:async(ref:string)=>values.has(ref)?{value:values.get(ref)!}:undefined,describe:async(ref:string)=>({configured:values.has(ref),writable:true}),set:async(ref:string,value:string)=>{values.set(ref,value);},unset:async(ref:string)=>{values.delete(ref);}}:undefined,connection:{fetch:{register:()=>async()=>{}}},effect:()=>{}};}
function execution(sessionId:string):ToolRunContext{return {name:'video_media',callId:'media-test',rootCallId:'media-test',arguments:{},token:Symbol(),agent:{id:sessionId,options:{provider:'host',model:'host-model'}},signal:new AbortController().signal};}
async function listen(server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+(server.address() as {port:number}).port;}
async function finish(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
async function until<T>(read:()=>Promise<T>,matches:(value:T)=>boolean,options:{timeoutMs?:number;label?:string;diagnostics?:(last:T|undefined)=>unknown|Promise<unknown>}={}):Promise<T>{
  const started=performance.now();let last:T|undefined;
  for(let attempt=0;options.timeoutMs===undefined?attempt<150:performance.now()-started<options.timeoutMs;attempt++){
    last=await read();if(matches(last))return last;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  const details=options.diagnostics?await options.diagnostics(last):last;
  throw new Error(`Timed out waiting for ${options.label??'local fixture'} after ${Math.round(performance.now()-started)}ms; last state: ${JSON.stringify(details)}`);
}
async function configure(hub:ProjectHub,baseUrl:string){const connection=await hub.call<{id:string}>('models.connection.save',{id:'images',name:'本地协议测试',protocol:'images',baseUrl,auth:'none'});const model=await hub.call<{id:string}>('models.model.save',{id:'image-model',connectionId:connection.id,model:'fixture-image',inputModalities:['text'],outputModalities:['image']});await hub.call('models.role.bind',{role:'image',modelId:model.id});return model.id;}

test('plugin credentials resolve the current host service and status never reads secret values',async()=>{
  let value='one',reads=0,available=true;
  const ctx={...host(),get:()=>available?{resolve:async()=>{reads++;return {value};},describe:async()=>({configured:true,writable:true}),set:async(_ref:string,next:string)=>{value=next;},unset:async()=>{value='';}}:undefined};
  const secrets=modelSecrets(ctx),ref='DSH_VIDEO_STUDIO_MODELS_FIXTURE_API_KEY';
  assert.equal((await secrets.status!(ref)).hasStoredKey,true);assert.equal(reads,0);
  assert.equal(await secrets.get(ref),'one');value='two';assert.equal(await secrets.get(ref),'two');
  await assert.rejects(secrets.get('OTHER_PLUGIN_KEY'),/本视频插件/);
  available=false;assert.equal((await secrets.status!(ref)).available,false);await assert.rejects(secrets.set(ref,'new'),/凭据服务不可用/);
});

test('media registry is global and secret-free; generated candidates apply once with revision protection',async()=>{
  const base=await mkdtemp(join(tmpdir(),'plugin-media-')),values=new Map<string,string>(),ctx=host(values),hub=new ProjectHub(ctx,{baseDirectory:base});let submits=0;
  const server=createServer((request,response)=>{if(request.url==='/images/generations'){submits++;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[{b64_json:png}]}));}else{response.statusCode=404;response.end();}});
  try{
    const url=await listen(server),modelId=await configure(hub,url);
    const connection=await hub.call<{credentialRef:string}>('models.connection.save',{id:'secret-profile',name:'独立凭据',protocol:'images',baseUrl:url,apiKey:'fixture-secret-value'});
    assert.match(connection.credentialRef,/^DSH_VIDEO_STUDIO_[A-Z0-9_]+$/);assert.equal(values.get(connection.credentialRef),'fixture-secret-value');
    assert.equal((await readFile(join(base,'models.json'),'utf8')).includes('fixture-secret-value'),false);
    const a=await hub.call<StudioSnapshot>('create',{title:'A',sessionId:'session-A'}),b=await hub.call<StudioSnapshot>('create',{title:'B',sessionId:'session-B'});
    assert.equal((await hub.call<{models:unknown[]}>('models.list')).models.length,1);
    await assert.rejects(hub.call('media.list',{projectId:b.project!.id},{callerSessionId:'session-A'}),/未关联此工程/);
    await assert.rejects(hub.call('models.connection.save',{baseUrl:url},{callerSessionId:'session-A'}),/工作台设置/);
    const task=await hub.call<MediaTask>('media.generate',{projectId:a.project!.id,shotId:a.project!.shots[0]!.id,expectedRevision:a.project!.revision,operation:'text-to-image',prompt:'协议测试图片',modelId},{callerSessionId:'session-A'});
    const ready=await until(()=>hub.call<MediaTask>('media.get',{taskId:task.id},{callerSessionId:'session-A'}),item=>item.phase==='ready');assert.equal(ready.ownerSessionId,'session-A');assert.equal(ready.connection.credentialRef,'');
    await assert.rejects(hub.call('media.get',{taskId:task.id},{callerSessionId:'session-B'}),/未关联此工程/);
    await assert.rejects(hub.call('media.apply',{taskId:task.id,expectedRevision:a.project!.revision+1},{callerSessionId:'session-A'}),/版本已变化/);
    const applied=await hub.call<MediaTask>('media.apply',{taskId:task.id,expectedRevision:a.project!.revision},{callerSessionId:'session-A'});assert.equal(applied.phase,'complete');
    const current=await hub.call<StudioSnapshot>('current',{projectId:a.project!.id});assert.equal(current.project!.assets.length,1);assert.equal(current.project!.shots[0]!.assetIds.length,1);assert.equal(current.project!.revision,a.project!.revision+1);
    await hub.call('media.apply',{taskId:task.id,expectedRevision:current.project!.revision},{callerSessionId:'session-A'});assert.equal((await hub.call<StudioSnapshot>('current',{projectId:a.project!.id})).project!.revision,current.project!.revision);assert.equal(submits,1);
  }finally{await hub.dispose();await finish(server);await rm(base,{recursive:true,force:true});}
});

test('video_media preflights DSH Jobs before submission and job kill pauses observation only',async()=>{
  const base=await mkdtemp(join(tmpdir(),'plugin-media-job-'));let submits=0,hooks:JobHooks|undefined,rejectJob=true;
  const ctx:HostContext={...host(),jobs:{start(spec){if(rejectJob)throw new Error('No DSH Job controller');hooks=spec.run({id:'video-media-test',append:()=>{},updateProgress:()=>{}});return 'video-media-test';}}};
  const hub=new ProjectHub(ctx,{baseDirectory:base}),server=createServer((_request,response)=>{submits++;response.on('close',()=>{});});
  try{
    const modelId=await configure(hub,await listen(server)),created=await hub.call<StudioSnapshot>('create',{sessionId:'owner',title:'异步生成'}),project=created.project!;
    const tool=createSessionTools(ctx,hub).find(item=>item.name==='video_media')!,args={action:'generate',projectId:project.id,shotId:project.shots[0]!.id,expectedRevision:project.revision,operation:'text-to-image',prompt:'尚未返回的测试',modelId};
    await assert.rejects(tool.execute(args,execution('owner')),/No DSH Job controller/);assert.equal(submits,0);assert.equal((await hub.media.list()).length,0);
    rejectJob=false;const receipt=await tool.execute(args,execution('owner')) as Record<string,any>;assert.ok(receipt.taskId);assert.equal(receipt.jobId,'video-media-test');
    await until(async()=>submits,count=>count===1);hooks!.cancel('stop waiting');const outcome=await hooks!.done;assert.equal(outcome.status,'killed');
    const task=await hub.call<MediaTask>('media.get',{taskId:receipt.taskId},{callerSessionId:'owner'});assert.equal(task.observation,'paused');assert.notEqual(task.phase,'cancelled');assert.equal(task.cancelRequested,undefined);assert.equal(submits,1);
  }finally{await hub.dispose();await finish(server);await rm(base,{recursive:true,force:true});}
});

test('video clip edits enforce revision; extraction clips original audio to its shot in one commit',{skip:spawnSync('ffmpeg',['-version']).status!==0||spawnSync('ffprobe',['-version']).status!==0},async()=>{
  const base=await mkdtemp(join(tmpdir(),'plugin-video-clip-')),hub=new ProjectHub(host(),{baseDirectory:base}),file=join(base,'source.mp4');
  try{
    const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=64x64:r=30:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',file]);assert.equal(generated.status,0,generated.stderr.toString());
    let snapshot=await hub.call<StudioSnapshot>('create',{title:'视频片段事务'}),project=snapshot.project!;project.shots[0]!.durationFrames=30;
    snapshot=await hub.call<StudioSnapshot>('save',{projectId:project.id,expectedRevision:project.revision,project});
    snapshot=await hub.call<StudioSnapshot>('import',{projectId:project.id,expectedRevision:snapshot.project!.revision,path:file});project=snapshot.project!;
    const asset=project.assets[0]!;assert.equal(asset.kind,'video');assert.equal(asset.hasAudio,true);
    const clip={shotId:project.shots[0]!.id,assetId:asset.id,trimStart:0,trimEnd:2,speed:1,fit:'contain',audio:'keep'};
    await assert.rejects(hub.call('video.clip.save',{projectId:project.id,clip}),/expectedRevision/);
    snapshot=await hub.call<StudioSnapshot>('video.clip.save',{projectId:project.id,expectedRevision:project.revision,clip});assert.equal(snapshot.project!.videoClips!.length,1);
    await assert.rejects(hub.call('video.clip.remove',{projectId:project.id,expectedRevision:project.revision,clipId:snapshot.project!.videoClips![0]!.id}),/版本冲突/);
    const before=snapshot.project!.revision,clipId=snapshot.project!.videoClips![0]!.id;
    snapshot=await hub.call<StudioSnapshot>('video.clip.extract',{projectId:project.id,expectedRevision:before,clipId});
    assert.equal(snapshot.project!.revision,before+1);assert.equal(snapshot.project!.videoClips![0]!.audio,'mute');assert.equal(snapshot.project!.audioClips!.length,1);assert.equal(snapshot.project!.audioClips![0]!.trimEnd,1);
    snapshot=await hub.call<StudioSnapshot>('video.clip.remove',{projectId:project.id,expectedRevision:snapshot.project!.revision,clipId});assert.equal(snapshot.project!.videoClips!.length,0);assert.equal(snapshot.project!.audioClips!.length,1);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('DSH workflow stages generated media and commits one revision without repeating provider submission',async()=>{
  const base=await mkdtemp(join(tmpdir(),'plugin-workflow-'));let textCalls=0,submits=0;
  const ctx:HostContext={...host(),llm:{listProviders:()=>[{id:'host',name:'DSH fixture'}],listModels:async()=>[{id:'fixture',name:'DSH fixture',inputModalities:['text']}],async *stream(input){
    textCalls++;const message=(input.messages[0] as {content:{text:string}[]}).content[0]!.text,request=JSON.parse(message);
    yield {type:'text-delta',text:JSON.stringify({shots:request.shots.map((shot:{id:string})=>({shotId:shot.id,prompt:'候选图片',narration:''}))})};yield {type:'finish',reason:{kind:'stop'}};
  }}};
  const hub=new ProjectHub(ctx,{baseDirectory:base}),server=createServer((_request,response)=>{submits++;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:[{b64_json:png}]}));});
  try{
    await configure(hub,await listen(server));const snapshot=await hub.call<StudioSnapshot>('create',{sessionId:'workflow-owner',title:'协作图像'}),project=snapshot.project!;
    await assert.rejects(hub.call('workflows.run',{projectId:project.id,expectedRevision:project.revision,prompt:'生成图片',visual:'image',textRoute:{provider:'host',model:'fixture'}},{callerSessionId:'unrelated'}),/未关联此工程/);
    const workflow=await hub.call<WorkflowRecord>('workflows.run',{projectId:project.id,expectedRevision:project.revision,prompt:'生成图片',visual:'image',shotIds:[project.shots[0]!.id],textRoute:{provider:'host',model:'fixture'},maxTasks:4},{callerSessionId:'workflow-owner'});
    // This crosses real media journaling and a project commit. Wait for its terminal
    // state rather than asserting completion within 150 timer ticks on a busy disk.
    const finished=await until(()=>hub.call<WorkflowRecord>('workflows.get',{id:workflow.id},{callerSessionId:'workflow-owner'}),item=>item.status!=='running',{
      timeoutMs:30_000,label:'DSH media workflow completion',
      diagnostics:async last=>({workflow:last&&{id:last.id,status:last.status,message:last.message,error:last.error,committedRevision:last.committedRevision,steps:last.steps.map(step=>({kind:step.kind,status:step.status,message:step.message,taskId:step.taskId}))},mediaTasks:(await hub.media.list(project.id)).map(task=>({id:task.id,phase:task.phase,observation:task.observation,message:task.message,error:task.error}))}),
    });assert.equal(finished.status,'complete',finished.error??finished.message);
    const current=(await hub.call<StudioSnapshot>('current',{projectId:project.id})).project!;assert.equal(current.revision,project.revision+1);assert.equal(current.assets.length,1);assert.equal(current.shots[0]!.assetIds.length,1);
    const tasks=await hub.media.list(project.id);assert.equal(tasks.length,1);assert.equal(tasks[0]!.phase,'complete');assert.equal(textCalls,1);assert.equal(submits,1);
    await hub.call('workflows.retry',{id:workflow.id},{callerSessionId:'workflow-owner'});assert.equal(submits,1);assert.equal(textCalls,1);
    await assert.rejects(hub.call('workflows.get',{id:workflow.id},{callerSessionId:'unrelated'}),/未关联此工程/);
  }finally{await hub.dispose();await finish(server);await rm(base,{recursive:true,force:true});}
});

test('DSH workflow retains candidate code after a user edit and merges only on explicit current revision',async()=>{
  const base=await mkdtemp(join(tmpdir(),'plugin-workflow-conflict-'));let hub!:ProjectHub,projectId='',sceneCalls=0;
  const ctx:HostContext={...host(),llm:{listProviders:()=>[{id:'host',name:'DSH fixture'}],listModels:async()=>[{id:'fixture',name:'DSH fixture',inputModalities:['text']}],async *stream(input){
    const request=JSON.parse((input.messages[0] as {content:{text:string}[]}).content[0]!.text);
    if(request.shots)yield {type:'text-delta',text:JSON.stringify({shots:request.shots.map((shot:{id:string})=>({shotId:shot.id,prompt:'生成可编辑画面',narration:''}))})};
    else{sceneCalls++;const current=(await hub.call<StudioSnapshot>('current',{projectId})).project!;await hub.call('apply',{projectId,expectedRevision:current.revision,title:'用户在生成中修改的名称'});yield {type:'text-delta',text:JSON.stringify({html:'<div>候选画面</div>',css:'',js:'export function render(ctx) { ctx.root.style.opacity = "1"; }'})};}
    yield {type:'finish',reason:{kind:'stop'}};
  }}};hub=new ProjectHub(ctx,{baseDirectory:base});
  try{
    const created=(await hub.call<StudioSnapshot>('create',{title:'原名称'})).project!;projectId=created.id;
    const workflow=await hub.call<WorkflowRecord>('workflows.run',{projectId,expectedRevision:created.revision,prompt:'制作画面',visual:'code',shotIds:[created.shots[0]!.id],textRoute:{provider:'host',model:'fixture'}});
    const waiting=await until(()=>hub.workflows.get(workflow.id),item=>item.status==='awaiting-apply'||item.status==='failed');assert.equal(waiting.status,'awaiting-apply',waiting.error);
    const before=(await hub.call<StudioSnapshot>('current',{projectId})).project!;assert.equal(before.title,'用户在生成中修改的名称');assert.equal(before.revision,created.revision+1);
    await hub.call('workflows.apply',{id:workflow.id,expectedRevision:before.revision});const done=await until(()=>hub.workflows.get(workflow.id),item=>item.status==='complete'||item.status==='failed');assert.equal(done.status,'complete',done.error);
    const after=(await hub.call<StudioSnapshot>('current',{projectId})).project!;assert.equal(after.title,before.title);assert.equal(after.revision,before.revision+1);assert.equal(sceneCalls,1);
    const source=await hub.call<{html:string}>('source',{projectId,shotId:created.shots[0]!.id});assert.match(source.html,/候选画面/);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('workflow speech distinguishes local preflight failure from a started provider request',async()=>{
  const base=await mkdtemp(join(tmpdir(),'plugin-voice-preflight-')),hub=new ProjectHub(host(),{baseDirectory:base});let submitted=0;
  const server=createServer((_request,response)=>{submitted++;response.statusCode=503;response.end('fixture unavailable');});
  const safelyUnsubmitted=(error:unknown)=>error instanceof Error&&(error as Error&{submissionUncertain?:boolean}).submissionUncertain===false;
  try{
    const endpoint=await listen(server),snapshot=await hub.call<StudioSnapshot>('create',{title:'配音提交边界'}),project=snapshot.project!,located=await hub.resolveProject({projectId:project.id});
    const settings={endpoint,model:'fixture-tts',voice:'fixture-voice',speed:1,enabled:true},signal=new AbortController().signal;
    await assert.rejects(located.service.stageWorkflowVoice(project.shots[0]!.id,'旁白',signal,{...settings,enabled:false}),safelyUnsubmitted);
    await assert.rejects(located.service.stageWorkflowVoice(project.shots[0]!.id,'旁白',signal,{...settings,voice:''}),safelyUnsubmitted);
    await assert.rejects(located.service.stageWorkflowVoice('missing-shot','旁白',signal,settings),safelyUnsubmitted);
    const aborted=new AbortController();aborted.abort(new Error('already stopped'));
    await assert.rejects(located.service.stageWorkflowVoice(project.shots[0]!.id,'旁白',aborted.signal,settings),safelyUnsubmitted);assert.equal(submitted,0);
    await assert.rejects(located.service.stageWorkflowVoice(project.shots[0]!.id,'旁白',signal,settings),error=>error instanceof Error&&/HTTP 503/.test(error.message)&&(error as Error&{submissionUncertain?:boolean}).submissionUncertain!==false);assert.equal(submitted,1);
  }finally{await hub.dispose();await finish(server);await rm(base,{recursive:true,force:true});}
});

test('missing registry speech credentials remain safely retryable without contacting a provider',async()=>{
  const base=await mkdtemp(join(tmpdir(),'plugin-voice-credentials-'));
  const ctx:HostContext={...host(),llm:{listProviders:()=>[{id:'host',name:'DSH fixture'}],listModels:async()=>[{id:'fixture',name:'DSH fixture'}],async *stream(input){
    const request=JSON.parse((input.messages[0] as {content:{text:string}[]}).content[0]!.text);
    yield {type:'text-delta',text:JSON.stringify(request.shots?{shots:request.shots.map((shot:{id:string})=>({shotId:shot.id,prompt:'镜头',narration:'测试旁白'}))}:{html:'<div></div>',css:'',js:'export function render(ctx) {}'})};yield {type:'finish',reason:{kind:'stop'}};
  }}};
  const hub=new ProjectHub(ctx,{baseDirectory:base});let submitted=0;const server=createServer((_request,response)=>{submitted++;response.statusCode=500;response.end();});
  try{
    await hub.call('models.connection.save',{id:'speech-fixture',protocol:'speech',baseUrl:await listen(server),auth:'bearer'});
    await hub.call('models.model.save',{id:'speech-model',connectionId:'speech-fixture',model:'fixture-tts',parameters:{voice:'fixture-voice'}});await hub.call('models.role.bind',{role:'speech',modelId:'speech-model'});
    const project=(await hub.call<StudioSnapshot>('create',{title:'缺少配音凭据'})).project!;
    const record=await hub.call<WorkflowRecord>('workflows.run',{projectId:project.id,expectedRevision:project.revision,prompt:'配音镜头',visual:'code',narration:true,shotIds:[project.shots[0]!.id],textRoute:{provider:'host',model:'fixture'}});
    const failed=await until(()=>hub.workflows.get(record.id),item=>item.status==='failed');assert.equal(failed.steps.find(step=>step.kind==='speech')!.submissionUncertain,false);assert.equal(submitted,0);
  }finally{await hub.dispose();await finish(server);await rm(base,{recursive:true,force:true});}
});


test('slow staged workflow speech does not block saving the current project',async()=>{
  const base=await mkdtemp(join(tmpdir(),'plugin-voice-concurrent-save-')),hub=new ProjectHub(host(),{baseDirectory:base});
  let entered!:()=>void,release:(()=>void)|undefined,voice:Promise<unknown>|undefined;
  const contacted=new Promise<void>(resolve=>{entered=resolve;});
  const server=createServer((_request,response)=>{release=()=>{response.statusCode=503;response.end();};entered();});
  try{
    const url=await listen(server),project=(await hub.call<StudioSnapshot>('create',{title:'配音期间编辑'})).project!;
    const located=await hub.resolveProject({projectId:project.id});
    voice=located.service.stageWorkflowVoice(project.shots[0]!.id,'测试旁白',new AbortController().signal,{endpoint:url,model:'fixture',voice:'fixture',speed:1,enabled:true});void voice.catch(()=>{});
    await contacted;let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const saved=await Promise.race([hub.call<StudioSnapshot>('save',{projectId:project.id,expectedRevision:project.revision,project:{...project,title:'配音仍在等待时保存'}}),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('save was blocked by staged speech')),1500);})]);
      assert.equal(saved.project!.title,'配音仍在等待时保存');assert.equal(saved.project!.revision,project.revision+1);
    }finally{if(timer)clearTimeout(timer);}
    release!();await assert.rejects(voice,/HTTP 503/);
  }finally{release?.();await voice?.catch(()=>{});await hub.dispose();await finish(server);await rm(base,{recursive:true,force:true});}
});
