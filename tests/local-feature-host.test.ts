import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StudioService} from '../src/host/service.ts';
import {ProjectHub} from '../src/host/project-hub.ts';
import {createSessionTools} from '../src/host/session-tools.ts';
import {VideoRenderer} from '../src/host/renderer.ts';
import {DIRECTOR_RULESET_VERSION,DIRECTOR_SHOT_LIMIT,compileDirectorShot,type DirectorDocument,type DirectorPlan} from '../src/director/index.ts';
import type {StudioSnapshot,VideoProject} from '../src/shared/types.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {LocalQualityReport} from '../src/workflows/local-quality.ts';
import type {ToolRunContext} from '@deepseek-ai/dsh-tools';

const context:HostContext={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('Local feature tests must not call a provider');}},connection:{fetch:{register:()=>async()=>{}}},effect:()=>{}};
function localRenderer(t:TestContext){
  t.mock.method(VideoRenderer.prototype,'assetBaseUrl',async()=> 'http://127.0.0.1:1/fixture/');
  t.mock.method(VideoRenderer.prototype,'preview',async(_root:string,project:VideoProject)=>'http://127.0.0.1:1/fixture/index.html?revision='+project.revision);
  t.mock.method(VideoRenderer.prototype,'audioPreview',async()=>null);
  t.mock.method(VideoRenderer.prototype,'captureCandidate',async()=>{throw new Error('fixture capture unavailable; this is a service contract test');});
}
function planFor(project:VideoProject):DirectorPlan {return {version:1,ruleSetVersion:DIRECTOR_RULESET_VERSION,filmKind:'explainer',characters:[{id:'host',name:'讲解者',identity:'灰色外套',features:['圆框眼镜']}],worldLayouts:[],identityMap:[],storyBeats:[],shots:project.shots.map(shot=>({shotId:shot.id,title:shot.title,visualPrompt:'讲解者介绍本镜内容',narration:'',durationSeconds:shot.durationFrames*project.target.fps.den/project.target.fps.num,audioStrategy:'silent',characterIds:['host'],performance:[],dialogue:[],events:[],references:[],acceptance:[]}))};}
async function call<T=StudioSnapshot>(service:StudioService,endpoint:string,payload:unknown={}):Promise<T>{const result=await service.rpc(endpoint,payload);assert.equal(result.ok,true,result.ok?'':result.error.message);return (result.ok?result.value:undefined) as T;}
async function settled(service:StudioService){const deadline=Date.now()+10000;while(Date.now()<deadline){const snapshot=await service.snapshot();if(snapshot.task?.status!=='running')return snapshot;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Local feature task did not settle');}

test('host persists director draft/approval, rejects stale CAS and protects approval from ordinary saves',async t=>{
  localRenderer(t);const base=await mkdtemp(join(tmpdir(),'local-director-host-'));let service=new StudioService(context,{baseDirectory:base});
  try{
    let snapshot=await call(service,'create',{productionMode:'code_animation',title:'导演文档测试'}),project=snapshot.project!,policy=structuredClone(project.productionPolicy);
    const saved=await call<{document:DirectorDocument}>(service,'director.document.save',{expectedRevision:project.revision,expectedVersion:0,plan:planFor(project)});assert.equal(saved.document.status,'draft');
    snapshot=await call(service,'current');const draftRevision=snapshot.project!.revision;assert.equal(draftRevision,project.revision+1);
    const stale=await service.rpc('director.document.approve',{expectedRevision:project.revision,expectedVersion:1,expectedHash:saved.document.hash});assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.error.code,'REVISION_CONFLICT');
    const approved=await call<{document:DirectorDocument}>(service,'director.document.approve',{expectedRevision:draftRevision,expectedVersion:1,expectedHash:saved.document.hash});assert.equal(approved.document.status,'approved');
    snapshot=await call(service,'current');project=snapshot.project!;assert.deepEqual(project.productionPolicy,policy);
    const forged=structuredClone(project);(forged.extensions.directorDocument as DirectorDocument).plan.shots[0]!.visualPrompt='未经批准替换';const rejected=await service.rpc('save',{project:forged,expectedRevision:project.revision});assert.equal(rejected.ok,false);
    await service.dispose();service=new StudioService(context,{baseDirectory:base});const restored=await call<{document:DirectorDocument}>(service,'director.document.get');assert.deepEqual(restored.document,approved.document);
    snapshot=await call(service,'current');snapshot=await call(service,'undo',{expectedRevision:snapshot.project!.revision});assert.equal((snapshot.project!.extensions.directorDocument as DirectorDocument).status,'draft');
    snapshot=await call(service,'redo',{expectedRevision:snapshot.project!.revision});assert.equal((snapshot.project!.extensions.directorDocument as DirectorDocument).hash,approved.document.hash);assert.deepEqual(snapshot.project!.productionPolicy,policy);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});

test('DSH session can save a plan but cannot impersonate trusted plan approval',async t=>{
  localRenderer(t);const base=await mkdtemp(join(tmpdir(),'local-director-hub-')),hub=new ProjectHub(context,{baseDirectory:base});
  try{
    const snapshot=await hub.call<StudioSnapshot>('create',{title:'会话导演计划',productionMode:'code_animation',sessionId:'director-owner',select:false},{callerSessionId:'director-owner'}),project=snapshot.project!;
    const saved=await hub.call<{document:DirectorDocument}>('director.document.save',{projectId:project.id,plan:planFor(project),expectedVersion:0,expectedRevision:project.revision},{callerSessionId:'director-owner'});
    const current=await hub.call<StudioSnapshot>('current',{projectId:project.id});
    await assert.rejects(hub.call('director.document.approve',{projectId:project.id,expectedRevision:current.project!.revision,expectedVersion:saved.document.version,expectedHash:saved.document.hash},{callerSessionId:'director-owner'}),{code:'DIRECTOR_APPROVAL_REQUIRED'});
    const approved=await hub.call<{document:DirectorDocument}>('director.document.approve',{projectId:project.id,expectedRevision:current.project!.revision,expectedVersion:saved.document.version,expectedHash:saved.document.hash});assert.equal(approved.document.status,'approved');
    await assert.rejects(hub.call('director.document.get',{projectId:project.id},{callerSessionId:'unrelated-session'}),/关联|权限|工程/);
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('120-shot DSH planning supports bounded and targeted reads with approval history kept separate',async t=>{
  localRenderer(t);
  const base=await mkdtemp(join(tmpdir(),'local-director-serial-')),hub=new ProjectHub(context,{baseDirectory:base}),sessionId='long-film';
  const tools=createSessionTools(context,hub);
  const invoke=async(name:string,args:object)=>{
    const execution:ToolRunContext={name,callId:'fixture',rootCallId:'fixture',arguments:{},token:Symbol(),agent:{id:sessionId,options:{provider:'fixture',model:'fixture'}},signal:new AbortController().signal};
    return await tools.find(tool=>tool.name===name)!.execute(args,execution) as Record<string,any>;
  };
  try{
    const created=await hub.call<StudioSnapshot>('create',{title:'长片结构',productionMode:'code_animation',sessionId},{callerSessionId:sessionId});
    const template=created.project!.shots[0]!;
    const shots=Array.from({length:DIRECTOR_SHOT_LIMIT},(_,index)=>({...template,id:`long-${index+1}`,title:`镜头 ${index+1}`,sourcePath:`shots/long-${index+1}`}));
    const expanded=await hub.call<StudioSnapshot>('apply',{projectId:created.project!.id,expectedRevision:created.project!.revision,shots});
    const project=expanded.project!;
    const start=await invoke('video_project',{action:'get',section:'shots',limit:4});
    assert.equal(start.shotCount,DIRECTOR_SHOT_LIMIT);
    assert.deepEqual(start.items.map((row:{id:string})=>row.id),shots.slice(0,4).map(shot=>shot.id));
    assert.equal(start.items[0].sourcePath,undefined);
    const next=await invoke('video_project',{action:'get',section:'shots',offset:start.pagination.nextOffset,limit:4,expectedRevision:start.revision});
    assert.equal(next.items[0].id,shots[4]!.id);
    const legacy=await invoke('video_project',{action:'get'});
    assert.equal(legacy.shots.length,DIRECTOR_SHOT_LIMIT);

    const plan=planFor(project),first=plan.shots[0]!;
    plan.locations=[{id:'set',name:'长廊',description:'固定长廊，暖光'}];
    plan.props=[{id:'key',name:'钥匙',description:'铜制',ownerCharacterId:'host'}];
    plan.continuityLog=[{shotId:first.shotId,axis180:'西侧轴线',notes:'左手持钥匙'}];
    Object.assign(first,{locationId:'set',propIds:['key'],camera:'缓推',visualPrompt:'字'.repeat(11000)});
    const saved=await invoke('video_director',{action:'document_save',expectedRevision:project.revision,expectedVersion:0,plan});
    let current=await hub.call<StudioSnapshot>('current',{projectId:project.id});
    const approved=await hub.call<{document:DirectorDocument}>('director.document.approve',{projectId:project.id,expectedRevision:current.project!.revision,expectedVersion:saved.document.version,expectedHash:saved.document.hash});
    const compiled=JSON.parse(compileDirectorShot(approved.document.plan,first.shotId).prompt);
    assert.equal(compiled.location.name,'长廊');
    assert.equal(compiled.props[0].name,'钥匙');
    assert.equal(compiled.continuity.axis180,'西侧轴线');

    const page=await invoke('video_director',{action:'document_get',section:'shots',limit:4});
    assert.equal(page.pagination.total,DIRECTOR_SHOT_LIMIT);
    assert.ok(page.fragment.text.length<=8000);
    const tail=await invoke('video_director',{action:'document_get',section:'shots',limit:4,textOffset:page.pagination.nextTextOffset,expectedVersion:page.documentHeader.version});
    assert.equal(JSON.parse(page.fragment.text+tail.fragment.text).visualPrompt,first.visualPrompt);
    assert.equal(tail.pagination.nextOffset,1);
    const specific=await invoke('video_director',{action:'document_get',section:'shots',shotIds:[shots.at(-1)!.id]});
    assert.equal(specific.items[0].shotId,shots.at(-1)!.id);

    current=await hub.call<StudioSnapshot>('current',{projectId:project.id});
    const revision=await invoke('video_director',{action:'document_save',expectedRevision:current.project!.revision,expectedVersion:approved.document.version,plan:{...plan,logline:'新稿'}});
    assert.equal(revision.document.status,'draft');
    assert.equal(revision.previousApprovedDocument.hash,approved.document.hash);
    const previous=await invoke('video_director',{action:'document_get',section:'summary',documentVersion:'previousApproved'});
    assert.equal(previous.documentHeader.hash,approved.document.hash);
    assert.equal(previous.documentVersion,'previousApproved');
    const service=(await hub.resolveProject({projectId:project.id})).service;
    const head=await service.snapshot();
    const duplicate=await call<{project:VideoProject}>(service,'duplicate',{expectedRevision:head.project!.revision});
    assert.equal(duplicate.project.extensions.directorApprovedDocument,undefined);
    assert.equal((duplicate.project.extensions.directorDocument as DirectorDocument).status,'draft');
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});

test('export reruns local QC and force cannot bypass unreadable-media hard failures',async t=>{
  localRenderer(t);let exports=0;t.mock.method(VideoRenderer.prototype,'export',async()=>{exports++;throw new Error('export must not run after hard QC failure');});
  const base=await mkdtemp(join(tmpdir(),'local-quality-host-')),service=new StudioService(context,{baseDirectory:base});
  try{
    let snapshot=await call(service,'create',{productionMode:'code_animation',title:'导出门槛测试'});
    const tiny=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCZkAAAAASUVORK5CYII=','base64');
    snapshot=await call(service,'import',{name:'required.png',mime:'image/png',dataBase64:tiny.toString('base64'),requestId:'quality-image',expectedRevision:snapshot.project!.revision});
    const initial=await call<LocalQualityReport>(service,'quality.check',{expectedRevision:snapshot.project!.revision});assert.equal(initial.decision,'needs-review');assert.equal(initial.scope.checkedFrames.length,0,'stubbed captures are not reported as measured');
    await unlink(join(snapshot.root!,snapshot.project!.assets[0]!.path!));
    const changed=await call<LocalQualityReport>(service,'quality.check',{expectedRevision:snapshot.project!.revision});assert.equal(changed.decision,'fail');assert.ok(changed.checks.some(check=>check.id.startsWith('file:')&&check.severity==='hard'));
    await call(service,'export',{expectedRevision:snapshot.project!.revision,force:true});snapshot=await settled(service);assert.equal(snapshot.task?.status,'failed');assert.match(snapshot.task?.error??'',/本地质检.*硬失败/);assert.equal(exports,0);
    const last=await call<LocalQualityReport>(service,'quality.last');assert.equal(last.candidateHash,changed.candidateHash);
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
