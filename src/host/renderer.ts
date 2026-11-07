import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import type { Asset, EnvironmentInfo, EnvironmentSettings, ExportResult, SceneSource, VideoProject, VideoSpec } from '../shared/types.js';
import { compileSpec } from '../core/index.js';
import {assertProductionComposition,usesCodeVisual,usesVideoVisual} from '../core/production-policy.js';
import {hashMediaFile} from '../media/video.js';
import { ProjectStore, projectPath } from './store.js';
import { browserRuntime, runtimeHtml } from '../runtime/browser.js';
import {AudioMixer, type AudioMix} from './audio.js';
import {inspectToolEnvironment, type ToolEnvironmentOptions} from './tool-environment.js';
import {atomicRename} from './atomic-rename.js';

export interface FrameCapture { frame:number; shotId:string; path:string; sha256:string }
export interface RenderIssue { shotId?:string; frame?:number; message:string }
export interface RenderCheckResult { ok:boolean; errors:RenderIssue[]; frames:FrameCapture[]; reportPath?:string }
export interface CandidatePlayback {candidateHash:string;url:string;mime:'video/mp4';duration:number;frameCount:number;shotIds:string[]}
export interface CandidatePlaybackInput {project:VideoProject;sources:Record<string,SceneSource>;expectedRevision?:number}
interface CandidatePlaybackEntry {controller:AbortController;promise:Promise<CandidatePlayback>;root?:string;renderer?:VideoRenderer;server?:ProjectServer;complete:boolean}
type ServerRole='render'|'assets'|`code:${string}`;
interface ResourcePolicy {allowed:Set<string>;frameOrigin?:string}
interface ProjectServer { server:Server; origin:string; root:string;role:ServerRole }
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

async function projectServer(root:string,role:ServerRole,policy:()=>ResourcePolicy|undefined,assertAuthorized?:()=>void):Promise<ProjectServer> {
  const absoluteRoot=path.resolve(root);
  const server=createServer(async(req,res)=>{
    try {
      try{assertAuthorized?.();}catch{res.writeHead(403);res.end('Candidate review authorization has expired');return;}
      if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405);res.end();return;}
      // A loopback listener is insufficient if a foreign website can send a forged Host header.
      const host=req.headers.host??'';
      if(!/^127\.0\.0\.1:\d+$/.test(host)){res.writeHead(403);res.end();return;}
      const pathname=decodeURIComponent(new URL(req.url??'/','http://'+host).pathname);
      const relative=pathname.replace(/^\//,'')||'index.html';
      const access=policy();
      if(role!=='assets'&&(!access||!access.allowed.has(relative))){res.writeHead(403);res.end('Resource not approved for this renderer');return;}
      const full=await projectPath(absoluteRoot,relative),type=mime[path.extname(full).toLowerCase()];
      if(!type){res.writeHead(415);res.end('Unsupported file type');return;}
      const stat=await fs.stat(full);if(!stat.isFile())throw new Error('File expected');
      const headers:Record<string,string|number>={'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src "+(role.startsWith('code:')?"'none'":"'self'")+"; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; frame-src "+(access?.frameOrigin??"'none'")};
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
  return {root:absoluteRoot,server,role,origin:'http://127.0.0.1:'+address.port};
}
async function closeServer(server:Server):Promise<void> {
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
}

export class VideoRenderer {
  private servers=new Map<string,ProjectServer>();
  private pendingServers=new Map<string,Promise<ProjectServer>>();
  private resourcePolicies=new Map<string,ResourcePolicy>();
  private browsers=new Set<Browser>();
  private captureSessions=new WeakMap<Page,CDPSession>();
  private pendingThumbnails=new Map<string,Promise<(FrameCapture&{url:string})[]>>();
  private children=new Set<ChildProcess>();
  private audioMixer=new AudioMixer();
  private candidatePlaybacks=new Map<string,CandidatePlaybackEntry>();
  private candidatePlaybackClosed=false;
  private renderAuthorization?:()=>void;
  private readonly store:ProjectStore;
  constructor(store:ProjectStore=new ProjectStore()) { this.store=store; }
  async preview(root:string,project:VideoProject):Promise<string> {
    await this.prepare(root,project);
    const server=await this.server(root);return server.origin+'/index.html?revision='+project.revision;
  }
  async assetBaseUrl(root:string):Promise<string> {return (await this.server(root,'assets')).origin+'/';}
  async assetUrl(root:string,asset:Asset):Promise<string> {
    if(!asset.path)return '';await projectPath(root,asset.path);
    return (await this.server(root,'assets')).origin+'/'+asset.path.split('/').map(encodeURIComponent).join('/');
  }
  async audioPreview(root:string,project:VideoProject,settings:EnvironmentSettings,signal?:AbortSignal):Promise<string|null>{
    assertProductionComposition(project);const mix=await this.audioMixer.mix(root,this.activeMedia(project),settings,signal);if(!mix)return null;
    const relative=path.relative(root,mix.path).split(path.sep).map(encodeURIComponent).join('/');
    return (await this.server(root,'assets')).origin+'/'+relative+'?revision='+project.revision;
  }
  private activeMedia(project:VideoProject):VideoProject{return {...project,videoClips:project.videoClips?.filter(clip=>project.shotOrder.includes(clip.shotId)&&project.shots.some(shot=>shot.id===clip.shotId&&usesVideoVisual(shot))) };}
  private async server(root:string,role:ServerRole='render'):Promise<ProjectServer> {
    const key=path.resolve(root)+'::'+role,existing=this.servers.get(key);if(existing)return existing;
    let pending=this.pendingServers.get(key);
    if(!pending){pending=projectServer(root,role,()=>this.resourcePolicies.get(key));this.pendingServers.set(key,pending);}
    try{const server=await pending;this.servers.set(key,server);return server;}
    finally{if(this.pendingServers.get(key)===pending)this.pendingServers.delete(key);}
  }
  private async prepare(root:string,project:VideoProject):Promise<VideoSpec> {
    this.renderAuthorization?.();
    assertProductionComposition(project);
    for(const key of this.resourcePolicies.keys())if(key.startsWith(path.resolve(root)+'::code:'))this.resourcePolicies.delete(key);
    const spec=compileSpec(project);const sources:{id:string;html:string;css:string;moduleUrl:string}[]=[];
    await fs.mkdir(await projectPath(root,'runtime/scenes'),{recursive:true});
    for(const shot of spec.shots){
      if(!usesCodeVisual(shot))continue;
      try{
        const source=await this.store.readSource(root,shot,project.revision);safeId(shot.id);
        // ESM modules are files served under a restrictive self-only CSP; no privileged APIs are exposed.
        await fs.writeFile(await projectPath(root,'runtime/scenes/'+shot.id+'.mjs'),source.js);
        sources.push({id:shot.id,html:source.html,css:source.css,moduleUrl:'./scenes/'+shot.id+'.mjs'});
      }catch(error){const e=error as Error&RenderIssue;e.shotId=shot.id;throw e;}
    }
    const server=await this.server(root),codeOrigins:Record<string,string>={};
    for(const shot of spec.shots.filter(usesCodeVisual)){
      const codeServer=await this.server(root,`code:${shot.id}`),source=sources.find(source=>source.id===shot.id)!;codeOrigins[shot.id]=codeServer.origin;
      const codeAssets=shot.assets.filter(asset=>asset.kind==='image').map(asset=>asset.path).filter((file):file is string=>!!file);
      this.resourcePolicies.set(path.resolve(root)+'::code:'+shot.id,{allowed:new Set(['code.html','runtime/frame.mjs','runtime/code-spec-'+shot.id+'.json','runtime/scenes/'+shot.id+'.mjs',...codeAssets])});
      const codeSpec={...spec,shots:[{...shot,hasVideo:!!shot.videoClip,videoClip:undefined,assets:shot.assets.filter(asset=>asset.kind==='image'||asset.kind==='text')}]};
      await fs.writeFile(await projectPath(root,'runtime/code-spec-'+shot.id+'.json'),json({spec:codeSpec,sources:[source],role:'code'}));
    }
    const videoAssets=spec.shots.flatMap(shot=>shot.assets.filter(asset=>asset.id===shot.videoClip?.assetId).map(asset=>asset.path).filter((file):file is string=>!!file));
    this.resourcePolicies.set(path.resolve(root)+'::render',{allowed:new Set(['index.html','runtime/frame.mjs','runtime/spec.json',...videoAssets]),frameOrigin:Object.values(codeOrigins).join(' ')||undefined});
    await fs.writeFile(await projectPath(root,'runtime/frame.mjs'),browserRuntime);
    await fs.writeFile(await projectPath(root,'runtime/spec.json'),json({spec,sources:[],role:'compositor',codeOrigins}));
    if(sources.length)await fs.writeFile(await projectPath(root,'code.html'),runtimeHtml(spec.target.width,spec.target.height));
    await fs.writeFile(await projectPath(root,'index.html'),runtimeHtml(spec.target.width,spec.target.height));
    return spec;
  }
  private async openPage(url:string,spec:VideoSpec,settings:EnvironmentSettings,issues:RenderIssue[],signal?:AbortSignal):Promise<{browser:Browser;page:Page;removeAbort:()=>void}> {
    aborted(signal);const env=detectEnvironment(settings);if(!env.browserAvailable)throw new Error('Chrome/Chromium unavailable. Set browserPath in environment settings.');
    await fs.access(env.browserPath,constants.X_OK);
    // 逐帧契约要求同一帧可复现：GPU 光栅的 2D canvas 在不同页面状态下会出现 ±1 的采样差异，
    // 会让逆序 seek / 冷启动的字节比对偶发失败。固定用 Skia 软件光栅画 2D canvas，
    // 合成与 WebGL 仍走原路径，渲染结果与截图因此稳定可复现。
    const browser=await chromium.launch({executablePath:env.browserPath,headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-accelerated-2d-canvas','--disable-accelerated-video-decode','--disable-frame-rate-limit','--renderer-process-limit=1']});this.browsers.add(browser);
    const cancel=()=>{void browser.close().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
    try {
      const context=await browser.newContext({viewport:{width:spec.target.width,height:spec.target.height},deviceScaleFactor:1,serviceWorkers:'block'});
      const origin=new URL(url).origin;
      const renderServer=[...this.servers.values()].find(server=>server.origin===origin),codeOrigins=new Set([...this.servers.values()].filter(server=>server.root===renderServer?.root&&server.role.startsWith('code:')).map(server=>server.origin));
      await context.route('**/*',async route=>{
        const request=new URL(route.request().url());
        if(request.origin===origin||codeOrigins.has(request.origin)||request.protocol==='data:')await route.continue();
        else{issues.push({message:'Blocked external resource: '+request.origin+request.pathname});await route.abort('blockedbyclient');}
      });
      await context.routeWebSocket('**/*',async socket=>{issues.push({message:'Blocked WebSocket: '+socket.url().split('?')[0]});await socket.close();});
      const page=await context.newPage();page.setDefaultTimeout(30_000);
      page.on('pageerror',error=>issues.push({message:error.message}));
      page.on('console',message=>{if(message.type()==='error')issues.push({message:message.text()});});
      page.on('response',response=>{if(response.status()>=400)issues.push({message:'HTTP '+response.status()+': '+new URL(response.url()).pathname});});
      // The host requests every frame explicitly; do not race an automatic frame-zero render.
      const renderUrl=new URL(url);renderUrl.searchParams.set('render','manual');
      await page.goto(renderUrl.href,{waitUntil:'load',timeout:30_000});
      await page.waitForFunction(()=>!!(window as any).__VIDEO_WORKPACK__);
      const ready=await deadline(page.evaluate(async()=>{
        try{await (window as any).__VIDEO_WORKPACK__.ready();return {ok:true};}
        catch(error){const e=error as any;return {ok:false,message:e.message,shotId:e.shotId};}
      }),'Scene ready');
      if(!ready.ok){issues.push({shotId:ready.shotId,message:ready.message??'Renderer ready failed'});throw new Error(ready.message);}
      this.captureSessions.set(page,await context.newCDPSession(page));
      return {browser,page,removeAbort:()=>signal?.removeEventListener('abort',cancel)};
    }catch(error){signal?.removeEventListener('abort',cancel);await browser.close().catch(()=>{});this.browsers.delete(browser);throw error;}
  }
  private async frame(page:Page,spec:VideoSpec,frame:number,scale=1):Promise<{buffer:Buffer;shotId:string}> {
    this.renderAuthorization?.();
    const result=await deadline(page.evaluate(async input=>{
      try{
        const info=await (window as any).__VIDEO_WORKPACK__.renderFrame(input);
        // Layout discovers fonts introduced by render(). CDP capture commits the resulting
        // compositor surface; waiting for two display refreshes here throttles offline export.
        void document.body.offsetHeight;await document.fonts.ready;
        return {ok:true,info};
      }catch(error){const e=error as any;return {ok:false,message:e.message,shotId:e.shotId,frame:e.frame};}
    },{frame,fps:spec.target.fps}),'Frame '+frame);
    if(!result.ok){const error=new Error(result.message) as Error&RenderIssue;error.shotId=result.shotId;error.frame=result.frame;throw error;}
    this.renderAuthorization?.();
    const session=this.captureSessions.get(page);if(!session)throw new Error('Frame capture session unavailable');
    // Lossless PNG with fast compression. The viewport and scale are fixed at openPage(),
    // so repeated caret/style/font preparation and viewport probes are unnecessary.
    const capture=await deadline(session.send('Page.captureScreenshot',{format:'png',optimizeForSpeed:true,
      clip:{x:0,y:0,width:spec.target.width,height:spec.target.height,scale},captureBeyondViewport:false}),'Screenshot '+frame);
    return {buffer:Buffer.from(capture.data,'base64'),shotId:result.info.sceneId};
  }
  /** Static previews share one short-lived browser and are cached against the render inputs. */
  async thumbnails(root:string,project:VideoProject,settings:EnvironmentSettings,requested:number[],signal?:AbortSignal):Promise<(FrameCapture&{url:string})[]>{
    aborted(signal);assertProductionComposition(project);const spec=compileSpec(project);
    if(!Array.isArray(requested)||requested.length<1||requested.length>3||requested.some(frame=>!Number.isSafeInteger(frame)||frame<0||frame>=spec.durationFrames))throw new Error('Thumbnails require 1–3 valid project frames');
    const frames=[...new Set(requested)],key=hash(JSON.stringify({runtime:browserRuntime,revision:project.revision,spec,frames}));
    const pendingKey=path.resolve(root)+':'+key;let pending=this.pendingThumbnails.get(pendingKey);
    if(!pending){pending=this.makeThumbnails(root,project,spec,settings,frames,key,signal);this.pendingThumbnails.set(pendingKey,pending);}
    try{return await pending;}finally{if(this.pendingThumbnails.get(pendingKey)===pending)this.pendingThumbnails.delete(pendingKey);}
  }
  private async makeThumbnails(root:string,project:VideoProject,spec:VideoSpec,settings:EnvironmentSettings,frames:number[],key:string,signal?:AbortSignal):Promise<(FrameCapture&{url:string})[]>{
    const server=await this.server(root),assetServer=await this.server(root,'assets'),captures=[];
    for(const frame of frames){
      const relative='.studio/thumbnails/'+key+'/'+frame+'.png';
      captures.push({frame,shotId:spec.shots.find(shot=>frame>=shot.startFrame&&frame<shot.endFrame)!.id,path:await projectPath(root,relative),url:assetServer.origin+'/'+relative});
    }
    const cached=await Promise.all(captures.map(capture=>fs.readFile(capture.path).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;})));
    if(cached.every(bytes=>bytes!==null))return captures.map((capture,index)=>({...capture,sha256:hash(cached[index]!)}));
    const errors:RenderIssue[]=[];let connection:Awaited<ReturnType<VideoRenderer['openPage']>>|undefined;
    try{
      await this.prepare(root,project);connection=await this.openPage(server.origin+'/index.html',spec,settings,errors,signal);
      const scale=Math.min(1,320/spec.target.width,180/spec.target.height),results=[];
      for(const capture of captures){
        aborted(signal);const result=await this.frame(connection.page,spec,capture.frame,scale);aborted(signal);
        if(errors.length)throw new Error(errors.map(error=>error.message).join('; '));
        await fs.mkdir(path.dirname(capture.path),{recursive:true});const temporary=capture.path+'.tmp-'+randomUUID();
        try{await fs.writeFile(temporary,result.buffer);await atomicRename(temporary,capture.path);}finally{await fs.rm(temporary,{force:true});}
        results.push({...capture,sha256:hash(result.buffer)});
      }
      return results;
    }finally{if(connection){connection.removeAbort();await connection.browser.close().catch(()=>{});this.browsers.delete(connection.browser);}}
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
      return {frame,shotId:result.shotId,path:file,sha256:hash(result.buffer),url:(await this.server(root,'assets')).origin+'/'+relative};
    }finally{if(connection){connection.removeAbort();await connection.browser.close().catch(()=>{});this.browsers.delete(connection.browser);}}
  }
  /** Render an immutable candidate without writing the live project or its runtime. */
  async captureCandidate(root:string,project:VideoProject,sources:Record<string,SceneSource>,settings:EnvironmentSettings,frame:number,signal?:AbortSignal):Promise<{bytes:Uint8Array;mime:string;sha256:string}>{
    aborted(signal);assertProductionComposition(project);const snapshotRoot=await fs.mkdtemp(path.join(os.tmpdir(),'video-studio-candidate-'));
    const renderer=new VideoRenderer(),snapshot=structuredClone(project);snapshot.outputs=[];
    try{
      await this.writeCandidateSnapshot(root,snapshotRoot,snapshot,sources,signal);
      const capture=await renderer.capture(snapshotRoot,snapshot,settings,frame,signal);
      return {bytes:await fs.readFile(capture.path),mime:'image/png',sha256:capture.sha256};
    }finally{await renderer.close();await fs.rm(snapshotRoot,{recursive:true,force:true});}
  }
  private async writeCandidateSnapshot(root:string,snapshotRoot:string,snapshot:VideoProject,sources:Record<string,SceneSource>,signal?:AbortSignal):Promise<void>{
    for(const asset of snapshot.assets)delete asset.originalPath;
    await fs.writeFile(path.join(snapshotRoot,'project.json'),json(snapshot));
    for(const asset of snapshot.assets)if(asset.path){
      aborted(signal);const input=await projectPath(root,asset.path),output=await projectPath(snapshotRoot,asset.path);
      await fs.mkdir(path.dirname(output),{recursive:true});await fs.copyFile(input,output,constants.COPYFILE_FICLONE);
    }
    for(const shot of snapshot.shots.filter(usesCodeVisual)){
      aborted(signal);const source=sources[shot.id]??await this.store.readSource(root,shot,snapshot.revision);
      await this.store.writeSource(snapshotRoot,shot,source);
    }
  }
  /** A review artifact is a separate immutable film, never a live preview or an adopted export. */
  async previewCandidate(root:string,candidate:CandidatePlaybackInput,settings:EnvironmentSettings,options:{candidateHash:string;shotIds?:string[];assertAuthorized:()=>void},signal?:AbortSignal):Promise<CandidatePlayback>{
    if(this.candidatePlaybackClosed)throw new Error('Candidate playback renderer has closed');
    aborted(signal);options.assertAuthorized();
    const pinned=structuredClone(candidate),actualHash=hash(JSON.stringify(pinned));
    if(options.candidateHash!==actualHash)throw new Error('候选 hash 与实际内容不一致，不能生成审看片');
    const requested=options.shotIds?.length?options.shotIds:pinned.project.shotOrder;
    if(new Set(requested).size!==requested.length||requested.some(id=>!pinned.project.shotOrder.includes(id)))throw new Error('候选审看镜头范围无效');
    const shotIds=pinned.project.shotOrder.filter(id=>requested.includes(id));if(!shotIds.length)throw new Error('候选没有可审看的镜头');
    assertProductionComposition({...pinned.project,shotOrder:shotIds},{forExport:true});
    const key=hash(JSON.stringify({root:path.resolve(root),candidateHash:actualHash,shotIds,settings,runtime:browserRuntime}));
    let entry=this.candidatePlaybacks.get(key);
    if(!entry){
      entry={controller:new AbortController(),complete:false,promise:undefined!};this.candidatePlaybacks.set(key,entry);
      const owned=entry;
      owned.promise=this.makeCandidatePlayback(root,pinned,settings,shotIds,actualHash,options.assertAuthorized,owned,signal).catch(async error=>{
        if(this.candidatePlaybacks.get(key)===owned)this.candidatePlaybacks.delete(key);
        await this.cleanupCandidatePlayback(owned);throw error;
      });
    }else{this.candidatePlaybacks.delete(key);this.candidatePlaybacks.set(key,entry);}
    const result=await entry.promise;aborted(signal);options.assertAuthorized();
    for(const [oldKey,oldEntry] of this.candidatePlaybacks){if(this.candidatePlaybacks.size<=4)break;if(oldKey!==key&&oldEntry.complete){this.candidatePlaybacks.delete(oldKey);await this.cleanupCandidatePlayback(oldEntry);}}
    return structuredClone(result);
  }
  private async makeCandidatePlayback(root:string,candidate:CandidatePlaybackInput,settings:EnvironmentSettings,shotIds:string[],candidateHash:string,assertAuthorized:()=>void,entry:CandidatePlaybackEntry,signal?:AbortSignal):Promise<CandidatePlayback>{
    const abort=()=>entry.controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const active=entry.controller.signal,check=()=>{aborted(active);assertAuthorized();};
    const monitor=setInterval(()=>{try{check();}catch(error){entry.controller.abort(error);}},50);monitor.unref();
    try{
      check();entry.root=await fs.mkdtemp(path.join(os.tmpdir(),'video-studio-candidate-playback-'));
      const renderer=entry.renderer=new VideoRenderer(new ProjectStore({baseDirectory:entry.root}));renderer.renderAuthorization=check;
      const snapshot=structuredClone(candidate.project);snapshot.outputs=[];
      await this.writeCandidateSnapshot(root,entry.root,snapshot,candidate.sources,active);check();
      const originalSpec=compileSpec(snapshot),selected=originalSpec.shots.filter(shot=>shotIds.includes(shot.id)),all=selected.length===originalSpec.shots.length;
      const selectedProject=structuredClone(snapshot);selectedProject.shots=selectedProject.shots.filter(shot=>shotIds.includes(shot.id));selectedProject.shotOrder=shotIds;selectedProject.videoClips=selectedProject.videoClips?.filter(clip=>shotIds.includes(clip.shotId));selectedProject.audioClips=[];delete selectedProject.extensions.graphEdges;
      const code=selected.some(usesCodeVisual);
      let renderedProject=snapshot;
      if(!all&&!code){
        if(selected.some((shot,index)=>(originalSpec.shots[originalSpec.shots.findIndex(item=>item.id===shot.id)+1]?.transition==='fade')!==(selected[index+1]?.transition==='fade')))throw new Error('选段会改变候选镜头的相邻淡出关系，请使用完整时间线审看');
        // Resolve the original candidate mix first, then select its exact timeline windows.
        // This preserves global music offsets, loops, voice anchors and native video audio.
        const mix=await renderer.audioMixer.mix(entry.root,renderer.activeMedia(snapshot),settings,active);check();
        renderedProject=selectedProject;renderedProject.videoClips=renderedProject.videoClips?.map(clip=>({...clip,audio:'mute'}));
        if(mix){
          const relative='assets/review-mix-'+randomUUID()+'.wav',destination=await projectPath(entry.root,relative);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(mix.path,destination);
          const assetId='review_mix_'+randomUUID().replaceAll('-','');renderedProject.assets.push({id:assetId,kind:'audio',name:'候选审看音轨',description:'候选原始时间线混音的精确选段',path:relative,duration:mix.duration,sampleRate:48000,channels:2,mime:'audio/wav',provenance:{origin:'unknown',usage:'production'}});
          renderedProject.audioClips=selected.map(shot=>({id:'review_'+shot.id,assetId,role:'sfx',shotId:shot.id,startSeconds:0,trimStart:shot.startFrame*originalSpec.target.fps.den/originalSpec.target.fps.num,trimEnd:shot.endFrame*originalSpec.target.fps.den/originalSpec.target.fps.num,volume:1,fadeIn:0,fadeOut:0}));
        }
      }
      const exported=await renderer.export(entry.root,renderedProject,settings,active,()=>check());check();let file=exported.path;
      const spec=compileSpec(selectedProject),hasAudio=exported.qa?.audioStreams===1;
      if(!all&&code){
        // Code can use absolute ctx.frame; render its original timeline before extracting shots.
        file=path.join(entry.root,'candidate-selection.mp4');const fps=originalSpec.target.fps.num/originalSpec.target.fps.den;
        const filters=selected.flatMap((shot,index)=>[`[0:v]trim=start_frame=${shot.startFrame}:end_frame=${shot.endFrame},setpts=PTS-STARTPTS[v${index}]`,...(hasAudio?[`[0:a]atrim=start=${shot.startFrame/fps}:end=${shot.endFrame/fps},asetpts=PTS-STARTPTS[a${index}]`]:[])]);
        filters.push(selected.map((_shot,index)=>`[v${index}]${hasAudio?'[a'+index+']':''}`).join('')+`concat=n=${selected.length}:v=1:a=${hasAudio?1:0}[v]${hasAudio?'[a]':''}`);
        await renderer.command(settings.ffmpegPath,['-hide_banner','-loglevel','error','-y','-i',exported.path,'-filter_complex',filters.join(';'),'-map','[v]',...(hasAudio?['-map','[a]','-c:a','aac','-ar','48000','-ac','2']:['-an']),'-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-crf','18','-movflags','+faststart',file],active);
        await renderer.mediaQa(file,spec,settings,active,hasAudio);check();
      }
      await renderer.close();entry.renderer=undefined;check();
      // A downloaded review film retains its known visual origin after renaming/reimport.
      // Only the host-local hash registry changes; this is never a live output receipt.
      await this.store.recordExportProvenance(file,selectedProject,'candidate-'+candidateHash);check();
      const relative=path.relative(entry.root,file).split(path.sep).join('/');
      entry.server=await projectServer(entry.root,'render',()=>({allowed:new Set([relative])}),check);check();entry.complete=true;
      return {candidateHash,url:entry.server.origin+'/'+relative.split('/').map(encodeURIComponent).join('/'),mime:'video/mp4',duration:spec.durationSeconds,frameCount:spec.durationFrames,shotIds};
    }finally{clearInterval(monitor);signal?.removeEventListener('abort',abort);await entry.renderer?.close();entry.renderer=undefined;}
  }
  private async cleanupCandidatePlayback(entry:CandidatePlaybackEntry):Promise<void>{
    entry.controller.abort(new Error('Candidate playback closed'));await entry.renderer?.close();entry.renderer=undefined;
    if(entry.server){await closeServer(entry.server.server);entry.server=undefined;}if(entry.root){await fs.rm(entry.root,{recursive:true,force:true});entry.root=undefined;}
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
      if(errors.length===0)for(const shot of project.shots.filter(usesCodeVisual))await this.store.markSourceGood(root,shot);
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
    aborted(signal);assertProductionComposition(project,{forExport:true});const env=detectEnvironment(settings);
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
      await fs.copyFile(source,destination,constants.COPYFILE_FICLONE);inputHashes.push({path:asset.path,sha256:await hashMediaFile(destination,signal)});
    }
    for(const shot of snapshot.shots){
      if(!usesCodeVisual(shot))continue;
      const source=await this.store.readSource(root,shot,project.revision);await this.store.writeSource(snapshotRoot,shot,source);
      inputHashes.push({path:shot.sourcePath+'/source.json',sha256:hash(json(source))});
    }
    const spec=await this.prepare(snapshotRoot,snapshot),errors:RenderIssue[]=[],frames:FrameCapture[]=[];
    if(spec.target.width%2||spec.target.height%2)throw new Error('H.264 yuv420p requires even width and height');
    const snapshotServer=await this.server(snapshotRoot);let connection:Awaited<ReturnType<VideoRenderer['openPage']>>|undefined,encoder:ChildProcess|undefined;
    const mp4Path=path.join(outputRoot,'video.mp4'),logPath=path.join(outputRoot,'ffmpeg.log');let log='',audioMix:AudioMix|null=null;
    const cancel=()=>{if(encoder)stopChild(encoder);};signal.addEventListener('abort',cancel,{once:true});
    let encoderResult:Promise<void>|undefined;
    try {
      onProgress(0.03,'制作输入已保存快照');audioMix=await this.audioMixer.mix(snapshotRoot,this.activeMedia(snapshot),env,signal);
      if(audioMix){await fs.writeFile(path.join(outputRoot,'audio-plan.json'),json(audioMix.plan));onProgress(.06,'配音、音乐与音效已完成混音');}
      connection=await this.openPage(snapshotServer.origin+'/index.html',spec,env,errors,signal);
      const audioArgs=audioMix?['-i',audioMix.path,'-map','0:v:0','-map','1:a:0','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-t',String(spec.durationSeconds)]:['-an'];
      const crf=spec.target.quality==='high'?'16':spec.target.quality==='small'?'23':'18';
      // PNG is fed one frame at a time. FFmpeg's automatic frame-thread decoder can
      // otherwise retain many full-resolution images and oversubscribe the machine.
      const encoderThreads=String(Math.max(1,Math.min(4,os.availableParallelism())));
      encoder=spawn(env.ffmpegPath,['-hide_banner','-loglevel','warning','-y','-filter_threads','1','-f','image2pipe','-vcodec','png','-threads','1','-probesize','32','-analyzeduration','0','-fpsprobesize','0','-framerate',spec.target.fps.num+'/'+spec.target.fps.den,'-i','pipe:0',...audioArgs,'-c:v','libx264','-threads',encoderThreads,'-preset','medium','-crf',crf,'-pix_fmt','yuv420p','-movflags','+faststart',mp4Path],{stdio:['pipe','ignore','pipe']});this.children.add(encoder);
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
      await this.store.recordExportProvenance(mp4Path,project,id);
      result.url=(await this.server(root,'assets')).origin+'/exports/'+id+'/video.mp4';onProgress(1,'视频导出完成');return result;
    }catch(error){
      if(encoder)stopChild(encoder);await encoderResult?.catch(()=>{});
      await fs.writeFile(logPath,log);await fs.writeFile(path.join(outputRoot,'failure.json'),json({status:signal.aborted?'cancelled':'failed',message:(error as Error).message,errors:deduplicate(errors),frames,inputHashes,snapshotRoot}));
      await fs.rm(mp4Path,{force:true});throw new Error(signal.aborted?'Task cancelled':(error as Error).message);
    }finally{
      signal.removeEventListener('abort',cancel);if(connection){connection.removeAbort();await connection.browser.close().catch(()=>{});this.browsers.delete(connection.browser);}
      for(const [key,server] of this.servers)if(server.root===path.resolve(snapshotRoot)){await closeServer(server.server);this.servers.delete(key);this.resourcePolicies.delete(key);}
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
    this.candidatePlaybackClosed=true;
    const candidates=[...this.candidatePlaybacks.values()];for(const entry of candidates)entry.controller.abort(new Error('Renderer closed'));
    await Promise.allSettled(candidates.map(entry=>entry.promise));await Promise.allSettled(candidates.map(entry=>this.cleanupCandidatePlayback(entry)));this.candidatePlaybacks.clear();
    for(const child of this.children)stopChild(child);
    await this.audioMixer.close();
    await Promise.allSettled([...this.browsers].map(browser=>browser.close()));this.browsers.clear();
    await Promise.allSettled([...this.pendingServers.values()]);
    await Promise.allSettled([...this.servers.values()].map(server=>closeServer(server.server)));this.servers.clear();this.pendingServers.clear();
    this.resourcePolicies.clear();
  }
}
function deduplicate(errors:RenderIssue[]):RenderIssue[] { return [...new Map(errors.map(error=>[JSON.stringify(error),error])).values()]; }
