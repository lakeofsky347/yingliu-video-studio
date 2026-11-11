import test from 'node:test';
import assert from 'node:assert/strict';
import type {ToolRunContext} from '@deepseek-ai/dsh-tools';
import {createSessionTools} from '../src/host/session-tools.ts';
import type {ProjectHub} from '../src/host/project-hub.ts';
import type {HostContext} from '../src/host/platform.ts';
import {createProject} from '../src/core/index.ts';

function fixture(){
  const project=createProject('会话迁移测试','','code_animation');const calls:{endpoint:string;data:any}[]=[];let resolutions=0;
  const snapshot=()=>({project:structuredClone(project),root:'/fixture',task:null});
  const hub={async resolveProject(){resolutions++;return {projectId:project.id,snapshot:snapshot(),routing:{callerSessionId:'owner',ownerSessionId:'owner',routingSource:'session-binding'}};},
    async call(endpoint:string,data:any){calls.push({endpoint,data:structuredClone(data)});if(['import','apply','audio','audio.sfx'].includes(endpoint)){project.revision++;return snapshot();}if(endpoint==='director.document.get')return {document:undefined};if(endpoint==='director.document.save')return {document:{version:1,status:'draft'}};if(endpoint==='quality.last')return null;if(endpoint==='quality.check')return {status:'PARTIAL'};throw new Error('unexpected endpoint '+endpoint);}} as unknown as ProjectHub;
  const tools=createSessionTools({} as HostContext,hub);
  const exec:ToolRunContext={name:'fixture',callId:'unique-call',rootCallId:'root',arguments:{},token:Symbol('fixture'),agent:{id:'owner',options:{provider:'fixture',model:'fixture'}},signal:new AbortController().signal};
  return {project,calls,tools,get resolutions(){return resolutions;},run(name:string,args:object){return tools.find(tool=>tool.name===name)!.execute(args,exec);}};
}

test('video_update and video_audio require revision for every caller before reading attachments or projects',async()=>{
  const f=fixture();await assert.rejects(f.run('video_update',{update:{title:'unsafe'}}),/expectedRevision/);await assert.rejects(f.run('video_audio',{action:'import',path:'/fake'}),/expectedRevision/);
  await assert.rejects(f.run('video_update',{expectedRevision:-1,update:{}}),/需要 expectedRevision/);assert.equal(f.resolutions,0);assert.deepEqual(f.calls,[]);
});

test('multi-file tool imports carry stable distinct request IDs and each preceding import revision',async()=>{
  const f=fixture(),imports=[{text:'first',name:'one'},{text:'second',name:'two'}];
  await f.run('video_update',{expectedRevision:0,imports,update:{title:'更新'}});
  const first=f.calls.filter(call=>call.endpoint==='import');assert.equal(first.length,2);assert.notEqual(first[0].data.requestId,first[1].data.requestId);assert.deepEqual(first.map(call=>call.data.expectedRevision),[0,1]);assert.equal(f.calls.at(-1)!.data.expectedRevision,2);
  await f.run('video_update',{expectedRevision:f.project.revision,imports,update:{title:'更新'}});
  const repeated=f.calls.filter(call=>call.endpoint==='import').slice(2);assert.deepEqual(repeated.map(call=>call.data.requestId),first.map(call=>call.data.requestId));
  await f.run('video_update',{expectedRevision:f.project.revision,imports,requestId:'user-stable',update:{}});assert.deepEqual(f.calls.filter(call=>call.endpoint==='import').slice(-2).map(call=>call.data.requestId),['user-stable.0','user-stable.1']);
});

test('an import CAS retry cannot silently rebase the old update; reread reuses its durable import receipt',async()=>{
  const project=createProject('并发导入','','code_animation'),calls:{endpoint:string;data:any}[]=[],staged=new Set<string>();
  const snapshot=()=>({project:structuredClone(project),root:'/fixture',task:null});
  const hub={async resolveProject(){return {projectId:project.id,snapshot:snapshot(),routing:{callerSessionId:'owner',ownerSessionId:'owner',routingSource:'session-binding'}};},
    async call(endpoint:string,data:any){calls.push({endpoint,data:structuredClone(data)});
      if(endpoint==='import'){
        if(staged.has(data.requestId))return snapshot();
        if(!staged.size){project.topic='并发写入保留';project.revision++;} // A different writer wins before this import's append.
        staged.add(data.requestId);project.revision++;return snapshot();
      }
      assert.equal(endpoint,'apply');assert.equal(data.expectedRevision,project.revision);project.topic=data.topic;project.revision++;return snapshot();
    }} as unknown as ProjectHub;
  const tool=createSessionTools({} as HostContext,hub).find(item=>item.name==='video_update')!;
  const exec:ToolRunContext={name:'fixture',callId:'import-call',rootCallId:'root',arguments:{},token:Symbol('fixture'),agent:{id:'owner',options:{provider:'fixture',model:'fixture'}},signal:new AbortController().signal};
  const imports=[{text:'first',name:'one'},{text:'second',name:'two'}];
  await assert.rejects(tool.execute({expectedRevision:0,imports,requestId:'stable-imports',update:{topic:'旧快照覆盖'}},exec),{code:'REVISION_CONFLICT'});
  assert.equal(project.revision,2);assert.equal(project.topic,'并发写入保留');assert.deepEqual(calls.map(call=>call.endpoint),['import']);assert.deepEqual([...staged],['stable-imports.0']);
  // A newly read revision and explicitly merged update may resume the same import IDs.
  await tool.execute({expectedRevision:project.revision,imports,requestId:'stable-imports',update:{topic:project.topic+'，已合并'}},{...exec,callId:'retry-call'});
  assert.deepEqual([...staged],['stable-imports.0','stable-imports.1']);assert.deepEqual(calls.map(call=>call.endpoint),['import','import','import','apply']);
  assert.deepEqual(calls.map(call=>call.data.expectedRevision),[0,2,2,3]);assert.equal(project.topic,'并发写入保留，已合并');assert.equal(project.revision,4);
});

test('tool director documents can be read and saved with both revisions but cannot be approved',async()=>{
  const f=fixture();await f.run('video_director',{action:'document_get'});
  await assert.rejects(f.run('video_director',{action:'document_save',expectedRevision:0,plan:{}}),/expectedVersion/);
  await f.run('video_director',{action:'document_save',expectedRevision:0,expectedVersion:0,plan:{version:1}});
  assert.equal(f.calls.at(-1)!.endpoint,'director.document.save');assert.equal(f.calls.at(-1)!.data.expectedRevision,0);assert.equal(f.calls.at(-1)!.data.expectedVersion,0);
  const count=f.calls.length;await assert.rejects(f.run('video_director',{action:'document_approve'}),/不能批准|invalid arguments/);assert.equal(f.calls.length,count);
});

test('local SFX is routed to the local endpoint with stable identity and quality tools remain separate',async()=>{
  const f=fixture(),spec={kind:'chime',durationSeconds:.3,frequency:440};
  await f.run('video_audio',{action:'local_sfx',expectedRevision:0,name:'提示音',request:{spec,shotId:f.project.shots[0]!.id}});
  assert.equal(f.calls[0].endpoint,'audio.sfx');assert.deepEqual(f.calls[0].data.spec,spec);assert.match(f.calls[0].data.requestId,/^dsh-import-/);assert.equal(f.calls[0].data.expectedRevision,0);
  await f.run('video_quality',{action:'check',expectedRevision:1});await f.run('video_quality',{action:'last'});assert.deepEqual(f.calls.slice(1).map(call=>call.endpoint),['quality.check','quality.last']);
});
