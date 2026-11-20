import { useState } from 'react';
import type { StudioController, StudioState } from './controller.ts';
import { t, useLocale } from './i18n.ts';
import { Button, Icon, IconButton } from './icons.tsx';
import { Dialog } from './Dialog.tsx';
import { Field } from './EnvironmentPanel.tsx';
import { NumberField } from './NumberField.tsx';
import { ASPECTS, dimensionsForAspect } from './output-settings.tsx';
import { isDelegatedSession, type SessionDirectoryProps } from './session-directory.ts';

type Mode='code_animation'|'model_video';
export function CreateFilmDialog({controller,state,sessions=[],initialStyleId='',onClose}:{controller:StudioController;state:StudioState;sessions?:SessionDirectoryProps['sessions'];initialStyleId?:string;onClose:()=>void}){
  useLocale();
  const busy=state.pending||state.snapshot?.task?.status==='running';
  const [title,setTitle]=useState(''),[topic,setTopic]=useState(''),[duration,setDuration]=useState(30),[aspect,setAspect]=useState('16:9');
  const [mode,setMode]=useState<Mode>('code_animation'),[styleId,setStyleId]=useState(initialStyleId),[sessionId,setSessionId]=useState(''),[delegated,setDelegated]=useState(false);
  const style=state.styles.find(item=>item.id===styleId);
  async function create(automatic:boolean){
    const name=title.trim()||t("我的视频");
    if(!await controller.action('create',{title:name,productionMode:mode,topic:topic.trim(),targetDuration:duration,target:{...dimensionsForAspect(aspect,1080),fps:{num:30,den:1},audioMode:'none'},videoStyle:style}))return;
    const created=controller.getSnapshot().snapshot?.project;onClose();
    if(sessionId&&created){try{await controller.bindSession(sessionId,created.id,state.sessionBindings[sessionId]?.currentProjectId);}catch{return;}}
    if(automatic)await controller.generate('storyboard');
  }
  const modes:[Mode,string,string,string][]=[['code_animation',t("代码动画"),t("文字、图片与动效，适合讲解和展示"),'code'],['model_video',t("模型视频"),t("使用生成或导入的视频素材"),'video']];
  return <Dialog label={t("开启一部新影片")} onClose={onClose} busy={busy} className="vs-create-modal">
    <div className="vs-section-header"><div><h2>{t("开启一部新影片")}</h2><p className="vs-modal-lead">{t("一个主题就能开始，也可以先建立项目，再导入图片和文字。")}</p></div><IconButton icon="close" label={t("关闭")} onClick={onClose}/></div>
    <Field label={t("影片名称")}><input autoFocus value={title} onChange={e=>setTitle(e.target.value)} placeholder={t("给这部影片起个名字")}/></Field>
    <Field label={t("主题与制作想法")}><textarea rows={3} value={topic} onChange={e=>setTopic(e.target.value)} placeholder={t("例如：用三张产品图片，制作一段 30 秒的极简新品介绍。")}/></Field>
    <div className="vs-field"><span>{t("制作模式")}</span><div className="vs-choice-cards" role="radiogroup" aria-label={t("制作模式")}>
      {modes.map(([value,label,hint,icon])=><button type="button" key={value} role="radio" aria-checked={mode===value} className={mode===value?'is-active':''} onClick={()=>setMode(value)}><Icon name={icon}/><span><strong>{label}</strong><small>{hint}</small></span></button>)}
    </div><small>{t("此选择会约束生成工具和成片来源；之后可在制作要求中明确修改。")}</small></div>
    <div className="vs-field-pair">
      <Field label={t("初始目标片长（秒）")}><NumberField value={duration} min={1} step={1} onCommit={setDuration} label={t("初始目标片长（秒）")}/></Field>
      <Field label={t("初始输出比例")}><select value={aspect} onChange={event=>setAspect(event.target.value)}>{ASPECTS.map(item=><option value={item.id} key={item.id}>{t(item.label)} · 1080p · 30 FPS</option>)}</select></Field>
    </div>
    <details className="vs-create-more">
      <summary><Icon name="chevronRight"/>{t("风格与会话（可选）")}</summary>
      <Field label={t("制作风格（可选）")} hint={t("风格会随影片保存，并用于生成分镜与镜头。")}><select value={styleId} onChange={event=>setStyleId(event.target.value)}><option value="">{t("不选择风格")}</option>{state.styles.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <Field label={t("关联已有会话（可选）")} hint={t("创建后将影片设为所选会话的当前工程，已有影片仍保留关联。")}><select value={sessionId} onChange={event=>setSessionId(event.target.value)}><option value="">{t("暂不关联，先进入工作台")}</option>{sessions.filter(session=>!session.archived&&(delegated||!isDelegatedSession(session))).map(session=><option value={session.id} key={session.id} disabled={session.running}>{session.displayTitle}{session.originLabel?` · ${session.originLabel}`:''}{session.running?t(" · 执行中"):''}</option>)}</select></Field>
      <label className="vs-home-delegated"><input type="checkbox" checked={delegated} onChange={event=>{setDelegated(event.target.checked);if(!event.target.checked&&sessions.some(session=>session.id===sessionId&&isDelegatedSession(session)))setSessionId('');}}/>{t("显示子代理／团队任务")}</label>
    </details>
    <div className="vs-modal-actions">
      <Button disabled={busy||!(duration>0)} onClick={()=>void create(false)}>{sessionId?t("创建并关联"):t("创建影片")}</Button>
      <Button variant="primary" icon="spark" disabled={busy||!(duration>0)||!topic.trim()||!state.route.model} title={!state.route.model?t("先选择一个 DSH 模型，再开始生成。"):!topic.trim()?t("填写主题后可以直接生成分镜"):undefined} onClick={()=>void create(true)}>{t("创建并生成分镜")}</Button>
    </div>
  </Dialog>;
}
