import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {GeneratedFile,MediaArtifact} from './contracts.ts';

export function mediaSignature(bytes:Uint8Array):string|undefined {
  const b=Buffer.from(bytes);
  if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
  if(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(b.subarray(4,8).toString()==='ftyp')return 'video/mp4';
  if(b.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'video/webm';
  return undefined;
}
function artifactUrl(raw:string):URL {const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('媒体产物地址必须是无内嵌凭据的 HTTP(S) URL');return url;}
/** Artifact requests deliberately never carry provider credentials, including across redirects. */
export async function downloadArtifact(artifact:MediaArtifact,directory:string,index:number,options:{signal:AbortSignal;fetch?:typeof fetch;maxBytes:number;expected:'image'|'video'}):Promise<Omit<GeneratedFile,'metadata'>> {
  await mkdir(directory,{recursive:true});const temporary=join(directory,randomUUID()+'.part');const handle=await open(temporary,'wx');const hash=createHash('sha256');let bytes=0,head=Buffer.alloc(0);let destination='';
  const write=async(chunk:Uint8Array)=>{options.signal.throwIfAborted();bytes+=chunk.byteLength;if(bytes>options.maxBytes)throw new Error('媒体产物超过配置的文件大小限制');if(head.length<64)head=Buffer.concat([head,chunk.subarray(0,64-head.length)]);hash.update(chunk);await handle.writeFile(chunk);};
  try {
    if(artifact.base64){if(artifact.base64.length>Math.ceil(options.maxBytes*4/3)+4)throw new Error('媒体产物超过配置的文件大小限制');for(let offset=0;offset<artifact.base64.length;offset+=65536)await write(Buffer.from(artifact.base64.slice(offset,offset+65536),'base64'));}
    else if(artifact.url){let url=artifactUrl(artifact.url),response:Response|undefined;
      for(let redirects=0;redirects<6;redirects++){response=await (options.fetch??fetch)(url,{signal:options.signal,redirect:'manual'});if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new Error('媒体下载重定向缺少地址');url=artifactUrl(new URL(location,url).href);continue;}break;}
      if(!response?.ok||!response.body)throw new Error('媒体下载失败（HTTP '+(response?.status??'unknown')+'）');
      if(Number(response.headers.get('content-length'))>options.maxBytes){await response.body.cancel();throw new Error('媒体产物超过配置的文件大小限制');}
      const reader=response.body.getReader();try{while(true){const next=await reader.read();if(next.done)break;await write(next.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    }else throw new Error('媒体产物没有下载地址');
    const mimeType=mediaSignature(head);if(!bytes||!mimeType||!mimeType.startsWith(options.expected+'/'))throw new Error('媒体产物真实格式与生成类型不符');
    const extension=({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','video/webm':'.webm'} as Record<string,string>)[mimeType]!;
    const digest=hash.digest('hex');destination=join(directory,String(index)+'-'+digest+extension);await handle.sync();await handle.close();await rename(temporary,destination);
    return {path:destination,mimeType,name:artifact.name?.slice(0,160)||'生成素材 '+(index+1)+extension,bytes,sha256:digest};
  }catch(error){await handle.close().catch(()=>{});await rm(temporary,{force:true});throw error;}
}
