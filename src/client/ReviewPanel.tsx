import {useState} from 'react';
import {projectSubtitles,validateSubtitles} from '../core/subtitles.ts';
import type {SubtitleCue,VideoProject} from '../shared/types.ts';
import type {StudioController} from './controller.ts';
import {systemMessage,t} from './i18n.ts';

interface ReviewFrame {frame:number;shotId:string;url:string}
interface FrameReview {revision:number;frames:ReviewFrame[]}
interface CutReview {revision:number;cuts:{seconds:number;score?:number}[]}
interface CueDraft {id:string;start:string;end:string;text:string;speaker:string;shotId?:string}

export function ReviewPanel({project,controller,disabled=false}:{project:VideoProject;controller:StudioController;disabled?:boolean}){
  const [draft,setDraft]=useState<CueDraft>();
  const [shotId,setShotId]=useState(project.shotOrder[0]??'');
  const [assetId,setAssetId]=useState('');
  const [sheet,setSheet]=useState<FrameReview>();
  const [cuts,setCuts]=useState<CutReview>();
  const [output,setOutput]=useState('');
  const [running,setRunning]=useState(false);
  const [error,setError]=useState('');
  const cues=project.subtitles??projectSubtitles(project);
  const videos=project.assets.filter(asset=>asset.kind==='video');
  const currentShot=project.shotOrder.includes(shotId)?shotId:project.shotOrder[0]??'';
  const currentAsset=videos.some(asset=>asset.id===assetId)?assetId:videos[0]?.id??'';
  const busy=disabled||running;

  function update(cue:SubtitleCue){setDraft({id:cue.id,start:String(cue.startSeconds),end:String(cue.endSeconds),text:cue.text,speaker:cue.speaker??'',shotId:cue.shotId});}
  function apply(next:SubtitleCue[]){
    const errors=validateSubtitles(next,new Set(project.shots.map(shot=>shot.id)));
    if(errors.length){setError(systemMessage(errors[0]!));return;}
    if(controller.edit({...project,subtitles:next})){setDraft(undefined);setOutput('');setError('');}
  }
  function save(){
    if(!draft)return;
    const cue:SubtitleCue={id:draft.id,startSeconds:draft.start.trim()?Number(draft.start):NaN,
      endSeconds:draft.end.trim()?Number(draft.end):NaN,text:draft.text.trim(),
      ...(draft.speaker.trim()?{speaker:draft.speaker.trim()}:{}),...(draft.shotId?{shotId:draft.shotId}:{})};
    apply([...cues.filter(item=>item.id!==cue.id),cue].sort((a,b)=>a.startSeconds-b.startSeconds));
  }
  async function run(work:()=>Promise<void>){
    setRunning(true);setError('');
    try{await work();}catch(cause){setError(systemMessage(cause instanceof Error?cause.message:String(cause)));}
    finally{setRunning(false);}
  }

  return <div className="vs-delivery-tools">
    <section className="vs-record-panel" aria-label={t("本地审片")}>
      <h3>{t("本地审片")}</h3>
      <div className="vs-field-pair">
        <label className="vs-field"><span>{t("审片镜头")}</span><select value={currentShot} onChange={event=>{setShotId(event.target.value);setSheet(undefined);}}>{project.shotOrder.map(id=><option value={id} key={id}>{project.shots.find(shot=>shot.id===id)?.title??id}</option>)}</select></label>
        <button disabled={busy||!currentShot} onClick={()=>void run(async()=>setSheet(await controller.mediaCommand<FrameReview>('review.frames',{shotId:currentShot})))}>{t("生成五帧宫格")}</button>
      </div>
      {sheet?.revision===project.revision&&<div className="vs-review-grid">{sheet.frames.map(frame=><figure key={frame.frame}><img src={frame.url} alt={t("审片帧 {frame}",{frame:frame.frame})}/><figcaption>{t("审片帧 {frame}",{frame:frame.frame})}</figcaption></figure>)}</div>}
      {!!videos.length&&<div className="vs-field-pair">
        <label className="vs-field"><span>{t("参考视频")}</span><select value={currentAsset} onChange={event=>{setAssetId(event.target.value);setCuts(undefined);}}>{videos.map(asset=><option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label>
        <button disabled={busy||!currentAsset} onClick={()=>void run(async()=>setCuts(await controller.mediaCommand<CutReview>('review.cuts',{assetId:currentAsset})))}>{t("检测参考片切镜")}</button>
      </div>}
      {cuts?.revision===project.revision&&<p role="status">{cuts.cuts.length?cuts.cuts.map(cut=>cut.seconds.toFixed(2)+' s').join(' · '):t("未检测到明显切镜")}</p>}
    </section>
    <section className="vs-record-panel" aria-label={t("字幕轨")}>
      <h3>{t("字幕轨")}</h3>
      {project.subtitles===undefined&&cues.length>0&&<p className="vs-muted">{t("已从镜头旁白和文字提取字幕。保存编辑后将在预览和成片中显示。")}</p>}
      {cues.map(cue=><div className="vs-subtitle-row" key={cue.id}>
        <span>{cue.startSeconds.toFixed(3)}–{cue.endSeconds.toFixed(3)} s</span><span>{cue.text}</span>
        <button disabled={busy} onClick={()=>update(cue)}>{t("编辑")}</button>
        <button disabled={busy} onClick={()=>apply(cues.filter(item=>item.id!==cue.id))}>{t("删除")}</button>
      </div>)}
      {draft&&<div className="vs-subtitle-form">
        <div className="vs-field-pair">
          <label className="vs-field"><span>{t("开始秒数")}</span><input type="number" min="0" step="0.001" value={draft.start} onChange={event=>setDraft({...draft,start:event.target.value})}/></label>
          <label className="vs-field"><span>{t("结束秒数")}</span><input type="number" min="0" step="0.001" value={draft.end} onChange={event=>setDraft({...draft,end:event.target.value})}/></label>
        </div>
        <label className="vs-field"><span>{t("字幕说话人")}</span><input maxLength={120} value={draft.speaker} onChange={event=>setDraft({...draft,speaker:event.target.value})}/></label>
        <label className="vs-field"><span>{t("字幕文字")}</span><textarea rows={3} maxLength={4000} value={draft.text} onChange={event=>setDraft({...draft,text:event.target.value})}/></label>
        <button disabled={busy} onClick={save}>{t("保存字幕")}</button> <button onClick={()=>setDraft(undefined)}>{t("取消")}</button>
      </div>}
      <div className="vs-record-actions">
        <button disabled={busy||!!draft} onClick={()=>setDraft({id:crypto.randomUUID(),start:'0',end:'1',text:'',speaker:''})}>{t("新建字幕")}</button>
        {(['srt','ass'] as const).map(format=><button key={format} disabled={busy||!!draft||!cues.length} onClick={()=>void run(async()=>{setOutput((await controller.mediaCommand<{path:string}>('subtitles.export',{format})).path);})}>{t("导出 {format} 字幕",{format:format.toUpperCase()})}</button>)}
        {output&&<button disabled={busy} onClick={()=>void controller.action('reveal',{path:output})}>{t("打开字幕文件 ↗")}</button>}
      </div>
    </section>
    {error&&<p className="vs-inline-error" role="alert">{error}</p>}
  </div>;
}
