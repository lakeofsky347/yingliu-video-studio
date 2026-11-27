import { Zip, ZipPassThrough, Unzip, UnzipInflate } from 'fflate';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, openSync, closeSync, writeSync, mkdirSync } from 'node:fs';
import { readFile, mkdir, stat, mkdtemp, rm, open } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { type ProjectStore, projectPath, validateStoredProject } from './store.ts';
import { defaultProductionPolicy,applyProductionPolicy,usesCodeVisual } from '../core/production-policy.ts';
import { defaultSceneSource } from '../core/default-source.ts';
import { portableProjectPathReason } from '../core/project-paths.ts';
import { readDirectorDocument,validateProjectDirectorPlan } from '../director/document.ts';
import { parseSceneSource } from './generator.ts';
import { atomicRename } from './atomic-rename.ts';
import type { Asset, VideoProject } from '../shared/types.ts';

const MiB=1024*1024;
/** Reserve space for ZIP32 headers and central-directory entries below the 4 GiB format limit. */
const LIMIT=4*1024*MiB-MiB,FILE_LIMIT=512*MiB,METADATA_LIMIT=24*MiB,ENTRY_LIMIT=256;
const json=(value:unknown)=>Buffer.from(JSON.stringify(value));
function assetPaths(asset:Asset):string[]{return [...new Set([asset.path,asset.originalPath].filter((value):value is string=>typeof value==='string'))];}
interface ArchiveEntry {name:string;bytes:number;sha256:string}
interface ExtractedEntry extends ArchiveEntry {path:string;complete:boolean}
function allowed(name:string){
  return name==='manifest.json'||name==='project.json'||/^sources\/[\w-]{1,100}\.json$/.test(name)||
    /^agent\/(story|ledger|qc)\.json$/.test(name)||name.startsWith('assets/')&&!portableProjectPathReason(name);
}
function fileLimit(name:string){return name.startsWith('assets/')?FILE_LIMIT:METADATA_LIMIT;}
function cleanProject(project:VideoProject):VideoProject{
  const value=structuredClone(project);value.outputs=[];delete value.sessionIds;
  for(const key of ['sessionIds','sourceCopies','importApplications','mediaApplications','workflowApplications','workflowInitializations','directorApprovedDocument','previzApprovals'])delete value.extensions[key];
  return value;
}

/** Write ZIP chunks immediately; media never passes through a whole-file buffer or JSON/base64. */
async function writeArchive(file:string,entries:{name:string;bytes?:Uint8Array;path?:string}[],project:VideoProject,signal?:AbortSignal):Promise<number>{
  const handle=await open(file,'wx'),pending:Uint8Array[]=[],records:ArchiveEntry[]=[];let error:Error|undefined,final=false,total=0,outputSize=0;
  const archive=new Zip((cause,chunk,finished)=>{if(cause){error=cause;return;}pending.push(chunk);if(finished)final=true;});
  const flush=async()=>{if(error)throw error;for(const chunk of pending.splice(0)){outputSize+=chunk.length;if(outputSize>LIMIT)throw new Error('工程包输出超过总量限额 '+LIMIT+' 字节');let written=0;while(written<chunk.length){const result=await handle.write(chunk,written,chunk.length-written);if(!result.bytesWritten)throw new Error('工程包写入失败');written+=result.bytesWritten;}}};
  const add=async(entry:{name:string;bytes?:Uint8Array;path?:string},record=true)=>{
    const stream=new ZipPassThrough(entry.name),hash=createHash('sha256');let size=0;archive.add(stream);await flush();
    const push=async(bytes:Uint8Array)=>{signal?.throwIfAborted();size+=bytes.length;total+=bytes.length;if(size>fileLimit(entry.name)||total>LIMIT)throw new Error('工程素材超过安全大小限额（单文件 '+FILE_LIMIT+' 字节，总量 '+LIMIT+' 字节）');hash.update(bytes);stream.push(bytes);await flush();};
    if(entry.bytes)await push(entry.bytes);
    else if(entry.path)for await(const bytes of createReadStream(entry.path,{highWaterMark:64*1024}))await push(bytes);
    stream.push(new Uint8Array(),true);await flush();if(record)records.push({name:entry.name,bytes:size,sha256:hash.digest('hex')});
  };
  try{
    for(const entry of entries)await add(entry);
    await add({name:'manifest.json',bytes:json({format:'yingliu-project',schemaVersion:2,projectSchemaVersion:project.schemaVersion,appVersion:'1.0.0',createdAt:new Date().toISOString(),files:records})},false);
    archive.end();await flush();if(!final)throw new Error('工程包未完成写入');await handle.sync();return outputSize;
  }finally{archive.terminate();await handle.close();}
}

/** Streaming inflate writes only into a fresh private staging directory, validating actual expanded sizes. */
async function extractArchive(filePath:string,directory:string,signal?:AbortSignal):Promise<Map<string,ExtractedEntry>>{
  const files=new Map<string,ExtractedEntry>(),handles=new Set<number>(),paths=new Set<string>();let total=0,compressed=0,tail=Buffer.alloc(0);
  const consume=(bytes:Uint8Array)=>{signal?.throwIfAborted();compressed+=bytes.length;if(compressed>LIMIT)throw new Error('工程包输入超过总量限额 '+LIMIT+' 字节');tail=Buffer.concat([tail,bytes]).subarray(-65557);unzip.push(bytes);};
  const unzip=new Unzip(file=>{
    const portableKey=file.name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
    if(files.size>=ENTRY_LIMIT||!allowed(file.name)||paths.has(portableKey))throw new Error('工程包含不支持、重复或不安全的路径');
    paths.add(portableKey);
    const maximum=fileLimit(file.name);if((file.originalSize??0)>maximum)throw new Error('工程包单文件超过安全大小限额 '+maximum+' 字节（元数据硬上限 24 MiB）');
    const destination=join(directory,...file.name.split('/'));mkdirSync(dirname(destination),{recursive:true});const fd=openSync(destination,'wx');handles.add(fd);
    const record:ExtractedEntry={name:file.name,path:destination,bytes:0,sha256:'',complete:false},hash=createHash('sha256');files.set(file.name,record);
    file.ondata=(error,chunk,final)=>{
      if(error)throw error;record.bytes+=chunk.length;total+=chunk.length;
      if(record.bytes>maximum||total>LIMIT){file.terminate();throw new Error('工程包解压后超过安全大小限额');}
      hash.update(chunk);let offset=0;while(offset<chunk.length){const written=writeSync(fd,chunk,offset,chunk.length-offset);if(!written)throw new Error('工程包素材写入失败');offset+=written;}
      if(final){record.complete=true;record.sha256=hash.digest('hex');closeSync(fd);handles.delete(fd);}
    };file.start();
  });unzip.register(UnzipInflate);
  try{
    const info=await stat(filePath);
    if(!info.isFile()||info.size>LIMIT)throw new Error('工程包文件超过总量限额 '+LIMIT+' 字节');
    for await(const bytes of createReadStream(filePath,{highWaterMark:64*1024,signal})){consume(bytes);}
    unzip.push(new Uint8Array(),true);
    let end=-1;for(let offset=tail.length-22;offset>=0;offset--)if(tail.readUInt32LE(offset)===0x06054b50&&offset+22+tail.readUInt16LE(offset+20)===tail.length){end=offset;break;}
    if(end<0||tail.readUInt16LE(end+4)!==0||tail.readUInt16LE(end+6)!==0||tail.readUInt16LE(end+8)!==files.size||tail.readUInt16LE(end+10)!==files.size||tail.readUInt32LE(end+12)+tail.readUInt32LE(end+16)!==compressed-tail.length+end)throw new Error('工程包被截断或 ZIP 目录损坏');
    if([...files.values()].some(file=>!file.complete))throw new Error('工程包被截断，素材未完整解压');return files;
  }finally{for(const fd of handles)closeSync(fd);}
}

/** Export a single immutable revision from the project directory through the host filesystem. */
export async function exportProjectArchive(store:ProjectStore,root:string,input:VideoProject,signal?:AbortSignal){
  const project=cleanProject(input);validateStoredProject(project);
  const entries:{name:string;bytes?:Uint8Array;path?:string}[]=[{name:'project.json',bytes:json(project)}];
  for(const shot of project.shots){
    const name='sources/'+shot.id+'.json';
    if(!allowed(name))throw new Error('工程包含无效镜头 ID');
    const source=await store.readSource(root,shot,project.revision).catch(error=>{
      if((error as NodeJS.ErrnoException).code!=='ENOENT'||usesCodeVisual(shot))throw error;
      return defaultSceneSource();
    });
    entries.push({name,bytes:json(source)});
  }
  for(const name of new Set(project.assets.flatMap(assetPaths))){
    if(!allowed(name)||!name.startsWith('assets/'))throw new Error('工程包含不安全的素材路径');
    const asset=await projectPath(root,name),info=await stat(asset);
    if(!info.isFile()||info.size>FILE_LIMIT)throw new Error('工程媒体单文件须不超过 512 MiB');
    entries.push({name,path:asset});
  }
  if(entries.length+1>ENTRY_LIMIT)throw new Error('工程包文件数量超过 256');
  const file=await projectPath(root,'exports/project-'+project.revision+'-'+randomUUID()+'.yingliu'),temporary=file+'.tmp-'+randomUUID();
  await mkdir(dirname(file),{recursive:true});
  try{
    const size=await writeArchive(temporary,entries,project,signal);
    const current=await store.open(root);
    if(current.revision!==project.revision)throw new Error('备份期间工程发生变化，请等待保存后重试');
    signal?.throwIfAborted();await atomicRename(temporary,file);
    return {path:file,size,revision:project.revision};
  }finally{await rm(temporary,{force:true});}
}

export async function importProjectArchive(store:ProjectStore,filePath:string,signal?:AbortSignal){
  if(!isAbsolute(filePath)||extname(filePath).toLowerCase()!=='.yingliu')throw new Error('请输入本机 .yingliu 工程包的绝对路径');
  const directory=await mkdtemp(join(tmpdir(),'yingliu-import-'));
  try{
    const files=await extractArchive(filePath,directory,signal),manifestFile=files.get('manifest.json'),projectFile=files.get('project.json');
    if(!manifestFile||!projectFile)throw new Error('文件不是有效的映流工程包');
    const manifest=JSON.parse(await readFile(manifestFile.path,'utf8'));
    if(!manifest||manifest.format!=='yingliu-project'||![1,2].includes(manifest.schemaVersion)||!Array.isArray(manifest.files))throw new Error('不支持此工程包版本');
    if(manifest.files.length!==files.size-1)throw new Error('工程包清单不完整');
    const seen=new Set<string>();
    for(const entry of manifest.files as ArchiveEntry[]){
      if(!entry||typeof entry.name!=='string'||seen.has(entry.name)||entry.name==='manifest.json')throw new Error('工程包清单路径无效');
      seen.add(entry.name);
      const file=files.get(entry.name);
      if(!file||entry.bytes!==file.bytes||entry.sha256!==file.sha256)throw new Error('工程包内容损坏：'+entry.name);
    }
    const project=cleanProject(JSON.parse(await readFile(projectFile.path,'utf8')) as VideoProject);validateStoredProject(project);
    const document=readDirectorDocument(project);
    if(document){
      validateProjectDirectorPlan(project,document.plan);
      project.extensions.directorDocument={schemaVersion:1,version:document.version,status:'draft',hash:document.hash,plan:document.plan,updatedAt:document.updatedAt};
    }
    const sources=[];
    for(const shot of project.shots){
      const entry=files.get('sources/'+shot.id+'.json');
      if(!entry)throw new Error('工程包缺少镜头源码');
      sources.push({shotId:shot.id,source:parseSceneSource(await readFile(entry.path,'utf8'))});
    }
    const assetFiles=[...new Set(project.assets.flatMap(assetPaths))].map(path=>{
      const entry=files.get(path);
      if(!entry||!path.startsWith('assets/'))throw new Error('工程包缺少素材 '+path);
      return {path,localPath:entry.path};
    });
    project.id='film-'+randomUUID();project.revision=0;
    for(const asset of project.assets){
      delete asset.generation;
      asset.provenance={origin:'unknown',usage:asset.provenance?.usage??'production'};
    }
    signal?.throwIfAborted();
    return await store.create({project:applyProductionPolicy(project,defaultProductionPolicy()),sources,assetFiles});
  }finally{await rm(directory,{recursive:true,force:true});}
}
