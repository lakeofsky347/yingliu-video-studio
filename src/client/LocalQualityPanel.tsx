import {t, useLocale, systemMessage, formatDate} from './i18n.ts';
import {useEffect,useRef,useState} from 'react';
import type {VideoProject} from '../shared/types.ts';
import type {StudioController} from './controller.ts';
import type {LocalQualityAudioEvidence,LocalQualityReport} from '../workflows/local-quality.ts';
const statusLabels={pass:'已检查',fail:'阻断',unchecked:'未检查','needs-review':'需查看'};
export function AudioQualitySummary({audio}:{audio:LocalQualityAudioEvidence|undefined}){
  if(!audio||audio.status==='empty')return null;
  if(audio.status==='unchecked')return <p>{t("总混音未能测量")}{audio.reason&&` · ${systemMessage(audio.reason)}`}</p>;
  const {integratedLufs,truePeakDbtp,loudnessRangeLu,totalSilenceSeconds}=audio.report;
  const value=(measured:number|null,unit:string)=>measured===null?t("无有效读数"):`${measured.toFixed(1)} ${unit}`;
  return <dl data-acoustic-report>
    <dt>{t("综合响度")}</dt><dd>{value(integratedLufs,'LUFS')}</dd>
    <dt>{t("真峰值")}</dt><dd>{value(truePeakDbtp,'dBTP')}</dd>
    <dt>{t("响度范围")}</dt><dd>{value(loudnessRangeLu,'LU')}</dd>
    <dt>{t("连续静音累计时长")}</dt><dd>{t("{value0} 秒",{value0:totalSilenceSeconds.toFixed(2)})}</dd>
  </dl>;
}
export function LocalQualityPanel({project,controller}:{project:VideoProject;controller:StudioController}){
  useLocale();
  const [report,setReport]=useState<LocalQualityReport|null>(null),[working,setWorking]=useState(false),[error,setError]=useState('');const active=useRef(true);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{let current=true;void controller.api.call<LocalQualityReport|null>('quality.last',{projectId:project.id}).then(value=>{if(current)setReport(value);}).catch(cause=>{if(current)setError(cause instanceof Error?cause.message:String(cause));});return()=>{current=false;};},[project.id,project.revision,controller]);
  async function check(){setWorking(true);setError('');try{const value=await controller.mediaCommand<LocalQualityReport>('quality.check');if(active.current)setReport(value);}catch(cause){if(active.current)setError(cause instanceof Error?cause.message:String(cause));}finally{if(active.current)setWorking(false);}}
  const stale=report?.revision!==project.revision;
  return <details className="vs-media-advanced" data-local-quality><summary>{t("导出前本地检查")}{report?` · ${stale?t("结果已过期"):report.decision==='fail'?t("发现阻断项"):report.decision==='needs-review'?t("有待查看项目"):t("检查范围内未发现异常")}`:''}</summary>
    <p className="vs-media-help">{t("检查工程结构、总混音、字幕文字量与实际抽样帧。严重结构错误会阻止导出。")}</p><button disabled={working||controller.busy} onClick={()=>void check()}>{working?t("正在检查画面和混音…"):t("检查当前版本")}</button>
    {error&&<p className="vs-inline-error" role="alert">{systemMessage(error)}</p>}{report&&<><p>{t("工程 v{revision} · 实际分析 {checked} / {requested} 帧 · {date}",{revision:report.revision,checked:report.scope.checkedFrames.length,requested:report.scope.requestedFrames.length,date:formatDate(report.checkedAt)})}</p>{stale&&<p role="status">{t("工程内容已改变，请重新检查。旧结果不用于当前导出。")}</p>}
      <AudioQualitySummary audio={report.scope.audio}/>
      <ul>{report.checks.filter(check=>check.status!=='pass').map(check=><li key={check.id}>{t(statusLabels[check.status])} · {systemMessage(check.message)}</li>)}</ul>{!report.checks.some(check=>check.status!=='pass')&&<p>{t("这些本地检查未发现异常；完整视听质量仍需审看片段。")}</p>}<details><summary>{t("抽样与未检查范围")}</summary><p>{t("抽样绝对帧：")}{report.scope.checkedFrames.map(frame=>frame.frame).join(t('、'))||t("无")}</p>{report.scope.unsampledShots.length>0&&<p>{t("没有已分析帧的镜头：")}{report.scope.unsampledShots.join(t('、'))}</p>}<ul>{report.scope.unchecked.map(item=><li key={item}>{systemMessage(item)}</li>)}</ul></details></>}
  </details>;
}
