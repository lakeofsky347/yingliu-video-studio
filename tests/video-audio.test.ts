import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createProject} from '../src/core/index.ts';
import {AudioMixer,compileAudioPlan,extractVideoAudio,probeAudio} from '../src/host/audio.ts';
import {detectEnvironment} from '../src/host/renderer.ts';
import type {Asset,VideoClip} from '../src/shared/types.ts';

const environment=detectEnvironment(),exec=promisify(execFile),available=environment.ffmpegAvailable&&environment.ffprobeAvailable;
function fixtureProject(){
  const project=createProject('视频原声');project.shots=project.shots.slice(0,2);project.shotOrder=project.shots.map(shot=>shot.id);
  project.target={width:64,height:64,fps:{num:30,den:1},audioMode:'mixed'};project.shots[0]!.durationFrames=30;project.shots[1]!.durationFrames=60;
  const asset:Asset={id:'video-asset',kind:'video',name:'测试视频',description:'本地FFmpeg合成验收素材',path:'assets/fixture.mp4',mime:'video/mp4',width:64,height:64,duration:4,fps:{num:30,den:1},hasAudio:true};
  const clip:VideoClip={id:'video-clip',shotId:project.shots[1]!.id,assetId:asset.id,trimStart:1,trimEnd:3,speed:2,fit:'contain',audio:'keep'};
  project.assets=[asset];project.videoClips=[clip];return {project,asset,clip};
}
function rms(bytes:Buffer,from:number,to:number){let sum=0,count=0;for(let i=Math.round(from*48000);i<Math.min(Math.round(to*48000),bytes.length/4);i++){sum+=bytes.readFloatLE(i*4)**2;count++;}return Math.sqrt(sum/Math.max(1,count));}

test('video audio plan respects shot anchors, trim, speed, mute and explicit extraction',()=>{
  const {project,clip,asset}=fixtureProject();const planned=compileAudioPlan(project).clips[0]!;
  assert.equal(planned.start,1);assert.equal(planned.duration,1);assert.equal(planned.trimStart,1);assert.equal(planned.trimEnd,3);assert.equal(planned.speed,2);assert.equal(planned.sourceVideoClipId,clip.id);
  project.shotOrder.reverse();assert.equal(compileAudioPlan(project).clips[0]!.start,0);
  clip.speed=.25;assert.equal(compileAudioPlan(project).clips[0]!.duration,2);
  clip.speed=2;clip.audio='mute';assert.equal(compileAudioPlan(project).clips.length,0);
  clip.audio='keep';asset.hasAudio=false;assert.equal(compileAudioPlan(project).clips.length,0);
  asset.hasAudio=true;clip.audio='extract';assert.throws(()=>compileAudioPlan(project),/先.*提取/);
  clip.audio='keep';project.target.audioMode='none';assert.equal(compileAudioPlan(project).clips.length,0);
});

test('actual MP4 original audio mixes only its selected window and extracts an independent WAV',{skip:!available},async()=>{
  const root=await mkdtemp(join(tmpdir(),'video-audio-')),mixer=new AudioMixer();
  try{
    await mkdir(join(root,'assets'));const {project,asset,clip}=fixtureProject(),file=join(root,asset.path!);
    await exec(environment.ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:s=64x64:r=30:d=4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-map','0:v','-map','1:a','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',file]);
    const mix=await mixer.mix(root,project,environment);assert.ok(mix);
    const decode=await exec(environment.ffmpegPath,['-v','error','-i',mix.path,'-map','0:a:0','-f','f32le','-ar','48000','-ac','1','pipe:1'],{encoding:'buffer',maxBuffer:2_000_000});
    assert.equal(decode.stdout.length,3*48000*4);assert.ok(rms(decode.stdout,.1,.9)<.00001);assert.ok(rms(decode.stdout,1.2,1.8)>.01);assert.ok(rms(decode.stdout,2.2,2.9)<.00001);
    const cached=await mixer.mix(root,project,environment);assert.equal(cached!.path,mix.path);
    const extracted=await extractVideoAudio(root,asset,clip,environment);assert.equal(extracted.kind,'audio');assert.notEqual(extracted.path,asset.path);assert.ok(Math.abs(extracted.duration!-1)<.001);
    assert.equal((await probeAudio(join(root,extracted.path!),environment)).channels,2);
    project.assets.push(extracted);clip.audio='mute';project.audioClips=[{id:'extracted-clip',assetId:extracted.id,role:'sfx',shotId:clip.shotId,startSeconds:0,trimStart:0,volume:1,fadeIn:0,fadeOut:0}];
    const independent=compileAudioPlan(project);assert.equal(independent.clips.length,1);assert.equal(independent.clips[0]!.assetId,extracted.id);assert.equal(independent.clips[0]!.start,1);
    assert.equal((await readdir(join(root,'runtime'))).some(name=>name.startsWith('video-audio-')),false);
    const noAudio={...asset,hasAudio:false};await assert.rejects(extractVideoAudio(root,noAudio,clip,environment),/没有可提取/);
  }finally{await mixer.close();await rm(root,{recursive:true,force:true});}
});

test('sequential voice mixing retains exact duration and stable PCM after earlier inputs end',{skip:!available,timeout:60_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'voice-tail-')),mixer=new AudioMixer();
  try{
    await mkdir(join(root,'assets'));const file=join(root,'assets/voice.wav');
    await exec(environment.ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=1.25','-ac','2','-c:a','pcm_s16le','-y',file]);
    const project=createProject('三镜旁白');project.target={width:64,height:64,fps:{num:12,den:1},audioMode:'mixed'};project.shots.forEach(shot=>shot.durationFrames=24);
    project.assets=[{id:'voice',kind:'audio',name:'旁白',description:'',path:'assets/voice.wav',mime:'audio/wav',duration:1.25,sampleRate:48000,channels:2}];
    project.audioClips=project.shots.map((shot,index)=>({id:'voice-'+index,assetId:'voice',role:'voice',shotId:shot.id,startSeconds:0,trimStart:0,volume:1,fadeIn:0,fadeOut:0}));
    let expectedHash='';
    for(let attempt=0;attempt<10;attempt++){
      const mix=await mixer.mix(root,project,environment);assert.ok(mix);const metadata=await probeAudio(mix.path,environment);
      assert.equal(metadata.duration,6,'cold mix '+attempt+' must pad the full six-second timeline');
      const decoded=await exec(environment.ffmpegPath,['-v','error','-i',mix.path,'-map','0:a:0','-f','f32le','-ar','48000','-ac','1','pipe:1'],{encoding:'buffer',maxBuffer:2_000_000});
      assert.equal(decoded.stdout.length,6*48000*4);for(const start of [.2,2.2,4.2])assert.ok(rms(decoded.stdout,start,start+.6)>.01);assert.ok(rms(decoded.stdout,5.4,5.9)<.00001);
      const hash=createHash('sha256').update(decoded.stdout).digest('hex');if(attempt===0)expectedHash=hash;else assert.equal(hash,expectedHash,'PCM remains repeatable across FFmpeg input scheduling');
      await rm(mix.path);
    }
  }finally{await mixer.close();await rm(root,{recursive:true,force:true});}
});
