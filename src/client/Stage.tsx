import { useEffect, useRef, type RefObject } from 'react';
import type { Shot, StudioSnapshot, VideoProject } from '../shared/types.ts';
import type { StudioController, StudioState } from './controller.ts';
import type { LiteGraphEditor } from './graph-adapter.ts';
import { t, useLocale, systemMessage } from './i18n.ts';
import { Button, Icon, IconButton } from './icons.tsx';
import { targetLabel } from './output-settings.tsx';
import { Preview } from './Preview.tsx';
import type { Playhead } from './playhead-store.ts';

export type StageMode='monitor'|'canvas'|'split';
export type StageLayout='wide'|'medium'|'narrow';

export function Stage({project,snapshot,state,controller,playhead,layout,stageMode,onStageMode,assetsOpen,onToggleAssets,onOutputSettings,duration,selectedShot,locked,busy,graphCheck,canvasRef,minimapRef,graphRef,zoom,onAddShot,onRefreshPreview,onConnectOrder,ordered,wordOpen,onWordOpen,editScope,onEditScope,instruction,onInstruction,onModify}:{
  project:VideoProject;snapshot:StudioSnapshot;state:StudioState;controller:StudioController;layout:StageLayout;
  playhead:Playhead;
  stageMode:StageMode;onStageMode:(mode:StageMode)=>void;assetsOpen:boolean;onToggleAssets:()=>void;onOutputSettings:()=>void;
  duration:number;selectedShot?:Shot;locked:boolean;busy:boolean;graphCheck:{ok:boolean;errors:string[]}|null;
  canvasRef:RefObject<HTMLCanvasElement>;minimapRef:RefObject<HTMLCanvasElement>;graphRef:RefObject<LiteGraphEditor|null>;zoom:number;
  onAddShot:()=>void;onRefreshPreview:()=>void;onConnectOrder:(ids:string[])=>void;ordered:Shot[];
  wordOpen:boolean;onWordOpen:(open:boolean)=>void;editScope:'shot'|'film';onEditScope:(scope:'shot'|'film')=>void;
  instruction:string;onInstruction:(value:string)=>void;onModify:()=>void;
}){
  useLocale();
  const wordRef=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{if(wordOpen)requestAnimationFrame(()=>wordRef.current?.focus());},[wordOpen]);
  const canvasVisible=stageMode!=='monitor';
  const durationOff=Math.abs(duration-project.targetDuration)>Math.max(1,project.targetDuration*.1);
  return <section className="vs-stage" data-mode={stageMode} aria-label={t("舞台")}>
    <div className="vs-stage-toolbar">
      <div className="vs-stage-left">
        {layout!=='wide'&&<IconButton icon="sidebar" label={t("资产库")} active={assetsOpen} onClick={onToggleAssets}/>}
        <div className="vs-segmented vs-stage-modes" role="radiogroup" aria-label={t("舞台视图")}>
          {([['monitor','monitor',t("监视器")],['canvas','graph',t("分镜画布")],['split','split',t("分栏")]] as const).map(([mode,icon,label])=>(layout==='narrow'&&mode==='split')?null:<button type="button" role="radio" key={mode} aria-checked={stageMode===mode} className={stageMode===mode?'is-active':''} title={label} onClick={()=>onStageMode(mode)}><Icon name={icon}/><span>{label}</span></button>)}
        </div>
        <button type="button" className="vs-format-chip" aria-label={t("打开输出设定")} title={t("输出设定")} onClick={onOutputSettings}>{targetLabel(project.target)}</button>
        <span className={`vs-duration ${durationOff?'is-off':''}`} title={t("/ 目标 {value0} 秒", {value0: project.targetDuration})}><strong>{duration.toFixed(1)}s</strong><small>/ {project.targetDuration}s</small></span>
      </div>
      <div className="vs-stage-right">
        <IconButton icon="undo" label={t("撤销 · Ctrl/Cmd Z")} disabled={!state.canUndo||locked} onClick={controller.undo}/>
        <IconButton icon="redo" label={t("重做 · Ctrl/Cmd Shift Z")} disabled={!state.canRedo||locked} onClick={controller.redo}/>
        {canvasVisible&&<><span className="vs-separator"/>
          <IconButton icon="group" label={t("选中节点分组")} disabled={locked} onClick={()=>graphRef.current?.groupSelection()}/>
          <IconButton icon="grid" label={t("整理画布")} disabled={locked} onClick={()=>graphRef.current?.arrange()}/>
        </>}
        <Button icon="plus" size="sm" disabled={locked} onClick={onAddShot} title={selectedShot?t("在选中镜头后添加"):t("添加镜头")}>{t("镜头")}</Button>
        <span className="vs-separator"/>
        <IconButton icon="refresh" label={t("检查资源并刷新预览")} disabled={busy||!!state.previewing||!graphCheck?.ok} onClick={onRefreshPreview}/>
        <button type="button" className={`vs-word-trigger ${wordOpen?'is-active':''}`} aria-expanded={wordOpen} onClick={()=>onWordOpen(!wordOpen)} title={t("用文字修改")+' · ⌘K'}><Icon name="spark"/><span>{t("用文字修改")}</span><kbd>⌘K</kbd></button>
      </div>
    </div>
    <div className="vs-stage-body">
      <div className="vs-stage-monitor" aria-hidden={stageMode==='canvas'||undefined}>
        <Preview key={project.id} snapshot={snapshot} project={project} selectedShot={selectedShot} controller={controller} transport={playhead} focusFrame={state.focusFrame} focusSerial={state.focusSerial} busy={busy} syncing={state.saving||state.dirty||!!state.previewing}/>
      </div>
      <div className="vs-stage-canvas" aria-hidden={stageMode==='monitor'||undefined}>
        <div className="vs-graph-shell"><canvas ref={canvasRef}/>
          <div className="vs-graph-legend"><span><i className="asset"/>{t("实际使用")}</span><span><i className="reference"/>{t("仅供参考")}</span><span><i className="shot"/>{t("播放顺序")}</span></div>
          <div className="vs-graph-hud-right">
            <div className="vs-graph-navigation" role="toolbar" aria-label={t("画布缩放")}>
              <button type="button" aria-label={t("缩小画布")} onClick={()=>graphRef.current?.zoom(zoom/1.2)}><Icon name="minus"/></button>
              <button type="button" className="vs-zoom-value" aria-label={t("画布 100%")} onClick={()=>graphRef.current?.zoom(1)}>{Math.round(zoom*100)}%</button>
              <button type="button" aria-label={t("放大画布")} onClick={()=>graphRef.current?.zoom(zoom*1.2)}><Icon name="plus"/></button>
              <span className="vs-separator"/>
              <button type="button" aria-label={t("聚焦选中")} title={t("聚焦选中")} disabled={!state.selected} onClick={()=>graphRef.current?.focus(state.selected||undefined)}><Icon name="focus"/></button>
              <button type="button" aria-label={t("全图概览")} title={t("全图概览")} onClick={()=>graphRef.current?.fit()}><Icon name="fit"/></button>
              <button type="button" aria-label={t("整理画布")} title={t("整理画布")} disabled={locked} onClick={()=>graphRef.current?.arrange()}><Icon name="grid"/></button>
            </div>
            <div className="vs-graph-minimap" aria-hidden="true" title={t("拖动或点击定位画布")}>
              <canvas ref={minimapRef}/>
            </div>
          </div>
          {graphCheck&&!graphCheck.ok&&<div className="vs-chain-note" role="status"><Icon name="warning"/><span><strong>{t("主链待连接")}</strong>{systemMessage(graphCheck.errors[0])}</span><Button size="sm" disabled={locked} onClick={()=>onConnectOrder(ordered.map(s=>s.id))}>{t("按时间线顺序连接")}</Button></div>}
        </div>
      </div>
      {wordOpen&&<div className="vs-word-panel" role="dialog" aria-label={t("用文字修改")}>
        <div className="vs-word-head">
          <div className="vs-segmented is-compact" role="radiogroup" aria-label={t("修改范围")}>
            <button type="button" role="radio" aria-checked={editScope==='shot'} className={editScope==='shot'?'is-active':''} disabled={!selectedShot} onClick={()=>onEditScope('shot')}>{t("当前镜头")}</button>
            <button type="button" role="radio" aria-checked={editScope==='film'} className={editScope==='film'?'is-active':''} onClick={()=>onEditScope('film')}>{t("整部影片")}</button>
          </div>
          <IconButton icon="close" label={t("关闭")} onClick={()=>onWordOpen(false)}/>
        </div>
        <h3>{editScope==='shot'&&selectedShot?t("修改「{value0}」", {value0: selectedShot.title}):t("继续打磨整部影片")}</h3>
        <p>{editScope==='shot'?t("用一句话改变这个镜头，保留其他镜头。"):t("统一调整整片风格、文字或节奏。")}</p>
        <textarea ref={wordRef} rows={3} placeholder={t("例如：标题从左侧滑入，图片缓慢放大，整体改成奶油色。")} value={instruction} onChange={e=>onInstruction(e.target.value)} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();onModify();}if(e.key==='Escape'){e.preventDefault();onWordOpen(false);}}}/>
        <div className="vs-word-foot"><small>{state.route.model?t("⌘ Enter 提交"):t("先选择一个 DSH 模型，再开始生成。")}</small><Button variant="primary" icon="spark" disabled={busy||!instruction.trim()||(editScope==='shot'&&!selectedShot)} onClick={onModify}>{editScope==='shot'?t("修改这个镜头"):t("修改整部影片")}</Button></div>
      </div>}
    </div>
  </section>;
}
