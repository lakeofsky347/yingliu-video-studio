import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {inflateSync} from 'node:zlib';
import {createProject} from '../src/core/index.ts';
import {approveDirectorDocument,saveDirectorDocument} from '../src/director/document.ts';
import {DIRECTOR_RULESET_VERSION,type DirectorDocument,type DirectorPlan} from '../src/director/index.ts';
import {approvedPrevizScope,matchingPrevizRecord,PREVIZ_EXTENSION} from '../src/director/previz.ts';
import {validatePrevizSpec} from '../src/host/blender.ts';
import type {HostContext} from '../src/host/platform.ts';
import {ProjectHub} from '../src/host/project-hub.ts';
import {detectEnvironment,VideoRenderer} from '../src/host/renderer.ts';
import {findBlenderExecutable} from '../src/host/tool-environment.ts';
import {previzAssetIds,type PrevizRecord,type PrevizSceneSpec,type PrevizStatus} from '../src/shared/previz.ts';
import type {StudioSnapshot,VideoProject} from '../src/shared/types.ts';

const scene:PrevizSceneSpec={
  camera:{startPos:[-4,-6,2.7],endPos:[-3,-5,2.5],startTarget:[0,0,.8],rollDeg:8},
  objects:[{id:'actor',kind:'character',position:[0,0,0],endPos:[1,0,0],pose:'walk'}],
  width:320,height:256,output:'both',fps:2,durationSeconds:1,
};
function planFor(project:VideoProject):DirectorPlan{
  return {version:1,ruleSetVersion:DIRECTOR_RULESET_VERSION,filmKind:'general',characters:[],worldLayouts:[],identityMap:[],storyBeats:[],
    shots:project.shots.map(shot=>({shotId:shot.id,title:shot.title,visualPrompt:'角色沿画面左侧入场',narration:'',durationSeconds:shot.durationFrames*project.target.fps.den/project.target.fps.num,audioStrategy:'silent',performance:[],dialogue:[],events:[],references:[],acceptance:[]}))};
}

test('Blender accepts only the bounded scene data used by the bundled renderer',()=>{
  const parsed=validatePrevizSpec({...scene,outputDir:'/unused',script:'raise Error()'});
  assert.equal(parsed.camera.rollDeg,8);
  assert.deepEqual(parsed.camera.endTarget,[0,0,.8]);
  assert.equal((parsed as Record<string,unknown>).outputDir,undefined);
  assert.equal((parsed as Record<string,unknown>).script,undefined);
  assert.throws(()=>validatePrevizSpec({...scene,width:319}),/尺寸/);
  assert.throws(()=>validatePrevizSpec({...scene,camera:{startPos:[0,0,0],startTarget:[0,0,0]}}),/不能重合/);
  assert.throws(()=>validatePrevizSpec({...scene,objects:[...scene.objects,...scene.objects]}),/不能重复/);
  assert.throws(()=>validatePrevizSpec({...scene,objects:[{...scene.objects[0],scale:[-1,0,0]}]}),/正数/);
});

test('Blender discovery respects host paths and preserves an invalid explicit configuration',()=>{
  const windows=win32.join('C:/Tools','blender.exe'),mac='/Applications/Blender.app/Contents/MacOS/Blender',linux='/usr/bin/blender';
  assert.equal(findBlenderExecutable({platform:'win32',env:{Path:'C:/Tools'},isExecutable:path=>path===windows}),windows);
  assert.equal(findBlenderExecutable({platform:'darwin',env:{},isExecutable:path=>path===mac}),mac);
  assert.equal(findBlenderExecutable({platform:'linux',env:{},isExecutable:path=>path===linux}),linux);
  const configured=detectEnvironment({blenderPath:'/missing'}, {platform:'linux',env:{},isExecutable:path=>path===linux});
  assert.equal(configured.blenderPath,'/missing');
  assert.equal(configured.blenderAvailable,false);
});

test('previsualization lookup is scoped to the approved plan, shot, project and reference assets',()=>{
  const project=createProject('预演测试','','code_animation'),shotId=project.shots[0]!.id,plan=planFor(project);
  const draft=saveDirectorDocument(project,plan,{expectedVersion:0});
  project.extensions.directorDocument=draft;
  assert.equal(approvedPrevizScope(project,shotId),null);
  project.extensions.directorDocument=approveDirectorDocument(project,{expectedVersion:draft.version,expectedHash:draft.hash});
  const scope=approvedPrevizScope(project,shotId)!;
  const image={id:'previz-image',kind:'image' as const,name:'白模关键帧',description:'',path:'assets/previz.png',provenance:{origin:'code_render' as const,usage:'reference_only' as const}};
  project.assets.push(image);
  const record:PrevizRecord={...scope,id:'preview-render',projectId:project.id,imageAssetId:image.id,mediaHashes:[],width:320,height:256,fps:2,frameCount:1,renderedAt:new Date().toISOString()};
  project.extensions[PREVIZ_EXTENSION]=[record];
  assert.equal(matchingPrevizRecord(project,scope),record);
  assert.equal(matchingPrevizRecord(project,{...scope,documentHash:'previous'}),null);
  assert.equal(matchingPrevizRecord(project,{...scope,shotId:'other-shot'}),null);
  assert.equal(matchingPrevizRecord({...project,id:'copy'},scope),null);
  assert.equal(matchingPrevizRecord({...project,assets:[]},scope),null);
  assert.equal(matchingPrevizRecord({...project,assets:[{...image,provenance:{...image.provenance,usage:'production'}}]},scope),null);
});

const env=detectEnvironment();
const verifyBlender=process.env.YINGLIU_VERIFY_BLENDER==='1';
test('host renders, stores and confirms a real Blender previsualization for the exact approved shot',{skip:!verifyBlender||!env.blenderAvailable||!env.ffmpegAvailable||!env.ffprobeAvailable,timeout:60_000},async t=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-blender-previz-'));
  const ctx:HostContext={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('Blender previsualization is local');}},connection:{fetch:{register:()=>async()=>{}}},effect:()=>{}};
  t.mock.method(VideoRenderer.prototype,'assetBaseUrl',async()=> 'http://127.0.0.1:1/fixture/');
  t.mock.method(VideoRenderer.prototype,'preview',async()=> 'http://127.0.0.1:1/fixture/index.html');
  t.mock.method(VideoRenderer.prototype,'audioPreview',async()=>null);
  const hub=new ProjectHub(ctx,{baseDirectory:base});
  try{
    const created=await hub.call<StudioSnapshot>('create',{title:'Blender 联调',productionMode:'code_animation'}),project=created.project!;
    const projectId=project.id,shotId=project.shots[0]!.id,shot={projectId,shotId};
    const current=()=>hub.call<StudioSnapshot>('current',{projectId});
    const status=()=>hub.call<PrevizStatus>('previz.get',shot);
    const plan=planFor(project);
    await assert.rejects(hub.call('previz.render',{...shot,expectedRevision:project.revision,spec:scene}),/批准/);
    const {document:draft}=await hub.call<{document:DirectorDocument}>('director.document.save',{projectId,expectedRevision:project.revision,expectedVersion:0,plan});
    const {document:approved}=await hub.call<{document:DirectorDocument}>('director.document.approve',{projectId,expectedRevision:(await current()).project!.revision,expectedVersion:draft.version,expectedHash:draft.hash});
    const scope={...shot,documentVersion:approved.version,documentHash:approved.hash};
    const render=()=>current().then(snapshot=>hub.call<PrevizRecord>('previz.render',{...scope,expectedRevision:snapshot.project!.revision,spec:scene}));
    await assert.rejects(hub.call('previz.approve',{...scope},{callerSessionId:'session-cannot-approve'}),/工作台/);
    const rendered=await render();
    assert.deepEqual(await status(),{scope:{shotId,documentVersion:approved.version,documentHash:approved.hash},record:rendered,rendering:false});
    assert.equal(rendered.frameCount,2);
    const saved=(await current()),assets=saved.project!.assets.filter(asset=>previzAssetIds(rendered).includes(asset.id));
    assert.deepEqual(assets.map(asset=>asset.kind),['image','image','video']);
    assert.ok(assets.every(asset=>asset.provenance?.origin==='code_render'&&asset.provenance.usage==='reference_only'));
    const depth=await readFile(join(saved.root!,assets[1]!.path!));
    assert.deepEqual([...depth.subarray(24,26)],[16,0]);
    const chunks:Buffer[]=[];
    for(let offset=8;offset+12<=depth.length;){
      const length=depth.readUInt32BE(offset);
      if(depth.toString('ascii',offset+4,offset+8)==='IDAT')chunks.push(depth.subarray(offset+8,offset+8+length));
      offset+=length+12;
    }
    const pixels=inflateSync(Buffer.concat(chunks)),width=depth.readUInt32BE(16),levels=new Set<number>();
    for(let offset=0;offset<pixels.length;offset+=2*width+1)for(let column=0;column<width;column++)levels.add(pixels.readUInt16BE(offset+1+2*column));
    assert.ok(levels.size>32,'the ground and objects have a per-pixel depth gradient');
    assert.equal(saved.project!.videoClips?.length??0,0);
    assert.ok(saved.project!.shots.every(item=>item.assetIds.every(id=>!previzAssetIds(rendered).includes(id))));
    const approval={...scope,expectedRevision:saved.project!.revision,renderId:rendered.id};
    await assert.rejects(hub.call('previz.approve',{...approval,assetIds:[rendered.imageAssetId]}),{code:'REVISION_CONFLICT'});
    const confirmed=await hub.call<PrevizRecord>('previz.approve',{...approval,assetIds:previzAssetIds(rendered)});
    assert.ok(confirmed.approvedAt);
    assert.equal((await status()).record?.approvedAt,confirmed.approvedAt);
    await writeFile(join(saved.root!,assets[0]!.path!),Buffer.from('changed'));
    assert.equal((await status()).record,null,'modified artifact bytes invalidate prior confirmation');
    const cancelled=assert.rejects(render(),/预演已取消/);
    let rendering=false;
    for(let retry=0;retry<40&&!rendering;retry++){
      rendering=(await status()).rendering;
      if(!rendering)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(rendering,true);
    await hub.call('previz.cancel',shot);
    await cancelled;
    assert.equal((await status()).rendering,false);
    assert.equal((await current()).project!.assets.length,saved.project!.assets.length,'cancel publishes no assets');
  }finally{
    await hub.dispose();
    await rm(base,{recursive:true,force:true});
  }
});
