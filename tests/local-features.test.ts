import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createProject,defaultSceneSource} from '../src/core/index.ts';
import {DIRECTOR_RULESET_VERSION,compileDirectorShot,validateDirectorPlan,type DirectorPlan} from '../src/director/index.ts';
import {approveDirectorDocument,directorPlanHash,readDirectorDocument,saveDirectorDocument,validateProjectDirectorPlan} from '../src/director/document.ts';
import {localExportQuality,localQualityFrames,localQualityHash,pngLuma} from '../src/workflows/local-quality.ts';
import {synthesizeLocalSfx,type LocalSfxSpec} from '../src/media/local-sfx.ts';
import {DirectorDraftStore} from '../src/client/director-drafts.ts';

function fixture(){
  const project=createProject('本地功能测试','','code_animation');project.shots=project.shots.slice(0,2);project.shotOrder=project.shots.map(shot=>shot.id);project.shots.forEach(shot=>shot.durationFrames=30);project.target.fps={num:30,den:1};project.targetDuration=2;
  project.assets.push({id:'portrait',kind:'image',name:'角色参考',description:'',path:'assets/portrait.png'});
  const plan:DirectorPlan={version:1,ruleSetVersion:DIRECTOR_RULESET_VERSION,filmKind:'general',characters:[{id:'hero',name:'主角',identity:'灰衣人物',features:['圆框眼镜'],referenceAssetIds:['portrait'],voice:'轻声'}],worldLayouts:[],identityMap:[],storyBeats:[],shots:project.shots.map(shot=>({shotId:shot.id,title:shot.title,visualPrompt:'主角介绍灯具',narration:'',characterIds:['hero'],durationSeconds:1,audioStrategy:'silent',performance:[],dialogue:[],events:[],references:[],acceptance:[]}))};
  return {project,plan,sources:Object.fromEntries(project.shots.map(shot=>[shot.id,defaultSceneSource()]))};
}
function png(gray:number,spread=false):Uint8Array {
  const chunk=(type:string,data:Buffer)=>{const out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(8,0);header.writeUInt32BE(8,4);header[8]=8;header[9]=0;
  const raw=Buffer.alloc(9*8);for(let y=0;y<8;y++)for(let x=0;x<8;x++)raw[y*9+x+1]=spread?(x+y)%2?255:0:gray;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

test('director document approval binds content/version and grants no production authority',()=>{
  const {project,plan}=fixture(),original=structuredClone(project);const draft=saveDirectorDocument(project,plan,{expectedVersion:0});
  assert.equal(draft.status,'draft');assert.equal(draft.version,1);assert.equal(readDirectorDocument(project),undefined);assert.deepEqual(project,original);
  project.extensions.directorDocument=draft;const approved=approveDirectorDocument(project,{expectedVersion:1,expectedHash:draft.hash});assert.equal(approved.status,'approved');assert.equal(approved.version,2);assert.equal(approved.hash,draft.hash);
  assert.deepEqual(project.productionPolicy,original.productionPolicy);assert.equal(project.revision,original.revision);assert.throws(()=>approveDirectorDocument(project,{expectedVersion:1,expectedHash:'stale'}),{code:'REVISION_CONFLICT'});
  project.extensions.directorDocument=approved;const changed=structuredClone(plan);changed.shots[0]!.visualPrompt='主角介绍台灯';const next=saveDirectorDocument(project,changed,{expectedVersion:2});assert.equal(next.status,'draft');assert.equal(next.approvedAt,undefined);assert.notEqual(next.hash,approved.hash);
  assert.throws(()=>saveDirectorDocument(project,changed,{expectedVersion:1}),{code:'REVISION_CONFLICT'});
});
test('director hashes are canonical and corrupt approvals fail closed',()=>{
  const {project,plan}=fixture(),reordered=Object.fromEntries(Object.entries(plan).reverse()) as unknown as DirectorPlan;assert.equal(directorPlanHash(plan),directorPlanHash(reordered));
  const doc=saveDirectorDocument(project,plan,{expectedVersion:0});project.extensions.directorDocument={...doc,status:'approved',approvedAt:new Date().toISOString(),hash:'forged'};assert.throws(()=>readDirectorDocument(project),/不一致/);
  project.extensions.directorDocument={...doc,plan:{...plan,shots:[]}};assert.throws(()=>readDirectorDocument(project),/镜头/);
});
test('role fields survive compilation, referenced roles cannot disappear and foreign assets are rejected',()=>{
  const {project,plan}=fixture();assert.equal(validateDirectorPlan(plan).ok,true);const output=compileDirectorShot(plan,plan.shots[0]!.shotId),context=JSON.parse(output.prompt);
  assert.deepEqual(context.characters[0].features,['圆框眼镜']);assert.equal(context.characters[0].voice,'轻声');assert.deepEqual(output.referenceAssetIds,['portrait']);
  const missing=structuredClone(plan);missing.characters=[];assert.equal(validateDirectorPlan(missing).ok,false);
  const foreign=structuredClone(plan);foreign.characters[0]!.referenceAssetIds=['not-in-project'];assert.throws(()=>validateProjectDirectorPlan(project,foreign),/图片资产不存在/);
  const wrongShot=structuredClone(plan);wrongShot.shots[0]!.shotId='foreign';assert.throws(()=>saveDirectorDocument(project,wrongShot,{expectedVersion:0}),/工程镜头/);
});
test('local quality frame samples use absolute integer timeline frames and disclose sampling bounds',()=>{
  const {project}=fixture();project.target.fps={num:30000,den:1001};project.shots[0]!.durationFrames=31;project.shots[1]!.durationFrames=15;
  assert.deepEqual(localQualityFrames(project),[{shotId:project.shots[0]!.id,frame:0},{shotId:project.shots[0]!.id,frame:15},{shotId:project.shots[0]!.id,frame:30},{shotId:project.shots[1]!.id,frame:31},{shotId:project.shots[1]!.id,frame:38},{shotId:project.shots[1]!.id,frame:45}]);
  assert.equal(localQualityFrames(project,2).length,2);assert.throws(()=>localQualityFrames(project,0),/数量/);
});
test('PNG checks reject unsupported/truncated input and bound decompression',()=>{
  assert.equal(pngLuma(png(0))?.mean,0);assert.ok(pngLuma(png(0,true))!.std>100);assert.equal(pngLuma(new Uint8Array()),null);assert.equal(pngLuma(png(0).slice(0,45)),null);
  const huge=Buffer.from(png(0));huge.writeUInt32BE(100000,16);assert.equal(pngLuma(huge),null);
  const bomb=Buffer.from(png(0));bomb.writeUInt32BE(1,16);bomb.writeUInt32BE(1,20);assert.equal(pngLuma(bomb),null);
});
test('local QC preserves hard structural failures and treats black/subtitle heuristics as advisory',()=>{
  const {project,sources}=fixture();project.shots[0]!.params.subtitle='长字幕'.repeat(100);const samples=localQualityFrames(project).map(point=>({...point,bytes:png(0)}));
  const report=localExportQuality(project,sources,samples);assert.equal(report.decision,'needs-review');assert.ok(report.checks.some(check=>check.category==='subtitle'&&check.status==='needs-review'));assert.ok(report.checks.filter(check=>check.category==='visual').every(check=>check.severity==='advisory'));assert.equal(report.scope.checkedFrames.length,6);assert.equal(report.scope.unchecked.length,3);assert.equal(report.candidateHash,localQualityHash(project,sources));
  project.audioClips=[{id:'missing-audio',assetId:'missing',role:'voice',startSeconds:0,trimStart:0,volume:1,fadeIn:0,fadeOut:0}];const failed=localExportQuality(project,sources,samples);assert.equal(failed.decision,'fail');assert.ok(failed.checks.some(check=>check.status==='fail'&&check.severity==='hard'));
});
test('missing captures remain unchecked and revision/source changes invalidate the local report hash',()=>{
  const {project,sources}=fixture();const first=localExportQuality(project,sources,[]);assert.equal(first.decision,'needs-review');assert.equal(first.scope.checkedFrames.length,0);assert.equal(first.scope.unsampledShots.length,2);assert.ok(first.checks.some(check=>check.status==='unchecked'));
  project.revision++;assert.notEqual(localQualityHash(project,sources),first.candidateHash);const next=localQualityHash(project,sources);sources[project.shots[0]!.id]!.css+='\nmain{color:red}';assert.notEqual(localQualityHash(project,sources),next);
  const sampled=localExportQuality(project,sources,localQualityFrames(project).map(point=>({...point,bytes:png(0,true)})));assert.equal(sampled.decision,'pass');assert.ok(sampled.scope.unchecked.some(item=>item.includes('声轨')),'scoped pass does not claim listening occurred');
});
test('local SFX is deterministic bounded mono PCM WAV, with actual silence only at explicit zero volume',()=>{
  for(const kind of ['tone','sweep','chime','noise','whoosh','click'] as LocalSfxSpec['kind'][]){const spec={kind,durationSeconds:.25,frequency:440,volume:.5,seed:42};const first=synthesizeLocalSfx(spec),second=synthesizeLocalSfx(spec);assert.deepEqual(first,second);const b=Buffer.from(first);assert.equal(b.toString('ascii',0,4),'RIFF');assert.equal(b.readUInt32LE(24),44100);assert.equal(b.readUInt16LE(22),1);assert.equal(b.readUInt16LE(34),16);assert.equal(b.readUInt32LE(40),Math.floor(.25*44100)*2);assert.ok(b.subarray(44).some(value=>value!==0));}
  assert.ok(Buffer.from(synthesizeLocalSfx({kind:'noise',durationSeconds:.1,volume:0})).subarray(44).every(value=>value===0));
  const hash=(seed:number)=>createHash('sha256').update(synthesizeLocalSfx({kind:'noise',durationSeconds:.1,seed})).digest('hex');assert.notEqual(hash(1),hash(2));
});
test('invalid SFX controls reject before synthesis rather than silently coercing',()=>{
  for(const patch of [{durationSeconds:Infinity},{durationSeconds:11},{volume:NaN},{frequency:0},{seed:1.5},{seed:-1},{kind:'paid-model'}])assert.throws(()=>synthesizeLocalSfx({kind:'tone',durationSeconds:.1,...patch} as LocalSfxSpec));
});
test('director local drafts are separated by project and survive store recreation',()=>{
  const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
  const {plan}=fixture(),a='draft-'+crypto.randomUUID(),b='draft-'+crypto.randomUUID(),store=new DirectorDraftStore(storage);store.set({projectId:a,baseVersion:3,plan,updatedAt:'2026-11-11T00:00:00Z'});store.set({projectId:b,baseVersion:1,plan:{...plan,filmKind:'product'},updatedAt:'2026-11-11T00:00:00Z'});
  assert.equal(new DirectorDraftStore(storage).get(a)?.baseVersion,3);assert.equal(store.get(b)?.plan.filmKind,'product');store.delete(a);assert.equal(store.get(a),undefined);assert.equal(store.get(b)?.baseVersion,1);store.delete(b);
});
