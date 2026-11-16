import { t, useLocale, systemMessage } from './i18n.ts';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Shot, StudioSnapshot, VideoProject } from '../shared/types.ts';
import type { StudioController } from './controller.ts';

export function shotFrameRange(project:VideoProject,shotId?:string):{start:number;end:number}{let frame=0;for(const id of project.shotOrder){const shot=project.shots.find(s=>s.id===id);if(!shot)continue;const start=frame;frame+=shot.durationFrames;if(id===shotId)return {start,end:frame};}return {start:0,end:frame};}
export function frameShotRange(project:VideoProject,frame:number):{shot?:Shot;start:number;end:number;localFrame:number}{
  const ordered=project.shotOrder.map(id=>project.shots.find(shot=>shot.id===id)).filter((shot):shot is Shot=>Boolean(shot));
  const total=ordered.reduce((sum,shot)=>sum+shot.durationFrames,0),current=Math.max(0,Math.min(Math.max(0,total-1),Math.floor(frame)));
  let start=0;
  for(const shot of ordered){const end=start+shot.durationFrames;if(current<end)return {shot,start,end,localFrame:current-start};start=end;}
  return {start:0,end:0,localFrame:0};
}
export function keyframeNumbers(start:number,end:number):number[]{return [...new Set([start,start+Math.floor(Math.max(0,end-start-1)/2),Math.max(start,end-1)])];}
/** Next preview frame. A negative animation-clock delta stays put instead of requesting frame -1. */
export function previewPlaybackFrame(from:number,elapsedMs:number,fps:number,mediaTime:number|null,duration:number):{frame:number;ended:boolean}{
  const maxFrame=Math.max(0,duration-1),origin=Number.isFinite(from)?Math.max(0,Math.min(maxFrame,Math.trunc(from))):0;
  const raw=mediaTime==null?origin+Math.floor(Math.max(0,elapsedMs)*fps/1000):Math.floor(mediaTime*fps);
  if(!Number.isFinite(raw)||raw>=Math.max(0,duration))return {frame:maxFrame,ended:true};
  return {frame:Math.max(0,raw),ended:false};
}
function FrameThumb({url,frame,onSelect,label,failed}:{url?:string;frame:number;onSelect:(frame:number)=>void;label:string;failed:boolean}){
  useLocale();
  const [imageFailed,setImageFailed]=useState(false);
  return <button className="vs-keyframe" aria-label={t("{value0} · 第 {value1} 帧", {value0: label, value1: frame})} onClick={()=>onSelect(frame)}>{url&&!imageFailed?<img src={url} alt={t("{value0}缩略帧", {value0: label})} onError={()=>setImageFailed(true)}/>:<div className="vs-keyframe-placeholder">{failed||imageFailed?t("画面加载失败"):t("正在生成缩略帧…")}</div>}<span>{label} <b>F{frame}</b></span></button>;
}

export function Preview({snapshot,project,selectedShot,controller,focusFrame,focusSerial,busy=false}:{snapshot:StudioSnapshot;project:VideoProject;selectedShot?:Shot;controller:StudioController;focusFrame?:number|null;focusSerial?:number;busy?:boolean}){
  useLocale();
  const preview=useRef<HTMLDivElement>(null),iframe=useRef<HTMLIFrameElement>(null),audio=useRef<HTMLAudioElement>(null),currentFrame=useRef(0);
  const [readyKey,setReadyKey]=useState(''),[frame,setFrame]=useState(0),[playing,setPlaying]=useState(false),[sceneId,setSceneId]=useState(''),[showOutput,setShowOutput]=useState(false),[expanded,setExpanded]=useState(false),[jump,setJump]=useState('0'),[audioError,setAudioError]=useState(''),[capturing,setCapturing]=useState(false),[capture,setCapture]=useState<{path:string;url:string}|null>(null),[previewError,setPreviewError]=useState(''),[reload,setReload]=useState(0);
  const duration=project.shots.reduce((n,s)=>n+s.durationFrames,0),fps=project.target.fps.num/project.target.fps.den;
  currentFrame.current=frame;
  const maxFrame=Math.max(0,duration-1),origin=snapshot.previewUrl?new URL(snapshot.previewUrl).origin:'';
  const previewKey=JSON.stringify([project.id,snapshot.previewUrl,snapshot.previewRevision,reload,showOutput]),ready=!!snapshot.previewUrl&&readyKey===previewKey;
  const requestFrame=useRef<(frame:number)=>void>(()=>{});
  const previewUrl=useMemo(()=>{if(!snapshot.previewUrl)return '';const value=new URL(snapshot.previewUrl);value.searchParams.set('render','manual');return value.href;},[snapshot.previewUrl]);
  const range=useMemo(()=>shotFrameRange(project,selectedShot?.id),[project.shotOrder,project.shots,selectedShot?.id]);
  const currentRange=useMemo(()=>frameShotRange(project,frame),[project.shotOrder,project.shots,frame]);
  const marks=useMemo(()=>keyframeNumbers(range.start,range.end),[range.start,range.end]);
  const thumbnailKey=JSON.stringify([snapshot.previewUrl,marks]);
  const [thumbnails,setThumbnails]=useState<{key:string;urls:Record<number,string>;failed:boolean}>({key:'',urls:{},failed:false});
  useEffect(()=>{
    if(!snapshot.previewUrl||!ready||showOutput||busy)return;
    let active=true;const timer=setTimeout(()=>{
      void controller.api.call<{frames:{frame:number;url:string}[]}>('thumbnails',{projectId:project.id,expectedRevision:snapshot.previewRevision,frames:marks}).then(result=>{if(active)setThumbnails({key:thumbnailKey,urls:Object.fromEntries(result.frames.map(capture=>[capture.frame,capture.url])),failed:false});}).catch(()=>{if(active)setThumbnails({key:thumbnailKey,urls:{},failed:true});});
    },150);
    return()=>{active=false;clearTimeout(timer);};
  },[thumbnailKey,ready,showOutput,busy,controller,project.id,snapshot.previewRevision]);
  const seek=(value:number)=>{setPlaying(false);setShowOutput(false);setFrame(Math.max(0,Math.min(maxFrame,Math.round(value))));};
  useEffect(()=>{
    setCapture(null);setPlaying(false);setSceneId('');setPreviewError('');
    const target=iframe.current?.contentWindow;if(!target||!previewUrl||showOutput)return;
    let active=true,initialized=false,timer:ReturnType<typeof setTimeout>|undefined;
    const clear=()=>{if(timer)clearTimeout(timer);timer=undefined;};
    const watch=()=>{if(timer)return;timer=setTimeout(()=>{timer=undefined;if(active){setReadyKey('');setPlaying(false);setPreviewError('预览等待画面超时，可重新加载当前版本。');}},30_000);};
    const send=(value:number)=>{if(!active||!initialized)return;watch();target.postMessage({type:'video-studio/render',frame:value},origin);};
    requestFrame.current=send;watch();
    const listener=(event:MessageEvent)=>{
      if(!active||event.source!==target||event.origin!==origin)return;const data=event.data;
      if(data?.type==='video-studio/ready'){initialized=true;send(currentFrame.current);}
      if(data?.type==='video-studio/frame'&&initialized&&Number.isSafeInteger(data.frame)){
        clear();setReadyKey(previewKey);setPreviewError('');setSceneId(typeof data.sceneId==='string'?data.sceneId:'');
      }
      if(data?.type==='video-studio/error'){clear();setReadyKey('');setPlaying(false);setPreviewError(`预览错误：${String(data.message||'渲染失败')}`);}
    };
    window.addEventListener('message',listener);return()=>{active=false;clear();requestFrame.current=()=>{};window.removeEventListener('message',listener);};
  },[previewKey,previewUrl,origin]);
  useEffect(()=>{if(ready)requestFrame.current(frame);setJump(String(frame));},[frame,ready]);
  useEffect(()=>{if(!playing||!ready)return;let animation=0;const start=performance.now(),from=frame;const tick=(now:number)=>{const mediaTime=project.target.audioMode==='mixed'&&snapshot.audioUrl&&audio.current&&Number.isFinite(audio.current.currentTime)?audio.current.currentTime:null;const step=previewPlaybackFrame(from,now-start,fps,mediaTime,duration);setFrame(step.frame);if(step.ended){setPlaying(false);return;}animation=requestAnimationFrame(tick);};animation=requestAnimationFrame(tick);return()=>cancelAnimationFrame(animation);},[playing,ready,duration,fps,snapshot.audioUrl,project.target.audioMode]);
  useEffect(()=>{if(!selectedShot)return;seek(range.start);},[selectedShot?.id,range.start]);
  useEffect(()=>{if(focusFrame==null)return;seek(focusFrame);},[focusSerial]);
  useEffect(()=>{if(frame>maxFrame)seek(maxFrame);},[maxFrame]);
  useEffect(()=>{const element=audio.current;if(!element)return;if(playing&&ready&&!showOutput){element.currentTime=Math.min(element.duration||Infinity,frame/fps);void element.play().catch(()=>{setAudioError('声音尚未播放，点击播放后重试。');setPlaying(false);});}else element.pause();return()=>element.pause();},[playing,ready,showOutput,snapshot.audioUrl]);
  useEffect(()=>{const element=audio.current;if(!element)return;const seconds=frame/fps;if(!playing){try{element.currentTime=seconds;}catch{}}},[frame,fps,playing]);
  useEffect(()=>{
    const studio=preview.current?.closest<HTMLElement>('.vs-studio');
    if(!studio)return;
    const onKey=(event:KeyboardEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(event.defaultPrevented||!target||target.closest('[role=dialog]'))return;
      if(expanded&&event.key==='Escape'&&preview.current?.contains(target)){
        event.preventDefault();setExpanded(false);return;
      }
      if(target.closest('input, textarea, select, button, a, summary, [role=tab], [contenteditable=true], canvas'))return;
      if(event.key===' '||event.code==='Space'){
        event.preventDefault();if(!ready||showOutput)return;
        setAudioError('');if(currentFrame.current>=maxFrame)setFrame(0);setPlaying(value=>!value);
      }
      if(event.altKey&&event.key==='ArrowLeft'){event.preventDefault();seek(currentFrame.current-1);}
      if(event.altKey&&event.key==='ArrowRight'){event.preventDefault();seek(currentFrame.current+1);}
    };
    studio.addEventListener('keydown',onKey);return()=>studio.removeEventListener('keydown',onKey);
  },[ready,showOutput,maxFrame,expanded]);
  async function capturePng(){const capturedFrame=currentFrame.current;setPlaying(false);setCapturing(true);try{await controller.flush();if(controller.getSnapshot().error)throw new Error(controller.getSnapshot().error);const result=await controller.api.call<{frame?:{path:string;url:string}}>('inspect',{projectId:project.id,shotId:frameShotRange(project,capturedFrame).shot?.id,frame:capturedFrame});if(!result.frame)throw new Error('未获得 PNG 帧');setCapture(result.frame);controller.notify(`第 ${capturedFrame} 帧 PNG 已保存到项目中。`);}catch(error){controller.notify(error instanceof Error?error.message:'导出 PNG 失败');}finally{setCapturing(false);}}
  const localFrame=currentRange.localFrame;
  const output=project.outputs.at(-1),outdated=snapshot.previewRevision!==null&&snapshot.previewRevision!==project.revision;
  const disabled=!ready||showOutput;
  return <div ref={preview} className={`vs-preview ${expanded?'is-expanded':''}`}>
    <div className="vs-preview-heading"><span data-testid="current-shot-heading" data-shot-id={currentRange.shot?.id}>{currentRange.shot?t("「{value0}」· 帧 [{value1}, {value2})", {value0: currentRange.shot.title, value1: currentRange.start, value2: currentRange.end}):t("整片逐帧查看")}</span><button aria-label={expanded?t("关闭大预览"):t("打开大预览")} onClick={()=>setExpanded(!expanded)}>{expanded?t("收起 ✕"):t("大预览 ↗")}</button></div>
    <div className="vs-preview-screen" style={{'--vs-preview-ratio':`${project.target.width}/${project.target.height}`} as CSSProperties}>
      {showOutput&&output?.url?<video src={output.url} controls className="vs-output-video"/>:snapshot.previewUrl?<iframe key={previewKey} ref={iframe} src={previewUrl} title={t("影片画面预览")} sandbox="allow-scripts allow-same-origin"/>:<div className="vs-preview-empty"><strong>{t("画面从这里开始")}</strong><p>{t("生成画面后，点击「预览」。")}<br/>{t("手动编辑的镜头也可以直接预览。")}</p></div>}
      {outdated&&<span className="vs-preview-badge">{t("参数已更新 · 刷新预览")}</span>}
    </div>
    {snapshot.audioUrl&&project.target.audioMode==='mixed'&&<audio ref={audio} src={snapshot.audioUrl} preload="auto" onError={()=>setAudioError('混音预览加载失败，可刷新预览后重试。')}/>}
    <div className="vs-player"><button aria-label={playing?t("暂停"):t("播放")} disabled={disabled} onClick={()=>{setAudioError('');if(frame>=maxFrame)setFrame(0);setPlaying(v=>!v);}}>{playing?'Ⅱ':'▶'}</button><button aria-label={t("上一帧")} disabled={disabled||frame===0} onClick={()=>seek(frame-1)}>◀|</button><button aria-label={t("下一帧")} disabled={disabled||frame===maxFrame} onClick={()=>seek(frame+1)}>&gt;|</button><span>{(frame/fps).toFixed(3)}s</span><input type="range" aria-label={t("影片播放位置")} min="0" max={maxFrame} step="1" value={frame} disabled={disabled} onChange={e=>seek(Number(e.target.value))}/><span>{(duration/fps).toFixed(3)}s</span></div>
    <div className="vs-frame-jump"><span>F<span data-testid="current-frame">{frame}</span> / {maxFrame}</span>{currentRange.shot&&<span data-testid="current-shot-local-frame">{t("镜头 F{value0} · {value1}s", {value0: localFrame, value1: (localFrame/fps).toFixed(3)})}</span>}<label>{t("跳转帧 ")}<input aria-label={t("跳转帧")} type="number" min="0" max={maxFrame} value={jump} disabled={disabled} onChange={e=>setJump(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&Number.isFinite(Number(jump)))seek(Number(jump));}}/></label><button disabled={disabled||!Number.isFinite(Number(jump))} onClick={()=>seek(Number(jump))}>{t("定位")}</button><button disabled={disabled||busy||capturing} onClick={()=>void capturePng()}>{capturing?t("正在保存…"):t("导出当前帧 PNG")}</button><span>{snapshot.audioUrl&&project.target.audioMode==='mixed'?t("声音已同步"):t("无声预览")}</span></div>{capture&&<div className="vs-captured-frame"><a href={capture.url} target="_blank" rel="noreferrer">{t("查看已保存 PNG ↗")}</a><button onClick={()=>void controller.action('reveal',{path:capture.path})}>{t("打开 PNG 文件")}</button></div>}
    {snapshot.previewUrl&&ready&&!showOutput&&<><div className="vs-eyebrow" data-testid="keyframe-scope">{selectedShot?t("选中「{value0}」的关键帧", {value0: selectedShot.title}):t("全片关键帧")}</div><div className="vs-keyframes" aria-label={t("镜头关键帧")}>{marks.map((number,index)=><FrameThumb key={`${thumbnailKey}:${number}`} url={thumbnails.key===thumbnailKey?thumbnails.urls[number]:undefined} failed={thumbnails.key===thumbnailKey&&thumbnails.failed} frame={number} label={index===0?t("首帧"):index===marks.length-1?t("末帧"):t("中帧")} onSelect={seek}/>)}</div></>}
    {audioError&&<p className="vs-inline-error">{systemMessage(audioError)}</p>}
    {previewError&&<p className="vs-inline-error" role="alert">{systemMessage(previewError)}<button onClick={()=>setReload(value=>value+1)}>{t("重新加载预览")}</button></p>}
    <div className="vs-preview-foot"><span>{showOutput?t("已导出 MP4"):sceneId?project.shots.find(s=>s.id===sceneId)?.title||sceneId:t("逐帧预览")}</span>{output?.url&&<button onClick={()=>{setPlaying(false);setReadyKey('');setShowOutput(value=>!value);}}>{showOutput?t("返回逐帧"):t("播放成片")}</button>}{output&&<button onClick={()=>void controller.action('reveal',{path:output.path})}>{t("打开成片 →")}</button>}</div>
  </div>;
}
