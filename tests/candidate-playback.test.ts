import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createProject} from '../src/core/index.js';
import {ProjectStore} from '../src/host/store.js';
import {StudioService} from '../src/host/service.js';
import {VideoRenderer,detectEnvironment,type CandidatePlaybackInput} from '../src/host/renderer.js';
import type {SceneSource,VideoProject} from '../src/shared/types.js';
import type {HostContext} from '../src/host/platform.js';

const env=detectEnvironment(),available=env.browserAvailable&&env.ffmpegAvailable&&env.ffprobeAvailable,exec=promisify(execFile);
const digest=(candidate:CandidatePlaybackInput)=>createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
function scene(color:string):SceneSource{return {html:'',css:'',js:`export function render(ctx){ctx.ctx2d.fillStyle=${color};ctx.ctx2d.fillRect(0,0,ctx.width,ctx.height);}`};}
function project(mode:'code_animation'|'model_video') {const project=createProject('候选动态审看','',mode);project.shots=project.shots.slice(0,2);project.shotOrder=project.shots.map(s=>s.id);project.target={width:160,height:90,fps:{num:4,den:1},audioMode:'none'};project.shots.forEach(shot=>shot.durationFrames=4);project.targetDuration=2;return project;}
async function files(root:string,relative=''):Promise<Record<string,string>>{const result:Record<string,string>={};for(const entry of (await fs.readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=path.posix.join(relative,entry.name);if(entry.isDirectory())Object.assign(result,await files(root,name));else result[name]=createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex');}return result;}
function frequency(bytes:Buffer){let crossings=0;const start=Math.floor(.2*48000),end=Math.floor(.8*48000);for(let i=start+1;i<end;i++)if(bytes.readFloatLE((i-1)*4)<=0&&bytes.readFloatLE(i*4)>0)crossings++;return crossings/.6;}
async function metadata(file:string){return JSON.parse((await exec(env.ffprobePath,['-v','error','-show_entries','stream=codec_type,codec_name,nb_frames:format=duration','-of','json',file])).stdout);}

test('candidate MP4 uses actual code, absolute frames and candidate audio; caches by actual hash without altering live previews or outputs',{skip:!available,timeout:90_000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'candidate-playback-test-')),store=new ProjectStore({baseDirectory:directory});let service:StudioService|undefined;let playbackRoot:string|undefined,playbackUrl:string|undefined;
  const ctx={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No model calls in candidate playback tests');}}} as unknown as HostContext;
  try{
    const initial=project('code_animation'),created=await store.create({project:initial,sources:initial.shots.map(shot=>({shotId:shot.id,source:scene('"#0000ff"')}))});
    const toneFile=path.join(directory,'candidate-tone.wav');await exec(env.ffmpegPath,['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1','-filter_complex','[0:a][1:a]concat=n=2:v=0:a=1[a]','-map','[a]','-ac','2','-c:a','pcm_s16le',toneFile]);
    const audio=await store.importAudio(created.root,{path:toneFile},env);
    service=new StudioService(ctx,{baseDirectory:directory});const snapshot=await service.snapshot(),live=snapshot.project!,second=live.shots[1]!;
    assert.ok(snapshot.previewUrl);const thumbnails=await service.renderer.thumbnails(created.root,live,env,[0,4,7]);const liveFiles=await files(created.root),liveProject=structuredClone(live);
    const candidate:CandidatePlaybackInput={expectedRevision:live.revision,project:structuredClone(live),sources:{[second.id]:scene('ctx.frame>=4?"#ff0000":"#00ff00"')}};
    candidate.project.target.audioMode='mixed';candidate.project.assets.push(audio);candidate.project.audioClips=[{id:'candidate-music',assetId:audio.id,role:'music',startSeconds:0,trimStart:0,trimEnd:2,volume:1,fadeIn:0,fadeOut:0}];
    const candidateHash=digest(candidate);
    const [playback,concurrent]=await Promise.all([service.previewWorkflowCandidate(candidate,candidateHash,[second.id]),service.previewWorkflowCandidate(candidate,candidateHash,[second.id])]);assert.deepEqual(playback,concurrent);playbackUrl=playback.url;
    assert.equal(playback.candidateHash,candidateHash);assert.equal(playback.frameCount,4);assert.equal(playback.duration,1);assert.deepEqual(playback.shotIds,[second.id]);assert.equal(playback.mime,'video/mp4');
    const cached=await service.previewWorkflowCandidate(candidate,candidateHash,[second.id]);assert.equal(cached.url,playback.url);assert.equal((service.renderer as any).candidatePlaybacks.size,1);
    playbackRoot=[...(service.renderer as any).candidatePlaybacks.values()][0].root;assert.ok(playbackRoot?.includes('video-studio-candidate-playback-'));
    const range=await fetch(playback.url,{headers:{Range:'bytes=0-63'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,64);
    const downloaded=path.join(directory,'review.mp4');await fs.writeFile(downloaded,Buffer.from(await(await fetch(playback.url)).arrayBuffer()));const meta=await metadata(downloaded);assert.equal(meta.streams.find((s:any)=>s.codec_type==='video').nb_frames,'4');assert.equal(meta.streams.filter((s:any)=>s.codec_type==='audio').length,1);
    const pixels=(await exec(env.ffmpegPath,['-v','error','-i',downloaded,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer'})).stdout;assert.ok(pixels[0]!>200&&pixels[1]!<30&&pixels[2]!<30,'Selected code must use original absolute frame 4, rather than the live blue or a rebased green frame');
    const sound=(await exec(env.ffmpegPath,['-v','error','-i',downloaded,'-map','0:a','-f','f32le','-ar','48000','-ac','1','pipe:1'],{encoding:'buffer'})).stdout;assert.ok(Math.abs(frequency(sound)-880)<15,'Selected audio must come from the candidate second-second window');
    assert.deepEqual(await files(created.root),liveFiles);assert.deepEqual((await service.snapshot()).project,liveProject);assert.deepEqual(await service.renderer.thumbnails(created.root,live,env,[0,4,7]),thumbnails);assert.equal((await fetch(snapshot.previewUrl!)).status,200);
    const importedReview=await store.importVideo(created.root,{path:downloaded,name:'renamed-review.mp4'},env);assert.equal(importedReview.provenance?.origin,'code_render');assert.equal(importedReview.provenance?.sourceProjectId,live.id);
    const altered=structuredClone(candidate);altered.sources[second.id]=scene('"#00ff00"');await assert.rejects(service.previewWorkflowCandidate(altered,candidateHash,[second.id]),/hash/);
    const alteredPlayback=await service.previewWorkflowCandidate(altered,digest(altered),[second.id]);assert.notEqual(alteredPlayback.url,playback.url);
    await service.setProductionPolicy({expectedRevision:live.revision,mode:'model_video'});assert.equal((await fetch(playback.url)).status,403);await assert.rejects(service.previewWorkflowCandidate(candidate,candidateHash,[second.id]),/过期|许可/);
    assert.equal((await service.snapshot()).project!.outputs.length,0);
  }finally{await service?.dispose();if(playbackRoot)await assert.rejects(fs.stat(playbackRoot),{code:'ENOENT'});if(playbackUrl)await assert.rejects(fetch(playbackUrl));await fs.rm(directory,{recursive:true,force:true});}
});

test('selected model-video preview uses the candidate clip and native audio even when an unrelated shot is unfilled',{skip:!available,timeout:60_000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'candidate-model-playback-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);let artifactRoot:string|undefined;
  try{
    const initial=project('model_video'),created=await store.create(initial),file=path.join(directory,'model.mp4');await exec(env.ffmpegPath,['-v','error','-y','-f','lavfi','-i','color=c=red:size=160x90:rate=4:duration=1','-f','lavfi','-i','sine=frequency=1200:sample_rate=48000:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',file]);
    const video=await store.importVideo(created.root,{path:file},env);video.provenance={origin:'model_generation',usage:'production'};const candidate:CandidatePlaybackInput={expectedRevision:0,project:structuredClone(created.project),sources:{[created.project.shots[1]!.id]:scene('(()=>{throw new Error("MODEL_PREVIEW_EXECUTED_CODE")})()')}};
    candidate.project.assets=[video];candidate.project.target.audioMode='mixed';const shotId=candidate.project.shots[1]!.id;candidate.project.videoClips=[{id:'clip',shotId,assetId:video.id,trimStart:0,trimEnd:1,speed:1,fit:'contain',audio:'keep'}];
    let authorized=true;const assertAuthorized=()=>{if(!authorized)throw new Error('Policy revoked');};const playback=await renderer.previewCandidate(created.root,candidate,env,{candidateHash:digest(candidate),shotIds:[shotId],assertAuthorized});
    artifactRoot=[...(renderer as any).candidatePlaybacks.values()][0].root;const copy=path.join(directory,'review.mp4');await fs.writeFile(copy,Buffer.from(await(await fetch(playback.url)).arrayBuffer()));const meta=await metadata(copy);assert.equal(meta.streams.find((s:any)=>s.codec_type==='video').nb_frames,'4');assert.equal(meta.streams.filter((s:any)=>s.codec_type==='audio').length,1);
    const sound=(await exec(env.ffmpegPath,['-v','error','-i',copy,'-map','0:a','-f','f32le','-ar','48000','-ac','1','pipe:1'],{encoding:'buffer'})).stdout;assert.ok(Math.abs(frequency(sound)-1200)<15);assert.equal((await store.open(created.root)).outputs.length,0);
    const fading=structuredClone(candidate);fading.project.shotOrder.reverse();fading.project.shots[0]!.transition='fade';await assert.rejects(renderer.previewCandidate(created.root,fading,env,{candidateHash:digest(fading),shotIds:[shotId],assertAuthorized}),/淡出关系/);
    authorized=false;assert.equal((await fetch(playback.url)).status,403);await assert.rejects(renderer.previewCandidate(created.root,candidate,env,{candidateHash:digest(candidate),shotIds:[shotId],assertAuthorized}),/revoked/);
  }finally{await renderer.close();if(artifactRoot)await assert.rejects(fs.stat(artifactRoot),{code:'ENOENT'});await fs.rm(directory,{recursive:true,force:true});}
});

test('policy revocation during candidate rendering aborts owned work and removes all candidate servers and temporary files',{skip:!available,timeout:60_000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'candidate-abort-test-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store),created=await store.create(project('code_animation'));let allowed=true,frames=0;const temporary:string[]=[];
  const originalMkdtemp=fs.mkdtemp;t.mock.method(fs,'mkdtemp',async(...args:Parameters<typeof fs.mkdtemp>)=>{const result=await originalMkdtemp(...args);if(String(args[0]).endsWith('video-studio-candidate-playback-'))temporary.push(String(result));return result;});
  const originalFrame=(VideoRenderer.prototype as any).frame;t.mock.method(VideoRenderer.prototype as any,'frame',async function(this:VideoRenderer,...args:unknown[]){if(++frames===2)allowed=false;return originalFrame.apply(this,args);});
  try{
    const candidate:CandidatePlaybackInput={expectedRevision:0,project:created.project,sources:{}};
    await assert.rejects(renderer.previewCandidate(created.root,candidate,env,{candidateHash:digest(candidate),assertAuthorized:()=>{if(!allowed)throw new Error('Revoked during render');}}),/Revoked|cancelled/);
    assert.ok(frames>=2);assert.equal((renderer as any).candidatePlaybacks.size,0);assert.equal((renderer as any).servers.size,0);for(const root of temporary)await assert.rejects(fs.stat(root),{code:'ENOENT'});assert.equal((await store.open(created.root)).outputs.length,0);
    const cancelled=new AbortController();cancelled.abort();await assert.rejects(renderer.previewCandidate(created.root,candidate,env,{candidateHash:digest(candidate),assertAuthorized:()=>{}},cancelled.signal),/cancelled/i);
  }finally{await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});
