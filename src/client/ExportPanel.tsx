import {t, useLocale, systemMessage} from './i18n.ts';
import { useEffect, useState } from 'react';
import type { VideoProject } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { localTime } from './project-format.ts';
import {LocalQualityPanel} from './LocalQualityPanel.tsx';
import {ExportQualityReport} from './ExportQualityReport.tsx';
import {ReviewPanel} from './ReviewPanel.tsx';
import {TimelineExchangePanel} from './TimelineExchangePanel.tsx';
export function ExportPanel({project,controller}:{project:VideoProject;controller:StudioController}){
  useLocale();
  const [selected,setSelected]=useState<string|null>(null),[error,setError]=useState('');
  useEffect(()=>{setSelected(null);setError('');},[project.id]);
  const outputs=[...project.outputs].reverse(),playing=outputs.find(output=>output.id===selected);
  return <div className="vs-record-panel vs-export-panel"><div className="vs-record-heading"><div><h3>{t("已导出的影片")}</h3><p>{t("成片保留导出时的工程版本，继续编辑不会覆盖旧成片。")}</p></div><span>{t("{count} 份",{count:outputs.length})}</span></div>
    <LocalQualityPanel key={project.id} project={project} controller={controller}/>
    <ReviewPanel key={project.id+'-review'} project={project} controller={controller}/>
    <TimelineExchangePanel key={project.id+'-exchange'} project={project} controller={controller}/>
    {playing?.url&&<div className="vs-export-player"><video key={playing.id} src={playing.url} controls preload="metadata" onError={()=>setError("此成片无法在插件内播放。可以打开文件检查，或在任务记录中重新导出。")}/><div><span>{t("导出时工程 v{revision}",{revision:playing.revision})}</span><button onClick={()=>setSelected(null)}>{t("关闭播放")}</button></div></div>}
    {error&&<p className="vs-inline-error" role="alert">{systemMessage(error)}</p>}
    {!outputs.length?<div className="vs-record-empty"><p>{t("完成分镜和画面后，点击「导出视频」。")}</p></div>:outputs.map(output=><article key={output.id} className="vs-export-record" data-output-id={output.id}><div><strong>{t("成片 · v{revision}",{revision:output.revision})}</strong><p>{t("{width} × {height} · {duration} 秒 · {frames} 帧",{width:output.width,height:output.height,duration:output.duration.toFixed(2),frames:output.frameCount})}</p><small>{localTime(output.createdAt)}</small><p className="vs-export-path" title={output.path}>{output.path}</p>{output.localQuality&&<ExportQualityReport report={output.localQuality} revision={output.revision}/>}</div><div className="vs-record-actions"><button disabled={!output.url} onClick={()=>{setError('');setSelected(output.id);}}>{t("播放成片")}</button><button onClick={()=>void controller.action('reveal',{path:output.path})}>{t("打开文件 ↗")}</button></div></article>)}
  </div>;
}
