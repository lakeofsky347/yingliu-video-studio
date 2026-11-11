import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StudioService} from '../src/host/service.ts';
import {ProjectHub} from '../src/host/project-hub.ts';
import {VideoRenderer} from '../src/host/renderer.ts';
import {DIRECTOR_RULESET_VERSION,type DirectorDocument,type DirectorPlan} from '../src/director/index.ts';
import type {StudioSnapshot,VideoProject} from '../src/shared/types.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {LocalQualityReport} from '../src/workflows/local-quality.ts';

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
