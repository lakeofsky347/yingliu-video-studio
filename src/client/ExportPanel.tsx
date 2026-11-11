import { useEffect, useState } from 'react';
import type { VideoProject } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { localTime } from './project-format.ts';
import {LocalQualityPanel} from './LocalQualityPanel.tsx';
import {ExportQualityReport} from './ExportQualityReport.tsx';
export function ExportPanel({project,controller}:{project:VideoProject;controller:StudioController}){
  const [selected,setSelected]=useState<string|null>(null),[error,setError]=useState('');
  useEffect(()=>{setSelected(null);setError('');},[project.id]);
  const outputs=[...project.outputs].reverse(),playing=outputs.find(output=>output.id===selected);
  return <div className="vs-record-panel vs-export-panel"><div className="vs-record-heading"><div><h3>已导出的影片</h3><p>成片保留导出时的工程版本，继续编辑不会覆盖旧成片。</p></div><span>{outputs.length} 份</span></div>
    <LocalQualityPanel key={project.id} project={project} controller={controller}/>
    {playing?.url&&<div className="vs-export-player"><video key={playing.id} src={playing.url} controls preload="metadata" onError={()=>setError('此成片无法在插件内播放。可以打开文件检查，或在任务记录中重新导出。')}/><div><span>导出时工程 v{playing.revision}</span><button onClick={()=>setSelected(null)}>关闭播放</button></div></div>}
    {error&&<p className="vs-inline-error" role="alert">{error}</p>}
    {!outputs.length?<div className="vs-record-empty"><p>完成分镜和画面后，点击「导出视频」。</p></div>:outputs.map(output=><article key={output.id} className="vs-export-record" data-output-id={output.id}><div><strong>成片 · v{output.revision}</strong><p>{output.width} × {output.height} · {output.duration.toFixed(2)} 秒 · {output.frameCount} 帧</p><small>{localTime(output.createdAt)}</small><p className="vs-export-path" title={output.path}>{output.path}</p>{output.localQuality&&<ExportQualityReport report={output.localQuality} revision={output.revision}/>}</div><div className="vs-record-actions"><button disabled={!output.url} onClick={()=>{setError('');setSelected(output.id);}}>播放成片</button><button onClick={()=>void controller.action('reveal',{path:output.path})}>打开文件 ↗</button></div></article>)}
  </div>;
}
