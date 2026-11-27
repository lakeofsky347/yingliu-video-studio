import {execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createProject,validateProject} from '../src/core/index.ts';
import {AudioMixer,probeAudio} from '../src/host/audio.ts';
import {detectEnvironment,VideoRenderer} from '../src/host/renderer.ts';
import {ProjectStore} from '../src/host/store.ts';
import {analyzeAudioAcoustics,deconstructReferenceVideo} from '../src/media/deconstruct.ts';
import type {AudioClip} from '../src/shared/types.ts';
import {localExportQuality} from '../src/workflows/local-quality.ts';

const exec=promisify(execFile),env=detectEnvironment();
const media={skip:!env.ffmpegAvailable||!env.ffprobeAvailable};
const ffmpeg=(...args:string[])=>exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-y',...args]);

test('acoustic checks use the final FFmpeg summary, retain sustained silence, and propagate cancellation',media,async()=>{
  const root=await mkdtemp(join(tmpdir(),'yingliu-acoustics-'));
  try{
    const wave=join(root,'tone.wav');
    await ffmpeg('-f','lavfi','-i','sine=frequency=1000:duration=2','-af','apad=pad_dur=1',wave);
    const report=await analyzeAudioAcoustics(wave,env);
    assert.ok(report.integratedLufs!==null&&Math.abs(report.integratedLufs+21.1)<.7);
    assert.equal(report.tooQuiet,false);assert.equal(report.clippingRisk,false);
    assert.deepEqual(report.silenceIntervals,[{startSeconds:2,endSeconds:3,durationSeconds:1}]);
    const project=createProject('声学测试','','code_animation');
    const quality=localExportQuality(project,{},[],{audio:{status:'measured',report}});
    assert.equal(quality.scope.audio?.status,'measured');
    assert.ok(quality.checks.some(check=>check.id==='audio-silence'&&check.severity==='advisory'));
    await assert.rejects(analyzeAudioAcoustics(wave,env,AbortSignal.abort(new Error('取消声学检查'))),/取消声学检查/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('reference video analysis returns measured cuts and preserves a fractional frame rate',media,async()=>{
  const root=await mkdtemp(join(tmpdir(),'yingliu-reference-video-'));
  try{
    const file=join(root,'reference.mp4');
    await ffmpeg('-f','lavfi','-i','color=c=black:s=64x64:d=1:r=24000/1001','-f','lavfi','-i','color=c=white:s=64x64:d=1:r=24000/1001','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','libx264',file);
    const result=await deconstructReferenceVideo(file,env);
    assert.equal(result.shotCount,2);assert.ok(Math.abs(result.fps-24000/1001)<.01);
    assert.ok(Math.abs(result.shots[0]!.endSeconds-1)<.05);
    assert.equal(result.shots[1]!.endSeconds,result.durationSeconds);
    assert.equal(result.hasAudio,false);
  }finally{await rm(root,{recursive:true,force:true});}
});

function amplitude(bytes:Buffer,frequency:number,from:number,to:number):number {
  let sin=0,cos=0;
  for(let i=Math.round(from*48000);i<Math.round(to*48000);i++){
    const radians=2*Math.PI*frequency*i/48000,sample=bytes.readFloatLE(i*4);
    sin+=sample*Math.sin(radians);cos+=sample*Math.cos(radians);
  }
  return Math.hypot(sin,cos);
}

test('master mix ducks music during speech without shortening the timeline and can normalize loudness',media,async()=>{
  const base=await mkdtemp(join(tmpdir(),'yingliu-master-')),store=new ProjectStore({baseDirectory:base}),mixer=new AudioMixer(),renderer=new VideoRenderer(store);
  try{
    const project=createProject('总混音','','code_animation');
    project.shots=[{...project.shots[0]!,durationFrames:120}];project.shotOrder=[project.shots[0]!.id];
    project.target.audioMode='mixed';
    const {root}=await store.create(project),musicFile=join(base,'music.wav'),voiceFile=join(base,'voice.wav');
    await ffmpeg('-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4',musicFile);
    await ffmpeg('-f','lavfi','-i','sine=frequency=1000:sample_rate=48000:duration=1',voiceFile);
    const music=await store.importAudio(root,{path:musicFile},env),voice=await store.importAudio(root,{path:voiceFile},env);
    const clip=(assetId:string,role:AudioClip['role'],startSeconds:number):AudioClip=>({id:role,assetId,role,startSeconds,trimStart:0,volume:1,fadeIn:0,fadeOut:0});
    project.assets.push(music,voice);project.audioClips=[clip(music.id,'music',0),clip(voice.id,'voice',1)];
    const plain=await mixer.mix(root,project,env);assert.ok(plain);
    project.audioMix={autoDucking:true,duckingDb:15};
    const ducked=await mixer.mix(root,project,env);assert.ok(ducked);assert.notEqual(ducked.path,plain.path);
    const pcm=async(file:string)=>(await exec(env.ffmpegPath,['-v','error','-i',file,'-f','f32le','-ar','48000','-ac','1','pipe:1'],{encoding:'buffer'})).stdout;
    const before=await pcm(plain.path),after=await pcm(ducked.path);
    assert.ok(amplitude(after,440,1.5,1.8)<amplitude(before,440,1.5,1.8)*.6);
    assert.ok(amplitude(after,1000,1.5,1.8)>amplitude(before,1000,1.5,1.8)*.9);
    assert.ok(amplitude(after,440,3.5,3.8)>amplitude(before,440,3.5,3.8)*.95);
    assert.equal((await probeAudio(ducked.path,env)).duration,4);
    project.audioMix={targetLufs:-18,voiceReverb:'room'};
    const normalized=await renderer.analyzeAudio(root,project,env);
    assert.equal(normalized.status,'measured');
    assert.ok(normalized.report.integratedLufs!==null&&Math.abs(normalized.report.integratedLufs+18)<1.5);
    project.audioMix.targetLufs=90;assert.equal(validateProject(project).ok,false);
  }finally{await Promise.all([mixer.close(),renderer.close()]);await rm(base,{recursive:true,force:true});}
});
