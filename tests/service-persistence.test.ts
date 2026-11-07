import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {StudioService} from '../src/host/service.ts';import type {HostContext} from '../src/host/platform.ts';import type {StudioSnapshot,ExportResult} from '../src/shared/types.ts';
const ctx={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('unexpected model call');}}} as unknown as HostContext;
function serviceAt(base:string,context:HostContext=ctx){const service=new StudioService(context,{baseDirectory:base,restoreRecent:false});service.renderer.assetBaseUrl=async()=> 'http://127.0.0.1:1/';service.renderer.preview=async(_root,project)=>`http://127.0.0.1:1/?revision=${project.revision}`;service.renderer.audioPreview=async()=>null;service.renderer.check=async()=>({ok:true,errors:[],frames:[]});return service;}
async function value(service:StudioService,endpoint:string,payload:unknown={}):Promise<any>{const result=await service.rpc(endpoint,payload);assert.equal(result.ok,true,result.ok?'':result.error.message);return result.ok?result.value:undefined;}
async function finished(service:StudioService){const deadline=Date.now()+5000;let snapshot=await service.snapshot();while(snapshot.task?.status==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,5));snapshot=await service.snapshot();}assert.notEqual(snapshot.task?.status,'running','task must finish');return snapshot;}
test('same-project CAS serializes competing saves and rejects stale writers',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-cas-')),service=serviceAt(base);
  try{const initial=await value(service,'create',{productionMode:'code_animation',title:'原始'}) as StudioSnapshot;const a=structuredClone(initial.project!),b=structuredClone(initial.project!);a.title='修改 A';b.title='修改 B';
    const results=await Promise.all([service.rpc('save',{project:a,expectedRevision:a.revision}),service.rpc('save',{project:b,expectedRevision:b.revision})]);
    assert.equal(results.filter(result=>result.ok).length,1,'only one mutation may commit the same expectedRevision');const conflict=results.find(result=>!result.ok)!;assert.equal(conflict.ok,false);if(!conflict.ok)assert.equal(conflict.error.code,'REVISION_CONFLICT');
    const current=await service.snapshot();assert.equal(current.project!.title,'修改 A');assert.equal(current.project!.revision,initial.project!.revision+1);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
test('legacy requests remain compatible; persisted undo/redo uses increasing revisions and CAS',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-history-'));let service=serviceAt(base);
  try{const initial=await value(service,'create',{productionMode:'code_animation',title:'初始名称'}),edited=await value(service,'rename',{title:'新名称'});assert.equal(edited.project.revision,initial.project.revision+1);
    await service.dispose();service=serviceAt(base);await value(service,'open',{path:initial.root});const history=await value(service,'history');assert.equal(history.canUndo,true);assert.equal(history.entries.at(-1).label,'重命名工程');
    const undone=await value(service,'undo',{expectedRevision:edited.project.revision});assert.equal(undone.project.title,'初始名称');assert.equal(undone.project.revision,edited.project.revision+1);
    const stale=await service.rpc('redo',{expectedRevision:edited.project.revision});assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.error.code,'REVISION_CONFLICT');
    const redone=await value(service,'redo');assert.equal(redone.project.title,'新名称');assert.equal(redone.project.revision,undone.project.revision+1);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
test('apply validates every source before committing metadata; preview failure preserves the saved version',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-apply-')),service=serviceAt(base);
  try{const initial=await value(service,'create',{productionMode:'code_animation',title:'不可半写'}),shot=initial.project.shots[0],source=await value(service,'source',{shotId:shot.id});
    const rejected=await service.rpc('apply',{title:'不得保存',sources:[{shotId:shot.id,source:{...source,html:'<main>不得保存</main>'}},{shotId:initial.project.shots[1].id,source:{html:'',css:'',js:'invalid'}}],expectedRevision:initial.project.revision});assert.equal(rejected.ok,false);
    assert.deepEqual(await value(service,'source',{shotId:shot.id}),source);assert.equal((await service.snapshot()).project!.title,'不可半写');
    service.renderer.preview=async()=>{throw new Error('fixture preview startup error');};
    const saved=await value(service,'saveSource',{shotId:shot.id,source:{...source,html:'<main>持久保存</main>'},check:false,expectedRevision:initial.project.revision});
    assert.equal(saved.project.revision,initial.project.revision+1);assert.equal(saved.task.status,'failed');assert.match(saved.task.message,/工程已保存/);assert.equal((await value(service,'source',{shotId:shot.id})).html,'<main>持久保存</main>');
    const history=await value(service,'history');assert.equal(history.canUndo,true);assert.equal(history.entries.length,2);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
test('running task is journaled before work and export retains its source revision while workbench saves',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-journal-')),service=serviceAt(base);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let oldSource='';
  try{const initial=await value(service,'create',{productionMode:'code_animation',title:'快照导出'}),shot=initial.project.shots[0];const source=await value(service,'source',{shotId:shot.id});
    service.renderer.export=async(root,project)=>{await gate;oldSource=(await service.store.readSource(root,shot,project.revision)).html;return {id:'fixture-export',path:join(root,'exports','fixture-export','video.mp4'),createdAt:new Date().toISOString(),revision:project.revision,width:project.target.width,height:project.target.height,frameCount:project.shots.reduce((sum,shot)=>sum+shot.durationFrames,0),duration:30} as ExportResult;};
    const started=await value(service,'export',{expectedRevision:initial.project.revision}),journal=JSON.parse(await readFile(started.task.logPath,'utf8'));
    assert.equal(journal.status,'running');assert.equal(journal.revision,initial.project.revision);assert.equal(journal.request.endpoint,'export');
    const next=structuredClone(initial.project);next.title='导出中已编辑';next.shots=next.shots.slice(1);next.shotOrder=next.shots.map((shot:any)=>shot.id);
    service.renderer.preview=async()=>{throw new Error('fixture preview failure during export');};const edited=await value(service,'save',{project:next,expectedRevision:initial.project.revision});assert.equal(edited.task.id,started.task.id);assert.equal(edited.task.status,'running');
    release();const completed=await finished(service);assert.equal(completed.task?.status,'complete');assert.equal(oldSource,source.html);assert.equal(completed.project!.title,'导出中已编辑');assert.equal(completed.project!.outputs[0]!.revision,initial.project.revision);
    const finalJournal=JSON.parse(await readFile(started.task.logPath,'utf8'));assert.equal(finalJournal.status,'complete');assert.ok(finalJournal.finishedAt);assert.ok((await value(service,'tasks')).tasks.some((task:any)=>task.kind==='preview'&&task.status==='failed'));
  }finally{release();await service.dispose();await rm(base,{recursive:true,force:true});}
});
test('restart marks unfinished tasks interrupted; retries use current project and reject audio/arbitrary requests',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-recovery-'));let service=serviceAt(base);let calls=0;
  try{const initial=await value(service,'create',{productionMode:'code_animation',title:'任务恢复'});await service.dispose();const folder=join(initial.root,'.studio','tasks');await mkdir(folder,{recursive:true});
    for(const [id,kind,request] of [['old-preview','preview',{endpoint:'preview',payload:{apiKey:'must-not-copy'}}],['old-audio','audio',{endpoint:'audio',payload:{text:'不可自动付费'}}],['legacy-export','export',{endpoint:'export',payload:{}}]] as const){await writeFile(join(folder,id+'.json'),JSON.stringify({id,kind,request,status:'running',progress:.3,message:'未完成',startedAt:'2026-10-06T00:00:00Z',recordVersion:id==='legacy-export'?undefined:1,revision:initial.project.revision}));}
    service=serviceAt(base);service.renderer.check=async()=>{calls++;return {ok:true,errors:[],frames:[]};};await value(service,'open',{path:initial.root});assert.equal(calls,0,'opening must not automatically run tasks');
    const records=(await value(service,'tasks')).tasks;assert.equal(records.length,3);for(const task of records)assert.equal(task.status,'interrupted');assert.equal(records.find((task:any)=>task.id==='old-preview').retryable,true);assert.equal(records.find((task:any)=>task.id==='old-audio').retryable,false);assert.equal(records.find((task:any)=>task.id==='legacy-export').retryable,false);
    const journal=JSON.parse(await readFile(join(folder,'old-preview.json'),'utf8'));assert.deepEqual(journal.request.payload,{});assert.match(journal.error,/TASK_INTERRUPTED/);
    const changed=await value(service,'rename',{title:'明确重试当前版本'});await value(service,'retry',{taskId:'old-preview',expectedRevision:changed.project.revision});const complete=await finished(service);assert.equal(complete.task!.retryOf,'old-preview');assert.equal(complete.task!.revision,changed.project.revision);assert.equal(calls,1);
    const audio=await service.rpc('retry',{taskId:'old-audio',expectedRevision:changed.project.revision});assert.equal(audio.ok,false);if(!audio.ok)assert.match(audio.error.message,/配音/);
    const old=await service.rpc('retry',{taskId:'legacy-export',expectedRevision:changed.project.revision});assert.equal(old.ok,false);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
test('durable task start failure prevents background work; cancelled jobs settle without deadlock',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-task-start-')),service=serviceAt(base);let calls=0;
  try{const initial=await value(service,'create',{productionMode:'code_animation',title:'任务落盘失败'});await writeFile(join(initial.root,'.studio','tasks'),'not-a-directory');service.renderer.check=async()=>{calls++;return {ok:true,errors:[],frames:[]};};
    const rejected=await service.rpc('preview',{});assert.equal(rejected.ok,false);assert.equal(calls,0);await rm(join(initial.root,'.studio','tasks'));
    service.renderer.check=async(_root,_project,_settings,signal)=>new Promise((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});});
    const started=await value(service,'preview',{});assert.equal(started.task.status,'running');await value(service,'cancel');assert.equal((await finished(service)).task!.status,'cancelled');
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});

for(const failLater of [false,true])test(`simulated scene generation ${failLater?'retains complete earlier scenes after failure':'commits all scenes'} as one persistent undo group`,async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-generation-group-'));let calls=0;
  const context={llm:{...ctx.llm,listModels:async()=>[{id:'offline-fixture',name:'离线测试模型'}],async *stream(){calls++;yield {type:'text-delta',text:JSON.stringify({html:`<main>生成 ${calls}</main>`,css:'',js:failLater&&calls===2?'broken fixture source':'export function render(ctx){}',shotPatch:{intent:`镜头意图 ${calls}`}})};yield {type:'finish',reason:{kind:'stop'}};}}} as unknown as HostContext;
  const service=serviceAt(base,context);
  try{const initial=await value(service,'create',{productionMode:'code_animation',title:'生成事务'}),initialSources=await Promise.all(initial.project.shots.map((shot:any)=>value(service,'source',{shotId:shot.id})));
    await value(service,'generate',{kind:'scenes',provider:'offline-fixture',model:'offline-fixture',expectedRevision:initial.project.revision});const generated=await finished(service);assert.equal(generated.task!.status,failLater?'failed':'complete',JSON.stringify(generated.task));assert.equal(generated.project!.revision,initial.project.revision+(failLater?1:initial.project.shots.length));assert.equal(generated.project!.shots[0]!.intent,'镜头意图 1');
    if(failLater)assert.deepEqual(await value(service,'source',{shotId:initial.project.shots[1].id}),initialSources[1]);const history=await value(service,'history');assert.equal(history.entries.length,2);assert.equal(history.canUndo,true);
    const undone=await value(service,'undo',{expectedRevision:generated.project!.revision});assert.equal(undone.project.revision,generated.project!.revision+1);for(let i=0;i<initial.project.shots.length;i++)assert.deepEqual(await value(service,'source',{shotId:initial.project.shots[i].id}),initialSources[i]);
    assert.equal(undone.project.shots[0].intent,initial.project.shots[0].intent);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});

test('service content undo retains export receipts and session binding before and after reopening',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-undo-artifacts-'));let service=serviceAt(base);
  try{const initial=await value(service,'create',{productionMode:'code_animation',title:'初稿'});await value(service,'rename',{title:'二稿'});const edited=await value(service,'rename',{title:'三稿'});
    service.renderer.export=async(root,project)=>({id:'fixture-output',path:join(root,'exports','fixture-output','video.mp4'),createdAt:new Date().toISOString(),revision:project.revision,width:project.target.width,height:project.target.height,frameCount:900,duration:30});await value(service,'export');const exported=await finished(service);assert.equal(exported.task!.status,'complete');const bound=structuredClone(exported.project!);bound.sessionIds=['session-keep'];bound.extensions.sessionIds=['session-keep'];await value(service,'save',{project:bound,expectedRevision:exported.project!.revision});
    for(let i=0;i<4;i++){const current=await service.snapshot(),undone=await value(service,'undo',{expectedRevision:current.project!.revision});assert.equal(undone.project.outputs[0].id,'fixture-output');assert.equal(undone.project.outputs[0].revision,edited.project.revision);assert.deepEqual(undone.project.sessionIds,['session-keep']);assert.deepEqual(undone.project.extensions.sessionIds,['session-keep']);}
    const undo=await service.snapshot();assert.equal(undo.project!.title,'初稿');await service.dispose();service=serviceAt(base);const reopened=await value(service,'open',{path:initial.root});assert.equal(reopened.project.outputs[0].id,'fixture-output');assert.equal(reopened.project.outputs[0].revision,edited.project.revision);assert.deepEqual(reopened.project.sessionIds,['session-keep']);assert.deepEqual(reopened.project.extensions.sessionIds,['session-keep']);
    const redone=await value(service,'redo',{expectedRevision:reopened.project.revision});assert.equal(redone.project.title,'二稿');assert.equal(redone.project.outputs[0].id,'fixture-output');assert.deepEqual(redone.project.sessionIds,['session-keep']);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
