import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {StudioService} from '../src/host/service.ts';
import {detectEnvironment} from '../src/host/renderer.ts';
import {synthesizeLocalSfx} from '../src/media/local-sfx.ts';
import type {StudioSnapshot} from '../src/shared/types.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {LocalQualityReport} from '../src/workflows/local-quality.ts';
const environment=detectEnvironment(),exec=promisify(execFile);
const context={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('Native local SFX validation must not call a provider');}}} as unknown as HostContext;
async function call<T=StudioSnapshot>(service:StudioService,endpoint:string,payload:unknown={}):Promise<T>{const result=await service.rpc(endpoint,payload);assert.equal(result.ok,true,result.ok?'':result.error.message);return (result.ok?result.value:undefined) as T;}
async function settled(service:StudioService){const deadline=Date.now()+45000;while(Date.now()<deadline){const snapshot=await service.snapshot();if(snapshot.task?.status!=='running')return snapshot;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Native local SFX export did not settle');}
test('native local SFX imports once across restart, mixes into an AAC MP4 and fully decodes',{skip:!environment.browserAvailable||!environment.ffmpegAvailable||!environment.ffprobeAvailable},async()=>{
  const base=await mkdtemp(join(tmpdir(),'local-sfx-native-'));let service=new StudioService(context,{baseDirectory:base});
  try{
    let snapshot=await call(service,'create',{productionMode:'code_animation',title:'本地音效完整媒体闭环'}),project=structuredClone(snapshot.project!);project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);project.shots[0]!.durationFrames=10;project.target={width:320,height:180,fps:{num:10,den:1},audioMode:'none'};project.targetDuration=1;
    snapshot=await call(service,'save',{project,expectedRevision:snapshot.project!.revision});
    const spec={kind:'chime' as const,durationSeconds:.5,frequency:880,volume:.6,seed:42},request={name:'确定性钟声',spec,requestId:'native-one-sfx'};
    snapshot=await call(service,'audio.sfx',{...request,expectedRevision:snapshot.project!.revision});const first=snapshot.project!;assert.equal(first.assets.filter(asset=>asset.kind==='audio').length,1);assert.equal(first.audioClips?.length,1);assert.equal(first.audioClips?.[0]?.role,'sfx');assert.equal(first.target.audioMode,'mixed');
    const asset=first.assets.find(asset=>asset.kind==='audio')!;assert.equal(asset.sampleRate,44100);assert.equal(asset.channels,1);assert.ok(Math.abs(asset.duration!-.5)<.001);assert.deepEqual(await readFile(join(snapshot.root!,asset.path!)),Buffer.from(synthesizeLocalSfx(spec)));
    snapshot=await call(service,'audio.sfx',{...request,expectedRevision:first.revision});assert.equal(snapshot.project!.revision,first.revision);assert.equal(snapshot.project!.audioClips?.length,1);
    await service.dispose();service=new StudioService(context,{baseDirectory:base});snapshot=await call(service,'current');snapshot=await call(service,'audio.sfx',{...request,expectedRevision:snapshot.project!.revision});assert.equal(snapshot.project!.assets.filter(item=>item.kind==='audio').length,1);assert.equal(snapshot.project!.audioClips?.length,1);
    const report=await call<LocalQualityReport>(service,'quality.check',{expectedRevision:snapshot.project!.revision});assert.notEqual(report.decision,'fail');assert.equal(report.scope.checkedFrames.length,3,JSON.stringify(report.checks));assert.equal(report.scope.unchecked.length,3);
    await call(service,'export',{expectedRevision:snapshot.project!.revision});snapshot=await settled(service);assert.equal(snapshot.task?.status,'complete',snapshot.task?.error);assert.equal(snapshot.project!.outputs.length,1);const output=snapshot.project!.outputs[0]!;
    const probed=await exec(environment.ffprobePath,['-v','error','-show_streams','-show_format','-of','json',output.path]);const media=JSON.parse(probed.stdout);assert.equal(media.streams.filter((stream:any)=>stream.codec_type==='audio').length,1);assert.equal(media.streams.find((stream:any)=>stream.codec_type==='audio').codec_name,'aac');assert.ok(Math.abs(Number(media.format.duration)-1)<.15);
    await exec(environment.ffmpegPath,['-v','error','-i',output.path,'-f','null','-']);
    const decoded=await exec(environment.ffmpegPath,['-v','error','-i',output.path,'-vn','-f','f32le','-ar','48000','-ac','1','pipe:1'],{encoding:'buffer',maxBuffer:1_000_000});let sum=0;for(let i=0;i<Math.min(decoded.stdout.length/4,12000);i++)sum+=decoded.stdout.readFloatLE(i*4)**2;assert.ok(Math.sqrt(sum/12000)>.005,'actual mixed sound must contain non-silent samples');
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
