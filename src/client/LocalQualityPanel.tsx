import {useEffect,useRef,useState} from 'react';
import type {VideoProject} from '../shared/types.ts';
import type {StudioController} from './controller.ts';
import type {LocalQualityReport} from '../workflows/local-quality.ts';
const statusLabels={pass:'已检查',fail:'阻断',unchecked:'未检查','needs-review':'需查看'};
export function LocalQualityPanel({project,controller}:{project:VideoProject;controller:StudioController}){
  const [report,setReport]=useState<LocalQualityReport|null>(null),[working,setWorking]=useState(false),[error,setError]=useState('');const active=useRef(true);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{let current=true;void controller.api.call<LocalQualityReport|null>('quality.last',{projectId:project.id}).then(value=>{if(current)setReport(value);}).catch(cause=>{if(current)setError(cause instanceof Error?cause.message:String(cause));});return()=>{current=false;};},[project.id,project.revision,controller]);
  async function check(){setWorking(true);setError('');try{const value=await controller.mediaCommand<LocalQualityReport>('quality.check');if(active.current)setReport(value);}catch(cause){if(active.current)setError(cause instanceof Error?cause.message:String(cause));}finally{if(active.current)setWorking(false);}}
  const stale=report?.revision!==project.revision;
  return <details className="vs-media-advanced" data-local-quality><summary>导出前本地检查{report?` · ${stale?'结果已过期':report.decision==='fail'?'发现阻断项':report.decision==='needs-review'?'有待查看项目':'检查范围内未发现异常'}`:''}</summary>
    <p className="vs-media-help">检查工程结构、音轨元数据、字幕文字量与少量实际帧。导出会重新检查当前版本，严重结构错误会阻止导出。</p><button disabled={working||controller.busy} onClick={()=>void check()}>{working?'正在截帧检查…':'检查当前版本'}</button>
    {error&&<p className="vs-inline-error" role="alert">{error}</p>}{report&&<><p>工程 v{report.revision} · 实际分析 {report.scope.checkedFrames.length} / {report.scope.requestedFrames.length} 帧 · {new Date(report.checkedAt).toLocaleString()}</p>{stale&&<p role="status">工程内容已改变，请重新检查。旧结果不用于当前导出。</p>}<ul>{report.checks.filter(check=>check.status!=='pass').map(check=><li key={check.id}>{statusLabels[check.status]} · {check.message}</li>)}</ul>{!report.checks.some(check=>check.status!=='pass')&&<p>这些本地检查未发现异常；完整视听质量仍需审看片段。</p>}<details><summary>抽样与未检查范围</summary><p>抽样绝对帧：{report.scope.checkedFrames.map(frame=>frame.frame).join('、')||'无'}</p>{report.scope.unsampledShots.length>0&&<p>没有已分析帧的镜头：{report.scope.unsampledShots.join('、')}</p>}<ul>{report.scope.unchecked.map(item=><li key={item}>{item}</li>)}</ul></details></>}
  </details>;
}
