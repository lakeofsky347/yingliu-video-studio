import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,stat,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {Asset,EnvironmentSettings} from '../shared/types.js';
import {findToolExecutable,isExecutableFile} from '../host/tool-environment.js';

export interface VideoMetadata {duration:number;width:number;height:number;fps:{num:number;den:number};frameCount:number;hasAudio:boolean;mime:string}
export const MAX_VIDEO_BYTES=512*1024*1024;
const formats='mov,matroska,avi,mpegts';
export function videoByteLimit(settings:Partial<EnvironmentSettings>={}):number{const limit=settings.maxVideoBytes??MAX_VIDEO_BYTES;if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_VIDEO_BYTES)throw new Error('视频大小限制须为 1 字节至 512 MiB');return limit;}
function executable(name:'ffmpeg'|'ffprobe',configured?:string):string {
  const value=configured||findToolExecutable(name);if(!value||!isExecutableFile(value))throw new Error(name+' 未就绪，请在环境设置中配置');return value;
}
/** Bounded subprocess owned only by this operation; an abort waits for termination. */
function run(file:string,args:string[],signal?:AbortSignal,timeoutMs=30_000):Promise<string>{
  signal?.throwIfAborted();return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{stdio:['ignore','pipe','pipe']});let output='',error='',reason:Error|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),1500);killTimer.unref();};
    const cancel=()=>{reason=new Error('视频处理已取消');stop();};signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>{reason=new Error('视频处理超时');stop();},timeoutMs);timer.unref();
    child.stdout.on('data',bytes=>{output+=String(bytes);if(output.length>2_000_000){reason=new Error('视频探测输出超过限制');stop();}});
    child.stderr.on('data',bytes=>{error=(error+String(bytes)).slice(-4000);});
    const finish=()=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener('abort',cancel);};
    child.once('error',cause=>{finish();reject(cause);});child.once('close',code=>{finish();if(reason)reject(reason);else if(code!==0)reject(new Error('视频处理失败：'+error.slice(-1400)));else resolve(output);});
  });
}
function rational(value:unknown):{num:number;den:number}{
  const match=/^(\d+)\/(\d+)$/.exec(String(value));if(!match)throw new Error('视频帧率无法读取');
  const num=Number(match[1]),den=Number(match[2]);if(!Number.isSafeInteger(num)||!Number.isSafeInteger(den)||num<=0||den<=0||num/den>120)throw new Error('视频帧率须为 0–120 FPS');return {num,den};
}
export async function probeVideo(file:string,settings:Partial<EnvironmentSettings>={},signal?:AbortSignal):Promise<VideoMetadata>{
  signal?.throwIfAborted();const limit=videoByteLimit(settings),info=await stat(file);if(!info.isFile()||!info.size||info.size>limit)throw new Error('视频文件超出本机大小限制（'+limit+' 字节）');
  const output=await run(executable('ffprobe',settings.ffprobePath),['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',formats,'-show_entries','stream=codec_type,width,height,avg_frame_rate,r_frame_rate,nb_frames,duration:stream_disposition=attached_pic:format=duration,format_name','-of','json',file],signal);
  const data=JSON.parse(output),video=data.streams?.find((stream:any)=>stream.codec_type==='video'&&!stream.disposition?.attached_pic);
  if(!video)throw new Error('文件未包含可播放的视频流');
  const width=Number(video.width),height=Number(video.height),duration=Number(video.duration??data.format?.duration),fps=rational(video.avg_frame_rate==='0/0'?video.r_frame_rate:video.avg_frame_rate);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>8192||height>8192||!(duration>0)||duration>3600||!Number.isFinite(duration))throw new Error('视频尺寸或时长超出范围（最大 8192 像素、60 分钟）');
  const frameCount=Number(video.nb_frames)||Math.max(1,Math.ceil(duration*fps.num/fps.den));
  return {width,height,duration,fps,frameCount,hasAudio:data.streams.some((stream:any)=>stream.codec_type==='audio'),mime:String(data.format?.format_name).includes('matroska')?'video/x-matroska':String(data.format?.format_name).includes('avi')?'video/x-msvideo':String(data.format?.format_name).includes('mpegts')?'video/mp2t':'video/mp4'};
}
export async function hashMediaFile(file:string,signal?:AbortSignal):Promise<string>{
  const hash=createHash('sha256');for await(const chunk of createReadStream(file,{signal}))hash.update(chunk);return hash.digest('hex');
}
/** Import to a new immutable CFR proxy; callers add the returned reference in their project transaction. */
export async function importVideoFile(root:string,input:{path?:string;dataBase64?:string;mime?:string;name?:string;description?:string},settings:Partial<EnvironmentSettings>,resolvePath:(relative:string)=>Promise<string>,signal?:AbortSignal):Promise<Asset>{
  signal?.throwIfAborted();const limit=videoByteLimit(settings),id=randomUUID(),relative='assets/'+id+'.mp4',destination=await resolvePath(relative);
  const original=await resolvePath('assets/'+id+'.video-input'),temporary=await resolvePath('assets/'+id+'.video-proxy.mp4');let retainedOriginal:string|undefined,completed=false;await mkdir(dirname(destination),{recursive:true});
  try{
    if(input.path){
      const selected=await stat(input.path);if(!selected.isFile()||!selected.size||selected.size>limit)throw new Error('视频文件超出本机大小限制，或不是普通文件');
      let bytes=0;const bound=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;callback(bytes>limit?new Error('视频文件超过本机大小限制'):null,chunk);}});
      await pipeline(createReadStream(input.path),bound,createWriteStream(original,{flags:'wx'}),{signal});
    }else if(input.dataBase64!==undefined){
      const encoded=input.dataBase64.replace(/^data:[^;]+;base64,/,'');
      if(encoded.length>44_739_244||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('内存视频导入限制为 32 MiB，请使用本地文件路径导入较大视频');
      await writeFile(original,Buffer.from(encoded,'base64'),{flag:'wx',signal});
    }else throw new Error('请选择视频文件');
    const source=await probeVideo(original,settings,signal),sourceSha256=await hashMediaFile(original,signal);
    // All-intra CFR H.264 keeps arbitrary seeks bounded and decodable by the bundled browser.
    const fps=source.fps.num+'/'+source.fps.den;
    await run(executable('ffmpeg',settings.ffmpegPath),['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-format_whitelist',formats,'-i',original,'-map','0:v:0','-map','0:a:0?','-vf','scale=ceil(iw/2)*2:ceil(ih/2)*2,fps='+fps,'-c:v','libx264','-preset','veryfast','-crf','20','-g','1','-pix_fmt','yuv420p','-fps_mode','cfr','-c:a','aac','-ar','48000','-ac','2','-map_metadata','-1','-movflags','+faststart','-fs',String(limit+1),'-y',temporary],signal,30*60_000);
    const metadata=await probeVideo(temporary,settings,signal);
    if(Math.abs(metadata.duration-source.duration)>Math.max(.1,2*source.fps.den/source.fps.num))throw new Error('规范化视频时长与输入不符，文件可能超过处理大小限制');
    const sha256=await hashMediaFile(temporary,signal),extension=({'video/mp4':'.mp4','video/x-matroska':'.mkv','video/x-msvideo':'.avi','video/mp2t':'.ts'} as Record<string,string>)[source.mime];
    const originalPath='assets/'+id+'.original'+extension;retainedOriginal=await resolvePath(originalPath);signal?.throwIfAborted();await rename(temporary,destination);await rename(original,retainedOriginal);completed=true;
    return {id,kind:'video',name:input.name??(input.path?basename(input.path):'视频素材.mp4'),description:input.description??'',path:relative,originalPath,...metadata,mime:'video/mp4',sha256,sourceSha256};
  }finally{await rm(original,{force:true});await rm(temporary,{force:true});if(!completed){await rm(destination,{force:true});if(retainedOriginal)await rm(retainedOriginal,{force:true});}}
}
