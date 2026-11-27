import {AudioProcesses, audioExecutable} from '../host/audio.ts';
import type {EnvironmentSettings} from '../shared/types.ts';

export interface VideoShotBoundary {
  index:number;
  startSeconds:number;
  endSeconds:number;
  durationSeconds:number;
  cutScore?:number;
}

export interface ReferenceVideoAnalysis {
  durationSeconds:number;
  width:number;
  height:number;
  fps:number;
  hasAudio:boolean;
  shotCount:number;
  averageShotLengthSeconds:number;
  pacing:'fast_montage'|'dynamic_commercial'|'narrative_balanced'|'slow_cinematic';
  shots:VideoShotBoundary[];
}

export interface AudioAcousticReport {
  integratedLufs:number|null;
  loudnessRangeLu:number|null;
  truePeakDbtp:number|null;
  clippingRisk:boolean;
  tooQuiet:boolean;
  silenceIntervals:{startSeconds:number;endSeconds:number;durationSeconds:number}[];
  totalSilenceSeconds:number;
}

const measuredNumber='(-?(?:\\d+(?:\\.\\d+)?|inf))';
const roundMillis=(time:number)=>Math.round(time*1000)/1000;

/** Keep only one partial line across chunks so diagnostics can be read without retaining long FFmpeg logs. */
function readLines(visit:(line:string)=>void){
  let rest='';
  return (chunk:string)=>{
    const lines=(rest+chunk).split(/\r?\n/);
    rest=lines.pop()!.slice(-8192);
    for(const line of lines)visit(line);
  };
}

function budget(signal:AbortSignal|undefined,ms:number):AbortSignal {
  const timeout=AbortSignal.timeout(ms);
  return signal?AbortSignal.any([signal,timeout]):timeout;
}

/** Measure the complete selected audio stream. Integrated values come only from the final EBU R128 summary. */
export async function analyzeAudioAcoustics(filePath:string,settings:Partial<EnvironmentSettings>={},signal?:AbortSignal):Promise<AudioAcousticReport> {
  const processes=new AudioProcesses(),active=budget(signal,45_000);
  const silenceIntervals:AudioAcousticReport['silenceIntervals']=[];
  let summary='',inSummary=false,pendingStart:number|undefined,totalSilenceSeconds=0;
  const listen=readLines(line=>{
    if(line.includes('Summary:')){inSummary=true;summary='';}
    if(inSummary&&summary.length<8192)summary+=line+'\n';
    const start=/silence_start:\s*(-?[\d.]+)/.exec(line);
    if(start)pendingStart=Number(start[1]);
    const end=/silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/.exec(line);
    if(end){
      const endSeconds=Math.max(0,Number(end[1])),startSeconds=Math.max(0,pendingStart??endSeconds-Number(end[2]));
      const durationSeconds=endSeconds-startSeconds;
      pendingStart=undefined;
      if(!(durationSeconds>0))return;
      totalSilenceSeconds+=durationSeconds;
      if(silenceIntervals.length<40)silenceIntervals.push({startSeconds:roundMillis(startSeconds),endSeconds:roundMillis(endSeconds),durationSeconds:roundMillis(durationSeconds)});
    }
  });
  try{
    await processes.run(audioExecutable('ffmpeg',settings.ffmpegPath),['-hide_banner','-nostats','-i',filePath,'-map','0:a:0','-af','silencedetect=noise=-45dB:d=0.6,ebur128=framelog=verbose:peak=true','-vn','-f','null','-'],active,listen);
    listen('\n');
  }catch(error){active.throwIfAborted();throw error;}
  finally{await processes.close();}
  const read=(label:string,unit:string)=>new RegExp(`^\\s*${label}:\\s*${measuredNumber}\\s*${unit}\\s*$`,'m').exec(summary)?.[1];
  const number=(value:string|undefined)=>value!==undefined&&Number.isFinite(Number(value))?Number(value):null;
  const integrated=read('I','LUFS'),loudnessRange=read('LRA','LU'),truePeak=read('Peak','dBFS');
  if(integrated===undefined||loudnessRange===undefined||truePeak===undefined)throw new Error('FFmpeg 未返回完整的响度摘要');
  const integratedLufs=number(integrated),loudnessRangeLu=number(loudnessRange),truePeakDbtp=number(truePeak);
  return {integratedLufs,loudnessRangeLu,truePeakDbtp,clippingRisk:truePeakDbtp!==null&&truePeakDbtp>-.2,
    tooQuiet:integrated==='-inf'||integratedLufs!==null&&integratedLufs< -30,silenceIntervals,totalSilenceSeconds:roundMillis(totalSilenceSeconds)};
}

/** FFmpeg scene scores indicate candidate cuts. They do not infer the contents of the shots. */
export async function deconstructReferenceVideo(filePath:string,settings:Partial<EnvironmentSettings>={},options:{threshold?:number;signal?:AbortSignal}={}):Promise<ReferenceVideoAnalysis> {
  const threshold=options.threshold??12;
  if(!Number.isFinite(threshold)||threshold<4||threshold>40)throw new Error('切镜侦测阈值须在 4–40 之间');
  const processes=new AudioProcesses(),active=budget(options.signal,60_000);
  try{
    const data=await processes.run(audioExecutable('ffprobe',settings.ffprobePath),['-v','error','-show_entries','stream=codec_type,width,height,avg_frame_rate,r_frame_rate:format=duration','-of','json',filePath],active);
    const info=JSON.parse(data) as {streams?:{codec_type:string;width?:number;height?:number;avg_frame_rate?:string;r_frame_rate?:string}[];format?:{duration?:string}};
    const video=info.streams?.find(stream=>stream.codec_type==='video'),duration=Number(info.format?.duration);
    const rate=(value:string|undefined)=>{const [num,den]=(value??'').split('/').map(Number);return num!/den!;};
    const fps=rate(video?.avg_frame_rate)||rate(video?.r_frame_rate);
    if(!video?.width||!video.height||!Number.isFinite(duration)||duration<=0||!Number.isFinite(fps)||fps<=0)throw new Error('参考片缺少可识别的视频画面、时长或帧率');
    const shots:VideoShotBoundary[]=[];
    let cursor=0,shotCount=0;
    const add=(time:number,cutScore?:number)=>{
      shotCount++;
      if(shots.length<500)shots.push({index:shotCount,startSeconds:roundMillis(cursor),endSeconds:roundMillis(time),durationSeconds:roundMillis(time-cursor),...(cutScore!==undefined?{cutScore}:{})});
      cursor=time;
    };
    const listen=readLines(line=>{
      const cut=/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*(-?[\d.]+)/.exec(line);
      if(!cut)return;
      const time=Number(cut[2]);
      if(time>cursor+.15&&time<duration-.15)add(time,Number(cut[1]));
    });
    await processes.run(audioExecutable('ffmpeg',settings.ffmpegPath),['-hide_banner','-nostats','-i',filePath,'-map','0:v:0','-vf',`scdet=threshold=${threshold}`,'-an','-f','null','-'],active,listen);
    listen('\n');
    add(duration);
    const average=duration/shotCount,pacing=average<1.5?'fast_montage':average<3?'dynamic_commercial':average<6?'narrative_balanced':'slow_cinematic';
    return {durationSeconds:roundMillis(duration),width:video.width,height:video.height,fps,hasAudio:!!info.streams?.some(stream=>stream.codec_type==='audio'),shotCount,averageShotLengthSeconds:roundMillis(average),pacing,shots};
  }catch(error){active.throwIfAborted();throw error;}
  finally{await processes.close();}
}
