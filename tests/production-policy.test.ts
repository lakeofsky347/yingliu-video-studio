import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright-core';
import {createProject,migrateProject,compileSpec,validateProject,defaultSceneSource,defaultShot} from '../src/core/index.js';
import {applyProductionPolicy,assertProductionComposition,assertProductionOperation,defaultProductionPolicy,productionPolicyFingerprint,validateProductionPolicy} from '../src/core/production-policy.js';
import {ProjectStore} from '../src/host/store.js';
import {VideoRenderer,detectEnvironment} from '../src/host/renderer.js';
import type {Asset,VideoProject} from '../src/shared/types.js';
import {grantHybrid} from './fixtures/production.js';

function video(project:VideoProject,origin:NonNullable<Asset['provenance']>['origin']='model_generation'):Asset {
  const asset:Asset={id:'video',kind:'video',name:'video',description:'',path:'assets/video.mp4',width:160,height:90,duration:10,fps:{num:30,den:1},hasAudio:false,provenance:{origin,usage:'production'}};
  project.assets.push(asset);project.videoClips=[{id:'clip',shotId:project.shots[0]!.id,assetId:asset.id,trimStart:0,speed:1,fit:'contain',audio:'mute'}];return asset;
}
function single(mode:'code_animation'|'model_video') {const project=createProject('fixture','',mode);project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(s=>s.id);return project;}

test('new projects require a mode; legacy v1/v2 migrates without inferring hybrid or changing revision',()=>{
  const fresh=createProject('unspecified');assert.equal(fresh.schemaVersion,3);assert.equal(fresh.productionPolicy?.mode,'unresolved');
  for(const op of ['code','video','image'] as const)assert.throws(()=>assertProductionOperation(fresh,op),/确认.*模式/);
  for(const version of [1,2] as const){const old=single('code_animation');old.schemaVersion=version;old.revision=7;video(old);const before=structuredClone(old),next=migrateProject(old);
    assert.deepEqual(old,before);assert.equal(next.schemaVersion,3);assert.equal(next.revision,7);assert.equal(next.productionPolicy?.mode,'unresolved');assert.equal(next.shots[0]!.visual?.kind,'unresolved');assert.deepEqual(next.videoClips,old.videoClips);assert.throws(()=>assertProductionComposition(next),/确认.*模式/);
  }
  const damaged=structuredClone(fresh);delete damaged.productionPolicy;assert.equal(validateProject(damaged).ok,false);
  assert.equal(productionPolicyFingerprint(damaged),productionPolicyFingerprint(damaged),'Missing policy fingerprints must be stable, without generating a new decision');
  const missingDecision=structuredClone(fresh);delete (missingDecision.productionPolicy as Partial<NonNullable<VideoProject['productionPolicy']>>).decisionId;assert.equal(validateProject(missingDecision).ok,false);
});

test('mode round trips and repeated confirmations never revive an earlier decision fingerprint',()=>{
  const original=single('model_video'),before=productionPolicyFingerprint(original);
  const code=applyProductionPolicy(original,defaultProductionPolicy('code_animation'));
  const restored=applyProductionPolicy(code,defaultProductionPolicy('model_video'));
  assert.equal(restored.productionPolicy?.mode,original.productionPolicy?.mode);
  assert.notEqual(restored.productionPolicy?.decisionId,original.productionPolicy?.decisionId);
  assert.notEqual(productionPolicyFingerprint(restored),before);
  const confirmedAgain=applyProductionPolicy(restored,defaultProductionPolicy('model_video'));
  assert.notEqual(productionPolicyFingerprint(confirmedAgain),productionPolicyFingerprint(restored));
  assert.equal(productionPolicyFingerprint(restored),productionPolicyFingerprint(structuredClone(restored)),'Read-only copies preserve a specific decision');
});

test('decision IDs remain distinct when crypto.randomUUID is unavailable',()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  try{
    Object.defineProperty(globalThis,'crypto',{value:undefined,configurable:true});
    const decisions=Array.from({length:1000},()=>defaultProductionPolicy('model_video').decisionId);
    assert.equal(new Set(decisions).size,decisions.length);assert.ok(decisions.every(id=>/^[a-zA-Z0-9_-]{1,128}$/.test(id)));
  }finally{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else Reflect.deleteProperty(globalThis,'crypto');}
});

test('operations obey explicit mode, generated-image choice and scoped hybrid base mode',()=>{
  const project=createProject('code','','code_animation');assert.doesNotThrow(()=>assertProductionOperation(project,'code'));assert.throws(()=>assertProductionOperation(project,'video'),/不允许/);assert.throws(()=>assertProductionOperation(project,'image'),/图片/);
  project.productionPolicy!.allowGeneratedImages=true;assert.doesNotThrow(()=>assertProductionOperation(project,'image'));
  grantHybrid(project,[project.shots[1]!.id]);assert.doesNotThrow(()=>assertProductionOperation(project,'code'));assert.doesNotThrow(()=>assertProductionOperation(project,'video',[project.shots[1]!.id]));assert.throws(()=>assertProductionOperation(project,'video',[project.shots[0]!.id]),/不允许/);
  project.productionPolicy!.hybridGrants![0]!.projectId='another-project';assert.ok(validateProductionPolicy(project).length);assert.throws(()=>assertProductionOperation(project,'video',[project.shots[1]!.id]),/许可/);
  project.productionPolicy!.hybridGrants![0]!.projectId=project.id;project.productionPolicy!.baseMode='model_video';assert.doesNotThrow(()=>assertProductionOperation(project,'video'));assert.throws(()=>assertProductionOperation(project,'code',[project.shots[0]!.id]),/不允许/);
});

test('switching mode retains inactive clips, replaces execution source and invalidates queued policy fingerprints',()=>{
  const project=single('code_animation');video(project);const before=productionPolicyFingerprint(project);assert.doesNotThrow(()=>assertProductionComposition(project));assert.equal(compileSpec(project).shots[0]!.videoClip,undefined);
  const next=applyProductionPolicy(project,defaultProductionPolicy('model_video'));assert.notEqual(productionPolicyFingerprint(next),before);assert.equal(next.revision,project.revision+1);assert.deepEqual(next.videoClips,project.videoClips);assert.equal(next.shots[0]!.visual?.kind,'model_video');assert.doesNotThrow(()=>assertProductionComposition(next,{forExport:true}));assert.throws(()=>assertProductionOperation(next,'code'),/不允许/);
});

test('model video cannot fall back to source, import code exports, or freeze a short clip at export',()=>{
  const project=single('model_video');assert.throws(()=>assertProductionComposition(project),/尚未采用视频/);const asset=video(project);asset.duration=1;
  assert.doesNotThrow(()=>assertProductionComposition(project));assert.throws(()=>assertProductionComposition(project,{forExport:true}),/长度不足/);
  asset.duration=10;asset.provenance!.origin='code_render';project.productionPolicy!.allowImportedVideo=true;project.shots[0]!.visual={kind:'imported_video'};assert.throws(()=>assertProductionComposition(project),/代码渲染/);
  asset.provenance!.origin='unknown';project.productionPolicy!.allowImportedVideo=false;assert.throws(()=>assertProductionComposition(project),/用户许可/);
  project.productionPolicy!.allowImportedVideo=true;assert.doesNotThrow(()=>assertProductionComposition(project));
});

test('reference-only assets never enter rendered assets or audio while their model descendants remain eligible',()=>{
  const project=single('model_video'),asset=video(project);asset.provenance!.usage='reference_only';assert.throws(()=>assertProductionComposition(project),/参考专用/);
  const descendant={...asset,id:'descendant',provenance:{origin:'model_generation',usage:'production'} as const,generation:{taskId:'task',model:'model',operation:'video',prompt:'reference',inputHashes:[{assetId:asset.id,sha256:'hash'}]}};
  project.assets.push(descendant);project.videoClips![0]!.assetId=descendant.id;project.shots[0]!.referenceIds=[asset.id];assert.doesNotThrow(()=>assertProductionComposition(project));assert.deepEqual(compileSpec(project).shots[0]!.assets.map(asset=>asset.id),['descendant']);
  project.shots[0]!.assetIds=[asset.id];assert.throws(()=>assertProductionComposition(project),/参考专用/);
  const code=single('code_animation'),clip=video(code);code.shots[0]!.assetIds=[clip.id];assert.throws(()=>assertProductionComposition(code),/自由源码/);
});

test('storage retains revoked policy through undo/redo, resets copied scoped grants, and rejects schema downgrade',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'policy-store-')),store=new ProjectStore({baseDirectory:directory});
  try{
    const initial=single('code_animation');grantHybrid(initial,[initial.shots[0]!.id]);const created=await store.create(initial);
    const copied=await store.duplicate(created.root);assert.equal(copied.project.productionPolicy?.mode,'unresolved');assert.equal(copied.project.productionPolicy?.hybridGrants,undefined);
    const revoked=applyProductionPolicy(created.project,defaultProductionPolicy('model_video'));await store.commit(created.root,revoked);
    const undone=await store.moveHistory(created.root,'undo',revoked.revision);assert.equal(undone.productionPolicy?.mode,'model_video');assert.equal(undone.productionPolicy?.decisionId,revoked.productionPolicy?.decisionId);assert.notEqual(undone.productionPolicy?.decisionId,initial.productionPolicy?.decisionId);assert.equal(undone.productionPolicy?.hybridGrants,undefined);assert.throws(()=>assertProductionComposition(undone),/不允许/);
    const redone=await store.moveHistory(created.root,'redo',undone.revision);assert.equal(redone.productionPolicy?.mode,'model_video');assert.equal(redone.productionPolicy?.decisionId,revoked.productionPolicy?.decisionId);
    const downgraded={...redone,schemaVersion:2 as const,revision:redone.revision+1};await assert.rejects(store.commit(created.root,downgraded),/降级/);
    assert.equal(JSON.parse(await readFile(join(created.root,'project.json'),'utf8')).schemaVersion,3);
  }finally{await rm(directory,{recursive:true,force:true});}
});

const env=detectEnvironment(),exec=promisify(execFile),available=env.browserAvailable&&env.ffmpegAvailable&&env.ffprobeAvailable;
test('real runtime separates model video from code and denies reference/other-shot/media/data/blob resources to code',{skip:!available,timeout:60_000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'policy-runtime-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    const file=join(directory,'fixture.mp4');await exec(env.ffmpegPath,['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=12:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-y',file]);
    const model=single('model_video');model.target={width:160,height:90,fps:{num:12,den:1},audioMode:'none'};model.shots[0]!.durationFrames=12;
    const created=await store.create(model),asset=await store.importVideo(created.root,{path:file},env);asset.provenance={origin:'model_generation',usage:'production'};
    let adopted=created.project;adopted.assets=[asset];adopted.videoClips=[{id:'clip',shotId:adopted.shots[0]!.id,assetId:asset.id,trimStart:0,speed:1,fit:'contain',audio:'mute'}];adopted.revision++;
    adopted=await store.commit(created.root,adopted,{[adopted.shots[0]!.id]:{html:'<h1>Forbidden code</h1>',css:'',js:'throw new Error("MODEL_EXECUTED_SOURCE")'}});
    const checked=await renderer.check(created.root,adopted,env);assert.equal(checked.ok,true,JSON.stringify(checked.errors));
    const modelPreview=await renderer.preview(created.root,adopted),modelData=await (await fetch(new URL('/runtime/spec.json',modelPreview))).json();assert.deepEqual(modelData.sources,[]);assert.deepEqual(modelData.codeOrigins,{});
    assert.equal((await fetch(new URL('/runtime/scenes/'+adopted.shots[0]!.id+'.mjs',modelPreview))).status,403);
    const code=applyProductionPolicy(adopted,defaultProductionPolicy('code_animation'));code.revision++;const reference={...asset,id:'reference',path:asset.path,provenance:{origin:'model_generation',usage:'reference_only'} as const};
    const imageFile=join(directory,'image.png');await exec(env.ffmpegPath,['-v','error','-i',file,'-frames:v','1','-y',imageFile]);
    const image=await store.importImageOrText(created.root,{path:imageFile}),other=defaultShot(1,code.target.fps);other.durationFrames=12;other.assetIds=[image.id];code.shots.push(other);code.shotOrder.push(other.id);code.assets.push(image);
    // Same file under another identity is still inaccessible: no active code video resources are exposed.
    code.assets.push(reference);code.shots[0]!.referenceIds=[reference.id];const saved=await store.commit(created.root,code,{[code.shots[0]!.id]:defaultSceneSource()});
    const preview=await renderer.preview(created.root,saved),data=await (await fetch(new URL('/runtime/spec.json',preview))).json(),codeOrigin=data.codeOrigins[saved.shots[0]!.id];
    assert.notEqual(codeOrigin,new URL(preview).origin);assert.equal((await fetch(codeOrigin+'/'+asset.path)).status,403);assert.equal((await fetch(codeOrigin+'/project.json')).status,403);assert.equal((await fetch(codeOrigin+'/runtime/spec.json')).status,403);
    assert.equal((await fetch(codeOrigin+'/'+image.path)).status,403,'A production image bound only to another shot is unavailable');assert.equal((await fetch(codeOrigin+'/runtime/scenes/'+other.id+'.mjs')).status,403);
    const codeSpec=await (await fetch(codeOrigin+'/runtime/code-spec-'+saved.shots[0]!.id+'.json')).json();assert.deepEqual(codeSpec.spec.shots[0].assets,[]);assert.equal(codeSpec.spec.shots[0].videoClip,undefined);
    browser=await chromium.launch({executablePath:env.browserPath,headless:true});const page=await browser.newPage({viewport:{width:160,height:90}});await page.goto(preview+'&render=manual');await page.waitForFunction(()=>!!(window as any).__VIDEO_WORKPACK__);
    await page.evaluate(()=>(window as any).__VIDEO_WORKPACK__.renderFrame({frame:0}));const frame=page.frames().find(frame=>frame.url().startsWith(codeOrigin+'/code.html'))!;assert.ok(frame);
    const blocked=await frame.evaluate(()=>{
      const outcomes:string[]=[];for(const attempt of [()=>new (window as any).VideoDecoder({}),()=>document.createElement('video').load(),()=>document.createElement('audio').play()]){try{attempt();outcomes.push('allowed');}catch{outcomes.push('blocked');}}return outcomes;
    });assert.deepEqual(blocked,['blocked','blocked','blocked']);
    assert.equal(await frame.evaluate(()=>{try{return parent.document.title;}catch{return 'isolated';}}),'isolated');
    const childDecoder=await frame.evaluate(()=>{const child=document.createElement('iframe');document.body.append(child);try{new (child.contentWindow as any).VideoDecoder({output:()=>{},error:()=>{}});return 'allowed';}catch{return 'blocked';}finally{child.remove();}});assert.equal(childDecoder,'blocked','A nested blank frame must not restore a decoder API');
    const csp=(await fetch(codeOrigin+'/code.html')).headers.get('content-security-policy');assert.match(csp!,/media-src 'none'/);assert.match(csp!,/frame-src 'none'/);assert.match(csp!,/worker-src 'none'/);
    const encodedVideo=(await readFile(file)).toString('base64');
    for(const src of ['data:video/mp4;base64,'+encodedVideo,await frame.evaluate(encoded=>URL.createObjectURL(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'video/mp4'})),encodedVideo)]){
      const result=await frame.evaluate(src=>new Promise<string>(resolve=>{const element=document.createElement('video');const timeout=setTimeout(()=>resolve('no policy evidence'),2000);document.addEventListener('securitypolicyviolation',(event:SecurityPolicyViolationEvent)=>{if(event.effectiveDirective==='media-src'){clearTimeout(timeout);resolve('media-src');}},{once:true});element.onloadeddata=()=>{clearTimeout(timeout);resolve('loaded');};element.src=src;document.body.append(element);}),src);assert.equal(result,'media-src');
    }
    // A code export is registered by content hash; renaming it cannot erase known provenance.
    const output=await renderer.export(created.root,saved,env,new AbortController().signal,()=>{});const reimported=await store.importVideo(created.root,{path:output.path},env);assert.equal(reimported.provenance?.origin,'code_render');
    const spoofed=single('model_video'),claimed={...reimported,provenance:{origin:'model_generation',usage:'production'} as const};delete claimed.originalPath;spoofed.assets=[claimed];spoofed.videoClips=[{id:'spoof-clip',shotId:spoofed.shots[0]!.id,assetId:claimed.id,trimStart:0,speed:1,fit:'cover',audio:'mute'}];
    const imported=await store.create({project:spoofed,assetFiles:[{path:claimed.path!,localPath:output.path}]});assert.equal(imported.project.assets[0]!.provenance?.origin,'code_render');assert.throws(()=>assertProductionComposition(imported.project),/代码渲染/);
    await renderer.preview(created.root,adopted);assert.equal((await fetch(codeOrigin+'/code.html')).status,403,'Revoked code runtime resources must not remain served');
  }finally{await browser?.close();await renderer.close();await rm(directory,{recursive:true,force:true});}
});
