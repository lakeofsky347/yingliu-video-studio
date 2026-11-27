import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {compileSpec} from '../core/index.ts';
import {assertProductionComposition} from '../core/production-policy.ts';
import {formatAss,formatSrt,projectSubtitles} from '../core/subtitles.ts';
import {exchangeEdlLimitation,formatExchangeEdl,formatExchangeFcpxml,formatExchangeOtio,type ExchangeTimeline} from '../media/timeline-exchange.ts';
import {hashMediaFile} from '../media/video.ts';
import type {EnvironmentSettings,VideoProject} from '../shared/types.ts';
import {writeDurableFile} from '../shared/durable-file.ts';
import {atomicRename} from './atomic-rename.ts';
import {AudioMixer,AudioProcesses,audioExecutable,compileAudioPlan,renderExchangeAudioClip} from './audio.ts';
import {VideoRenderer} from './renderer.ts';
import {projectPath} from './store.ts';

interface ExchangeFile {path:string;bytes:number;sha256:string}
export interface TimelineExchangeResult {
  projectId:string;
  revision:number;
  path:string;
  formats:('otio'|'fcpxml'|'edl')[];
  files:ExchangeFile[];
  notes:string[];
}

const numbered=(index:number)=>String(index+1).padStart(6,'0');

/** Prepare a portable editor handoff from one committed snapshot. Only a completed folder is published. */
export async function exportTimelineExchange(root:string,input:VideoProject,settings:EnvironmentSettings,signal:AbortSignal,onProgress:(value:number,message:string)=>void=()=>{}):Promise<TimelineExchangeResult>{
  signal.throwIfAborted();
  const project=structuredClone(input);
  assertProductionComposition(project,{forExport:true});
  const spec=compileSpec(project);
  if(!spec.shots.length)throw new Error('没有可交换的主链镜头');
  const id=randomUUID(),relative=`exports/timeline-${project.revision}-${id}`;
  const staged=`exports/.timeline-${id}`,stagePath=await projectPath(root,staged),finalPath=await projectPath(root,relative);
  const bundle=join(stagePath,'bundle'),media=join(bundle,'media');
  const renderer=new VideoRenderer(),mixer=new AudioMixer(),processes=new AudioProcesses();
  try{
    await fs.mkdir(media,{recursive:true});
    const splitFrames=spec.shots.slice(1).map(shot=>shot.startFrame),directory=`${staged}/render`;
    const render=await renderer.export(root,{...project,target:{...project.target,audioMode:'none'},subtitles:undefined},settings,signal,
      (value,message)=>onProgress(value*.8,message),{directory,splitFrames});
    signal.throwIfAborted();
    const video=spec.shots.map((shot,index)=>({shotId:shot.id,title:shot.title,media:`media/v${numbered(index)}.mp4`,startFrame:shot.startFrame,durationFrames:shot.durationFrames}));
    if(video.length===1)await fs.rename(render.path,join(bundle,video[0]!.media));
    else{
      const ffmpeg=audioExecutable('ffmpeg',settings.ffmpegPath);
      await processes.run(ffmpeg,['-hide_banner','-loglevel','error','-i',render.path,'-map','0:v:0','-c:v','copy','-an','-f','segment',
        '-segment_frames',splitFrames.join(','),'-segment_start_number','1','-reset_timestamps','1','-segment_format_options','movflags=+faststart',join(media,'v%06d.mp4')],signal);
    }
    const ffprobe=audioExecutable('ffprobe',settings.ffprobePath);
    for(const shot of video){
      const raw=await processes.run(ffprobe,['-v','error','-count_frames','-show_entries','stream=codec_type,nb_read_frames,start_time','-of','json',join(bundle,shot.media)],signal);
      const {streams}=JSON.parse(raw) as {streams:{codec_type:string;nb_read_frames?:string;start_time?:string}[]};
      if(streams.length!==1||streams[0]?.codec_type!=='video'||Number(streams[0].nb_read_frames)!==shot.durationFrames||Math.abs(Number(streams[0].start_time))>1e-6)throw new Error(`剪辑片段 ${shot.title} 的首帧、帧数或音轨不符合交换规格`);
    }
    const snapshot=join(stagePath,'render','snapshot');
    const activeProject={...project,videoClips:spec.shots.flatMap(shot=>shot.videoClip?[shot.videoClip]:[])};
    const audioPlan=compileAudioPlan(activeProject),audio:ExchangeTimeline['audio']=[];
    onProgress(.85,'正在准备分角色音频');
    for(const [index,clip] of audioPlan.clips.entries()){
      const mediaPath=`media/a${numbered(index)}.wav`;
      const durationSamples=await renderExchangeAudioClip(snapshot,clip,join(bundle,mediaPath),settings,signal);
      const title=project.assets.find(asset=>asset.id===clip.assetId)?.name??clip.id;
      audio.push({clipId:clip.id,title,media:mediaPath,role:clip.role,startSample:Math.round(clip.start*48000),durationSamples});
    }
    const mix=await mixer.mix(snapshot,activeProject,settings,signal);
    if(mix)await fs.copyFile(mix.path,join(media,'master-reference.wav'));
    const timeline:ExchangeTimeline={title:project.title,target:project.target,durationFrames:spec.durationFrames,video,audio};
    const formats:TimelineExchangeResult['formats']=['otio','fcpxml'];
    const notes=['每个镜头的画面和效果已渲染为可重排视频片段，字幕另附。','分轨音频包含裁剪、速度、循环、电平和淡入淡出；总混音设置保存在参考音频中。'];
    const filesToWrite:Record<string,string>={'timeline.otio':formatExchangeOtio(timeline),'timeline.fcpxml':formatExchangeFcpxml(timeline)};
    const edlLimitation=exchangeEdlLimitation(timeline);
    if(edlLimitation)notes.push(edlLimitation);
    else{filesToWrite['timeline.edl']=formatExchangeEdl(timeline);formats.push('edl');notes.push('CMX3600 EDL 仅含画面剪切与素材标识；可编辑分轨音频在 OTIO 和 FCPXML 中。');}
    const cues=projectSubtitles(project);
    if(cues.length){filesToWrite['subtitles.srt']=formatSrt(cues);filesToWrite['subtitles.ass']=formatAss(cues,project.target);}
    for(const [name,contents] of Object.entries(filesToWrite)){signal.throwIfAborted();await writeDurableFile(join(bundle,name),contents);}
    const files:ExchangeFile[]=[];
    const fileNames=[...Object.keys(filesToWrite),...video.map(item=>item.media),...audio.map(item=>item.media),...(mix?['media/master-reference.wav']:[])];
    for(const file of fileNames){
      const path=join(bundle,file),stat=await fs.stat(path);
      files.push({path:file,bytes:stat.size,sha256:await hashMediaFile(path,signal)});
    }
    await writeDurableFile(join(bundle,'manifest.json'),JSON.stringify({format:'yingliu-timeline-exchange',version:1,projectId:project.id,revision:project.revision,timeline,formats,files,notes},null,2)+'\n');
    signal.throwIfAborted();await atomicRename(bundle,finalPath);
    onProgress(1,'可编辑时间轴交换包已保存');
    return {projectId:project.id,revision:project.revision,path:finalPath,formats,files,notes};
  }finally{
    await Promise.allSettled([renderer.close(),mixer.close(),processes.close()]);
    await fs.rm(stagePath,{recursive:true,force:true});
  }
}
