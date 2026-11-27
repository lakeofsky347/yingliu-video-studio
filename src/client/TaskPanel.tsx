import {t, useLocale, systemMessage} from './i18n.ts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { TaskRecord } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { localTime } from './project-format.ts';
const labels:Record<string,string>={running:'执行中',complete:'完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
const taskLabels:Record<string,string>={preview:'检查预览',export:'导出影片',storyboard:'构建分镜',scenes:'生成画面',modify:'修改镜头',audio:'制作音频',timeline:'导出时间轴交换包'};
export function TaskPanel({controller}:{controller:StudioController}){
  useLocale();
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),projectId=state.snapshot?.project?.id;
  const [tasks,setTasks]=useState<TaskRecord[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0);
  useEffect(()=>{setTasks([]);setLoading(true);setError('');},[projectId]);
  useEffect(()=>{if(!projectId)return;let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
    async function read(){try{const result=await controller.api.call<{tasks:TaskRecord[]}>('tasks',{projectId});if(active){setTasks(result.tasks);setError('');setLoading(false);if(result.tasks.some(task=>task.status==='running'))timer=setTimeout(()=>void read(),1200);}}catch(cause){if(active){setError(cause instanceof Error?cause.message:"任务记录读取失败");setLoading(false);}}}
    void read();return()=>{active=false;clearTimeout(timer);};
  },[controller,projectId,state.snapshot?.task?.id,state.snapshot?.task?.status,refresh]);
  return <div className="vs-record-panel"><div className="vs-record-heading"><div><h3>{t("任务记录")}</h3><p>{t("任务关联工程与输入版本；重试会使用当前已保存工程。")}</p></div><button disabled={loading} onClick={()=>setRefresh(value=>value+1)}>{t("刷新任务")}</button></div>{error&&<p className="vs-inline-error" role="alert">{systemMessage(error)}</p>}{loading?<p className="vs-record-empty">{t("读取任务记录…")}</p>:!tasks.length?<div className="vs-record-empty"><p>{t("生成、预览、音频和导出任务会在这里留下记录。")}</p></div>:tasks.map(task=><article key={task.id} className={`vs-task-record is-${task.status}`} data-task-id={task.id}><div className="vs-task-record-heading"><span>{t(labels[task.status]||task.status)}</span><strong>{task.message?systemMessage(task.message):t(taskLabels[task.kind])}</strong><small>{task.revision!==undefined?t("输入 v{revision}", {revision: task.revision}):''}</small></div>{task.status==='running'&&<div className="vs-progress"><i style={{width:`${Math.round(task.progress*100)}%`}}/></div>}{task.error&&<p className="vs-task-error">{systemMessage(task.error)}</p>}{task.status==='interrupted'&&<p className="vs-task-error">{t("上次关闭时任务尚未完成，已保存的工程仍可继续使用。")}</p>}<div className="vs-task-record-foot"><span>{localTime(task.startedAt)}{task.retryOf?t(" · 重试任务"):''}</span>{task.status==='running'&&<button disabled={state.pending} onClick={()=>void controller.action('cancel')}>{t("取消任务")}</button>}{task.retryable&&['failed','cancelled','interrupted'].includes(task.status)&&<button disabled={controller.busy||state.sourceDraft} onClick={()=>void controller.action('retry',{taskId:task.id},"已创建重试任务。")}>{t("以当前工程重试")}</button>}{task.logPath&&<button onClick={()=>void controller.action('reveal',{path:task.logPath})}>{t("打开日志 ↗")}</button>}</div></article>)}</div>;
}
export function HistoryPanel({controller}:{controller:StudioController}){
  useLocale();
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),history=state.history;
  useEffect(()=>{void controller.refreshHistory();},[controller,state.snapshot?.project?.id]);
  return <div className="vs-record-panel"><div className="vs-record-heading"><div><h3>{t("工程修改历史")}</h3><p>{t("分镜、源码与音轨修改保存在工程中，重开仍可撤销和重做。")}</p></div><div className="vs-record-actions"><button disabled={!state.canUndo||controller.busy||state.sourceDraft} onClick={controller.undo}>{t("撤销")}</button><button disabled={!state.canRedo||controller.busy||state.sourceDraft} onClick={controller.redo}>{t("重做")}</button></div></div>{!history?.entries.length?<p className="vs-record-empty">{t("保存一次修改后，在这里查看历史。")}</p>:<ol className="vs-history-list">{history.entries.map((entry,index)=><li key={entry.id} className={index===history.cursor?'is-current':index>history.cursor?'is-future':''}><div><strong>{entry.label}</strong><small>{localTime(entry.createdAt)}</small></div><span>v{entry.revision}{index===history.cursor?t(" · 当前"):''}</span></li>)}</ol>}</div>;
}
