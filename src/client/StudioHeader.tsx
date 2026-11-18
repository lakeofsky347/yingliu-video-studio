import { useEffect, useRef, useState } from 'react';
import type { ProviderGroup, TaskState, VideoProject } from '../shared/types.ts';
import type { StudioState } from './controller.ts';
import { t, useLocale, systemMessage } from './i18n.ts';
import { Button, Icon } from './icons.tsx';
import { Popover } from './Feedback.tsx';
import { VideoStudioIcon } from './VideoStudioIcon.tsx';

export type StageId='storyboard'|'scenes'|'preview'|'export';
export type StepState='done'|'current'|'todo'|'running'|'stale'|'warning';
export interface StepInfo { id:StageId; label:string; state:StepState; hint:string }
export interface MenuItem { id:string; label:string; icon:string; onSelect:()=>void; disabled?:boolean; danger?:boolean; separatorBefore?:boolean; hint?:string }

export function taskLabel(kind:string):string{return ({storyboard:t("生成分镜"),scenes:t("生成画面"),modify:t("修改镜头"),preview:t("准备预览"),export:t("导出视频"),audio:t("合成声音")} as Record<string,string>)[kind]||t("正在处理");}

/** Single-row studio header: identity, save state, honest progress stepper, model and primary actions. */
export function StudioHeader({project,state,providers,steps,task,busy,graphOk,canExport,onHome,onRename,onStep,onGenerate,onExport,onCancel,onHistory,onRoute,menu}:{
  project:VideoProject;state:StudioState;providers:ProviderGroup[];steps:StepInfo[];task:TaskState|null|undefined;busy:boolean;graphOk:boolean;canExport:boolean;
  onHome:()=>void;onRename:(title:string)=>void;onStep:(id:StageId)=>void;onGenerate:(kind:'storyboard'|'scenes')=>void;onExport:()=>void;onCancel:()=>void;onHistory:()=>void;onRoute:(route:{provider:string;model:string})=>void;
  menu:MenuItem[];
}){
  useLocale();
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(project.title),input=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(!editing)setDraft(project.title);},[project.title,editing]);
  useEffect(()=>{if(editing)input.current?.select();},[editing]);
  const commitTitle=()=>{const value=draft.trim();setEditing(false);if(value&&value!==project.title)onRename(value);else setDraft(project.title);};
  const provider=providers.find(p=>p.id===state.route.provider),model=provider?.models.find(m=>m.id===state.route.model);
  const save=state.conflict?{tone:'danger',label:t("保存冲突")}:state.saving?{tone:'busy',label:t("正在保存")}:state.dirty?{tone:'warn',label:t("尚未保存")}:state.sourceDraft?{tone:'warn',label:t("源码草稿已保留")}:{tone:'ok',label:t("已保存")};
  const running=task?.status==='running';
  return <header className={`vs-header ${running?'is-running':''}`}>
    <button type="button" className="vs-brand vs-brand-home" onClick={onHome} aria-label={t("返回影片首页")} title={t("返回影片首页")}><span className="vs-brandmark"><VideoStudioIcon/></span></button>
    <div className="vs-header-identity">
      <nav className="vs-crumbs" aria-label={t("位置")}><button type="button" onClick={onHome}>{t("映流")}</button><Icon name="chevronRight"/></nav>
      {editing?<input ref={input} className="vs-title-input" aria-label={t("影片标题")} value={draft} onChange={e=>setDraft(e.target.value)} onBlur={commitTitle} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitTitle();}if(e.key==='Escape'){e.preventDefault();setDraft(project.title);setEditing(false);}}}/>
        :<h1><button type="button" className="vs-title-button" title={t("点击重命名")} onClick={()=>setEditing(true)} disabled={busy}>{project.title}<Icon name="text"/></button></h1>}
      <button type="button" className={`vs-save-chip is-${save.tone}`} onClick={onHistory} title={t("查看修改历史")}><i/>{save.label}<span>v{project.revision}</span></button>
    </div>
    <ol className="vs-stepper" aria-label={t("制作阶段")}>
      {steps.map((step,index)=><li key={step.id} className={`is-${step.state}`}>
        {index>0&&<i className="vs-step-line" aria-hidden="true"/>}
        <button type="button" title={step.hint} aria-current={step.state==='current'?'step':undefined} onClick={()=>onStep(step.id)}>
          <span className="vs-step-dot" aria-hidden="true">{step.state==='done'?<Icon name="check"/>:step.state==='warning'||step.state==='stale'?<Icon name="warning"/>:step.state==='running'?<span className="vs-spinner"/>:index+1}</span>
          <span className="vs-step-label">{step.label}</span>
        </button>
      </li>)}
    </ol>
    <div className="vs-header-actions">
      {running&&task&&<div className="vs-task-pill" role="status" title={systemMessage(task.message)||taskLabel(task.kind)}>
        <span className="vs-spinner"/><span className="vs-task-pill-text">{systemMessage(task.message)||taskLabel(task.kind)}</span><b>{Math.round(task.progress*100)}%</b>
        <button type="button" onClick={onCancel} aria-label={t("取消")} title={t("取消")}><Icon name="close"/></button>
      </div>}
      <Popover label={t("创作模型")} className="vs-model-popover" trigger={({open,toggle,ref})=><button type="button" ref={ref} className={`vs-model-chip ${model?'':'is-empty'}`} aria-expanded={open} onClick={toggle} title={t("创作模型")}>
        <Icon name="spark"/><span>{model?model.name:t("选择模型")}</span><Icon name="chevronDown"/></button>}>
        {()=><ModelPicker state={state} providers={providers} onRoute={onRoute}/>}
      </Popover>
      <Button icon="spark" className="vs-header-generate" disabled={busy} onClick={()=>onGenerate('storyboard')} title={t("让模型规划镜头、素材与时长")}>{t("生成分镜")}</Button>
      <Button icon="wand" className="vs-header-generate" disabled={busy||!graphOk} onClick={()=>onGenerate('scenes')} title={graphOk?t("让模型为每个镜头制作动画"):t("主链待连接")}>{t("生成画面")}</Button>
      <Button variant="primary" icon="download" disabled={busy||!canExport} onClick={onExport}>{t("导出视频")}</Button>
      <Popover label={t("更多操作")} trigger={({open,toggle,ref})=><button type="button" ref={ref} className="vs-iconbutton" aria-label={t("更多操作")} title={t("更多操作")} aria-expanded={open} onClick={toggle}><Icon name="more"/></button>}>
        {close=><div className="vs-menu">{menu.map(item=><div key={item.id} className={item.separatorBefore?'vs-menu-group':''}><button type="button" className={item.danger?'is-danger':''} disabled={item.disabled} onClick={()=>{close();item.onSelect();}}><Icon name={item.icon}/><span>{item.label}</span>{item.hint&&<kbd>{item.hint}</kbd>}</button></div>)}</div>}
      </Popover>
    </div>
    {running&&task&&<div className="vs-header-progress" aria-hidden="true"><i style={{transform:`scaleX(${Math.max(.02,task.progress)})`}}/></div>}
  </header>;
}

function ModelPicker({state,providers,onRoute}:{state:StudioState;providers:ProviderGroup[];onRoute:(route:{provider:string;model:string})=>void}){
  useLocale();
  const provider=providers.find(p=>p.id===state.route.provider);
  return <div className="vs-model-picker">
    <p className="vs-eyebrow">{t("创作模型")}</p>
    <label className="vs-field"><span>{t("模型提供方")}</span><select aria-label={t("模型提供方")} value={state.route.provider} onChange={e=>{const p=providers.find(v=>v.id===e.target.value);onRoute({provider:e.target.value,model:p?.models[0]?.id||''});}}><option value="">{t("选择提供方")}</option>{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label className="vs-field"><span>{t("创作模型")}</span><select aria-label={t("创作模型")} value={state.route.model} onChange={e=>onRoute({...state.route,model:e.target.value})}><option value="">{t("选择模型")}</option>{provider?.models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    {!providers.length&&<small className="vs-muted">{t("在 DSH 中配置创作模型后，这里会列出可用模型。")}</small>}
  </div>;
}
