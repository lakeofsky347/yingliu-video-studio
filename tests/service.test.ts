import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,cp,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {StudioService} from '../src/host/service.ts';import {duplicateShot,reorderFromGraph} from '../src/core/index.ts';
import {parseModelJson,parseSceneSource} from '../src/host/generator.ts';
import type {HostContext} from '../src/host/platform.ts';import type {StudioSnapshot} from '../src/shared/types.ts';
const ctx={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('unexpected model call');}}} as unknown as HostContext;
async function value(service:StudioService,endpoint:string,payload:unknown={}):Promise<any>{const result=await service.rpc(endpoint,payload);assert.equal(result.ok,true,result.ok?'':result.error.message);return result.ok?result.value:undefined;}
test('save broken graph, clone current source, restart project without model calls',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-studio-service-'));let service=new StudioService(ctx,{baseDirectory:base});
  try{
    const start=await value(service,'create',{productionMode:'code_animation',title:'持久化中文项目',topic:'图文到视频'}) as StudioSnapshot;
    const source=await value(service,'source',{shotId:start.project!.shots[0]!.id});source.js+='\n// manual edit kept in duplicate';
    const edited=await value(service,'saveSource',{shotId:start.project!.shots[0]!.id,source,check:false}) as StudioSnapshot;
    let project=duplicateShot(edited.project!,edited.project!.shots[0]!.id);const clone=project.shots.at(-1)!;
    await value(service,'save',{project});const copied=await value(service,'source',{shotId:clone.id});assert.match(copied.js,/manual edit kept/);
    project=reorderFromGraph(project,[]);const draft=await value(service,'save',{project}) as StudioSnapshot;assert.equal(draft.project!.shotOrder.length,0);assert.equal(draft.previewRevision,null);
    const preview=await service.rpc('preview',{});assert.equal(preview.ok,false);
    await service.dispose();service=new StudioService(ctx,{baseDirectory:base});const restored=await value(service,'current') as StudioSnapshot;assert.equal(restored.project!.id,project.id);assert.equal(restored.project!.shots.length,4);assert.equal(restored.project!.shotOrder.length,0);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
test('model JSON fences and scene contract',()=>{
  assert.deepEqual(parseModelJson('```json\n{"shots":[]}\n```'),{shots:[]});
  assert.throws(()=>parseSceneSource('{"html":"","css":"","js":"oops"}'),/render/);
  assert.equal(parseSceneSource(JSON.stringify({html:'',css:'',js:'export function render(ctx){}',shotPatch:{title:'新标题'}})).shotPatch?.title,'新标题');
});
test('source-only simulated generation increments revision and changes preview URL; media checker is stubbed',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-studio-revision-'));let serial=0;
  const fixtureContext={llm:{listProviders:()=>[{id:'fixture',name:'simulated'}],listModels:async()=>[{id:'fixture',name:'simulated'}],
    async *stream(){const source={html:'<div>revision regression</div>',css:'',js:`export function render(ctx) {}\n// source version ${++serial}`};yield {type:'text-delta',text:JSON.stringify(source)};yield {type:'finish',reason:{kind:'stop'}};}}} as unknown as HostContext;
  const service=new StudioService(fixtureContext,{baseDirectory:base});
  // This regression covers service revision/cache keys. Browser/media behavior is tested separately.
  service.renderer.check=async()=>({ok:true,errors:[],frames:[]});
  try{
    let before=await value(service,'create',{productionMode:'code_animation',title:'源码revision回归'}) as StudioSnapshot;const shotId=before.project!.shots[0]!.id;
    for(let iteration=1;iteration<=2;iteration++){
      await value(service,'generate',{kind:'scenes',shotId,provider:'fixture',model:'fixture'});
      let after=await service.snapshot();const deadline=Date.now()+5000;
      while(after.task?.status==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,10));after=await service.snapshot();}
      assert.equal(after.task?.status,'complete',JSON.stringify(after.task));assert.equal(after.project!.revision,before.project!.revision+1);
      assert.equal(after.previewRevision,after.project!.revision);assert.notEqual(after.previewUrl,before.previewUrl);
      assert.equal(new URL(after.previewUrl!).searchParams.get('revision'),String(after.project!.revision));
      const source=await value(service,'source',{shotId});assert.match(source.js,new RegExp(`source version ${iteration}`));before=after;
    }
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
test('complete project directory copy opens with relative assets; broken graph retains asset HTTP access after restart',async()=>{
  const base=await mkdtemp(join(tmpdir(),'video-studio-relocation-'));let service=new StudioService(ctx,{baseDirectory:base});
  try{
    const start=await value(service,'create',{productionMode:'code_animation',title:'完整目录搬迁'}) as StudioSnapshot;
    const data=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCZkAAAAASUVORK5CYII=','base64');
    const imported=await value(service,'import',{name:'tiny.png',mime:'image/png',dataBase64:data.toString('base64')}) as StudioSnapshot;
    const destination=join(base,'relocated');await cp(start.root!,destination,{recursive:true});
    const opened=await value(service,'open',{path:destination}) as StudioSnapshot;assert.equal(opened.root,destination);assert.equal(opened.project!.id,imported.project!.id);
    const asset=opened.project!.assets[0]!;assert.deepEqual(await readFile(join(destination,asset.path!)),data);
    const draft=structuredClone(opened.project!);draft.extensions.graphEdges=[];draft.shotOrder=[];
    const saved=await value(service,'save',{project:draft}) as StudioSnapshot;assert.equal(saved.previewRevision,null);assert.ok(saved.assetBaseUrl);
    const first=await fetch(new URL(asset.path!,saved.assetBaseUrl!));assert.equal(first.status,200);assert.deepEqual(Buffer.from(await first.arrayBuffer()),data);
    assert.equal((await service.rpc('preview',{})).ok,false);
    await service.dispose();service=new StudioService(ctx,{baseDirectory:base});const restored=await value(service,'current') as StudioSnapshot;
    assert.equal(restored.root,destination);assert.deepEqual(restored.project!.extensions.graphEdges,[]);assert.equal(restored.previewRevision,null);assert.ok(restored.assetBaseUrl);
    const second=await fetch(new URL(asset.path!,restored.assetBaseUrl!));assert.equal(second.status,200);assert.deepEqual(Buffer.from(await second.arrayBuffer()),data);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
