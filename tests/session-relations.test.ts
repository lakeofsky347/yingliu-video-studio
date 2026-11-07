import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {HostContext,SessionDirectoryRow} from '../src/host/platform.ts';
import type {StudioSnapshot,SessionBindings} from '../src/shared/types.ts';
import type {ToolDefinition,ToolRunContext} from '@deepseek-ai/dsh-tools';
import type {JobHooks} from '@deepseek-ai/dsh-jobs';
import {ProjectHub} from '../src/host/project-hub.ts';
import {createSessionTools} from '../src/host/session-tools.ts';

const context:HostContext={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('Relation tools must not call a model');}},connection:{fetch:{register:()=>async()=>{}}},effect:()=>{}};
type Listing={bindings:SessionBindings;sessions:Record<string,string>;projects:{id:string}[]};
function directory(rows:SessionDirectoryRow[]):HostContext{return {...context,sessionController:{async list(){return {items:rows};}}};}
function execution(name:string,sessionId:string):ToolRunContext{return {name,callId:'relation-call',rootCallId:'relation-call',arguments:{},token:Symbol(),signal:new AbortController().signal,agent:{id:sessionId,options:{}}};}
function run(tools:ToolDefinition[],name:string,args:object,sessionId:string){return tools.find(tool=>tool.name===name)!.execute(args,execution(name,sessionId)) as Promise<Record<string,any>>;}

test('relation changes are separate from film revisions and a Session retains multiple projects',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-relations-')),rows=[{sessionId:'conversation',running:false},{sessionId:'second',running:false}],hub=new ProjectHub(directory(rows),{baseDirectory:base});
  try{
    const a=await hub.call<StudioSnapshot>('create',{title:'A'}),b=await hub.call<StudioSnapshot>('create',{title:'B',select:false});
    const originalA=await readFile(join(a.root!,'project.json'),'utf8'),originalB=await readFile(join(b.root!,'project.json'),'utf8');
    await hub.call('bindSession',{projectId:b.project!.id,sessionId:'second'});
    assert.equal((await hub.call<StudioSnapshot>('current')).project!.id,a.project!.id,'binding another project does not change visible/global selection');
    await hub.call('bindSession',{projectId:a.project!.id,sessionId:'conversation',select:false,expectedCurrentProjectId:null});
    await hub.call('bindSession',{projectId:b.project!.id,sessionId:'conversation',select:false,expectedCurrentProjectId:a.project!.id});
    await hub.call('bindSession',{projectId:a.project!.id,sessionId:'second',select:false});
    const listed=await hub.call<Listing>('list');assert.deepEqual(listed.bindings.conversation!.relatedProjectIds,[a.project!.id,b.project!.id]);assert.equal(listed.sessions.conversation,b.project!.id);
    const focused=await hub.call<StudioSnapshot>('focus',{projectId:a.project!.id,sessionId:'conversation'});assert.equal(focused.sessionId,'conversation');assert.deepEqual(focused.currentSessionIds,['second']);
    assert.equal((await hub.call<Listing>('list')).sessions.conversation,b.project!.id,'browsing does not switch current project');
    await hub.call('unbindSession',{projectId:b.project!.id,sessionId:'conversation',expectedCurrentProjectId:b.project!.id});
    const unbound=await hub.call<Listing>('list');assert.deepEqual(unbound.bindings.conversation!.relatedProjectIds,[a.project!.id]);assert.equal(unbound.sessions.conversation,undefined);
    assert.equal(await readFile(join(a.root!,'project.json'),'utf8'),originalA);assert.equal(await readFile(join(b.root!,'project.json'),'utf8'),originalB);
    assert.equal((await hub.call<StudioSnapshot>('current',{projectId:a.project!.id})).project!.revision,a.project!.revision);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('v1 index migrates without reviving portable Session fields or altering film contents',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-relation-migration-'));let hub=new ProjectHub(context,{baseDirectory:base});
  try{
    const created=await hub.call<StudioSnapshot>('create',{title:'旧工程'}),project=structuredClone(created.project!);project.sessionIds=['foreign-session'];project.extensions.sessionIds=['foreign-session'];
    const saved=await hub.call<StudioSnapshot>('save',{project,expectedRevision:project.revision}),contents=await readFile(join(saved.root!,'project.json'),'utf8');
    const previous=await hub.call<Listing>('list');await hub.dispose();
    await writeFile(join(base,'sessions.json'),JSON.stringify({version:1,projects:previous.projects,selected:project.id,sessions:{'known-session':project.id}}));
    hub=new ProjectHub(context,{baseDirectory:base});const migrated=await hub.call<Listing>('list');
    assert.equal(migrated.bindings['known-session']!.currentProjectId,project.id);assert.deepEqual(migrated.bindings['known-session']!.relatedProjectIds,[project.id]);assert.equal(migrated.bindings['foreign-session'],undefined);
    assert.equal(JSON.parse(await readFile(join(base,'sessions.json'),'utf8')).version,2);assert.equal(await readFile(join(saved.root!,'project.json'),'utf8'),contents);
    await hub.call('open',{path:saved.root});assert.equal((await hub.call<Listing>('list')).bindings['foreign-session'],undefined);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('failed atomic relation write and stale current-project check leave the old binding intact',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-relation-atomic-')),hub=new ProjectHub(context,{baseDirectory:base});
  try{
    const a=await hub.call<StudioSnapshot>('create',{title:'A',sessionId:'session'}),b=await hub.call<StudioSnapshot>('create',{title:'B',select:false});
    const before=await readFile(join(base,'sessions.json'),'utf8');await mkdir(join(base,'sessions.json.tmp'));
    await assert.rejects(hub.call('bindSession',{projectId:b.project!.id,sessionId:'session',select:false}),/EISDIR/);
    assert.equal((await hub.call<Listing>('list')).sessions.session,a.project!.id);assert.equal(await readFile(join(base,'sessions.json'),'utf8'),before);
    await rm(join(base,'sessions.json.tmp'),{recursive:true});
    await assert.rejects(hub.call('bindSession',{projectId:b.project!.id,sessionId:'session',select:false,expectedCurrentProjectId:null}),/当前工程已改变/);
    assert.equal((await hub.call<Listing>('list')).sessions.session,a.project!.id);
    await hub.call('bindSession',{projectId:b.project!.id,sessionId:'session',select:false,expectedCurrentProjectId:a.project!.id});
    assert.equal((await hub.call<Listing>('list')).sessions.session,b.project!.id);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('actual Session directory validates binding and protects a running delegated descendant',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-relation-busy-')),rows:SessionDirectoryRow[]=[{sessionId:'lead',running:false},{sessionId:'worker',running:false,origin:'subagent',parentSessionId:'lead'},{sessionId:'fork',running:false,parentSessionId:'lead'}],hub=new ProjectHub(directory(rows),{baseDirectory:base});
  try{
    const a=await hub.call<StudioSnapshot>('create',{title:'A',sessionId:'lead'}),b=await hub.call<StudioSnapshot>('create',{title:'B',select:false});
    await assert.rejects(hub.call('bindSession',{projectId:b.project!.id,sessionId:'missing'}),/会话已不可用/);
    rows[1]!.running=true;
    await assert.rejects(hub.call('bindSession',{projectId:b.project!.id,sessionId:'lead'}),/子代理仍在执行/);
    await assert.rejects(hub.call('unbindSession',{projectId:a.project!.id,sessionId:'lead'}),/子代理仍在执行/);
    await hub.call('bindSession',{projectId:a.project!.id,sessionId:'lead',select:false});
    rows[1]!.running=false;await hub.call('bindSession',{projectId:a.project!.id,sessionId:'worker',select:false});rows[1]!.running=true;rows[2]!.running=true;
    await hub.call('bindSession',{projectId:b.project!.id,sessionId:'lead',select:false});
    assert.equal((await hub.call<Listing>('list')).sessions.lead,b.project!.id,'independently bound child and fork do not follow lead routing');
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('nested subagents and team members inherit the nearest binding; fork stays independent',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-team-routing-')),rows:SessionDirectoryRow[]=[{sessionId:'lead',running:false},{sessionId:'worker',running:false,origin:'subagent',parentSessionId:'lead'},{sessionId:'nested',running:false,origin:'subagent',parentSessionId:'worker'},{sessionId:'teammate',running:false,origin:'subagent',parentSessionId:'lead'},{sessionId:'fork',running:false,parentSessionId:'lead'}],ctx=directory(rows),hub=new ProjectHub(ctx,{baseDirectory:base}),tools=createSessionTools(ctx,hub);
  try{
    const lead=await run(tools,'video_project',{action:'create',title:'团队影片'},'lead');
    for(const caller of ['worker','nested','teammate']){
      const current=await run(tools,'video_project',{action:'get'},caller);assert.equal(current.projectId,lead.projectId);assert.equal(current.callerSessionId,caller);assert.equal(current.ownerSessionId,'lead');assert.equal(current.sessionId,'lead');assert.equal(current.routingSource,'subagent-ancestor');
    }
    const reused=await run(tools,'video_project',{action:'create',title:'不应重复建立'},'teammate');assert.equal(reused.projectId,lead.projectId);assert.equal(reused.reusedInheritedProject,true);assert.equal((await hub.call<Listing>('list')).projects.length,1);
    await assert.rejects(run(tools,'video_project',{action:'get'},'fork'),/还没有视频工程/);
    const own=await run(tools,'video_project',{action:'create',title:'独立子工程',forceNew:true},'worker');assert.notEqual(own.projectId,lead.projectId);
    assert.equal((await run(tools,'video_project',{action:'get'},'nested')).ownerSessionId,'worker');
    await hub.call('unbindSession',{projectId:own.projectId,sessionId:'worker'});
    await assert.rejects(run(tools,'video_project',{action:'get'},'worker'),/还没有视频工程/);await assert.rejects(run(tools,'video_project',{action:'get'},'nested'),/还没有视频工程/);
    assert.equal((await run(tools,'video_project',{action:'get'},'teammate')).projectId,lead.projectId);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('cold child catalogs provide validated lineage without opening or activating Sessions',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-cold-child-')),reads:string[]=[],values:Record<string,Record<string,unknown>>={lead:{subagentCatalog:[{id:'cold-parent'}]},'cold-parent':{subagentCatalog:[{id:'cold-worker'}]},'cold-worker':{subagentCatalog:[]}};
  const ctx:HostContext={...context,sessionController:{async list(){return {items:[{sessionId:'lead',running:false}]};},async projections({sessionId}){reads.push(sessionId);return values[sessionId]?{values:values[sessionId]!}:null;}}},hub=new ProjectHub(ctx,{baseDirectory:base}),tools=createSessionTools(ctx,hub);
  try{
    const lead=await run(tools,'video_project',{action:'create'},'lead'),child=await run(tools,'video_project',{action:'get'},'cold-worker');assert.equal(child.projectId,lead.projectId);assert.equal(child.ownerSessionId,'lead');assert.ok(reads.includes('cold-parent'));assert.ok(reads.includes('cold-worker'));
    const independent=await hub.call<StudioSnapshot>('create',{title:'冷子工程',select:false});await hub.call('bindSession',{projectId:independent.project!.id,sessionId:'cold-parent',select:false});assert.equal((await run(tools,'video_project',{action:'get'},'cold-worker')).projectId,independent.project!.id);
    await assert.rejects(hub.call('bindSession',{projectId:lead.projectId,sessionId:'not-in-catalog'}),/会话已不可用/);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('a title-only cached Session projection refreshes the complete catalog for cold child routing',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-title-only-catalog-')),reads:string[]=[];
  const ctx:HostContext={...context,sessionController:{
    async list(){return {items:[{sessionId:'lead',running:false,projections:{kind:'cached',asOfSeq:0,values:{title:'缓存中的会话标题'}}}]};},
    async projections({sessionId}){reads.push(sessionId);return sessionId==='lead'?{values:{subagentCatalog:[{id:'cold-worker'},{id:'deleted-worker'}]}}:sessionId==='cold-worker'?{values:{subagentCatalog:[]}}:null;}
  }},hub=new ProjectHub(ctx,{baseDirectory:base}),tools=createSessionTools(ctx,hub);
  try{
    const lead=await run(tools,'video_project',{action:'create'},'lead'),child=await run(tools,'video_project',{action:'get'},'cold-worker');
    assert.equal(child.projectId,lead.projectId);assert.equal(child.ownerSessionId,'lead');assert.equal(child.routingSource,'subagent-ancestor');assert.ok(reads.includes('lead'));assert.ok(reads.includes('cold-worker'));
    await assert.rejects(hub.call('bindSession',{projectId:lead.projectId,sessionId:'deleted-worker'}),/会话已不可用/);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('team edits require a read revision and concurrent commits cannot overwrite each other',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-team-conflict-')),rows:SessionDirectoryRow[]=[{sessionId:'lead',running:false},...['editor-A','editor-B'].map(sessionId=>({sessionId,running:false,origin:'subagent' as const,parentSessionId:'lead'}))],ctx=directory(rows),hub=new ProjectHub(ctx,{baseDirectory:base}),tools=createSessionTools(ctx,hub);
  try{
    const project=await run(tools,'video_project',{action:'create'},'lead');await assert.rejects(run(tools,'video_update',{update:{title:'无版本'}},'editor-A'),/需要 expectedRevision/);
    const [a,b]=await Promise.all(['editor-A','editor-B'].map(caller=>run(tools,'video_project',{action:'get'},caller)));
    const results=await Promise.allSettled([run(tools,'video_update',{expectedRevision:a.revision,update:{title:'A 的修改'}},'editor-A'),run(tools,'video_update',{expectedRevision:b.revision,update:{title:'B 的修改'}},'editor-B')]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
    const latest=await run(tools,'video_project',{action:'get'},'lead');assert.equal(latest.revision,project.revision+1);assert.ok(['A 的修改','B 的修改'].includes(latest.title));
    const merged=await run(tools,'video_update',{projectId:project.projectId,expectedRevision:latest.revision,update:{topic:'合并另一位成员的补充'}},'editor-B');assert.equal(merged.title,latest.title);assert.equal(merged.routingSource,'explicit-project');assert.equal(merged.ownerSessionId,'lead');
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('an explicit project ID permits cross-agent collaboration without changing either Session default',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-cross-agent-')),rows:SessionDirectoryRow[]=[{sessionId:'lead-A',running:false},{sessionId:'lead-B',running:false},{sessionId:'worker',running:false,origin:'subagent',parentSessionId:'lead-A'}],ctx=directory(rows),hub=new ProjectHub(ctx,{baseDirectory:base}),tools=createSessionTools(ctx,hub);
  try{
    const a=await run(tools,'video_project',{action:'create',title:'A'},'lead-A'),b=await run(tools,'video_project',{action:'create',title:'B'},'lead-B');
    const listed=await run(tools,'video_project',{action:'list'},'worker');assert.equal(listed.ownerSessionId,'lead-A');assert.equal(listed.projectId,a.projectId);
    const foreign=await run(tools,'video_project',{action:'get',projectId:b.projectId},'worker');assert.equal(foreign.ownerSessionId,'worker');assert.equal(foreign.routingSource,'explicit-project');
    await assert.rejects(run(tools,'video_update',{projectId:b.projectId,update:{title:'未读取版本'}},'worker'),/需要 expectedRevision/);
    await run(tools,'video_update',{projectId:b.projectId,expectedRevision:foreign.revision,update:{topic:'协助 B 工程'}},'worker');
    assert.equal((await run(tools,'video_project',{action:'get'},'worker')).projectId,a.projectId);assert.equal((await run(tools,'video_project',{action:'get'},'lead-A')).topic,a.topic);assert.equal((await run(tools,'video_project',{action:'get'},'lead-B')).topic,'协助 B 工程');
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('team projection makes the lead a versioned writer alongside its teammate',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-team-lead-version-')),rows:SessionDirectoryRow[]=[{sessionId:'lead',running:false,projections:{values:{agentTeam:{members:[{id:'lead',role:'lead'},{id:'member',role:'teammate',phase:'active'}]}}}},{sessionId:'member',running:false,origin:'subagent',parentSessionId:'lead'}],ctx=directory(rows),hub=new ProjectHub(ctx,{baseDirectory:base}),tools=createSessionTools(ctx,hub);
  try{
    await run(tools,'video_project',{action:'create'},'lead');await assert.rejects(run(tools,'video_update',{update:{shots:[]}},'lead'),/需要 expectedRevision/);
    const [lead,member]=await Promise.all(['lead','member'].map(caller=>run(tools,'video_project',{action:'get'},caller)));
    const results=await Promise.allSettled([run(tools,'video_update',{expectedRevision:lead.revision,update:{topic:'Lead 修改'}},'lead'),run(tools,'video_update',{expectedRevision:member.revision,update:{title:'Member 修改'}},'member')]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('team background jobs keep caller ownership and pin the project even after lead switches current',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-team-job-')),rows:SessionDirectoryRow[]=[{sessionId:'lead',running:false},{sessionId:'worker',running:false,origin:'subagent',parentSessionId:'lead'}];let hooks:JobHooks|undefined,jobOwner:string|undefined;
  const ctx:HostContext={...directory(rows),jobs:{start(spec){jobOwner=spec.owner;hooks=spec.run({id:'team-job',append:()=>{},updateProgress:()=>{}});return 'team-job';}}},hub=new ProjectHub(ctx,{baseDirectory:base}),tools=createSessionTools(ctx,hub);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  try{
    const a=await run(tools,'video_project',{action:'create',title:'影片 A'},'lead'),b=await hub.call<StudioSnapshot>('create',{title:'影片 B',select:false}),located=await hub.resolveProject({},'worker');
    await hub.call('production.set',{projectId:a.projectId,expectedRevision:a.revision,mode:'code_animation'});
    located.service.renderer.check=async()=>{await gate;return {ok:true,errors:[],frames:[]};};
    const job=await run(tools,'video_render',{action:'check'},'worker');assert.equal(jobOwner,'worker');assert.equal(job.projectId,a.projectId);assert.equal(job.ownerSessionId,'lead');assert.equal(job.callerSessionId,'worker');
    await hub.call('bindSession',{projectId:b.project!.id,sessionId:'lead',select:false});release();
    const result=await hooks!.done;assert.equal(result.status,'completed');const receipt=JSON.parse(result.result!);assert.equal(receipt.projectId,a.projectId);assert.equal(receipt.callerSessionId,'worker');assert.equal(receipt.ownerSessionId,'lead');assert.equal((await run(tools,'video_project',{action:'get'},'worker')).projectId,b.project!.id);
  }finally{release();await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('cancelling a foreground request before task acquisition does not cancel another agent task',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-team-foreground-')),hub=new ProjectHub(context,{baseDirectory:base}),tools=createSessionTools(context,hub),controller=new AbortController();
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let entered!:()=>void;const acquiring=new Promise<void>(resolve=>entered=resolve);let cancellations=0;
  try{
    await run(tools,'video_project',{action:'create'},'session');const located=await hub.resolveProject({},'session'),original=located.service.rpc.bind(located.service);
    located.service.rpc=async(endpoint,payload)=>{if(endpoint==='preview'){entered();await gate;return {ok:false,error:{code:'TASK_BUSY',message:'另一成员任务仍在运行'}};}if(endpoint==='cancel')cancellations++;return original(endpoint,payload);};
    const exec={...execution('video_render','session'),signal:controller.signal},request=tools.find(tool=>tool.name==='video_render')!.execute({action:'check',foreground:true},exec);
    await acquiring;controller.abort(new Error('取消尚未获得任务的请求'));await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(cancellations,0);release();await assert.rejects(request,/另一成员任务仍在运行/);
  }finally{release();await hub.dispose();await rm(base,{recursive:true,force:true});}
});
