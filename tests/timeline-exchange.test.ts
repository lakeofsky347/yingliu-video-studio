import {execFile} from 'node:child_process';
import {mkdtemp,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createProject} from '../src/core/index.ts';
import {ProjectHub} from '../src/host/project-hub.ts';
import {ProjectStore} from '../src/host/store.ts';
import {detectEnvironment,VideoRenderer} from '../src/host/renderer.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {StudioSnapshot,TaskRecord,VideoProject} from '../src/shared/types.ts';
import {hashMediaFile} from '../src/media/video.ts';
import {exchangeEdlLimitation,formatExchangeEdl,formatExchangeFcpxml,formatExchangeOtio,type ExchangeTimeline} from '../src/media/timeline-exchange.ts';

const exec=promisify(execFile),env=detectEnvironment();
const context:HostContext={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('Timeline export must not call a provider');}},connection:{fetch:{register:()=>async()=>{}}},effect:()=>{}};

async function settled(hub:ProjectHub,projectId:string):Promise<StudioSnapshot>{
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline){
    const snapshot=await hub.call<StudioSnapshot>('current',{projectId});
    if(snapshot.task?.status!=='running')return snapshot;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  throw new Error('Timeline exchange did not settle');
}

function timeline():ExchangeTimeline {
  return {title:'剪辑 & 交付',durationFrames:48,target:{width:320,height:180,fps:{num:24000,den:1001},audioMode:'mixed'},
    video:[{shotId:'one',title:'Shot <one>',media:'media/v000001.mp4',startFrame:0,durationFrames:24},{shotId:'two',title:'Shot two',media:'media/v000002.mp4',startFrame:24,durationFrames:24}],
    audio:[{clipId:'a',title:'First',media:'media/a000001.wav',role:'voice',startSample:24_000,durationSamples:30_000},
      {clipId:'b',title:'Overlap',media:'media/a000002.wav',role:'voice',startSample:36_000,durationSamples:30_000},
      {clipId:'c',title:'Later',media:'media/a000003.wav',role:'voice',startSample:72_000,durationSamples:6000}]};
}

test('exchange serializers express gaps, overlaps, rational time and relative media links',()=>{
  const input=timeline(),otio=JSON.parse(formatExchangeOtio(input));
  const [pictures,dialogueOne,dialogueTwo]=otio.tracks.children;
  assert.equal(pictures.children[0].media_reference.target_url,'./media/v000001.mp4');
  assert.equal(pictures.children[0].source_range.duration.rate,24000/1001);
  assert.deepEqual(dialogueOne.children.map((item:any)=>[item.OTIO_SCHEMA,item.source_range.duration.value]),[['Gap.1',24_000],['Clip.1',30_000],['Gap.1',18_000],['Clip.1',6000]]);
  assert.deepEqual(dialogueTwo.children.map((item:any)=>[item.OTIO_SCHEMA,item.source_range.duration.value]),[['Gap.1',36_000],['Clip.1',30_000]]);
  const fcpxml=formatExchangeFcpxml(input);
  assert.match(fcpxml,/frameDuration="1001\/24000s"/);assert.match(fcpxml,/剪辑 &amp; 交付/);
  assert.match(fcpxml,/<media-rep kind="original-media" src="\.\/media\/a000001\.wav"\/>/);
  assert.match(fcpxml,/name="Overlap" lane="-2" offset="3\/4s"/);
  assert.match(fcpxml,/name="Later" lane="-1" offset="499\/1000s"/);
  const edl=formatExchangeEdl(input);
  assert.match(edl,/002  YL000002 V +C +00:00:00:00 00:00:01:00 00:00:01:00 00:00:02:00/);
  input.target.fps={num:60,den:1};assert.match(exchangeEdlLimitation(input)!,/FPS/);assert.throws(()=>formatExchangeEdl(input),/FPS/);
});

test('the workbench RPC journals an exact, portable exchange and recovers a published result after interruption',{
  skip:!env.browserAvailable||!env.ffmpegAvailable||!env.ffprobeAvailable,timeout:90_000,
},async()=>{
  const base=await mkdtemp(join(tmpdir(),'yingliu-exchange-')),store=new ProjectStore({baseDirectory:base});
  let hub:ProjectHub|undefined;
  try{
    const project=createProject('交换夹具','','code_animation');
    project.target={width:320,height:180,fps:{num:24000,den:1001},audioMode:'mixed'};
    project.shots=project.shots.slice(0,2);
    project.shotOrder=project.shots.map(shot=>shot.id);
    project.shots[0]!.durationFrames=7;project.shots[1]!.durationFrames=9;
    project.shots[0]!.params={...project.shots[0]!.params,text:'Red',subtitle:'',background:'#b00000'};
    project.shots[1]!.params={...project.shots[1]!.params,text:'Blue',subtitle:'',background:'#0000b0'};
    project.subtitles=[{id:'s-one',text:'字幕保留为外挂',startSeconds:0,endSeconds:.2}];
    const {root}=await store.create(project),tone=join(base,'tone.wav');
    await exec(env.ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.12',tone]);
    const asset=await store.importAudio(root,{path:tone,name:'对白'},env);
    project.assets.push(asset);
    project.audioClips=[{id:'dialogue',assetId:asset.id,role:'voice',shotId:project.shots[1]!.id,startSeconds:.05,trimStart:0,volume:1,fadeIn:0,fadeOut:0}];
    const expectedRevision=project.revision;project.revision++;
    const saved=await store.commit(root,project,{},{expectedRevision});
    hub=new ProjectHub(context,{baseDirectory:base});
    const opened=await hub.call<StudioSnapshot>('open',{path:root});assert.equal(opened.project!.revision,saved.revision);
    const request={projectId:saved.id,expectedRevision:saved.revision};
    const started=await hub.call<StudioSnapshot>('timeline.exchange',request);
    assert.equal(started.task?.kind,'timeline');assert.equal(started.task?.revision,saved.revision);
    const completed=await settled(hub,saved.id),record=completed.task?.timelineExchange;
    assert.equal(completed.task?.status,'complete',completed.task?.error);assert.ok(record);
    assert.equal(completed.project!.revision,saved.revision);assert.deepEqual(completed.project!.outputs,[]);
    assert.equal(record.folder,`exports/timeline-${saved.revision}-${started.task!.id}`);
    assert.deepEqual(record.formats,['otio','fcpxml','edl']);
    const tasks=await hub.call<{tasks:TaskRecord[]}>('tasks',{projectId:saved.id});
    assert.deepEqual(tasks.tasks.find(task=>task.id===started.task?.id)?.timelineExchange,record);
    const journal=completed.task?.logPath;assert.ok(journal);
    const completedJournal=JSON.parse(await readFile(journal,'utf8'));
    delete completedJournal.timelineExchange;
    await writeFile(journal,JSON.stringify({...completedJournal,status:'running'}));
    await hub.dispose();hub=new ProjectHub(context,{baseDirectory:base});
    const recovered=await hub.call<StudioSnapshot>('current',{projectId:saved.id});
    assert.equal(recovered.task?.status,'complete');assert.deepEqual(recovered.task?.timelineExchange,record);
    const relocated=join(base,'恢复的位置');await rename(join(root,record.folder),relocated);
    const result=JSON.parse(await readFile(join(relocated,'manifest.json'),'utf8')) as {files:{path:string;bytes:number;sha256:string}[]};
    assert.ok(result.files.some(file=>file.path==='media/master-reference.wav'));
    assert.ok(result.files.some(file=>file.path==='subtitles.srt'));
    for(const file of result.files){
      const path=join(relocated,file.path);assert.equal((await stat(path)).size,file.bytes);assert.equal(await hashMediaFile(path),file.sha256);
    }
    const probe=async(file:string)=>JSON.parse((await exec(env.ffprobePath,['-v','error','-count_frames','-show_entries','stream=nb_read_frames','-of','json',join(relocated,'media',file)])).stdout);
    assert.equal((await probe('v000001.mp4')).streams[0].nb_read_frames,'7');
    assert.equal((await probe('v000002.mp4')).streams[0].nb_read_frames,'9');
    const xml=await readFile(join(relocated,'timeline.fcpxml'),'utf8');assert.match(xml,/name="对白" lane="-1" offset="1\/20s"/);
    assert.deepEqual((await store.open(root)).outputs,[]);
    assert.deepEqual(await readdir(join(root,'exports')),[]);
  }finally{await hub?.dispose();await rm(base,{recursive:true,force:true});}
});

test('timeline export requires a saved revision and workbench user, and only cancels its requested task',async t=>{
  const base=await mkdtemp(join(tmpdir(),'yingliu-timeline-command-')),hub=new ProjectHub(context,{baseDirectory:base});
  t.mock.method(VideoRenderer.prototype,'assetBaseUrl',async()=> 'http://127.0.0.1:1/');
  t.mock.method(VideoRenderer.prototype,'preview',async()=> 'http://127.0.0.1:1/');
  t.mock.method(VideoRenderer.prototype,'audioPreview',async()=>null);
  let entered!:()=>void;
  const rendering=new Promise<void>(resolve=>{entered=resolve;});
  t.mock.method(VideoRenderer.prototype,'export',async(_root:string,_project:VideoProject,_settings:unknown,signal:AbortSignal)=>{
    entered();
    if(signal.aborted)throw signal.reason;
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  try{
    const unresolved=await hub.call<StudioSnapshot>('create',{title:'未确认制作方式'});
    await assert.rejects(hub.call('timeline.exchange',{projectId:unresolved.project!.id,expectedRevision:unresolved.project!.revision}),{code:'PRODUCTION_POLICY_VIOLATION'});
    const created=await hub.call<StudioSnapshot>('create',{title:'交换取消',productionMode:'code_animation'});
    const projectId=created.project!.id,expectedRevision=created.project!.revision;
    await assert.rejects(hub.call('timeline.exchange',{projectId}),{code:'REVISION_REQUIRED'});
    await assert.rejects(hub.call('timeline.exchange',{projectId,expectedRevision:expectedRevision+1}),{code:'REVISION_CONFLICT'});
    await assert.rejects(hub.call('timeline.exchange',{projectId,expectedRevision},{callerSessionId:'agent-session'}),{code:'TIMELINE_EXPORT_REQUIRES_WORKBENCH'});
    const started=await hub.call<StudioSnapshot>('timeline.exchange',{projectId,expectedRevision});
    assert.equal(started.task?.status,'running');await rendering;
    const unrelated=await hub.call<StudioSnapshot>('cancel',{projectId,taskId:'other-task'});assert.equal(unrelated.task?.status,'running');
    await hub.call('cancel',{projectId,taskId:started.task!.id});
    const cancelled=await settled(hub,projectId);assert.equal(cancelled.task?.status,'cancelled');assert.equal(cancelled.task?.timelineExchange,undefined);
    assert.deepEqual(await readdir(join(created.root!,'exports')),[]);
    await assert.rejects(hub.call('retry',{projectId,expectedRevision,taskId:started.task!.id},{callerSessionId:'agent-session'}),{code:'TIMELINE_EXPORT_REQUIRES_WORKBENCH'});
  }finally{await hub.dispose();await rm(base,{recursive:true,force:true});}
});
