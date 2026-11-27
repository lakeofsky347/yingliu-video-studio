import {execFile} from 'node:child_process';
import {mkdtemp,readFile,readdir,rename,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createProject} from '../src/core/index.ts';
import {exportTimelineExchange} from '../src/host/timeline-exchange.ts';
import {ProjectStore} from '../src/host/store.ts';
import {detectEnvironment} from '../src/host/renderer.ts';
import {hashMediaFile} from '../src/media/video.ts';
import {exchangeEdlLimitation,formatExchangeEdl,formatExchangeFcpxml,formatExchangeOtio,type ExchangeTimeline} from '../src/media/timeline-exchange.ts';

const exec=promisify(execFile),env=detectEnvironment();

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

test('timeline bundle renders exact video cuts and portable referenced media without changing project outputs',{
  skip:!env.browserAvailable||!env.ffmpegAvailable||!env.ffprobeAvailable,
},async()=>{
  const base=await mkdtemp(join(tmpdir(),'yingliu-exchange-')),store=new ProjectStore({baseDirectory:base});
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
    const result=await exportTimelineExchange(root,saved,env,new AbortController().signal);
    const relocated=join(base,'恢复的位置');await rename(result.path,relocated);
    assert.deepEqual(result.formats,['otio','fcpxml','edl']);
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
  }finally{await rm(base,{recursive:true,force:true});}
});
