import {createCodeProject as createProject} from './fixtures/production.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectStore, projectPath } from '../src/host/store.js';
import { VideoRenderer, detectEnvironment } from '../src/host/renderer.js';
import {  defaultSceneSource } from '../src/core/index.js';
import {createTestSymlink} from './fixtures/symlink.js';

test('project, image/text references and scene sources persist without an in-memory cache',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-studio-store-'));
  try{
    const store=new ProjectStore({baseDirectory:directory}),created=await store.create({title:'存储回读',topic:'中文说明'}),shot=created.project.shots[0]!;
    const asset=await store.importImageOrText(created.root,{text:'正文素材',name:'说明'});
    created.project.assets.push(asset);created.project.shots[0]!.assetIds.push(asset.id);
    created.project.revision++;created.project=await store.commit(created.root,created.project);
    const freshStore=new ProjectStore({baseDirectory:directory}),reopened=await freshStore.open(created.root);
    assert.equal(reopened.assets[0]!.text,'正文素材');assert.equal(reopened.shots[0]!.assetIds[0],asset.id);
    assert.equal((await freshStore.recent())[0]!.title,'存储回读');
    const original=await store.readSource(created.root,shot);await store.markSourceGood(created.root,shot);
    created.project.revision++;created.project=await store.commit(created.root,created.project,{[shot.id]:{...original,js:'export function render(){throw new Error("broken")}'}});
    const restored=await store.restorationSource(created.root,shot);assert.deepEqual(restored,original);created.project.revision++;created.project=await store.commit(created.root,created.project,{[shot.id]:restored});
    // Committed versions are authoritative; direct projection edits are repaired on reopen.
    await fs.appendFile(path.join(created.root,shot.sourcePath,'scene.js'),'\n// edited outside plugin');
    assert.doesNotMatch((await freshStore.readSource(created.root,shot)).js,/edited outside plugin/);
    await freshStore.open(created.root);assert.equal(await fs.readFile(path.join(created.root,shot.sourcePath,'scene.js'),'utf8'),original.js);
    await assert.rejects(projectPath(created.root,'../outside.txt'),/Invalid/);
    await assert.rejects(store.importImageOrText(created.root,{dataBase64:Buffer.from('GIF89a').toString('base64'),mime:'image/gif'}),/Only PNG/);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('project paths reject a real directory symlink outside the project',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-studio-link-'));
  try{
    const created=await new ProjectStore({baseDirectory:directory}).create({title:'真实链接边界'});
    if(!await createTestSymlink(t,directory,path.join(created.root,'link'),'dir'))return;
    await assert.rejects(projectPath(created.root,'link/recent.json'),/Symlink/);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

const env=detectEnvironment();
test('real Chrome + FFmpeg export: image/text, horizontal/vertical frames, Range serving, replay and failure attribution',{skip:env.browserAvailable&&env.ffmpegAvailable&&env.ffprobeAvailable?false:'Real media test requires executable Chromium, FFmpeg and ffprobe; export behavior was not verified.'},async()=>{
  const parent=process.env.VIDEO_STUDIO_TEST_ARTIFACTS?path.resolve(process.env.VIDEO_STUDIO_TEST_ARTIFACTS):await fs.mkdtemp(path.join(os.tmpdir(),'dsh-studio-render-'));
  await fs.mkdir(parent,{recursive:true});const store=new ProjectStore({baseDirectory:parent}),renderer=new VideoRenderer(store);
  try{
    const {stdout:image}=await promisify(execFile)(env.ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=64x64:d=0.1','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],{encoding:'buffer',maxBuffer:1_000_000});
    const results=[];
    for(const portrait of [false,true]){
      let project=createProject(portrait?'竖屏渲染验收':'横屏渲染验收');project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);
      project.shots[0]!.durationFrames=12;project.shots[0]!.params.text=portrait?'竖屏测试':'横屏测试';project.shots[0]!.params.subtitle='真实图像 + 可编辑文案';
      project.target={width:portrait?180:320,height:portrait?320:180,fps:{num:12,den:1},audioMode:'none'};project.targetDuration=1;
      const created=await store.create(project),asset=await store.importImageOrText(created.root,{dataBase64:image.toString('base64'),mime:'image/png',name:'红色图像'});
      project.assets.push(asset);project.shots[0]!.assetIds.push(asset.id);project.revision++;project=await store.commit(created.root,project);
      const preview=await renderer.preview(created.root,project);assert.equal((await fetch(preview)).status,200);
      const check=await renderer.check(created.root,project,env);assert.equal(check.ok,true,JSON.stringify(check.errors));assert.equal(check.frames.length,3);
      const output=await renderer.export(created.root,project,env,new AbortController().signal,()=>{});
      assert.equal(output.frameCount,12);assert.equal(output.duration,1);assert.equal(output.qa?.status,'PASS');assert.equal(output.qa?.coldReload,'PASS');
      const range=await fetch(output.url!,{headers:{Range:'bytes=0-63'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,64);assert.match(range.headers.get('content-range')!,/^bytes 0-63\//);
      const suffix=await fetch(output.url!,{headers:{Range:'bytes=-16'}});assert.equal(suffix.status,206);assert.equal((await suffix.arrayBuffer()).byteLength,16);
      const invalid=await fetch(output.url!,{headers:{Range:'bytes=0-1,4-6'}});assert.equal(invalid.status,416);
      const backup=await store.readSource(created.root,project.shots[0]!);
      project.revision++;project=await store.commit(created.root,project,{[project.shots[0]!.id]:{...backup,js:'export function render(ctx) { throw new Error("test-scene-error"); }'}});
      const failed=await renderer.check(created.root,project,env);assert.equal(failed.ok,false);assert.ok(failed.errors.some(issue=>issue.shotId===project.shots[0]!.id&&issue.message.includes('test-scene-error')));
      const restore=await store.restorationSource(created.root,project.shots[0]!);project.revision++;project=await store.commit(created.root,project,{[project.shots[0]!.id]:restore});assert.deepEqual(await store.readSource(created.root,project.shots[0]!),backup);
      results.push({orientation:portrait?'portrait':'landscape',root:created.root,preview,check,output,failure:failed.errors});
    }
    // Cancellation must close only this task's browser/encoder, remove the partial MP4 and preserve its snapshot/log.
    const cancelledProject=createProject('取消导出');cancelledProject.shots=cancelledProject.shots.slice(0,1);cancelledProject.shotOrder=cancelledProject.shots.map(shot=>shot.id);cancelledProject.shots[0]!.durationFrames=24;cancelledProject.target={width:320,height:180,fps:{num:12,den:1},audioMode:'none'};cancelledProject.targetDuration=2;
    const cancelled=await store.create(cancelledProject),abort=new AbortController();
    await assert.rejects(renderer.export(cancelled.root,cancelledProject,env,abort.signal,progress=>{if(progress>=0.1)abort.abort();}),/cancelled/);
    const exports=await fs.readdir(path.join(cancelled.root,'exports'));const failure=JSON.parse(await fs.readFile(path.join(cancelled.root,'exports',exports[0]!,'failure.json'),'utf8'));
    assert.equal(failure.status,'cancelled');await assert.rejects(fs.stat(path.join(cancelled.root,'exports',exports[0]!,'video.mp4')));
    await fs.writeFile(path.join(parent,'renderer-acceptance.json'),JSON.stringify({status:'PASS',environment:env,results,cancellation:{status:failure.status,root:cancelled.root}},null,2)+'\n');
  }finally{await renderer.close();if(!process.env.VIDEO_STUDIO_TEST_ARTIFACTS)await fs.rm(parent,{recursive:true,force:true});}
});

test('environment detection is explicit and never installs tools',()=>{
  const info=detectEnvironment({browserPath:'/missing/browser',ffmpegPath:'/missing/ffmpeg',ffprobePath:'/missing/ffprobe'});
  assert.equal(info.browserAvailable,false);assert.equal(info.ffmpegAvailable,false);assert.equal(info.ffprobeAvailable,false);
});
