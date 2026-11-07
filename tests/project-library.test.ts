import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectHub} from '../src/host/project-hub.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {ProjectLocation,StudioSnapshot,SceneSource} from '../src/shared/types.ts';
const context:HostContext={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No model calls in library tests');}},connection:{fetch:{register:()=>async()=>{}}},effect:()=>{}};

test('library rename, independent copy, archive and restore survive restart without copying Session bindings',async()=>{
 const base=await mkdtemp(join(tmpdir(),'dsh-library-'));let hub=new ProjectHub(context,{baseDirectory:base});
 try{
  const created=await hub.call<StudioSnapshot>('create',{productionMode:'code_animation',title:'原工程',topic:'中文故事',sessionId:'original-session'}),id=created.project!.id,shotId=created.project!.shots[0]!.id;
  const imported=await hub.call<StudioSnapshot>('import',{projectId:id,text:'保留的文本素材',name:'文案'});
  const source:SceneSource={html:'<h1></h1>',css:'h1{color:#ffeeaa}',js:'export function render(ctx){ctx.root.querySelector("h1").textContent=ctx.params.text}'};
  const edited=await hub.call<StudioSnapshot>('apply',{projectId:id,expectedRevision:imported.project!.revision,sources:[{shotId,source}]});
  const renamed=await hub.call<StudioSnapshot>('rename',{projectId:id,title:'重命名影片',expectedRevision:edited.project!.revision});assert.equal(renamed.project!.title,'重命名影片');
  const copy=await hub.call<StudioSnapshot>('duplicate',{projectId:id,title:'独立副本'});assert.notEqual(copy.project!.id,id);assert.equal(copy.project!.title,'独立副本');assert.deepEqual(copy.project!.outputs,[]);assert.deepEqual(copy.project!.sessionIds??[],[]);assert.equal(copy.project!.extensions.sessionIds,undefined);
  assert.equal(copy.project!.assets[0]!.text,'保留的文本素材');assert.deepEqual(await hub.call('source',{projectId:copy.project!.id,shotId}),source);
  await hub.call('archive',{projectId:id});const listed=await hub.call<{projects:ProjectLocation[]}>('list');assert.equal(listed.projects.some(p=>p.id===id),false);
  const all=await hub.call<{projects:ProjectLocation[]}>('list',{includeArchived:true});assert.equal(all.projects.find(p=>p.id===id)!.archived,true);assert.ok(all.projects.find(p=>p.id===id)!.archivedAt);
  const index=JSON.parse(await readFile(join(base,'sessions.json'),'utf8'));assert.equal(index.bindings['original-session'].currentProjectId,id);
  await hub.dispose();hub=new ProjectHub(context,{baseDirectory:base});const restored=await hub.call<StudioSnapshot>('restore',{projectId:id});assert.equal(restored.project!.title,'重命名影片');assert.ok(restored.relatedSessionIds!.includes('original-session'));assert.deepEqual(await hub.call('source',{projectId:id,shotId}),source);
  const current=await hub.call<StudioSnapshot>('current',{sessionId:'original-session'});assert.equal(current.project!.id,id);
 }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('concurrent lazy project reads share one service and preserve explicit Session selection',async()=>{
 const base=await mkdtemp(join(tmpdir(),'dsh-library-lazy-'));let hub=new ProjectHub(context,{baseDirectory:base});
 try{
  const a=await hub.call<StudioSnapshot>('create',{title:'A',sessionId:'session-A'}),b=await hub.call<StudioSnapshot>('create',{title:'B',sessionId:'session-B',select:false});
  await hub.dispose();hub=new ProjectHub(context,{baseDirectory:base});
  const reads=await Promise.all(Array.from({length:8},()=>hub.resolveProject({projectId:b.project!.id},'session-B')));assert.ok(reads.every(item=>item.service===reads[0]!.service));
  assert.equal((await hub.call<StudioSnapshot>('current')).project!.id,a.project!.id);assert.equal((await hub.call<StudioSnapshot>('current',{sessionId:'session-B'})).project!.id,b.project!.id);
 }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('changing a Session current project retains related projects and survives archive/restart',async()=>{
 const base=await mkdtemp(join(tmpdir(),'dsh-library-rebind-'));let hub=new ProjectHub(context,{baseDirectory:base});
 try{
  const a=await hub.call<StudioSnapshot>('create',{title:'A',sessionId:'moving-session'}),aId=a.project!.id;
  await hub.call('bindSession',{projectId:aId,sessionId:'retained-session'});
  const b=await hub.call<StudioSnapshot>('create',{title:'B',select:false}),bId=b.project!.id;
  await hub.call('archive',{projectId:aId});await hub.dispose();hub=new ProjectHub(context,{baseDirectory:base});
  await hub.call('bindSession',{projectId:bId,sessionId:'moving-session'});
  const restored=await hub.call<StudioSnapshot>('restore',{projectId:aId});
  assert.deepEqual(restored.relatedSessionIds,['moving-session','retained-session']);assert.deepEqual(restored.currentSessionIds,['retained-session']);assert.equal(restored.sessionId,undefined);
  const previous=await hub.call<StudioSnapshot>('focus',{projectId:aId,sessionId:'moving-session'});assert.equal(previous.sessionId,'moving-session');assert.deepEqual(previous.currentSessionIds,['retained-session']);
  assert.equal((await hub.call<StudioSnapshot>('current',{sessionId:'moving-session'})).project!.id,bId);
  await hub.dispose();hub=new ProjectHub(context,{baseDirectory:base});
  assert.equal((await hub.call<StudioSnapshot>('current',{sessionId:'moving-session'})).project!.id,bId);
  assert.equal((await hub.call<StudioSnapshot>('current',{sessionId:'retained-session'})).project!.id,aId);
 }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('renaming a library project leaves both host and client snapshot on the selected project',async()=>{
 const base=await mkdtemp(join(tmpdir(),'dsh-library-rename-other-'));let hub=new ProjectHub(context,{baseDirectory:base});
 try{
  const a=await hub.call<StudioSnapshot>('create',{title:'正在编辑的 A'}),b=await hub.call<StudioSnapshot>('create',{title:'列表中的 B',select:false});
  const renamed=await hub.call<StudioSnapshot>('rename',{projectId:b.project!.id,title:'更新后的 B'});
  assert.equal(renamed.project!.id,a.project!.id);assert.equal((await hub.call<StudioSnapshot>('current')).project!.id,a.project!.id);
  const listed=await hub.call<{projects:ProjectLocation[]}>('list');assert.equal(listed.projects.find(p=>p.id===b.project!.id)!.title,'更新后的 B');
  await hub.dispose();hub=new ProjectHub(context,{baseDirectory:base});
  assert.equal((await hub.call<StudioSnapshot>('catalog')).project!.id,a.project!.id);
  assert.equal((await hub.call<StudioSnapshot>('current',{projectId:b.project!.id})).project!.title,'更新后的 B');
 }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});
