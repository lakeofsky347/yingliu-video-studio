import { useState, type ReactNode } from 'react';
import { bindAsset, unbindAsset, updateShot } from '../core/index.ts';
import type { Asset, Shot, VideoProject } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { t, useLocale } from './i18n.ts';
import { Button, Icon } from './icons.tsx';
import { Field } from './EnvironmentPanel.tsx';
import { NumberField } from './NumberField.tsx';
import { OutputSettings } from './output-settings.tsx';
import { VideoClipEditor } from './MediaPanel.tsx';

const FOLD_KEY='vs-property-folds';
function readFolds():Record<string,boolean>{try{return JSON.parse(globalThis.localStorage?.getItem(FOLD_KEY)||'{}')||{};}catch{return {};}}
/** Collapsible property group whose open state is remembered across shots and sessions. */
function Fold({id,title,defaultOpen=false,children,badge}:{id:string;title:string;defaultOpen?:boolean;children:ReactNode;badge?:ReactNode}){
  const [open,setOpen]=useState(()=>readFolds()[id]??defaultOpen);
  return <section className={`vs-prop-fold ${open?'is-open':''}`}>
    <button type="button" className="vs-prop-fold-head" aria-expanded={open} onClick={()=>{const next=!open;setOpen(next);try{globalThis.localStorage?.setItem(FOLD_KEY,JSON.stringify({...readFolds(),[id]:next}));}catch{/* storage is optional */}}}>
      <Icon name="chevronRight"/><span>{title}</span>{badge}
    </button>
    <div className="vs-prop-fold-body"><div>{children}</div></div>
  </section>;
}

export function PropertiesPanel({project,controller,selectedShot,selectedAsset,assetUrl,fps,duration,locked,lockReason,commit,onOpenPanel,onDeleteShot,onDeleteAsset,onDuplicateShot}:{
  project:VideoProject;controller:StudioController;selectedShot?:Shot;selectedAsset?:Asset;assetUrl:(asset:Asset)=>string;fps:number;duration:number;
  locked:boolean;lockReason:string;commit:(project:VideoProject)=>void;onOpenPanel:(tab:'audio'|'media')=>void;
  onDeleteShot:(shot:Shot)=>void;onDeleteAsset:(asset:Asset)=>void;onDuplicateShot:(shot:Shot)=>void;
}){
  useLocale();
  const edit=(patch:Partial<VideoProject>)=>commit({...project,...patch,revision:project.revision+1,updatedAt:new Date().toISOString()});
  const shot=(patch:Partial<Shot>)=>{if(selectedShot)commit(updateShot(project,selectedShot.id,patch));};
  const params=(patch:Partial<Shot['params']>)=>{if(selectedShot)shot({params:{...selectedShot.params,...patch} as Shot['params']});};
  const asset=(patch:Partial<Asset>)=>{if(selectedAsset)edit({assets:project.assets.map(a=>a.id===selectedAsset.id?{...a,...patch}:a)});};
  const kind=selectedShot?'shot':selectedAsset?'asset':'film';
  const order=selectedShot?project.shotOrder.indexOf(selectedShot.id):-1;
  const bindable=project.assets.filter(a=>a.kind!=='audio'&&a.kind!=='video');
  return <aside className="vs-properties" aria-label={t("属性")} data-kind={kind}>
    <div className="vs-panel-header">
      <h2>{selectedShot?t("镜头属性"):selectedAsset?t("资产属性"):t("影片设定")}{selectedShot&&order>=0&&<small>{String(order+1).padStart(2,'0')}</small>}</h2>
      {(selectedShot||selectedAsset)&&<button type="button" className="vs-link-button" onClick={()=>controller.select(null)}>{t("影片设定")}<Icon name="chevronRight"/></button>}
    </div>
    <div className={`vs-lock-veil ${locked?'is-on':''}`} role={locked?'status':undefined} aria-hidden={!locked}><span className="vs-spinner"/>{lockReason}</div>
    <fieldset className="vs-property-scroll" disabled={locked} key={selectedShot?.id||selectedAsset?.id||'film'}>
      {selectedShot?<>
        <section className="vs-prop-group">
          <Field label={t("镜头标题")}><input value={selectedShot.title} onChange={e=>shot({title:e.target.value})}/></Field>
          <div className="vs-field-pair">
            <Field label={t("时长（秒）")}><NumberField value={Number((selectedShot.durationFrames/fps).toFixed(2))} min={0.05} step={0.1} label={t("时长（秒）")} onCommit={n=>shot({durationFrames:Math.max(1,Math.round(n*fps))})}/></Field>
            <Field label={t("镜头转场")}><div className="vs-segmented" role="radiogroup" aria-label={t("镜头转场")}>{(['cut','fade'] as const).map(value=><button type="button" role="radio" key={value} aria-checked={selectedShot.transition===value} className={selectedShot.transition===value?'is-active':''} onClick={()=>shot({transition:value})}>{value==='cut'?t("直接切换"):t("淡入淡出")}</button>)}</div></Field>
          </div>
        </section>
        <section className="vs-prop-group">
          <h3>{t("屏幕上的字")}</h3>
          <Field label={t("屏幕主文字")}><textarea rows={2} value={selectedShot.params.text} onChange={e=>params({text:e.target.value})}/></Field>
          <Field label={t("补充文字")}><textarea rows={2} value={selectedShot.params.subtitle} onChange={e=>params({subtitle:e.target.value})}/></Field>
        </section>
        <Fold id="story" title={t("叙事与旁白")} defaultOpen>
          <Field label={t("叙事意图")}><textarea rows={2} value={selectedShot.intent} onChange={e=>shot({intent:e.target.value})}/></Field>
          <Field label={t("构图")}><textarea rows={2} value={selectedShot.composition} onChange={e=>shot({composition:e.target.value})}/></Field>
          <Field label={t("运动意图")}><textarea rows={2} value={selectedShot.action} onChange={e=>shot({action:e.target.value})}/></Field>
          <Field label={t("旁白文案")}><textarea rows={3} value={selectedShot.narration||''} placeholder={t("此镜头的配音文字…")} onChange={e=>shot({narration:e.target.value})}/></Field>
          <Button icon="music" size="sm" onClick={()=>onOpenPanel('audio')}>{t("安排配音与音效")}</Button>
        </Fold>
        <Fold id="look" title={t("色彩与运动")} badge={<span className="vs-swatches" aria-hidden="true">{(['background','foreground','accent'] as const).map(key=><i key={key} style={{background:selectedShot.params[key]}}/>)}</span>}>
          <div className="vs-color-fields">{(['background','foreground','accent'] as const).map((key,i)=><label key={key} className="vs-color-field"><input type="color" aria-label={[t("背景"),t("文字"),t("强调")][i]!} value={selectedShot.params[key]} onChange={e=>params({[key]:e.target.value})}/><span>{[t("背景"),t("文字"),t("强调")][i]}</span></label>)}</div>
          <div className="vs-field-pair">
            <Field label={t("主文字字号")}><NumberField value={selectedShot.params.fontSize} min={8} max={300} step={1} label={t("主文字字号")} onCommit={n=>params({fontSize:Math.round(n)})}/></Field>
            <Field label={t("基础运动")}><select value={selectedShot.params.motion} onChange={e=>params({motion:e.target.value as Shot['params']['motion']})}><option value="fade">{t("淡入")}</option><option value="slide">{t("滑入")}</option><option value="zoom">{t("缩放")}</option><option value="none">{t("静止")}</option></select></Field>
          </div>
        </Fold>
        <Fold id="image" title={t("图片位置与缩放")}>
          <Field label={t("横向位置")}><input type="range" min="0" max="100" step="1" value={selectedShot.params.imageX} onChange={e=>params({imageX:Number(e.target.value)})}/></Field>
          <Field label={t("纵向位置")}><input type="range" min="0" max="100" step="1" value={selectedShot.params.imageY} onChange={e=>params({imageY:Number(e.target.value)})}/></Field>
          <Field label={t("图片缩放")}><input type="range" min="0.1" max="3" step="0.05" value={selectedShot.params.imageScale} onChange={e=>params({imageScale:Number(e.target.value)})}/></Field>
          <Field label={t("图片适应")}><div className="vs-segmented" role="radiogroup" aria-label={t("图片适应")}>{(['contain','cover'] as const).map(value=><button type="button" role="radio" key={value} aria-checked={selectedShot.params.imageFit===value} className={selectedShot.params.imageFit===value?'is-active':''} onClick={()=>params({imageFit:value})}>{value==='contain'?t("完整展示"):t("填满区域")}</button>)}</div></Field>
        </Fold>
        <VideoClipEditor controller={controller} project={project} shot={selectedShot} assetUrl={assetUrl}/>
        <section className="vs-bindings">
          <h3>{t("素材关联")}</h3>
          {bindable.map(item=>{const used=selectedShot.assetIds.includes(item.id),referenced=selectedShot.referenceIds.includes(item.id);return <div key={item.id} className={used||referenced?'is-linked':''}>
            <span className={`vs-binding-icon is-${item.kind}`}><Icon name={item.kind==='image'?'image':'text'}/></span><span className="vs-binding-name" title={item.name}>{item.name}</span>
            <div className="vs-segmented is-compact">
              <button type="button" aria-pressed={used} className={used?'is-active':''} onClick={()=>commit((used?unbindAsset:bindAsset)(project,selectedShot.id,item.id,'asset'))}>{t("使用")}</button>
              <button type="button" aria-pressed={referenced} className={referenced?'is-active is-reference':''} onClick={()=>commit((referenced?unbindAsset:bindAsset)(project,selectedShot.id,item.id,'reference'))}>{t("参考")}</button>
            </div>
          </div>;})}
          {!bindable.length&&<small>{t("导入图片或文字后，在这里绑定。")}</small>}
        </section>
        <div className="vs-property-actions">
          <Button icon="copy" size="sm" onClick={()=>onDuplicateShot(selectedShot)}>{t("复制镜头")}</Button>
          <Button variant="danger" icon="delete" size="sm" onClick={()=>onDeleteShot(selectedShot)}>{t("删除")}</Button>
        </div>
      </>:selectedAsset?<>
        {selectedAsset.kind==='image'&&assetUrl(selectedAsset)&&<img className="vs-property-image" src={assetUrl(selectedAsset)} alt={selectedAsset.name}/>}
        <Field label={t("资产名称")}><input value={selectedAsset.name} onChange={e=>asset({name:e.target.value})}/></Field>
        <Field label={t("用途说明")}><textarea rows={3} value={selectedAsset.description} onChange={e=>asset({description:e.target.value})}/></Field>
        {selectedAsset.kind==='video'&&<><video className="vs-property-video" controls preload="metadata" src={assetUrl(selectedAsset)}/><p className="vs-media-help">{t("选中镜头，在“视频片段”中绑定此素材并设置裁剪与原声。")}</p></>}
        {selectedAsset.kind==='audio'&&<><audio className="vs-property-audio" controls src={assetUrl(selectedAsset)}/><Button icon="music" size="sm" onClick={()=>onOpenPanel('audio')}>{t("安排声音片段")}</Button></>}
        {selectedAsset.kind==='text'&&<Field label={t("文字内容")}><textarea rows={8} value={selectedAsset.text||''} onChange={e=>asset({text:e.target.value})}/></Field>}
        <div className="vs-legend-box"><p><i className="is-asset"/>{t("使用素材：会进入镜头画面。")}</p><p><i className="is-reference"/>{t("仅供参考：指导模型理解构图与风格。")}</p></div>
        <div className="vs-property-actions"><span/><Button variant="danger" icon="delete" size="sm" onClick={()=>onDeleteAsset(selectedAsset)}>{t("删除资产")}</Button></div>
      </>:<>
        <Field label={t("影片标题")}><input value={project.title} onChange={e=>edit({title:e.target.value})}/></Field>
        <Field label={t("主题与想法")}><textarea rows={4} value={project.topic} placeholder={t("要表达什么？希望观众记住什么？")} onChange={e=>edit({topic:e.target.value})}/></Field>
        <Field label={t("目标片长（秒）")}><NumberField value={project.targetDuration} min={1} step={1} label={t("目标片长（秒）")} onCommit={value=>edit({targetDuration:value})}/></Field>
        <div className="vs-stat-grid"><div><strong>{project.shots.length}</strong><small>{t("镜头")}</small></div><div><strong>{project.assets.length}</strong><small>{t("资产")}</small></div><div><strong>{duration.toFixed(1)}<em>s</em></strong><small>{t("总时长")}</small></div></div>
        <Fold id="output" title={t("输出设定")} defaultOpen><OutputSettings project={project} onChange={commit}/></Fold>
        <div className="vs-tip-box"><Icon name="info"/><div><strong>{t("先讲清故事，再生成画面。")}</strong><p>{t("选中镜头可以调整文字、色彩、时长和素材。拖动端口，连接镜头顺序。")}</p></div></div>
      </>}
    </fieldset>
  </aside>;
}
