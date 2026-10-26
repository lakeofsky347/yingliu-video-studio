import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createProject,compileSpec,validateProject,migrateProject,deleteShot,deleteAsset,duplicateShot} from '../src/core/index.ts';
import {ProjectStore} from '../src/host/store.ts';
import {VideoRenderer,detectEnvironment} from '../src/host/renderer.ts';
import {probeVideo,MAX_VIDEO_BYTES} from '../src/media/video.ts';
const exec=promisify(execFile),env=detectEnvironment();

test('video clips validate source ranges, one layer per shot and v1 migration preserves stable content',()=>{
  const project=createProject('迁移');project.schemaVersion=1;delete project.videoClips;
  const migrated=migrateProject(project);assert.equal(migrated.schemaVersion,2);assert.equal(project.schemaVersion,1);assert.deepEqual(migrated.shots,project.shots);assert.equal(migrated.revision,project.revision);
  migrated.assets=[{id:'film',kind:'video',name:'片段',description:'',path:'assets/film.mp4',duration:2,width:160,height:90,fps:{num:24,den:1},hasAudio:false}];
  migrated.videoClips=[{id:'clip',shotId:migrated.shots[0]!.id,assetId:'film',trimStart:.25,trimEnd:1.5,speed:2,fit:'cover',audio:'mute'}];
  assert.equal(validateProject(migrated).ok,true);const spec=compileSpec(migrated);assert.equal(spec.shots[0]!.assets[0]!.id,'film');assert.equal(spec.shots[0]!.videoClip?.speed,2);
  assert.equal(deleteShot(migrated,migrated.shots[0]!.id).videoClips?.length,0);assert.equal(deleteAsset(migrated,'film').videoClips?.length,0);
  const duplicated=duplicateShot(migrated,migrated.shots[0]!.id);assert.equal(duplicated.videoClips?.length,2);assert.notEqual(duplicated.videoClips![0]!.shotId,duplicated.videoClips![1]!.shotId);assert.equal(validateProject(duplicated).ok,true);
  migrated.videoClips[0]!.trimEnd=3;assert.equal(validateProject(migrated).ok,false);migrated.videoClips[0]!.trimEnd=1.5;
  migrated.videoClips.push({...migrated.videoClips[0]!,id:'other'});assert.equal(validateProject(migrated).ok,false);
});

test('real video imports, random seeks, code overlays, mixed-shot export and migrated history',{skip:!(env.browserAvailable&&env.ffmpegAvailable&&env.ffprobeAvailable),timeout:120_000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-video-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
  try{
    const input=join(directory,'input.mp4');await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=24:duration=2','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',input]);
    const project=createProject('视频混排');project.target={width:160,height:90,fps:{num:12,den:1},audioMode:'mixed'};project.shots.forEach((shot,index)=>shot.durationFrames=index===1?12:6);project.targetDuration=2;
    const created=await store.create(project);const asset=await store.importAsset(created.root,{path:input,name:'测试视频'},env);
    assert.ok(asset.originalPath?.startsWith('assets/'));assert.notEqual(asset.originalPath,asset.path);assert.deepEqual(await readFile(join(created.root,asset.originalPath!)),await readFile(input));
    assert.equal(asset.kind,'video');assert.equal(asset.hasAudio,true);assert.equal(asset.frameCount,48);assert.ok(asset.sourceSha256);assert.ok(asset.sha256);assert.ok(asset.path?.startsWith('assets/'));
    const metadata=await probeVideo(join(created.root,asset.path!),env);assert.equal(metadata.fps.num/metadata.fps.den,24);
    let next=structuredClone(created.project);next.assets.push(asset);next.videoClips=[{id:'video-clip',shotId:next.shots[1]!.id,assetId:asset.id,trimStart:.25,trimEnd:1.25,speed:2,fit:'contain',audio:'keep'}];next.revision++;
    next=await store.commit(created.root,next,{[next.shots[1]!.id]:{html:'<b id="overlay">字幕</b>',css:'#overlay{position:absolute;left:0;bottom:0;color:white;font:10px sans-serif}',js:'export function render(ctx){if(!ctx.hasVideo||!ctx.video)throw new Error("video context missing");}'}});
    const check=await renderer.check(created.root,next,env);assert.equal(check.ok,true,JSON.stringify(check.errors));
    const hashes=new Map<number,string>();for(const frame of [6,9,17,11,6,9]){const capture=await renderer.capture(created.root,next,env,frame);if(hashes.has(frame))assert.equal(capture.sha256,hashes.get(frame));hashes.set(frame,capture.sha256);}
    assert.notEqual(hashes.get(6),hashes.get(9));
    const output=await renderer.export(created.root,next,env,new AbortController().signal,()=>{});assert.equal(output.frameCount,24);assert.equal(output.qa?.arbitrarySeek,'PASS');assert.equal(output.qa?.coldReload,'PASS');assert.equal(output.qa?.silent,false);
    await exec(env.ffmpegPath,['-v','error','-i',output.path,'-f','null','-']);
    const snapshot=JSON.parse(await readFile(join(String(output.qa!.snapshotRoot),'project.json'),'utf8'));assert.equal(snapshot.assets[0].originalPath,undefined);assert.equal(snapshot.assets[0].sourceSha256,asset.sourceSha256);
    const duplicate=await store.duplicate(created.root,'带原始素材副本');assert.deepEqual(await readFile(join(duplicate.root,asset.originalPath!)),await readFile(input));
    const reopened=await new ProjectStore({baseDirectory:directory}).open(created.root);assert.deepEqual(reopened.videoClips,next.videoClips);
    const undone=await store.moveHistory(created.root,'undo',next.revision);assert.equal(undone.videoClips?.length,0);const redone=await store.moveHistory(created.root,'redo',undone.revision);assert.deepEqual(redone.videoClips,next.videoClips);
    const before=await readdir(join(created.root,'assets'));await assert.rejects(store.importAsset(created.root,{dataBase64:Buffer.from('not a video').toString('base64'),mime:'video/mp4'},env));assert.deepEqual(await readdir(join(created.root,'assets')),before);
    // Opening an old immutable snapshot migrates only its in-memory data and preserves history IDs.
    const state=JSON.parse(await readFile(join(created.root,'.studio/state.json'),'utf8')),file=join(created.root,'.studio/versions',state.current+'.json');const record=JSON.parse(await readFile(file,'utf8'));record.project.schemaVersion=1;delete record.project.videoClips;record.project.assets=[];await writeFile(file,JSON.stringify(record));
    const migrated=await new ProjectStore({baseDirectory:directory}).open(created.root);assert.equal(migrated.schemaVersion,2);assert.equal(migrated.id,next.id);assert.equal(migrated.revision,redone.revision);assert.equal(JSON.parse(await readFile(file,'utf8')).project.schemaVersion,1);
  }finally{await renderer.close();await rm(directory,{recursive:true,force:true});}
});


test('VFR source is normalized to CFR and path-backed project restore streams the immutable asset',{skip:!env.ffmpegAvailable||!env.ffprobeAvailable,timeout:60_000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'video-cfr-')),store=new ProjectStore({baseDirectory:directory});
  try{
    const input=join(directory,'vfr.mp4');await exec(env.ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=64x64:rate=24:duration=2','-vf',"select='if(lt(n,12),1,not(mod(n,2)))'",'-fps_mode','vfr','-c:v','libx264','-pix_fmt','yuv420p','-y',input]);
    const created=await store.create({title:'CFR'}),asset=await store.importAsset(created.root,{path:input},env);
    const proxy=join(created.root,asset.path!),probe=JSON.parse((await exec(env.ffprobePath,['-v','error','-select_streams','v:0','-show_entries','stream=r_frame_rate,avg_frame_rate','-of','json',proxy])).stdout).streams[0];
    assert.equal(probe.r_frame_rate,probe.avg_frame_rate);assert.equal(asset.hasAudio,false);
    const restoredProject=createProject('路径恢复');restoredProject.assets=[asset];const restored=await store.create({project:restoredProject,assetFiles:[{path:asset.path!,localPath:proxy},{path:asset.originalPath!,localPath:join(created.root,asset.originalPath!)}]});
    assert.deepEqual(await readFile(join(restored.root,asset.path!)),await readFile(proxy));
    assert.deepEqual(await readFile(join(restored.root,asset.originalPath!)),await readFile(input));
    const retained=await readdir(join(created.root,'assets'));await assert.rejects(store.importAsset(created.root,{path:input},{...env,maxVideoBytes:1}),/大小限制/);assert.deepEqual(await readdir(join(created.root,'assets')),retained);
    await assert.rejects(store.importAsset(created.root,{path:input},{...env,maxVideoBytes:MAX_VIDEO_BYTES+1}),/512 MiB/);
    const aborted=new AbortController();aborted.abort();await assert.rejects(store.importAsset(created.root,{path:input},env,aborted.signal));
  }finally{await rm(directory,{recursive:true,force:true});}
});
