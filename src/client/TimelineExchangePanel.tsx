import {useEffect,useState,useSyncExternalStore} from 'react';
import type {TaskRecord,TimelineExchangeRecord,VideoProject} from '../shared/types.ts';
import type {StudioController} from './controller.ts';
import {systemMessage,t,useLocale} from './i18n.ts';
import {localTime} from './project-format.ts';

const formatNames={otio:'OTIO',fcpxml:'FCPXML',edl:'CMX3600 EDL'};
type CompletedExchange=TaskRecord&{timelineExchange:TimelineExchangeRecord};

export function TimelineExchangePanel({project,controller}:{project:VideoProject;controller:StudioController}){
  useLocale();
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const current=state.snapshot?.project?.id===project.id?state.snapshot?.task:undefined;
  const latest=current?.kind==='timeline'?current:undefined;
  const active=latest?.status==='running'?latest:undefined;
  const root=state.snapshot?.project?.id===project.id?state.snapshot.root:undefined;
  const [outputs,setOutputs]=useState<CompletedExchange[]>([]),[readError,setReadError]=useState('');
  useEffect(()=>{
    let live=true;
    void controller.api.call<{tasks:TaskRecord[]}>('tasks',{projectId:project.id}).then(result=>{
      if(!live)return;
      setOutputs(result.tasks.filter((task):task is CompletedExchange=>task.kind==='timeline'&&task.status==='complete'&&!!task.timelineExchange));
      setReadError('');
    }).catch(error=>{if(live)setReadError(error instanceof Error?error.message:String(error));});
    return()=>{live=false;};
  },[controller,project.id,latest?.id,latest?.status]);
  return <details className="vs-media-advanced" data-timeline-exchange>
    <summary>{t("时间轴交换")}</summary>
    <p className="vs-media-help">{t("保存剪辑时间轴和配套素材。OTIO、FCPXML 支持分轨音频，CMX3600 EDL 在支持的帧率下提供画面剪切表。")} {t("请一起移动整个包。剪辑器提示素材离线时，重联到包内的 media 文件夹。")}</p>
    <div className="vs-record-actions">
      <button type="button" disabled={controller.busy||state.sourceDraft||!project.shotOrder.length} onClick={()=>void controller.action('timeline.exchange')}>{t("导出时间轴交换包")}</button>
      {active&&<button type="button" disabled={state.pending} onClick={()=>void controller.action('cancel',{taskId:active.id})}>{t("取消任务")}</button>}
    </div>
    {active&&<p role="status">{t("{progress}% · {message}",{progress:Math.round(active.progress*100),message:systemMessage(active.message)})}</p>}
    {latest?.status==='failed'&&<p className="vs-inline-error" role="alert">{systemMessage(latest.error??latest.message)}</p>}
    {latest?.status==='cancelled'&&<p role="status">{t("时间轴交换已取消")}</p>}
    {readError&&<p className="vs-inline-error" role="alert">{systemMessage(readError)}</p>}
    {outputs.map(task=><article key={task.id} className="vs-export-record">
      <div>
        <strong>{t("时间轴交换包 · v{revision}",{revision:task.revision??''})}</strong>
        <p>{task.timelineExchange.formats.map(format=>formatNames[format]).join(' · ')}</p>
        <small>{localTime(task.finishedAt??task.startedAt)}</small>
        {task.timelineExchange.notes.map(note=><p className="vs-media-help" key={note}>{systemMessage(note)}</p>)}
      </div>
      <div className="vs-record-actions"><button type="button" disabled={!root||state.pending} onClick={()=>root&&void controller.action('reveal',{path:root+'/'+task.timelineExchange.folder})}>{t("打开交换包 ↗")}</button></div>
    </article>)}
  </details>;
}
