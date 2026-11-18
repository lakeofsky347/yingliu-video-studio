import { t, useLocale, systemMessage } from './i18n.ts';
import { useMemo, useState } from 'react';
import type { ProjectLocation, SessionBinding } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { Dialog } from './Dialog.tsx';
import { IconButton } from './icons.tsx';
import { isDelegatedSession, resolveSessionBinding, sessionName, sessionUpdatedAt, type SessionDirectoryProps } from './session-directory.ts';

interface SessionPickerProps extends SessionDirectoryProps {
  project:Pick<ProjectLocation,'id'|'title'>; projects:ProjectLocation[]; bindings:Record<string,SessionBinding>;
  controller:StudioController; mode?:'associate'|'continue'; onClose:()=>void;
}
export function SessionPicker({project,projects,bindings,controller,sessions=[],sessionsLoading=false,sessionsError='',onRefreshSessions,currentSessionId,onOpenSession,mode='associate',onClose}:SessionPickerProps) {
  useLocale();
  const [query,setQuery]=useState(''),[delegated,setDelegated]=useState(false),[archived,setArchived]=useState(false),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const eligible=useMemo(()=>sessions.filter(session=>mode!=='continue'||resolveSessionBinding(session.id,sessions,bindings).binding?.relatedProjectIds.includes(project.id)),[sessions,bindings,mode,project.id]);
  const rows=eligible.filter(session=>(archived||!session.archived)&&(delegated||!isDelegatedSession(session))&&`${session.displayTitle} ${session.cwd||''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const row=sessions.find(session=>session.id===selected),resolved=row?resolveSessionBinding(row.id,sessions,bindings):undefined;
  const activeId=resolved?.binding?.currentProjectId,active=projects.find(item=>item.id===activeId),alreadyCurrent=activeId===project.id;
  const direct=selected?bindings[selected]:undefined,linked=Boolean(direct?.relatedProjectIds.includes(project.id));
  const targetRunning=Boolean(row?.running||sessions.find(session=>session.id===resolved?.ownerSessionId)?.running);
  const changing=mode==='associate'?!alreadyCurrent||Boolean(resolved?.inherited):!alreadyCurrent;
  async function submit(){if(!row)return;setBusy(true);setError('');try{
    if(changing){await controller.bindSession(row.id,project.id,direct?.currentProjectId);}
    if(mode==='continue'){await onOpenSession?.(row.id);}onClose();
  }catch(cause){setError(cause instanceof Error?cause.message:'会话关联未完成');}finally{setBusy(false);}}
  async function remove(sessionId:string){setBusy(true);setError('');try{await controller.unbindSession(sessionId,project.id);setSelected('');}catch(cause){setError(cause instanceof Error?cause.message:'解除关联未完成');}finally{setBusy(false);}}
  const unavailable=Object.keys(bindings).filter(id=>bindings[id]?.relatedProjectIds.includes(project.id)&&!sessions.some(session=>session.id===id));
  return <Dialog label={mode==='continue'?t("选择继续创作的会话"):t("关联会话")} onClose={onClose} busy={busy} className="vs-session-modal">
    <div className="vs-section-header"><div><h2>{mode==='continue'?t("继续会话创作"):t("关联已有会话")}</h2></div><IconButton icon="close" label={t("关闭会话选择")} onClick={onClose} disabled={busy}/></div>
    <p>{t("影片：")}<strong>{project.title}</strong>{t("。{value0}", {value0: mode==='continue'?t("选择要继续的会话。切换当前工程会明确写入关联。"):t("每个会话有一个当前影片，并保留其他关联工程。")})}</p>
    <div className="vs-session-search"><input autoFocus data-dialog-autofocus type="search" aria-label={t("搜索会话")} placeholder={t("搜索会话名称或工作区…")} value={query} onChange={event=>setQuery(event.target.value)}/><button onClick={()=>void onRefreshSessions?.()} disabled={sessionsLoading}>{t("刷新")}</button></div>
    <div className="vs-session-options"><label><input type="checkbox" checked={delegated} onChange={event=>{setDelegated(event.target.checked);if(event.target.checked)void onRefreshSessions?.(selected||currentSessionId);}}/>{t("显示子代理／团队任务")}</label><label><input type="checkbox" checked={archived} onChange={event=>setArchived(event.target.checked)}/>{t("包含归档会话")}</label></div>
    {sessionsError&&<p className="vs-inline-error" role="alert">{systemMessage(sessionsError)}</p>}
    <div className="vs-session-rows" role="radiogroup" aria-label={t("已有会话")}>{sessionsLoading&&<p className="vs-session-loading" role="status">{t("正在刷新会话目录…")}</p>}{!rows.length&&!sessionsLoading&&<p className="vs-session-empty">{mode==='continue'?t("暂无可继续的关联会话，可先从工程卡片关联会话。"):query?t("没有找到匹配的会话。"):t("暂无已有会话，请先在 DSH 创建一个会话。")}</p>}{rows.map(session=>{const relation=resolveSessionBinding(session.id,sessions,bindings),film=projects.find(item=>item.id===relation.binding?.currentProjectId);return <label className={`vs-session-row ${selected===session.id?'is-selected':''}`} key={session.id} data-session-id={session.id}><input type="radio" name="vs-session-choice" value={session.id} checked={selected===session.id} onChange={()=>{setSelected(session.id);setError('');void onRefreshSessions?.(session.id);}} disabled={busy}/><span className="vs-session-row-body"><strong>{session.displayTitle}<span className="vs-session-badges">{session.id===currentSessionId&&<small>{t("当前会话")}</small>}{isDelegatedSession(session)&&<small>{session.originLabel||t("子代理／团队任务")}</small>}{session.archived&&<small>{t("已归档")}</small>}{session.running&&<small>{t("执行中")}</small>}</span></strong><span>{session.cwd||t("未指定工作区")}{sessionUpdatedAt(session.updatedAt)&&` · ${sessionUpdatedAt(session.updatedAt)}`}</span><span className="vs-session-film">{relation.inherited?t("沿用「{value0}」的工程：", {value0: sessionName(relation.ownerSessionId!,sessions)}): t("当前工程：")}{film?.title||(relation.binding?.currentProjectId?t("工程不可用"):t("尚未设置"))}{relation.binding?.relatedProjectIds.includes(project.id)&&<b>{relation.binding.currentProjectId===project.id?t("本影片为当前工程"):t("已关联本影片")}</b>}</span></span></label>;})}</div>
    {row&&<div className="vs-session-choice-summary">{resolved?.inherited&&<p>{t("此任务沿用上级会话的工程。为此任务关联会建立专属关系，其他任务保持原有工程。")}</p>}{alreadyCurrent&&(!resolved?.inherited||mode==='continue')?<p>{t("《{value0}》已是此会话的当前工程。", {value0: project.title})}</p>:<p>{activeId?t("此会话当前制作《{value0}》，将切换为《{value1}》。", {value0: active?.title||t("不可用工程"), value1: project.title}):t("将《{value0}》设为此会话的当前工程。", {value0: project.title})}</p>}{targetRunning&&changing&&<p>{t("会话或上级任务正在执行，结束后可切换当前工程。")}</p>}{mode==='continue'&&row.navigable===false&&<p>{t("此任务的会话地址尚未就绪，可关联工程，暂时无法进入会话。")}</p>}{linked&&<button className="vs-danger" disabled={busy||targetRunning} onClick={()=>void remove(row.id)}>{t("解除本影片与此会话的关联")}</button>}</div>}
    {unavailable.length>0&&<details className="vs-unavailable-sessions"><summary>{t("{value0} 个关联会话当前不可用", {value0: unavailable.length})}</summary>{unavailable.map(id=><div key={id}><span>{sessionName(id,sessions)}</span><button disabled={busy} onClick={()=>void remove(id)}>{t("解除关联")}</button></div>)}</details>}
    {error&&<p className="vs-inline-error" role="alert">{systemMessage(error)}</p>}
    <div className="vs-modal-actions"><button disabled={busy} onClick={onClose}>{t("取消")}</button><button className="vs-primary" disabled={busy||!row||(changing&&targetRunning)||(mode==='continue'&&(!onOpenSession||row?.navigable===false))||(mode==='associate'&&alreadyCurrent&&!resolved?.inherited)} onClick={()=>void submit()}>{busy?t("正在处理…"):mode==='continue'?(alreadyCurrent?t("进入会话"):t("设为当前工程并进入会话")):alreadyCurrent&&!resolved?.inherited?t("已关联为当前工程"):resolved?.inherited?t("为此任务关联专属工程"):t("关联并设为当前工程")}</button></div>
  </Dialog>;
}
