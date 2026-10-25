import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Asset, EnvironmentSettings, SceneSource, Shot, VideoProject } from '../shared/types.js';
import { createProject, defaultSceneSource, validateProject, migrateProject } from '../core/index.js';
import {probeAudio} from './audio.js';
import {importVideoFile,MAX_VIDEO_BYTES} from '../media/video.js';
import {syncDirectory} from './directory-sync.js';
import {atomicRename} from './atomic-rename.js';
import {inspectProjectPaths,portableProjectPathReason,safeRelativeProjectPath} from '../core/project-paths.js';

export interface StoreOptions {
  baseDirectory?:string;
  /** Local fault injection for storage recovery tests; never exposed as an RPC option. */
  onCommitPhase?:(phase:'staged'|'committed'|'projected')=>Promise<void>|void;
}
export interface SourceInput { shotId:string; source:SceneSource }
export interface AssetFileInput { path:string; dataBase64?:string; localPath?:string }
export interface CreateInput { project:VideoProject; sources?:SourceInput[]; assetFiles?:AssetFileInput[] }
export interface CommitOptions { label?:string; expectedRevision?:number; historyGroup?:string }
export interface HistoryEntry { id:string; label:string; createdAt:string; revision:number }
export interface ProjectHistory { canUndo:boolean; canRedo:boolean; cursor:number; entries:HistoryEntry[] }
interface StoredVersion { version:1; id:string; label:string; createdAt:string; project:VideoProject; sources:Record<string,SceneSource> }
interface StoreState { version:1; current:string; undo:string[]; redo:string[]; historyGroup?:string }

export interface ImportAssetInput { path?:string; dataBase64?:string; mime?:string; text?:string; name?:string; description?:string }
export interface RecentProject { path:string; title:string; id:string }

/** Resolve a project-local path and reject traversal, absolute paths and existing symlinks. */
export async function projectPath(root:string,relative:string):Promise<string> {
  if(!safeRelativeProjectPath(relative))throw new Error('Invalid project-relative path');
  const reason=process.platform==='win32'?portableProjectPathReason(relative):undefined;
  if(reason)throw Object.assign(new Error(`路径 ${JSON.stringify(relative)} 不能在 Windows 访问：${reason}`),{code:'PROJECT_PATH_NOT_PORTABLE'});
  const absoluteRoot=path.resolve(root), result=path.resolve(absoluteRoot,relative);
  if(!result.startsWith(absoluteRoot+path.sep))throw new Error('Path outside project');
  let cursor=absoluteRoot;
  const rootInfo=await fs.lstat(absoluteRoot);
  if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new Error('Project directory must be a real directory');
  for(const part of relative.split('/')){
    cursor=path.join(cursor,part);
    try{if((await fs.lstat(cursor)).isSymbolicLink())throw new Error('Symlinks are not supported in project paths');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}
  }
  return result;
}

async function atomicWrite(file:string,data:string|Buffer):Promise<void> {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temporary=file+'.tmp-'+randomUUID();
  try {
    const handle=await fs.open(temporary,'w');try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
    await atomicRename(temporary,file);
    await syncDirectory(path.dirname(file));
  }
  finally { await fs.rm(temporary,{force:true}); }
}
function json(value:unknown):string { return JSON.stringify(value,null,2)+'\n'; }
function assertProjectShape(project:VideoProject):void {
  if(!project||![1,2].includes(project.schemaVersion)||typeof project.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(project.id)||!Array.isArray(project.assets)||!Array.isArray(project.shots)||!Array.isArray(project.shotOrder)||!Array.isArray(project.outputs)||!project.target||!project.graph)throw new Error('Unsupported or damaged project.json');
}
function assertSource(source:SceneSource):void {
  if(!source||!['html','css','js'].every(key=>typeof source[key as keyof SceneSource]==='string'))throw new Error('Scene source requires html, css and js strings');
  if(Buffer.byteLength(source.html)+Buffer.byteLength(source.css)+Buffer.byteLength(source.js)>2_000_000)throw new Error('Scene source exceeds 2 MB');
}
export function validateStoredProject(project:VideoProject,options:{portablePaths?:boolean}={}):void {
  assertProjectShape(project);
  const check=validateProject(project);if(!check.ok)throw new Error(check.errors.join('\n'));
  if(options.portablePaths!==false)assertPortablePaths(project);
  const ids=[project.id,...project.shots.map(s=>s.id),...project.assets.map(a=>a.id)];
  if(ids.some(id=>!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||['__proto__','constructor','prototype'].includes(id)))throw new Error('工程、镜头和资产 ID 无效');
  const folders=new Set<string>();
  for(const shot of project.shots){
    if(!safeStoragePath(shot.sourcePath,'shots/')||[...folders].some(folder=>folder===shot.sourcePath||folder.startsWith(shot.sourcePath+'/')||shot.sourcePath.startsWith(folder+'/')))throw new Error('镜头源码须使用唯一的 shots/ 子目录');
    folders.add(shot.sourcePath);
  }
  for(const asset of project.assets)for(const file of [asset.path,asset.originalPath])if(file&&!safeStoragePath(file,'assets/'))throw new Error('媒体资产须保存在 assets/ 子目录');
}
function safeStoragePath(value:string,prefix:string):boolean {
  return safeRelativeProjectPath(value)&&value.startsWith(prefix)&&value.length>prefix.length;
}
function assertPortablePaths(project:VideoProject,projection=false):void {
  const issues=inspectProjectPaths(project).filter(issue=>!projection||issue.code==='conflict'||process.platform==='win32');
  if(issues.length)throw Object.assign(new Error(issues.map(issue=>issue.message).join('\n')),{code:issues.some(issue=>issue.code==='conflict')?'PROJECT_PATH_CONFLICT':'PROJECT_PATH_NOT_PORTABLE'});
}
export function validateSources(project:VideoProject,inputs:SourceInput[]=[]):Record<string,SceneSource> {
  if(!Array.isArray(inputs))throw new Error('sources 须为数组');
  const sources:Record<string,SceneSource>={};
  for(const input of inputs){
    if(!input||!project.shots.some(s=>s.id===input.shotId))throw new Error('源码引用的镜头不存在');
    if(Object.hasOwn(sources,input.shotId))throw new Error('镜头源码重复');
    assertSource(input.source);sources[input.shotId]={html:input.source.html,css:input.source.css,js:input.source.js};
  }
  return sources;
}
function scenePath(shot:Shot|string):string { return typeof shot==='string'?shot:shot.sourcePath; }

export class ProjectStore {
  readonly baseDirectory:string;
  private static readonly projectQueues=new Map<string,Promise<unknown>>();
  private queued<T>(root:string,work:()=>Promise<T>):Promise<T>{
    const key=path.resolve(root),previous=ProjectStore.projectQueues.get(key)??Promise.resolve();
    const result=previous.then(work),settled=result.then(()=>undefined,()=>undefined);ProjectStore.projectQueues.set(key,settled);
    void settled.then(()=>{if(ProjectStore.projectQueues.get(key)===settled)ProjectStore.projectQueues.delete(key);});return result;
  }
  private readonly versionCache=new Map<string,{record:StoredVersion;bytes:number}>();
  private cachedBytes=0;
  constructor(private options:StoreOptions={}) { this.baseDirectory=path.resolve(options.baseDirectory??path.join(os.homedir(),'Documents','DSHVideoProjects')); }
  async create(input:VideoProject|CreateInput|{title?:string;topic?:string}={}):Promise<{root:string;project:VideoProject}> {
    const full='project' in input?input:undefined;
    const brief=input as {title?:string;topic?:string};
    const project:VideoProject=migrateProject(full?full.project:'schemaVersion' in input?input:createProject(brief.title??'未命名视频',brief.topic??''));
    project.revision=0;project.createdAt=new Date().toISOString();project.updatedAt=project.createdAt;
    validateStoredProject(project);
    const sources=validateSources(project,full?.sources);
    for(const shot of project.shots)if(!sources[shot.id])sources[shot.id]=defaultSceneSource();
    const files=await this.validateAssetFiles(project,full?.assetFiles??[]);
    await fs.mkdir(this.baseDirectory,{recursive:true});
    const slug=project.title.replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-|-$/g,'').slice(0,50)||'video';
    const root=path.join(this.baseDirectory,slug+'-'+project.id);
    await fs.mkdir(root,{recursive:false});
    try{
      await fs.mkdir(path.join(root,'assets'),{recursive:true});
      for(const [relative,bytes] of files){const destination=await projectPath(root,relative);await fs.mkdir(path.dirname(destination),{recursive:true});if(typeof bytes==='string'){let size=0;await pipeline(createReadStream(bytes),new Transform({transform(chunk,_encoding,callback){size+=chunk.length;callback(size>MAX_VIDEO_BYTES?new Error('工程媒体单文件超过 512 MiB'):null,chunk);}}),createWriteStream(destination,{flags:'wx'}));}else await atomicWrite(destination,bytes);}
      const saved=await this.commit(root,project,sources,{label:'创建工程'});
      return {root,project:saved};
    }catch(error){await fs.rm(root,{recursive:true,force:true});throw error;}
  }
  private async validateAssetFiles(project:VideoProject,inputs:AssetFileInput[]):Promise<Map<string,Buffer|string>>{
    if(!Array.isArray(inputs))throw new Error('assetFiles 须为数组');
    const expected=new Set(project.assets.flatMap(asset=>[asset.path,asset.originalPath].filter((file):file is string=>typeof file==='string'))),files=new Map<string,Buffer|string>();let total=0,encodedTotal=0;
    for(const input of inputs){
      if(!input||typeof input.path!=='string'||!safeStoragePath(input.path,'assets/')||!expected.has(input.path)||files.has(input.path)||(typeof input.dataBase64==='string')===(typeof input.localPath==='string'))throw new Error('工程媒体文件路径无效或重复');
      if(typeof input.localPath==='string'){
        const info=await fs.stat(input.localPath);if(!info.isFile()||!info.size||info.size>MAX_VIDEO_BYTES)throw new Error('工程媒体单文件须不超过 512 MiB');
        total+=info.size;files.set(input.path,input.localPath);
      }else{
        const encoded=input.dataBase64!;if(encoded.length>90_000_000||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length%4!==0)throw new Error('工程媒体文件须为有效 base64');
        const bytes=Buffer.from(encoded,'base64');total+=bytes.length;encodedTotal+=bytes.length;
        if(!bytes.length||encodedTotal>64*1024*1024)throw new Error('内存工程导入媒体总量须不超过 64 MB，请使用文件工程包');files.set(input.path,bytes);
      }
      if(total>4*1024*1024*1024)throw new Error('工程导入媒体总量须不超过 4 GiB');
    }
    for(const relative of expected)if(!files.has(relative))throw new Error('工程缺少媒体文件：'+relative);
    return files;
  }
  private async state(root:string):Promise<StoreState|undefined>{
    try{
      const state=JSON.parse(await fs.readFile(await projectPath(root,'.studio/state.json'),'utf8')) as StoreState;
      if(state.version!==1||!this.validVersionId(state.current)||!Array.isArray(state.undo)||!Array.isArray(state.redo)||[...state.undo,...state.redo].some(id=>!this.validVersionId(id)))throw new Error('工程版本指针损坏');
      return state;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  }
  private validVersionId(id:string):boolean{return typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);}
  private async version(root:string,id:string):Promise<StoredVersion>{
    if(!this.validVersionId(id))throw new Error('工程版本 ID 无效');
    const key=path.resolve(root)+'/'+id,cached=this.versionCache.get(key);if(cached){this.versionCache.delete(key);this.versionCache.set(key,cached);return cached.record;}
    const text=await fs.readFile(await projectPath(root,`.studio/versions/${id}.json`),'utf8'),record=JSON.parse(text) as StoredVersion;
    if(record.version!==1||record.id!==id||!record.sources||typeof record.label!=='string')throw new Error('工程版本快照损坏');
    record.project=migrateProject(record.project);validateStoredProject(record.project,{portablePaths:false});
    for(const shot of record.project.shots)assertSource(record.sources[shot.id]);
    const bytes=Buffer.byteLength(text);if(bytes<=32*1024*1024){while(this.cachedBytes+bytes>32*1024*1024&&this.versionCache.size){const oldest=this.versionCache.keys().next().value!;this.cachedBytes-=this.versionCache.get(oldest)!.bytes;this.versionCache.delete(oldest);}this.versionCache.set(key,{record,bytes});this.cachedBytes+=bytes;}
    return record;
  }
  private async physicalProject(root:string):Promise<VideoProject>{
    const project=migrateProject(JSON.parse(await fs.readFile(await projectPath(root,'project.json'),'utf8')) as VideoProject);
    validateStoredProject(project,{portablePaths:false});return project;
  }
  private async physicalSource(root:string,shot:Shot|string):Promise<SceneSource>{
    const folder=scenePath(shot);
    const result:SceneSource={html:await fs.readFile(await projectPath(root,folder+'/index.html'),'utf8'),css:await fs.readFile(await projectPath(root,folder+'/style.css'),'utf8'),js:await fs.readFile(await projectPath(root,folder+'/scene.js'),'utf8')};
    assertSource(result);return result;
  }
  private async assertPhysicalProjectPaths(root:string):Promise<void>{
    const state=await this.state(root);let project:VideoProject;
    if(state)project=(await this.version(root,state.current)).project;
    else try{project=await this.physicalProject(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    assertPortablePaths(project,true);
  }
  private async ensureState(root:string):Promise<StoreState|undefined>{
    const state=await this.state(root);if(state)return state;
    let project:VideoProject;
    try{project=await this.physicalProject(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    assertPortablePaths(project,true);
    const sources:Record<string,SceneSource>={};
    for(const shot of project.shots){try{sources[shot.id]=await this.physicalSource(root,shot);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;sources[shot.id]=defaultSceneSource();}}
    const baseline:StoredVersion={version:1,id:randomUUID(),label:'导入既有工程',createdAt:new Date().toISOString(),project,sources};
    await atomicWrite(await projectPath(root,`.studio/versions/${baseline.id}.json`),json(baseline));
    await this.indexRevision(root,baseline);
    const head:StoreState={version:1,current:baseline.id,undo:[],redo:[]};await atomicWrite(await projectPath(root,'.studio/state.json'),json(head));return head;
  }
  /** The atomic head rename is the commit point for project + every scene source. */
  commit(root:string,project:VideoProject,sourceChanges:Record<string,SceneSource>={},options:CommitOptions={}):Promise<VideoProject>{
    return this.queued(root,()=>this.commitVersion(root,project,sourceChanges,options));
  }
  private async commitVersion(root:string,project:VideoProject,sourceChanges:Record<string,SceneSource>,options:CommitOptions):Promise<VideoProject>{
    validateStoredProject(project);
    const state=await this.ensureState(root),previous=state?await this.version(root,state.current):undefined;
    if(previous&&project.id!==previous.project.id)throw new Error('不能改写工程 ID');
    if(options.expectedRevision!==undefined&&options.expectedRevision!==previous?.project.revision)throw Object.assign(new Error('工程版本已更新，请重新读取后合并修改'),{code:'REVISION_CONFLICT'});
    if(previous&&project.revision<=previous.project.revision)throw Object.assign(new Error('新提交的 revision 必须递增'),{code:'REVISION_CONFLICT'});
    const sources:Record<string,SceneSource>={};
    for(const id of Object.keys(sourceChanges))if(!project.shots.some(s=>s.id===id))throw new Error('源码引用的镜头不存在');
    for(const shot of project.shots){
      const origin=(project.extensions.sourceCopies as Record<string,string>|undefined)?.[shot.id];
      const originId=previous?.project.shots.find(s=>s.sourcePath===origin)?.id;
      const source=sourceChanges[shot.id]??previous?.sources[shot.id]??(originId?previous?.sources[originId]:undefined)??defaultSceneSource();
      assertSource(source);sources[shot.id]={html:source.html,css:source.css,js:source.js};
      await projectPath(root,shot.sourcePath+'/index.html');
    }
    for(const asset of project.assets)for(const file of [asset.path,asset.originalPath])if(file){const info=await fs.stat(await projectPath(root,file));if(!info.isFile())throw new Error('媒体文件不存在：'+file);}
    const saved=migrateProject(project);saved.updatedAt=new Date().toISOString();
    const record:StoredVersion={version:1,id:randomUUID(),label:options.label??'编辑工程',createdAt:saved.updatedAt,project:saved,sources};
    const stage=await projectPath(root,`.studio/staging/${record.id}.json`);await atomicWrite(stage,json(record));
    try{
      await this.options.onCommitPhase?.('staged');
      const destination=await projectPath(root,`.studio/versions/${record.id}.json`);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.rename(stage,destination);
      await this.indexRevision(root,record);
      const grouped=!!options.historyGroup&&state?.historyGroup===options.historyGroup;
      const next:StoreState={version:1,current:record.id,undo:state?[...state.undo,...(grouped?[]:[state.current])]:[],redo:[],historyGroup:options.historyGroup};
      try{await atomicWrite(await projectPath(root,'.studio/state.json'),json(next));}catch(error){if((await this.state(root))?.current!==next.current)throw error;}
    }finally{await fs.rm(stage,{force:true});}
    // Projection is recoverable after a successful commit; it cannot roll back the head.
    try{await this.options.onCommitPhase?.('committed');await this.projectVersion(root,record,previous);await this.options.onCommitPhase?.('projected');}catch{/* open() repairs projections from the committed snapshot. */}
    await this.remember(root,saved).catch(()=>{});return saved;
  }
  async save(root:string,project:VideoProject):Promise<VideoProject>{return this.commit(root,project);}
  private async projectVersion(root:string,record:StoredVersion,previous?:StoredVersion):Promise<void>{
    assertPortablePaths(record.project,true);
    let previousProjected=false;
    if(previous)try{previousProjected=JSON.parse(await fs.readFile(await projectPath(root,'.studio/projected.json'),'utf8')).current===previous.id;}catch{/* A missing/damaged projection marker means repair every scene file. */}
    for(const shot of record.project.shots){
      const prior=previous?.sources[shot.id],unchanged=!!prior&&JSON.stringify(prior)===JSON.stringify(record.sources[shot.id]);
      if(unchanged&&previousProjected&&previous?.project.shots.find(item=>item.id===shot.id)?.sourcePath===shot.sourcePath)continue;
      if(prior&&!unchanged)await atomicWrite(await projectPath(root,shot.sourcePath+'/previous.json'),json(prior));
      await this.writeSourceFiles(root,shot.sourcePath,record.sources[shot.id]!);
    }
    await atomicWrite(await projectPath(root,'project.json'),json(record.project));
    await atomicWrite(await projectPath(root,'.studio/projected.json'),json({version:1,current:record.id}));
  }
  open(root:string):Promise<VideoProject>{return this.queued(root,()=>this.openVersion(root));}
  private async openVersion(root:string):Promise<VideoProject>{
    const state=await this.ensureState(root);if(!state)throw new Error('未找到工程');
    const record=await this.version(root,state.current);await this.projectVersion(root,record);
    const staging=await projectPath(root,'.studio/staging');await fs.rm(staging,{recursive:true,force:true});
    await this.remember(root,record.project);return structuredClone(record.project);
  }
  async history(root:string):Promise<ProjectHistory>{
    const state=await this.ensureState(root);if(!state)throw new Error('未找到工程');
    const entries:HistoryEntry[]=[];
    for(const id of [...state.undo,state.current,...[...state.redo].reverse()]){const version=await this.version(root,id);entries.push({id,label:version.label,createdAt:version.createdAt,revision:version.project.revision});}
    return {canUndo:!!state.undo.length,canRedo:!!state.redo.length,cursor:state.undo.length,entries};
  }
  moveHistory(root:string,direction:'undo'|'redo',expectedRevision:number):Promise<VideoProject>{return this.queued(root,()=>this.moveVersionHistory(root,direction,expectedRevision));}
  private async moveVersionHistory(root:string,direction:'undo'|'redo',expectedRevision:number):Promise<VideoProject>{
    const state=await this.ensureState(root);if(!state)throw new Error('未找到工程');
    const current=await this.version(root,state.current);
    if(current.project.revision!==expectedRevision)throw Object.assign(new Error('工程版本冲突，请重新读取后再撤销或重做'),{code:'REVISION_CONFLICT'});
    const candidates=direction==='undo'?state.undo:state.redo,id=candidates.at(-1);if(!id)throw new Error(direction==='undo'?'没有可以撤销的变更':'没有可以重做的变更');
    const target=await this.version(root,id),project=structuredClone(target.project);
    // Outputs and session associations outlive editable content and must not be rolled back.
    project.outputs=structuredClone(current.project.outputs);
    if(current.project.sessionIds!==undefined)project.sessionIds=structuredClone(current.project.sessionIds);else delete project.sessionIds;
    if(Object.hasOwn(current.project.extensions,'sessionIds'))project.extensions.sessionIds=structuredClone(current.project.extensions.sessionIds);else delete project.extensions.sessionIds;
    project.revision=current.project.revision+1;project.updatedAt=new Date().toISOString();
    validateStoredProject(project);
    const restored:StoredVersion={...target,id:randomUUID(),label:direction==='undo'?'撤销：'+current.label:'重做：'+target.label,createdAt:project.updatedAt,project};
    const stage=await projectPath(root,`.studio/staging/${restored.id}.json`);await atomicWrite(stage,json(restored));
    try{
      await this.options.onCommitPhase?.('staged');const destination=await projectPath(root,`.studio/versions/${restored.id}.json`);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.rename(stage,destination);
      await this.indexRevision(root,restored);
      const next:StoreState={version:1,current:restored.id,undo:direction==='undo'?state.undo.slice(0,-1):[...state.undo,state.current],redo:direction==='redo'?state.redo.slice(0,-1):[...state.redo,state.current]};
      try{await atomicWrite(await projectPath(root,'.studio/state.json'),json(next));}catch(error){if((await this.state(root))?.current!==next.current)throw error;}
    }finally{await fs.rm(stage,{force:true});}
    try{await this.options.onCommitPhase?.('committed');await this.projectVersion(root,restored,current);}catch{/* Recovery uses the committed version. */}
    await this.remember(root,project).catch(()=>{});return project;
  }
  async duplicate(root:string,title?:string):Promise<{root:string;project:VideoProject}>{
    const state=await this.ensureState(root);if(!state)throw new Error('未找到工程');const current=await this.version(root,state.current),project=structuredClone(current.project);
    project.id='film_'+randomUUID().replaceAll('-','');project.title=title?.trim()||project.title+'（副本）';project.outputs=[];project.sessionIds=[];delete project.extensions.sessionIds;
    project.revision=0;project.createdAt=new Date().toISOString();project.updatedAt=project.createdAt;validateStoredProject(project);
    const slug=project.title.replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-|-$/g,'').slice(0,50)||'video';
    const destination=path.join(this.baseDirectory,slug+'-'+project.id);await fs.mkdir(destination,{recursive:false});
    try{
      await fs.mkdir(path.join(destination,'assets'),{recursive:true});
      for(const relative of new Set(project.assets.flatMap(asset=>[asset.path,asset.originalPath].filter((file):file is string=>typeof file==='string')))){
        const source=await projectPath(root,relative),file=await projectPath(destination,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.copyFile(source,file);
      }
      return {root:destination,project:await this.commit(destination,project,current.sources,{label:'复制工程'})};
    }catch(error){await fs.rm(destination,{recursive:true,force:true});throw error;}
  }
  async recent():Promise<RecentProject[]> {
    try {
      const items=JSON.parse(await fs.readFile(path.join(this.baseDirectory,'recent.json'),'utf8')) as RecentProject[];
      if(!Array.isArray(items))return [];
      const existing=await Promise.all(items.slice(0,20).map(async item=>{
        try { const state=await this.state(item.path);const project=state?(await this.version(item.path,state.current)).project:await this.physicalProject(item.path);return {path:item.path,title:project.title,id:project.id}; }
        catch{return null;}
      }));
      return existing.filter((item):item is RecentProject=>item!==null);
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  }
  private async remember(root:string,project:VideoProject):Promise<void> {
    await fs.mkdir(this.baseDirectory,{recursive:true});
    const items=await this.recent();
    await atomicWrite(path.join(this.baseDirectory,'recent.json'),json([{path:path.resolve(root),title:project.title,id:project.id},...items.filter(item=>path.resolve(item.path)!==path.resolve(root))].slice(0,20)));
  }
  async importAsset(root:string,input:ImportAssetInput,settings:Partial<EnvironmentSettings>={},signal?:AbortSignal):Promise<Asset>{
    const extension=path.extname(input.path??input.name??'').toLowerCase();
    if(input.mime?.startsWith('video/')||['.mp4','.mov','.webm','.mkv','.avi','.m4v','.ts'].includes(extension)||input.dataBase64?.startsWith('data:video/'))return this.importVideo(root,input,settings,signal);
    if(input.mime?.startsWith('audio/')||['.wav','.mp3','.m4a','.aac','.flac','.ogg'].includes(extension)||input.dataBase64?.startsWith('data:audio/'))return this.importAudio(root,input,settings,signal);
    return this.importImageOrText(root,input);
  }
  async importVideo(root:string,input:ImportAssetInput,settings:Partial<EnvironmentSettings>={},signal?:AbortSignal):Promise<Asset>{
    return importVideoFile(root,input,settings,relative=>projectPath(root,relative),signal);
  }
  async importAudio(root:string,input:ImportAssetInput,settings:Partial<EnvironmentSettings>={},signal?:AbortSignal):Promise<Asset>{
    signal?.throwIfAborted();const id=randomUUID(),temporary=await projectPath(root,'assets/'+id+'.audio-input');let buffer:Buffer;
    if(input.dataBase64!==undefined){
      const encoded=input.dataBase64.replace(/^data:[^;]+;base64,/,'');
      if(encoded.length>180_000_000||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('音频数据无效或超过 128 MB');buffer=Buffer.from(encoded,'base64');
    }else if(input.path){
      const info=await fs.stat(input.path);if(!info.isFile()||info.size>128*1024*1024)throw new Error('音频文件须不超过 128 MB');buffer=await fs.readFile(input.path);
    }else throw new Error('请选择音频文件');
    if(!buffer.length||buffer.length>128*1024*1024)throw new Error('音频文件须为 1 字节至 128 MB');
    try{
      await atomicWrite(temporary,buffer);const metadata=await probeAudio(temporary,settings,signal);signal?.throwIfAborted();
      const relative='assets/'+id+metadata.extension;await fs.rename(temporary,await projectPath(root,relative));
      return {id,kind:'audio',name:input.name??(input.path?path.basename(input.path):'音频素材'+metadata.extension),description:input.description??'',path:relative,mime:metadata.mime,duration:metadata.duration,sampleRate:metadata.sampleRate,channels:metadata.channels};
    }finally{await fs.rm(temporary,{force:true});}
  }
  async importImageOrText(root:string,input:ImportAssetInput):Promise<Asset> {
    const id=randomUUID(), description=input.description??'';
    if(typeof input.text==='string'){
      if(input.text.length>2_000_000)throw new Error('Text asset exceeds 2 MB');
      return {id,kind:'text',name:input.name??'文本素材',description,text:input.text,mime:'text/plain'};
    }
    let buffer:Buffer;
    if(input.dataBase64!==undefined){
      const base64=input.dataBase64.replace(/^data:[^;]+;base64,/, '');
      if(base64.length>28_000_000||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw new Error('Invalid or oversized image data');
      buffer=Buffer.from(base64,'base64');
    }else if(input.path){
      const info=await fs.stat(input.path);if(!info.isFile()||info.size>20_000_000)throw new Error('Image file must be at most 20 MB');
      const extension=path.extname(input.path).toLowerCase();
      if(['.txt','.md'].includes(extension)){
        if(info.size>2_000_000)throw new Error('Text asset exceeds 2 MB');
        return {id,kind:'text',name:input.name??path.basename(input.path),description,text:await fs.readFile(input.path,'utf8'),mime:'text/plain'};
      }
      buffer=await fs.readFile(input.path);
    }else throw new Error('Choose a PNG, JPEG, WebP image or text');
    if(buffer.length===0||buffer.length>20_000_000)throw new Error('Image file must be between 1 byte and 20 MB');
    const mime=sniffImage(buffer);
    if(!mime)throw new Error('Only PNG, JPEG and WebP images are supported');
    if(input.mime&&input.mime!==mime)throw new Error('Declared image MIME does not match file contents');
    const extension=mime==='image/png'?'.png':mime==='image/jpeg'?'.jpg':'.webp';
    const relative='assets/'+id+extension;
    await atomicWrite(await projectPath(root,relative),buffer);
    return {id,kind:'image',name:input.name??(input.path?path.basename(input.path):'图片素材'+extension),description,path:relative,mime,...imageSize(buffer,mime)};
  }
  private async indexRevision(root:string,record:StoredVersion):Promise<void>{
    await atomicWrite(await projectPath(root,`.studio/revisions/${record.project.revision}.json`),json({version:1,id:record.id,revision:record.project.revision}));
    await syncDirectory(await projectPath(root,'.studio/versions'));
  }
  private async snapshotVersion(root:string,state:StoreState,revision?:number):Promise<StoredVersion>{
    const current=await this.version(root,state.current);if(revision===undefined||revision===current.project.revision)return current;
    if(!Number.isSafeInteger(revision)||revision<0||revision>current.project.revision)throw new Error('请求的工程版本尚未提交');
    try{
      const pointer=JSON.parse(await fs.readFile(await projectPath(root,`.studio/revisions/${revision}.json`),'utf8')) as {id:string;revision:number};
      const record=await this.version(root,pointer.id);if(pointer.revision!==revision||record.project.revision!==revision)throw new Error('工程版本索引损坏');return record;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    // Compatibility with earlier local snapshots that did not have revision pointers.
    for(const name of await fs.readdir(await projectPath(root,'.studio/versions'))){if(!name.endsWith('.json'))continue;const record=await this.version(root,name.slice(0,-5));if(record.project.revision===revision){await this.indexRevision(root,record);return record;}}
    throw new Error('未找到请求的工程版本');
  }
  async readSource(root:string,shot:Shot|string,revision?:number):Promise<SceneSource> {
    const state=await this.state(root);
    if(state){const current=await this.snapshotVersion(root,state,revision);const found=typeof shot==='string'?current.project.shots.find(s=>s.sourcePath===shot):current.project.shots.find(s=>s.id===shot.id);if(!found)throw Object.assign(new Error('镜头源码不存在'),{code:'ENOENT'});return structuredClone(current.sources[found.id]!);}
    await this.assertPhysicalProjectPaths(root);
    return this.physicalSource(root,shot);
  }
  /** Used for detached render snapshots. Live engineering writes use commit(). */
  async writeSource(root:string,shot:Shot|string,source:SceneSource):Promise<void> {
    assertSource(source);const state=await this.state(root);
    if(state)throw new Error('已打开工程的源码须与工程通过 commit 一起提交');
    await this.assertPhysicalProjectPaths(root);
    const folder=scenePath(shot);
    try { const previous=await this.physicalSource(root,shot);await atomicWrite(await projectPath(root,folder+'/previous.json'),json(previous)); }
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await this.writeSourceFiles(root,folder,source);
  }
  private async writeSourceFiles(root:string,folder:string,source:SceneSource):Promise<void> {
    await atomicWrite(await projectPath(root,folder+'/source.json'),json(source));
    await atomicWrite(await projectPath(root,folder+'/index.html'),source.html);
    await atomicWrite(await projectPath(root,folder+'/style.css'),source.css);
    await atomicWrite(await projectPath(root,folder+'/scene.js'),source.js);
  }
  async markSourceGood(root:string,shot:Shot|string):Promise<void> {
    await this.assertPhysicalProjectPaths(root);
    const source=await this.readSource(root,shot);await atomicWrite(await projectPath(root,scenePath(shot)+'/last-good.json'),json(source));
  }
  async restorationSource(root:string,shot:Shot|string):Promise<SceneSource> {
    await this.assertPhysicalProjectPaths(root);
    const folder=scenePath(shot);let source:SceneSource;
    try{source=JSON.parse(await fs.readFile(await projectPath(root,folder+'/last-good.json'),'utf8')) as SceneSource;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;source=JSON.parse(await fs.readFile(await projectPath(root,folder+'/previous.json'),'utf8')) as SceneSource;}
    assertSource(source);return source;
  }
}

function sniffImage(buffer:Buffer):string|undefined {
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return 'image/jpeg';
  if(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP')return 'image/webp';
}
function imageSize(buffer:Buffer,mime:string):{width?:number;height?:number} {
  if(mime==='image/png'&&buffer.length>=24)return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
  return {};
}
