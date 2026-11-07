import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createCodeProject as createProject} from './fixtures/production.js';
import {ProjectStore} from '../src/host/store.js';
import {AudioMixer, AudioProcesses, compileAudioPlan, SpeechSynthesizer} from '../src/host/audio.js';
import {detectEnvironment, VideoRenderer} from '../src/host/renderer.js';
import type {AudioClip, VideoProject, TtsSettings} from '../src/shared/types.js';

const env=detectEnvironment(),exec=promisify(execFile),available=env.ffmpegAvailable&&env.ffprobeAvailable;
async function fixture(file:string,duration=1,frequency=440):Promise<Buffer>{
  await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`,'-c:a','pcm_s16le',file]);return fs.readFile(file);
}
function clip(assetId:string,patch:Partial<AudioClip>={}):AudioClip{return {id:crypto.randomUUID(),assetId,role:'voice',startSeconds:0,trimStart:0,volume:1,fadeIn:0,fadeOut:0,...patch};}
function shortProject():VideoProject{
  const project=createProject('声音闭环');project.shots=project.shots.slice(0,2);project.shotOrder=project.shots.map(shot=>shot.id);
  project.target={width:320,height:180,fps:{num:10,den:1},audioMode:'mixed',quality:'standard'};
  for(const shot of project.shots)shot.durationFrames=10;project.targetDuration=2;project.audioClips=[];return project;
}
function rms(bytes:Buffer,from:number,to:number):number{
  const start=Math.round(from*48000),end=Math.min(Math.round(to*48000),bytes.length/4);let sum=0;
  for(let i=start;i<end;i++)sum+=bytes.readFloatLE(i*4)**2;return Math.sqrt(sum/Math.max(1,end-start));
}

test('audio import probes actual media, persists relative paths and rejects video',{skip:!available},async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-audio-import-'));
  try{
    const store=new ProjectStore({baseDirectory:folder}),created=await store.create(shortProject()),file=path.join(folder,'声音.wav'),bytes=await fixture(file);
    const asset=await store.importAsset(created.root,{path:file,name:'真实配音'},env);assert.equal(asset.kind,'audio');assert.equal(asset.mime,'audio/wav');assert.equal(asset.sampleRate,48000);assert.equal(asset.channels,1);assert.ok(Math.abs(asset.duration!-1)<.001);assert.match(asset.path!,/^assets\/[^/]+\.wav$/);
    assert.deepEqual(await fs.readFile(path.join(created.root,asset.path!)),bytes);created.project.assets.push(asset);created.project.revision++;created.project=await store.commit(created.root,created.project);assert.equal((await new ProjectStore({baseDirectory:folder}).open(created.root)).assets[0]!.duration,asset.duration);
    const base64=await store.importAsset(created.root,{dataBase64:bytes.toString('base64'),mime:'audio/wav',name:'HTTP字节'},env);assert.equal(base64.kind,'audio');
    for(const extension of ['mp3','m4a','aac','flac','ogg']){
      const encoded=path.join(folder,'fixture.'+extension);await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-y','-i',file,encoded]);
      const imported=await store.importAsset(created.root,{path:encoded},env);assert.equal(imported.kind,'audio');assert.ok(imported.duration!>.9);assert.ok(imported.channels!>0);assert.match(imported.path!,new RegExp('\\.'+extension+'$'));
    }
    const video=path.join(folder,'not-audio.mp4');await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:s=64x64:d=0.2','-f','lavfi','-i','sine=frequency=220:duration=0.2','-c:v','libx264','-c:a','aac','-shortest',video]);
    await assert.rejects(store.importAudio(created.root,{path:video},env),/纯音频/);
    await assert.rejects(store.importAudio(created.root,{dataBase64:Buffer.from('not a sound').toString('base64')},env),/音频处理失败/);
    assert.equal((await fs.readdir(path.join(created.root,'assets'))).some(name=>name.endsWith('.audio-input')),false);
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('one audio plan resolves shot anchors, trim, looping, volume and fades into the actual preview mix',{skip:!available},async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-audio-mix-')),mixer=new AudioMixer();
  try{
    const store=new ProjectStore({baseDirectory:folder}),created=await store.create(shortProject()),project=created.project;
    const voiceFile=path.join(folder,'voice.wav'),musicFile=path.join(folder,'music.wav');await fixture(voiceFile,1,880);await fixture(musicFile,.2,440);
    const voice=await store.importAudio(created.root,{path:voiceFile},env),music=await store.importAudio(created.root,{path:musicFile},env);project.assets.push(voice,music);
    const voiceClip=clip(voice.id,{shotId:project.shots[1]!.id,startSeconds:.2,trimStart:.1,trimEnd:.7,volume:.8,fadeIn:.1,fadeOut:.1});
    project.audioClips=[clip(music.id,{role:'music',trimEnd:.2,loop:true,volume:.15,fadeIn:.1,fadeOut:.1}),voiceClip];
    const plan=compileAudioPlan(project);assert.equal(plan.clips[1]!.start,1.2);assert.ok(Math.abs(plan.clips[1]!.duration-.6)<1e-6);assert.equal(plan.clips[0]!.duration,2);
    const mix=await mixer.mix(created.root,project,env);assert.ok(mix);const decoded=await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-i',mix.path,'-map','0:a','-f','f32le','-ar','48000','-ac','1','pipe:1'],{encoding:'buffer',maxBuffer:1_000_000});
    assert.equal(decoded.stdout.length,2*48000*4);assert.ok(rms(decoded.stdout,0,.01)<rms(decoded.stdout,.3,.4)*.2);assert.ok(rms(decoded.stdout,1.4,1.5)>rms(decoded.stdout,.7,.8)*3);assert.ok(rms(decoded.stdout,1.99,2)<rms(decoded.stdout,.3,.4)*.2);
    const oldBytes=await fs.readFile(mix.path),oldHash=createHash('sha256').update(oldBytes).digest('hex');project.audioClips[1]!.volume=.2;
    const quieter=await mixer.mix(created.root,project,env);assert.notEqual(quieter!.path,mix.path);assert.equal(createHash('sha256').update(await fs.readFile(mix.path)).digest('hex'),oldHash);
    const repeat=await mixer.mix(created.root,project,env);assert.equal(repeat!.path,quieter!.path);
    project.shotOrder.reverse();assert.equal(compileAudioPlan(project).clips[1]!.start,.2);
    const original=structuredClone(project.audioClips[1]!);project.audioClips[1]!.trimStart=0;project.audioClips[1]!.trimEnd=1;
    assert.throws(()=>compileAudioPlan(project),/旁白超出镜头时长/);project.audioClips[1]=original;
    project.audioClips.push(clip(voice.id,{startSeconds:1.5,trimEnd:1}));assert.throws(()=>compileAudioPlan(project),/旁白超出成片时长/);project.audioClips.pop();
    project.target.audioMode='none';assert.equal(await mixer.mix(created.root,project,env),null);
    project.target.audioMode='mixed';project.audioClips[1]!.assetId='missing';assert.throws(()=>compileAudioPlan(project),/缺少|引用无效/);
  }finally{await mixer.close();await fs.rm(folder,{recursive:true,force:true});}
});

test('speech adapter uses explicitly configured HTTP route and cancellable local fixture, never ctx.llm',{skip:!available},async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-audio-tts-'));let request:any,authorization='';const wav=await fixture(path.join(folder,'fixture.wav'),.35);
  const server=createServer(async(req,res)=>{let body='';for await(const bytes of req)body+=String(bytes);request={url:req.url,...JSON.parse(body)};authorization=req.headers.authorization??'';if(request.input==='cancel'){return;}res.writeHead(200,{'Content-Type':'audio/wav'});res.end(wav);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  const store=new ProjectStore({baseDirectory:folder}),created=await store.create(shortProject()),speech=new SpeechSynthesizer(store);
  const settings:TtsSettings={endpoint:'http://127.0.0.1:'+address.port+'/v1',model:'fixture-voice',voice:'中文音色',speed:1.1,enabled:true,apiKey:'fixture-key'};
  try{
    const asset=await speech.synthesize(created.root,{text:'这是一次本地测试。',name:'旁白'},settings,env);assert.equal(asset.kind,'audio');assert.equal(asset.name,'旁白');assert.equal(request.url,'/v1/audio/speech');assert.equal(request.model,'fixture-voice');assert.equal(request.voice,'中文音色');assert.equal(request.response_format,'wav');assert.equal(authorization,'Bearer fixture-key');assert.deepEqual(await fs.readFile(path.join(created.root,asset.path!)),wav);
    await assert.rejects(speech.synthesize(created.root,{text:'hello'},{...settings,enabled:false},env),/启用/);
    const abort=new AbortController();const pending=speech.synthesize(created.root,{text:'cancel'},settings,env,abort.signal);await new Promise(resolve=>setTimeout(resolve,30));abort.abort();await assert.rejects(pending);
  }finally{await speech.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(folder,{recursive:true,force:true});}
});

test('mixed MP4 exports AAC, serves audio ranges and captures selected frame',{skip:!available||!env.browserAvailable},async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-audio-export-')),store=new ProjectStore({baseDirectory:folder}),renderer=new VideoRenderer(store);
  try{
    const created=await store.create(shortProject()),project=created.project,file=path.join(folder,'voice.wav');await fixture(file,.8);const asset=await store.importAudio(created.root,{path:file},env);project.assets.push(asset);project.audioClips=[clip(asset.id,{startSeconds:.2,fadeIn:.05,fadeOut:.05})];
    const audioUrl=await renderer.audioPreview(created.root,project,env);assert.ok(audioUrl);const range=await fetch(audioUrl,{headers:{Range:'bytes=0-63'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,64);assert.match(range.headers.get('content-type')!,/audio\/wav/);
    const captured=await renderer.capture(created.root,project,env,12);assert.equal(captured.frame,12);assert.equal(captured.shotId,project.shots[1]!.id);assert.equal((await fetch(captured.url)).status,200);
    const output=await renderer.export(created.root,project,env,new AbortController().signal,()=>{});assert.equal(output.qa?.audioStreams,1);assert.equal(output.qa?.audioCodec,'aac');assert.equal(output.qa?.silent,false);assert.equal(output.qa?.audioStart,0);assert.equal(output.frameCount,20);assert.equal(output.qa?.crf,18);
    await exec(env.ffmpegPath,['-v','error','-i',output.path,'-f','null','-']);
    project.revision++;project.audioClips[0]!.volume=.3;const changed=await renderer.audioPreview(created.root,project,env);assert.notEqual(changed,audioUrl);assert.equal((await fetch(audioUrl)).status,200);
  }finally{await renderer.close();await fs.rm(folder,{recursive:true,force:true});}
});

test('macOS system voice creates actual Chinese narration as portable WAV',{skip:!available||process.platform!=='darwin'},async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-audio-system-')),store=new ProjectStore({baseDirectory:folder}),speech=new SpeechSynthesizer(store);
  try{
    const created=await store.create(shortProject()),asset=await speech.synthesize(created.root,{text:'这是视频工作台的配音验收。',name:'中文系统配音'},{endpoint:'local:say',model:'system',voice:'Tingting',speed:1,enabled:true},env);
    assert.equal(asset.kind,'audio');assert.equal(asset.mime,'audio/wav');assert.equal(asset.sampleRate,48000);assert.equal(asset.channels,2);assert.ok(asset.duration!>1);
    const decoded=await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-i',path.join(created.root,asset.path!),'-f','f32le','-ar','48000','-ac','1','pipe:1'],{encoding:'buffer',maxBuffer:4_000_000});assert.ok(rms(decoded.stdout,0,asset.duration!)>.005);
    assert.equal((await fs.readdir(path.join(created.root,'runtime'))).some(name=>name.startsWith('tts-')),false);
  }finally{await speech.close();await fs.rm(folder,{recursive:true,force:true});}
});

test('audio cancellation waits for its owned subprocess and leaves no processing task',{skip:!available},async()=>{
  const processes=new AudioProcesses(),abort=new AbortController(),started=Date.now();
  const running=processes.run(env.ffmpegPath,['-hide_banner','-loglevel','error','-re','-f','lavfi','-i','sine=frequency=440:duration=20','-f','null','-'],abort.signal);
  const timer=setTimeout(()=>abort.abort(),80);
  try{await assert.rejects(running,/Task cancelled/);await processes.close();assert.ok(Date.now()-started<2500);}
  finally{clearTimeout(timer);await processes.close();}
});
