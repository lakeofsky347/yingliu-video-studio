import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Asset, EnvironmentInfo, EnvironmentSettings, ExportResult, SceneSource, VideoProject, VideoSpec } from '../shared/types.js';
import { compileSpec } from '../core/index.js';
import {hashMediaFile} from '../media/video.js';
import { ProjectStore, projectPath } from './store.js';
import { browserRuntime, runtimeHtml } from '../runtime/browser.js';
import {AudioMixer, type AudioMix} from './audio.js';
import {inspectToolEnvironment, type ToolEnvironmentOptions} from './tool-environment.js';

export interface FrameCapture { frame:number; shotId:string; path:string; sha256:string }
export interface RenderIssue { shotId?:string; frame?:number; message:string }
export interface RenderCheckResult { ok:boolean; errors:RenderIssue[]; frames:FrameCapture[]; reportPath?:string }
interface ProjectServer { server:Server; origin:string; root:string }
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.txt':'text/plain; charset=utf-8','.woff2':'font/woff2','.mp4':'video/mp4','.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.flac':'audio/flac','.ogg':'audio/ogg'};

export function detectEnvironment(settings:Partial<EnvironmentSettings>={},options:ToolEnvironmentOptions={}):EnvironmentInfo {
  return inspectToolEnvironment(settings,options);
}
function hash(buffer:Buffer|string):string { return createHash('sha256').update(buffer).digest('hex'); }
function json(value:unknown):string { return JSON.stringify(value,null,2)+'\n'; }
function aborted(signal?:AbortSignal):void { if(signal?.aborted)throw new Error('Task cancelled'); }
function keyFrames(spec:VideoSpec):number[] { return [...new Set(spec.shots.flatMap(shot=>[shot.startFrame,Math.floor((shot.startFrame+shot.endFrame-1)/2),shot.endFrame-1]))].sort((a,b)=>a-b); }
function safeId(id:string):string { if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('Unsafe scene ID');return id; }
async function deadline<T>(promise:Promise<T>,message:string):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message+' (30 s timeout)')),30_000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
/** Only call for a child spawned by this renderer. EOF also releases FFmpeg's blocking pipe read. */
function stopChild(child:ChildProcess):void {
  if(child.exitCode!==null||child.signalCode!==null)return;
  child.stdin?.destroy();child.kill('SIGTERM');
  const fallback=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1500);
  fallback.unref();child.once('close',()=>clearTimeout(fallback));
}

async function projectServer(root:string):Promise<ProjectServer> {
  const absoluteRoot=path.resolve(root);
  const server=createServer(async(req,res)=>{
    try {
      if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405);res.end();return;}
      // A loopback listener is insufficient if a foreign website can send a forged Host header.
      const host=req.headers.host??'';
      if(!/^127\.0\.0\.1:\d+$/.test(host)){res.writeHead(403);res.end();return;}
      const pathname=decodeURIComponent(new URL(req.url??'/','http://'+host).pathname);
      const relative=pathname.replace(/^\//,'')||'index.html';
      const full=await projectPath(absoluteRoot,relative),type=mime[path.extname(full).toLowerCase()];
      if(!type){res.writeHead(415);res.end('Unsupported file type');return;}
      const stat=await fs.stat(full);if(!stat.isFile())throw new Error('File expected');
      const headers:Record<string,string|number>={'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"};
      const media=type==='video/mp4'||type.startsWith('audio/');if(media)headers['Accept-Ranges']='bytes';
      let start=0,end=stat.size-1,status=200;
      if(req.headers.range&&media){
        const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if(!range||(!range[1]&&!range[2])){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});res.end();return;}
        if(!range[1]){const suffix=Number(range[2]);start=Math.max(0,stat.size-suffix);}
        else{start=Number(range[1]);if(range[2])end=Math.min(Number(range[2]),stat.size-1);}
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});res.end();return;}
        status=206;headers['Content-Range']='bytes '+start+'-'+end+'/'+stat.size;
      }
      headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);
      if(req.method==='HEAD'){res.end();return;}
      const file=await fs.open(full,'r');
      const stream=file.createReadStream({start,end,autoClose:true});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
    }catch { if(!res.headersSent)res.writeHead(404);res.end('Not found'); }
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Unable to bind preview server');
  return {root:absoluteRoot,server,origin:'http://127.0.0.1:'+address.port};
}
async function closeServer(server:Server):Promise<void> {
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
}

export class VideoRenderer {
  private servers=new Map<string,ProjectServer>();
  private pendingServers=new Map<string,Promise<ProjectServer>>();
  private browsers=new Set<Browser>();
  private children=new Set<ChildProcess>();
  private audioMixer=new AudioMixer();
  private readonly store:ProjectStore;
  constructor(store:ProjectStore=new ProjectStore()) { this.store=store; }
  async preview(root:string,project:VideoProject):Promise<string> {
    await this.prepare(root,project);
    const server=await this.server(root);return server.origin+'/index.html?revision='+project.revision;
  }
  async assetBaseUrl(root:string):Promise<string> {return (await this.server(root)).origin+'/';}
  async assetUrl(root:string,asset:Asset):Promise<string> {
    if(!asset.path)return '';await projectPath(root,asset.path);
    return (await this.server(root)).origin+'/'+asset.path.split('/').map(encodeURIComponent).join('/');
  }
  async audioPreview(root:string,project:VideoProject,settings:EnvironmentSettings,signal?:AbortSignal):Promise<string|null>{
    const mix=await this.audioMixer.mix(root,project,settings,signal);if(!mix)return null;
    const relative=path.relative(root,mix.path).split(path.sep).map(encodeURIComponent).join('/');
    return (await this.server(root)).origin+'/'+relative+'?revision='+project.revision;
  }
  private async server(root:string):Promise<ProjectServer> {
    const key=path.resolve(root),existing=this.servers.get(key);if(existing)return existing;
    let pending=this.pendingServers.get(key);
    if(!pending){pending=projectServer(key);this.pendingServers.set(key,pending);}
    try{const server=await pending;this.servers.set(key,server);return server;}
    finally{if(this.pendingServers.get(key)===pending)this.pendingServers.delete(key);}
  }
  private async prepare(root:string,project:VideoProject):Promise<VideoSpec> {
    const spec=compileSpec(project);const sources:{id:string;html:string;css:string;moduleUrl:string}[]=[];
    await fs.mkdir(await projectPath(root,'runtime/scenes'),{recursive:true});
    for(const shot of spec.shots){
      try{
        const source=await this.store.readSource(root,shot,project.revision);safeId(shot.id);
        // ESM modules are files served under a restrictive self-only CSP; no privileged APIs are exposed.
        await fs.writeFile(await projectPath(root,'runtime/scenes/'+shot.id+'.mjs'),source.js);
        sources.push({id:shot.id,html:source.html,css:source.css,moduleUrl:'./scenes/'+shot.id+'.mjs'});
      }catch(error){const e=error as Error&RenderIssue;e.shotId=shot.id;throw e;}
    }
    await fs.writeFile(await projectPath(root,'runtime/frame.mjs'),browserRuntime);
    await fs.writeFile(await projectPath(root,'runtime/spec.json'),json({spec,sources}));
    await fs.writeFile(await projectPath(root,'index.html'),runtimeHtml(spec.target.width,spec.target.height));
    return spec;
  }
  private async openPage(url:string,spec:VideoSpec,settings:EnvironmentSettings,issues:RenderIssue[],signal?:AbortSignal):Promise<{browser:Browser;page:Page;removeAbort:()=>void}> {
    aborted(signal);const env=detectEnvironment(settings);if(!env.browserAvailable)throw new Error('Chrome/Chromium unavailable. Set browserPath in environment settings.');
    await fs.access(env.browserPath,constants.X_OK);
    // 逐帧契约要求同一帧可复现：GPU 光栅的 2D canvas 在不同页面状态下会出现 ±1 的采样差异，
    // 会让逆序 seek / 冷启动的字节比对偶发失败。固定用 Skia 软件光栅画 2D canvas，
    // 合成与 WebGL 仍走原路径，渲染结果与截图因此稳定可复现。
    const browser=await chromium.launch({executablePath:env.browserPath,headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-accelerated-2d-canvas','--disable-accelerated-video-decode']});this.browsers.add(browser);
    const cancel=()=>{void browser.close().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
    try {
      const context=await browser.newContext({viewport:{width:spec.target.width,height:spec.target.height},deviceScaleFactor:1,serviceWorkers:'block'});
      const origin=new URL(url).origin;
      await context.route('**/*',async route=>{
        const request=new URL(route.request().url());
        if(request.origin===origin||request.protocol==='data:'||request.protocol==='blob:')await route.continue();
        else{issues.push({message:'Blocked external resource: '+request.origin+request.pathname});await route.abort('blockedbyclient');}
      });
      await context.routeWebSocket('**/*',async socket=>{issues.push({message:'Blocked WebSocket: '+socket.url().split('?')[0]});await socket.close();});
      const page=await context.newPage();page.setDefaultTimeout(30_000);
      page.on('pageerror',error=>issues.push({message:error.message}));
      page.on('console',message=>{if(message.type()==='error')issues.push({message:message.text()});});
      page.on('response',response=>{if(response.status()>=400)issues.push({message:'HTTP '+response.status()+': '+new URL(response.url()).pathname});});
      await page.goto(url,{waitUntil:'load',timeout:30_000});
      await page.waitForFunction(()=>!!(window as any).__VIDEO_WORKPACK__);
      const ready=await deadline(page.evaluate(async()=>{
        try{await (window as any).__VIDEO_WORKPACK__.ready();return {ok:true};}
        catch(error){const e=error as any;return {ok:false,message:e.message,shotId:e.shotId};}
      }),'Scene ready');
      if(!ready.ok){issues.push({shotId:ready.shotId,message:ready.message??'Renderer ready failed'});throw new Error(ready.message);}
      return {browser,page,removeAbort:()=>signal?.removeEventListener('abort',cancel)};
    }catch(error){signal?.removeEventListener('abort',cancel);await browser.close().catch(()=>{});this.browsers.delete(browser);throw error;}
  }
  private async frame(page:Page,spec:VideoSpec,frame:number):Promise<{buffer:Buffer;shotId:string}> {
    const result=await deadline(page.evaluate(async input=>{
      try{
        const info=await (window as any).__VIDEO_WORKPACK__.renderFrame(input);
        await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
        return {ok:true,info};
      }catch(error){const e=error as any;return {ok:false,message:e.message,shotId:e.shotId,frame:e.frame};}
    },{frame,fps:spec.target.fps}),'Frame '+frame);
    if(!result.ok){const error=new Error(result.message) as Error&RenderIssue;error.shotId=result.shotId;error.frame=result.frame;throw error;}
    return {buffer:await page.screenshot({type:'png',clip:{x:0,y:0,width:spec.target.width,height:spec.target.height},timeout:30_000}),shotId:result.info.sceneId};
  }
  async capture(root:string,project:VideoProject,settings:EnvironmentSettings,frame:number,signal?:AbortSignal):Promise<FrameCapture&{url:string}>{
    const spec=await this.prepare(root,project),errors:RenderIssue[]=[];aborted(signal);
    if(!Number.isSafeInteger(frame)||frame<0||frame>=spec.durationFrames)throw new Error('Frame outside project: '+frame);
    let connection:Awaited<ReturnType<VideoRenderer['openPage']>>|undefined;
    try{
      const server=await this.server(root);connection=await this.openPage(server.origin+'/index.html',spec,settings,errors,signal);
      const result=await this.frame(connection.page,spec,frame);aborted(signal);
      if(errors.length)throw new Error(errors.map(error=>error.message).join('; '));
      const relative='.studio/inspection/'+project.revision+'-'+frame+'-'+randomUUID()+'.png',file=await projectPath(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,result.buffer);
      return {frame,shotId:result.shotId,path:file,sha256:hash(result.buffer),url:server.origin+'/'+relative};
    }finally{if(connection){connection.removeAbort();await connection.browser.close().catch(()=>{});this.browsers.delete(connection.browser);}}
  }
  /** Render an immutable candidate without writing the live project or its runtime. */
  async captureCandidate(root:string,project:VideoProject,sources:Record<string,SceneSource>,settings:EnvironmentSettings,frame:number,signal?:AbortSignal):Promise<{bytes:Uint8Array;mime:string;sha256:string}>{
    aborted(signal);const snapshotRoot=await fs.mkdtemp(path.join(os.tmpdir(),'video-studio-candidate-'));
    const renderer=new VideoRenderer(),snapshot=structuredClone(project);snapshot.outputs=[];
    try{
      for(const asset of snapshot.assets)delete asset.originalPath;
      await fs.writeFile(path.join(snapshotRoot,'project.json'),json(snapshot));
      for(const asset of snapshot.assets)if(asset.path){
        aborted(signal);const input=await projectPath(root,asset.path),output=await projectPath(snapshotRoot,asset.path);
        await fs.mkdir(path.dirname(output),{recursive:true});await fs.copyFile(input,output);
      }
      for(const shot of snapshot.shots){
        aborted(signal);const source=sources[shot.id]??await this.store.readSource(root,shot,project.revision);
        await this.store.writeSource(snapshotRoot,shot,source);
      }
      const capture=await renderer.capture(snapshotRoot,snapshot,settings,frame,signal);
      return {bytes:await fs.readFile(capture.path),mime:'image/png',sha256:capture.sha256};
    }finally{await renderer.close();await fs.rm(snapshotRoot,{recursive:true,force:true});}
  }
  async check(root:string,project:VideoProject,settings:EnvironmentSettings,signal?:AbortSignal):Promise<RenderCheckResult> {
    const errors:RenderIssue[]=[],frames:FrameCapture[]=[];let connection:Awaited<ReturnType<VideoRenderer['openPage']>>|undefined;
    const reportRoot=await projectPath(root,'validation/check-'+randomUUID());await fs.mkdir(reportRoot,{recursive:true});
    try {
      const spec=await this.prepare(root,project),url=(await this.server(root)).origin+'/index.html';
      connection=await this.openPage(url,spec,settings,errors,signal);
      for(const frame of keyFrames(spec)){
        aborted(signal);const result=await this.frame(connection.page,spec,frame);
        const file=path.join(reportRoot,String(frame).padStart(6,'0')+'.png');await fs.writeFile(file,result.buffer);
        frames.push({frame,shotId:result.shotId,path:file,sha256:hash(result.buffer)});
      }
      await this.verifySeek(connection.page,spec,frames,errors,signal);
      if(errors.length===0)for(const shot of project.shots)await this.store.markSourceGood(root,shot);
    }catch(error){const e=error as Error&RenderIssue;errors.push({shotId:e.shotId,frame:e.frame,message:signal?.aborted?'Task cancelled':e.message});}
    finally{if(connection){connection.removeAbort();await connection.browser.close().catch(()=>{});this.browsers.delete(connection.browser);}}
    const reportPath=path.join(reportRoot,'check.json');const result={ok:errors.length===0,errors:deduplicate(errors),frames,reportPath};
    await fs.writeFile(reportPath,json(result));return result;
  }
  private async verifySeek(page:Page,spec:VideoSpec,frames:FrameCapture[],errors:RenderIssue[],signal?:AbortSignal):Promise<void> {
    const expected=new Map(frames.map(frame=>[frame.frame,frame.sha256]));
    for(const frame of [...expected.keys()].reverse()){
      aborted(signal);const result=await this.frame(page,spec,frame);
      if(hash(result.buffer)!==expected.get(frame))errors.push({shotId:result.shotId,frame,message:'Frame is not repeatable after seeking backwards'});
    }
    await page.reload({waitUntil:'load'});await page.waitForFunction(()=>!!(window as any).__VIDEO_WORKPACK__);await deadline(page.evaluate(()=>(window as any).__VIDEO_WORKPACK__.ready()),'Cold scene ready');
    for(const frame of expected.keys()){
      aborted(signal);const result=await this.frame(page,spec,frame);
      if(hash(result.buffer)!==expected.get(frame))errors.push({shotId:result.shotId,frame,message:'Frame is not repeatable after a cold page reload'});
    }
  }
  async export(root:string,project:VideoProject,settings:EnvironmentSettings,signal:AbortSignal,onProgress:(progress:number,message:string)=>void):Promise<ExportResult> {
    aborted(signal);const env=detectEnvironment(settings);
    if(!env.browserAvailable||!env.ffmpegAvailable||!env.ffprobeAvailable)throw new Error('Export needs existing Chrome/Chromium, FFmpeg and FFprobe. Configure missing paths.');
    const id=randomUUID(),outputRoot=await projectPath(root,'exports/'+id),snapshotRoot=path.join(outputRoot,'snapshot');
    await fs.mkdir(snapshotRoot,{recursive:true});
    const snapshot=structuredClone(project);snapshot.outputs=[];
    // Rendering consumes the CFR proxy; keep source provenance without duplicating unused originals.
    for(const asset of snapshot.assets)delete asset.originalPath;
    await fs.writeFile(path.join(snapshotRoot,'project.json'),json(snapshot));
    const inputHashes:{path:string;sha256:string}[]=[];
    for(const asset of snapshot.assets)if(asset.path){
      const source=await projectPath(root,asset.path),destination=await projectPath(snapshotRoot,asset.path);await fs.mkdir(path.dirname(destination),{recursive:true});
      await fs.copyFile(source,destination);inputHashes.push({path:asset.path,sha256:await hashMediaFile(destination,signal)});
    }
    for(const shot of snapshot.shots){
      const source=await this.store.readSource(root,shot,project.revision);await this.store.writeSource(snapshotRoot,shot,source);
      inputHashes.push({path:shot.sourcePath+'/source.json',sha256:hash(json(source))});
    }
    const spec=await this.prepare(snapshotRoot,snapshot),errors:RenderIssue[]=[],frames:FrameCapture[]=[];
    if(spec.target.width%2||spec.target.height%2)throw new Error('H.264 yuv420p requires even width and height');
    const snapshotServer=await projectServer(snapshotRoot);let connection:Awaited<ReturnType<VideoRenderer['openPage']>>|undefined,encoder:ChildProcess|undefined;
    const mp4Path=path.join(outputRoot,'video.mp4'),logPath=path.join(outputRoot,'ffmpeg.log');let log='',audioMix:AudioMix|null=null;
    const cancel=()=>{if(encoder)stopChild(encoder);};signal.addEventListener('abort',cancel,{once:true});
    let encoderResult:Promise<void>|undefined;
    try {
      onProgress(0.03,'制作输入已保存快照');audioMix=await this.audioMixer.mix(snapshotRoot,snapshot,env,signal);
      if(audioMix){await fs.writeFile(path.join(outputRoot,'audio-plan.json'),json(audioMix.plan));onProgress(.06,'配音、音乐与音效已完成混音');}
      connection=await this.openPage(snapshotServer.origin+'/index.html',spec,env,errors,signal);
      const audioArgs=audioMix?['-i',audioMix.path,'-map','0:v:0','-map','1:a:0','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-t',String(spec.durationSeconds)]:['-an'];
      const crf=spec.target.quality==='high'?'16':spec.target.quality==='small'?'23':'18';
      encoder=spawn(env.ffmpegPath,['-hide_banner','-loglevel','warning','-y','-f','image2pipe','-vcodec','png','-framerate',spec.target.fps.num+'/'+spec.target.fps.den,'-i','pipe:0',...audioArgs,'-c:v','libx264','-preset','medium','-crf',crf,'-pix_fmt','yuv420p','-movflags','+faststart',mp4Path],{stdio:['pipe','ignore','pipe']});this.children.add(encoder);
      encoder.stderr?.on('data',chunk=>{log+=String(chunk);if(log.length>2_000_000)log=log.slice(-2_000_000);});
      encoder.stdin?.on('error',()=>{});
      encoderResult=new Promise<void>((resolve,reject)=>{
        encoder!.once('error',reject);encoder!.once('close',code=>{this.children.delete(encoder!);code===0?resolve():reject(new Error('FFmpeg exited '+code+': '+log.slice(-1600)));});
      });
      // Attach a handler immediately; a failed encoder must not become an unhandled rejection during capture.
      void encoderResult.catch(()=>{});
      const keys=new Set(keyFrames(spec));
      for(let frame=0;frame<spec.durationFrames;frame++){
        aborted(signal);const capture=await this.frame(connection.page,spec,frame);
        if(errors.length)throw new Error('Browser reported errors: '+errors.map(error=>error.message).join('; '));
        if(keys.has(frame)){
          const file=path.join(outputRoot,String(frame).padStart(6,'0')+'.png');await fs.writeFile(file,capture.buffer);
          frames.push({frame,shotId:capture.shotId,path:file,sha256:hash(capture.buffer)});
        }
        await new Promise<void>((resolve,reject)=>{
          if(!encoder?.stdin||encoder.stdin.destroyed){reject(new Error('FFmpeg input closed'));return;}
          encoder.stdin.write(capture.buffer,error=>error?reject(error):resolve());
        });
        if(frame===0||frame===spec.durationFrames-1||frame%Math.max(1,Math.floor(spec.durationFrames/50))===0)onProgress(0.08+0.8*(frame+1)/spec.durationFrames,'捕获帧 '+(frame+1)+' / '+spec.durationFrames);
      }
      encoder.stdin?.end();await encoderResult;await fs.writeFile(logPath,log);
      await this.verifySeek(connection.page,spec,frames,errors,signal);if(errors.length)throw new Error(errors.map(error=>error.message).join('; '));
      onProgress(0.94,'核对视频规格、帧数与音轨');const qa=await this.mediaQa(mp4Path,spec,env,signal,!!audioMix);
      const result:ExportResult={id,path:mp4Path,url:undefined,createdAt:new Date().toISOString(),revision:project.revision,width:spec.target.width,height:spec.target.height,frameCount:spec.durationFrames,duration:spec.durationSeconds,qa:{...qa,silent:!audioMix,quality:spec.target.quality??'standard',crf:Number(crf),audioPlan:audioMix?.plan,arbitrarySeek:'PASS',coldReload:'PASS',inputHashes,frames,browser:connection.browser.version(),snapshotRoot,logPath}};
      await fs.writeFile(path.join(outputRoot,'result.json'),json(result));
      result.url=(await this.server(root)).origin+'/exports/'+id+'/video.mp4';onProgress(1,'视频导出完成');return result;
    }catch(error){
      if(encoder)stopChild(encoder);await encoderResult?.catch(()=>{});
      await fs.writeFile(logPath,log);await fs.writeFile(path.join(outputRoot,'failure.json'),json({status:signal.aborted?'cancelled':'failed',message:(error as Error).message,errors:deduplicate(errors),frames,inputHashes,snapshotRoot}));
      await fs.rm(mp4Path,{force:true});throw new Error(signal.aborted?'Task cancelled':(error as Error).message);
    }finally{
      signal.removeEventListener('abort',cancel);if(connection){connection.removeAbort();await connection.browser.close().catch(()=>{});this.browsers.delete(connection.browser);}
      await closeServer(snapshotServer.server);
    }
  }
  private async mediaQa(file:string,spec:VideoSpec,settings:EnvironmentSettings,signal:AbortSignal,expectedAudio=false):Promise<Record<string,unknown>> {
    const output=await this.command(settings.ffprobePath,['-v','error','-count_frames','-show_entries','stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames,duration,start_time,sample_rate,channels:format=duration','-of','json',file],signal);
    const parsed=JSON.parse(output),stream=parsed.streams?.find((item:{codec_type:string})=>item.codec_type==='video');
    const audios=parsed.streams?.filter((item:{codec_type:string})=>item.codec_type==='audio')??[];
    if(audios.length!==(expectedAudio?1:0))throw new Error('FFprobe audio stream count mismatch');
    if(expectedAudio&&(audios[0].codec_name!=='aac'||audios[0].channels!==2||Number(audios[0].sample_rate)!==48000||Math.abs(Number(audios[0].start_time??0))>.025||Math.abs(Number(audios[0].duration)-spec.durationSeconds)>Math.max(.05,1/(spec.target.fps.num/spec.target.fps.den))))throw new Error('FFprobe audio codec, duration or synchronization mismatch: '+JSON.stringify({actual:{codec:audios[0].codec_name,channels:audios[0].channels,sampleRate:audios[0].sample_rate,startTime:audios[0].start_time,duration:audios[0].duration},expected:{codec:'aac',channels:2,sampleRate:48000,startTime:0,duration:spec.durationSeconds},tolerance:{startTime:.025,duration:Math.max(.05,1/(spec.target.fps.num/spec.target.fps.den))}}));
    if(!stream||stream.codec_name!=='h264'||stream.pix_fmt!=='yuv420p'||stream.width!==spec.target.width||stream.height!==spec.target.height||Number(stream.nb_read_frames)!==spec.durationFrames)throw new Error('FFprobe video dimensions, codec, pixel format or frame count mismatch');
    const [num,den]=String(stream.r_frame_rate).split('/').map(Number),actualFps=num/den,expectedFps=spec.target.fps.num/spec.target.fps.den;
    const duration=Number(stream.duration??parsed.format?.duration);
    if(Math.abs(actualFps-expectedFps)>0.0001||Math.abs(duration-spec.durationSeconds)>1/expectedFps+0.001)throw new Error('FFprobe FPS or duration mismatch');
    return {status:'PASS',codec:stream.codec_name,pixelFormat:stream.pix_fmt,fps:stream.r_frame_rate,frameCount:Number(stream.nb_read_frames),duration,audioStreams:audios.length,...(expectedAudio?{audioCodec:audios[0].codec_name,audioDuration:Number(audios[0].duration),audioStart:Number(audios[0].start_time??0),sampleRate:Number(audios[0].sample_rate),channels:audios[0].channels}:{})};
  }
  private command(executable:string,args:string[],signal:AbortSignal):Promise<string> {
    aborted(signal);return new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{stdio:['ignore','pipe','pipe']});this.children.add(child);let stdout='',stderr='';
      const cancel=()=>stopChild(child);signal.addEventListener('abort',cancel,{once:true});
      child.stdout?.on('data',buffer=>{stdout+=String(buffer);});child.stderr?.on('data',buffer=>{stderr+=String(buffer);});
      child.once('error',error=>{signal.removeEventListener('abort',cancel);this.children.delete(child);reject(error);});
      child.once('close',code=>{signal.removeEventListener('abort',cancel);this.children.delete(child);code===0?resolve(stdout):reject(new Error(signal.aborted?'Task cancelled':'Process exited '+code+': '+stderr));});
    });
  }
  async close():Promise<void> {
    for(const child of this.children)stopChild(child);
    await this.audioMixer.close();
    await Promise.allSettled([...this.browsers].map(browser=>browser.close()));this.browsers.clear();
    await Promise.allSettled([...this.pendingServers.values()]);
    await Promise.allSettled([...this.servers.values()].map(server=>closeServer(server.server)));this.servers.clear();this.pendingServers.clear();
  }
}
function deduplicate(errors:RenderIssue[]):RenderIssue[] { return [...new Map(errors.map(error=>[JSON.stringify(error),error])).values()]; }
