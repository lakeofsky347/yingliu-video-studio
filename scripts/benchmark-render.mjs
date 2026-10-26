import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createProject,defaultSceneSource} from '../src/core/index.ts';
import {ProjectStore} from '../src/host/store.ts';

const exec=promisify(execFile);
const option=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
const rendererRoot=path.resolve(option('renderer-root')??path.join(import.meta.dirname,'..'));
const {VideoRenderer,detectEnvironment}=await import(pathToFileURL(path.join(rendererRoot,'src/host/renderer.ts')).href),env=detectEnvironment();
const frames=Number(option('frames')??60),label=option('label')??'current';
assert.ok(Number.isSafeInteger(frames)&&frames>=6&&frames<=600,'--frames must be between 6 and 600');
assert.ok(env.browserAvailable&&env.ffmpegAvailable&&env.ffprobeAvailable,'Chromium, FFmpeg and FFprobe are required');
const output=path.resolve(option('output')??'artifacts/render-benchmark/'+label+'.json');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'video-render-benchmark-'));
const cases=[];
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
async function pixelHash(file){
  const {stdout}=await exec(env.ffmpegPath,['-v','error','-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{encoding:'buffer',maxBuffer:40*1024*1024});
  return createHash('sha256').update(stdout).digest('hex');
}
// Sample only this process and its descendants; RSS includes shared pages and is an approximate peak.
async function treeRss(){
  if(process.platform==='win32')return null;
  const {stdout}=await exec('ps',['-axo','pid=,ppid=,rss=,comm=']);
  const rows=stdout.trim().split('\n').map(line=>{const [,pid,parent,rss,command]=/\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)/.exec(line);return [Number(pid),Number(parent),Number(rss),command];}),ids=new Set([process.pid]);
  for(let count=-1;count!==ids.size;){count=ids.size;for(const [pid,parent] of rows)if(ids.has(parent))ids.add(pid);}
  const processes=rows.filter(([pid])=>ids.has(pid)).map(([pid,,rss,command])=>({pid,rssMiB:rss/1024,command}));
  return {rssMiB:processes.reduce((sum,item)=>sum+item.rssMiB,0),processes};
}
try{
  const fixture=path.join(directory,'fixture.png');
  await exec(env.ffmpegPath,['-v','error','-f','lavfi','-i','testsrc2=size=640x360:duration=1','-frames:v','1','-y',fixture]);
  for(const [width,height] of [[1280,720],[1920,1080]]){
    const store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
    let sampling,peakRssMiB=null,peakProcesses=[];
    const timer=setInterval(()=>{if(!sampling)sampling=treeRss().then(value=>{if(value!==null&&value.rssMiB>(peakRssMiB??0)){peakRssMiB=value.rssMiB;peakProcesses=value.processes;}}).catch(()=>{}).finally(()=>{sampling=undefined;});},250);
    try{
      let project=createProject('渲染性能基准');project.id='render-benchmark-'+width;project.shots=project.shots.slice(0,2);
      project.shots.forEach((shot,index)=>{shot.id='benchmark-'+index;shot.sourcePath='shots/'+shot.id;shot.durationFrames=index===0?Math.floor(frames/2):frames-Math.floor(frames/2);shot.params.text='渲染性能 · '+width+' × '+height;shot.params.subtitle='中文排版、图片、Canvas、淡入与逆序跳帧';shot.params.motion='slide';});
      project.shotOrder=project.shots.map(shot=>shot.id);project.target={width,height,fps:{num:30,den:1},audioMode:'none',quality:'standard'};project.targetDuration=frames/30;
      const created=await store.create(project),asset=await store.importAsset(created.root,{path:fixture},env);
      project=created.project;project.assets.push(asset);project.shots.forEach(shot=>shot.assetIds.push(asset.id));project.revision++;
      const source=defaultSceneSource();
      const canvas={...source,js:source.js+`\nconst baseRender=render;export {draw as render};function draw(ctx){baseRender(ctx);const g=ctx.ctx2d;for(let i=0;i<160;i++){g.fillStyle='hsl('+((i*17+ctx.localFrame*3)%360)+' 65% 60% / 0.5)';g.fillRect((i*79+ctx.localFrame*11)%ctx.width,(i*53)%ctx.height,18,18);}}`};
      // Replace the named export before adding the wrapper, preserving the default scene's DOM and image work.
      canvas.js=canvas.js.replace('export function render(ctx)','function render(ctx)');
      project=await store.commit(created.root,project,{[project.shots[0].id]:source,[project.shots[1].id]:canvas});
      const timings=[];const original=renderer.frame.bind(renderer);
      renderer.frame=async(...args)=>{const start=performance.now();const result=await original(...args);timings.push(performance.now()-start);return result;};
      const start=performance.now();let capturedAt;
      const result=await renderer.export(created.root,project,env,new AbortController().signal,progress=>{if(progress>=.88&&capturedAt===undefined)capturedAt=performance.now()-start;});
      const elapsedMs=performance.now()-start;
      clearInterval(timer);await sampling;
      assert.equal(result.qa.status,'PASS');assert.equal(result.qa.arbitrarySeek,'PASS');assert.equal(result.qa.coldReload,'PASS');
      const framePixels=[];for(const frame of result.qa.frames)framePixels.push({frame:frame.frame,sha256:await pixelHash(frame.path)});
      const sample={width,height,frames,elapsedMs,capturedAtMs:capturedAt,exportFps:frames/(elapsedMs/1000),captureMeanMs:timings.reduce((a,b)=>a+b,0)/timings.length,captureP50Ms:percentile(timings,.5),captureP95Ms:percentile(timings,.95),peakTreeRssMiB:peakRssMiB,peakProcesses,mp4Bytes:(await fs.stat(result.path)).size,qa:result.qa.status,framePixels};
      cases.push(sample);console.log(JSON.stringify({label,width,height,frames,elapsedMs,exportFps:sample.exportFps,captureMeanMs:sample.captureMeanMs,peakTreeRssMiB:peakRssMiB,qa:sample.qa}));
    }finally{clearInterval(timer);await sampling;await renderer.close();}
  }
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,JSON.stringify({label,rendererRoot,createdAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,environment:env,cases},null,2)+'\n');
  console.log('Saved '+output);
}finally{await fs.rm(directory,{recursive:true,force:true});}
