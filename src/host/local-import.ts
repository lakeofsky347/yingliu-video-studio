import {createHash} from 'node:crypto';
import {open,mkdir,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {basename,extname,dirname} from 'node:path';
import type {ImportAssetInput} from './store.ts';

/** Large local videos keep the existing streaming path while freezing bytes once. */
export async function freezeLocalVideo(input:ImportAssetInput,target:string,limit:number):Promise<{input:ImportAssetInput;sha256:string}|undefined>{
  if(typeof input.path!=='string'||input.dataBase64!==undefined||input.text!==undefined||!(input.mime?.startsWith('video/')||['.mp4','.mov','.webm','.mkv','.avi','.m4v','.ts'].includes(extname(input.path).toLowerCase())))return;
  const source=await open(input.path,'r'),hash=createHash('sha256');let bytes=0;
  try{
    const info=await source.stat();if(!info.isFile()||!info.size||info.size>limit)throw new Error('视频文件为空或超过大小上限');
    await mkdir(dirname(target),{recursive:true});
    await pipeline(source.createReadStream({autoClose:false}),new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>limit||bytes>info.size){callback(new Error('素材在读取时发生变化'));return;}hash.update(chunk);callback(null,chunk);}}),createWriteStream(target,{flags:'wx'}));
    if(bytes!==info.size)throw new Error('素材在读取时发生变化');
    const handle=await open(target,'r');try{await handle.sync();}finally{await handle.close();}
    return {input:{path:target,mime:input.mime??'video/mp4',name:input.name??basename(input.path),description:input.description},sha256:hash.digest('hex')};
  }catch(error){await rm(target,{force:true});throw error;}finally{await source.close();}
}

/** Freeze local bytes before staging/retrying. A changing source path is never replayed. */
export async function freezeImport(input:ImportAssetInput,maxVideoBytes=512*1024*1024):Promise<ImportAssetInput>{
  const frozen:ImportAssetInput={};
  for(const key of ['mime','name','description','text','dataBase64'] as const)if(input[key]!==undefined){if(typeof input[key]!=='string')throw new Error('素材输入须为字符串');frozen[key]=input[key];}
  if(frozen.text!==undefined||frozen.dataBase64!==undefined)return frozen;
  if(typeof input.path!=='string'||!input.path)throw new Error('请选择素材文件');
  const extension=extname(input.path).toLowerCase(),text=['.txt','.md'].includes(extension),audio=input.mime?.startsWith('audio/')||['.wav','.mp3','.m4a','.aac','.flac','.ogg'].includes(extension),video=input.mime?.startsWith('video/')||['.mp4','.mov','.webm','.mkv','.avi','.m4v','.ts'].includes(extension);
  const limit=text?2_000_000:video?maxVideoBytes:audio?128*1024*1024:20_000_000;
  const handle=await open(input.path,'r');let bytes:Buffer;
  try{const info=await handle.stat();if(!info.isFile()||info.size<1||info.size>limit)throw new Error('素材文件为空或超过大小上限');bytes=Buffer.alloc(info.size);let offset=0;while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)throw new Error('素材在读取时发生变化');offset+=result.bytesRead;}const tail=Buffer.alloc(1);if((await handle.read(tail,0,1,bytes.length)).bytesRead)throw new Error('素材在读取时发生变化');}finally{await handle.close();}
  frozen.name??=basename(input.path);if(video)frozen.mime??='video/mp4';else if(audio)frozen.mime??='audio/wav';if(text)frozen.text=bytes.toString('utf8');else frozen.dataBase64=bytes.toString('base64');return frozen;
}
export function importDigest(input:ImportAssetInput,audio:Record<string,unknown>|undefined):string{
  return createHash('sha256').update(JSON.stringify({input,audio})).digest('hex');
}
/** Only the store's proven pre-write CAS rejection permits an append retry. */
export async function retryLocalAppend<T>(attempt:()=>Promise<T>,refresh:()=>Promise<void>):Promise<T>{
  for(let i=0;;i++)try{return await attempt();}catch(error){
    if(i>=2||!error||typeof error!=='object'||!('code'in error)||error.code!=='REVISION_CONFLICT'||!('localWriteNotStarted'in error)||error.localWriteNotStarted!==true)throw error;
    await refresh();
  }
}
