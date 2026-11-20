import { t, useLocale, systemMessage, getLocale } from './i18n.ts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { addShot, compileSpec, deleteAsset, deleteShot, duplicateShot, reorderShots, specMarkdown, validateGraph } from '../core/index.ts';
import type { Asset, ProjectLocation, Shot, VideoProject, VideoStyle } from '../shared/types.ts';
import { StudioController, type EditUndo } from './controller.ts';
import { LiteGraphEditor, type GraphRemoval } from './graph-adapter.ts';
import { OutputSettings } from './output-settings.tsx';
import { AudioPanel } from './AudioPanel.tsx';
import { ProjectHome } from './ProjectHome.tsx';
import { StyleLibrary } from './StyleLibrary.tsx';
import { SessionPicker } from './SessionPicker.tsx';
import { Dialog } from './Dialog.tsx';
import { projectSessions, type SessionDirectoryProps } from './session-directory.ts';
import { ExportPanel } from './ExportPanel.tsx';
import { MediaPanel } from './MediaPanel.tsx';
import { WorkflowPanel } from './WorkflowPanel.tsx';
import { ModelCenter } from './ModelCenter.tsx';
import { ProductionPolicySettings } from './ProductionPolicySettings.tsx';
import { TaskPanel, HistoryPanel } from './TaskPanel.tsx';
import { SourceEditor } from './SourceEditor.tsx';
import { VideoStudioIcon } from './VideoStudioIcon.tsx';
import { Button, Icon, IconButton } from './icons.tsx';
import { ConfirmationScope, ConfirmHost, Toasts, useCancelConfirmation, useConfirmAction } from './Feedback.tsx';
import { createToastStore } from './toast-store.ts';
import { AssetsPanel } from './AssetsPanel.tsx';
import { PropertiesPanel } from './PropertiesPanel.tsx';
import { Stage, type StageLayout, type StageMode } from './Stage.tsx';
import { Timeline } from './Timeline.tsx';
import { createPlayhead } from './playhead-store.ts';
import { BottomDrawer, type DrawerTab } from './BottomDrawer.tsx';
import { EnvironmentPanel, Field } from './EnvironmentPanel.tsx';
import { CreateFilmDialog } from './CreateFilmDialog.tsx';
import { StudioHeader, taskLabel, type MenuItem, type StageId, type StepInfo } from './StudioHeader.tsx';

type PanelTab='media'|'audio'|'source'|'workflow'|'spec'|'history'|'tasks'|'exports'|'environment';
type Pane='properties'|'assets'|'panels';
export interface StudioProps extends SessionDirectoryProps { controller:StudioController }

const store={
  get<T>(key:string,fallback:T):T{try{const value=globalThis.localStorage?.getItem(key);return value===null||value===undefined?fallback:JSON.parse(value) as T;}catch{return fallback;}},
  set(key:string,value:unknown):void{try{globalThis.localStorage?.setItem(key,JSON.stringify(value));}catch{/* optional */}},
};
/** Layout follows the studio's own width, so the DSH right sidebar gets the compact layout even in a wide window. */
function useLayout(ref:RefObject<HTMLElement>):StageLayout{
  const [layout,setLayout]=useState<StageLayout>('wide');
  useLayoutEffect(()=>{
    const element=ref.current;if(!element||typeof ResizeObserver==='undefined')return;
    const measure=()=>{const width=element.getBoundingClientRect().width;setLayout(width<780?'narrow':width<1180?'medium':'wide');};
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[ref]);
  return layout;
}

export function Studio(props:StudioProps){return <ConfirmationScope><StudioContent {...props}/></ConfirmationScope>;}

function StudioContent({controller,currentSessionId,onOpenSession,sessions=[],sessionsLoading=false,sessionsError='',onRefreshSessions}:StudioProps){
  useLocale();
  const confirmAction=useConfirmAction(),cancelConfirmation=useCancelConfirmation();
  const [toasts]=useState(createToastStore),{toast}=toasts;
  useEffect(()=>controller.subscribe(toasts.dropUnavailableActions),[controller,toasts]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const snapshot=state.snapshot,project=snapshot?.project||null,task=snapshot?.task;
  const isHome=state.workspaceView==='projects'||!project;
  useEffect(()=>()=>{cancelConfirmation?.();toasts.clear();},[controller,project?.id,isHome,cancelConfirmation,toasts]);
  const sessionProps={sessions,sessionsLoading,sessionsError,onRefreshSessions,currentSessionId,onOpenSession};
  const busy=state.pending||task?.status==='running';
  const generating=task?.status==='running'&&['storyboard','scenes','modify','audio'].includes(task.kind);
  const validatingPreview=task?.status==='running'&&task.kind==='preview';
  const locked=generating||validatingPreview||state.pending;
  const studioRef=useRef<HTMLElement>(null),canvasRef=useRef<HTMLCanvasElement>(null),graphRef=useRef<LiteGraphEditor|null>(null),autoPreviewedRef=useRef('');
  const minimapRef=useRef<HTMLCanvasElement>(null);
  const [playhead]=useState(createPlayhead);
  const layout=useLayout(studioRef);
  const [stageMode,setStageModeState]=useState<StageMode>(()=>store.get<StageMode>('vs-stage-mode','monitor'));
  const [panel,setPanel]=useState<PanelTab>(()=>store.get<PanelTab>('vs-drawer-tab','audio'));
  const [drawerOpen,setDrawerOpen]=useState(false),[drawerHeight,setDrawerHeight]=useState(()=>store.get('vs-drawer-height',320)),[flash,setFlash]=useState(0);
  const [pane,setPane]=useState<Pane>('properties'),[assetsOpen,setAssetsOpen]=useState(false);
  const [homeModal,setHomeModal]=useState<'media'|'environment'|null>(null);
  const [newOpen,setNewOpen]=useState(false),[newStyleId,setNewStyleId]=useState(''),[directoryOpen,setDirectoryOpen]=useState(false),[styleLibraryOpen,setStyleLibraryOpen]=useState(false);
  const [openPath,setOpenPath]=useState(''),[textOpen,setTextOpen]=useState(false),[textAsset,setTextAsset]=useState('');
  const [sessionDialog,setSessionDialog]=useState<{project:Pick<ProjectLocation,'id'|'title'>;mode:'associate'|'continue'}|null>(null);
  const [zoom,setZoom]=useState(.9),[outputOpen,setOutputOpen]=useState(false),[keysOpen,setKeysOpen]=useState(false);
  const [wordOpen,setWordOpen]=useState(false),[instruction,setInstruction]=useState(''),[editScope,setEditScope]=useState<'shot'|'film'>('film');
  const [dismissedTask,setDismissedTask]=useState('');
  const selectedShot=project?.shots.find(s=>s.id===state.selected),selectedAsset=project?.assets.find(a=>a.id===state.selected);
  const graphCheck=useMemo(()=>project?validateGraph(project):null,[project]);
  const spec=useMemo(()=>{try{return project?compileSpec(project):null;}catch{return null;}},[project]);
  const totalFrames=project?.shots.reduce((sum,s)=>sum+s.durationFrames,0)||0;
  const fps=project?project.target.fps.num/project.target.fps.den:30;
  const duration=totalFrames/fps;
  const canvasVisible=stageMode!=='monitor';
  const setStageMode=(mode:StageMode)=>{setStageModeState(mode);store.set('vs-stage-mode',mode);};
  /** Every entry point to a panel goes through here: open the drawer, select the tab and bring it into view. */
  const openPanel=(tab:PanelTab)=>{setPanel(tab);store.set('vs-drawer-tab',tab);setDrawerOpen(true);if(layout==='narrow')setPane('panels');setFlash(value=>value+1);};
  useEffect(()=>setEditScope(selectedShot?'shot':'film'),[selectedShot?.id]);
  useEffect(()=>{void controller.refreshVisibleProject();},[controller]);
  useEffect(()=>()=>{controller.persistDrafts();void controller.flush();},[controller]);
  useEffect(()=>{if(state.focusSerial){if(stageMode==='canvas')setStageMode('split');if(state.selected)graphRef.current?.focus(state.selected);}},[state.focusSerial]);
  const assetBaseUrl=snapshot?.assetBaseUrl||snapshot?.previewUrl;
  const assetUrl=(asset:Asset):string=>state.localImages[asset.id]||(assetBaseUrl&&asset.path?new URL(asset.path,assetBaseUrl).href:'');
  const commit=controller.edit;
  // Debounced auto-preview: ~1.2s after a saved revision settles with an outdated preview, rebuild without locking edits.
  useEffect(()=>{
    if(!project||state.workspaceView!=='studio'||!graphCheck?.ok||state.dirty||state.saving||state.pending||state.previewing||state.conflict||state.sourceDraft||generating||task?.status==='running')return;
    if(snapshot?.previewRevision===project.revision)return;
    const key=`${project.id}:${project.revision}`;if(autoPreviewedRef.current===key)return;
    const timer=setTimeout(()=>{autoPreviewedRef.current=key;void controller.refreshPreview();},1200);
    return()=>clearTimeout(timer);
  },[project?.id,project?.revision,snapshot?.previewRevision,state.workspaceView,graphCheck?.ok,state.dirty,state.saving,state.pending,state.previewing,state.conflict,state.sourceDraft,generating,task?.status,controller]);
  const graphUndo=useRef<EditUndo>();
  const undoAction=(undo:EditUndo|undefined)=>undo?.available()?{label:t("撤销"),...undo}:undefined;
  const onGraphRemoved=(removal:GraphRemoval)=>{
    const messages=removal.shots.length?[removal.shots.length===1?t("已删除镜头「{value0}」",{value0:removal.shots[0]}):t("已删除 {value0} 个镜头",{value0:removal.shots.length})]:[];
    for(const asset of removal.assets)messages.push(asset.links?t("已解除「{value0}」的 {value1} 处关联，资产仍保留在资产库",{value0:asset.name,value1:asset.links}):t("「{value0}」没有关联任何镜头。删除资产请在资产库中操作。",{value0:asset.name}));
    const action=undoAction(graphUndo.current);graphUndo.current=undefined;
    for(const [index,message] of messages.entries())toast({message,action:index===messages.length-1?action:undefined});
  };
  const removedRef=useRef(onGraphRemoved);removedRef.current=onGraphRemoved;
  useEffect(()=>{
    if(state.workspaceView!=='studio'||!canvasRef.current||!project)return;
    const editor=new LiteGraphEditor(canvasRef.current,(next,offerUndo)=>{
      if(!offerUndo)return controller.edit(next);
      const result=controller.editWithUndo(next);
      graphUndo.current=result?.undo;
      return result!==null;
    },controller.select,setZoom,removal=>removedRef.current(removal),playhead);graphRef.current=editor;
    return()=>{editor.dispose();graphRef.current=null;};
  },[project?.id,controller,state.workspaceView,playhead]);
  useEffect(()=>{graphRef.current?.attachMinimap(canvasVisible?minimapRef.current:null);},[canvasVisible,project?.id,controller,state.workspaceView]);
  useEffect(()=>{if(project)graphRef.current?.setProject(project,assetUrl);},[project,state.localImages,assetBaseUrl,state.workspaceView]);
  useEffect(()=>{graphRef.current?.setSelected(state.selected);},[state.selected,project?.id,state.workspaceView]);
  useEffect(()=>{graphRef.current?.setInteractive(!locked);},[locked]);
  useEffect(()=>{graphRef.current?.applyTheme();},[state.scheme]);
  useEffect(()=>{if(canvasVisible)requestAnimationFrame(()=>graphRef.current?.resize());},[canvasVisible,stageMode,layout]);
  useEffect(()=>{graphRef.current?.clearShotThumbs();},[project?.id,project?.revision,snapshot?.previewUrl,snapshot?.previewRevision]);
  // Thumbnail requests target the same saved revision as the canvas and obey the host's 3-frame limit.
  useEffect(()=>{
    const editor=graphRef.current;
    if(!editor||!canvasVisible||state.workspaceView!=='studio'||!project||!spec?.shots.length||!snapshot?.previewUrl||
      snapshot.previewRevision!==project.revision||busy||state.dirty||state.saving)return;
    let active=true;
    const entries=spec.shots.map(shot=>({shotId:shot.id,frame:Math.floor((shot.startFrame+shot.endFrame-1)/2)}));
    async function load(projectId:string,revision:number){
      for(let offset=0;active&&offset<entries.length;offset+=3){
        const batch=entries.slice(offset,offset+3);
        try{
          const result=await controller.api.call<{frames:{frame:number;url:string}[]}>('thumbnails',{
            projectId,expectedRevision:revision,frames:batch.map(entry=>entry.frame),
          });
          if(!active)return;
          const byFrame=new Map(result.frames.map(item=>[item.frame,item.url]));
          const urls:Record<string,string>={};
          for(const {shotId,frame} of batch){const url=byFrame.get(frame);if(url)urls[shotId]=url;}
          editor?.setShotThumbs(urls);
        }catch{/* Other batches can still provide thumbnails. */}
      }
    }
    const timer=setTimeout(()=>void load(project.id,project.revision),180);
    return()=>{active=false;clearTimeout(timer);};
  },[canvasVisible,state.workspaceView,project?.id,project?.revision,spec,snapshot?.previewUrl,snapshot?.previewRevision,busy,state.dirty,state.saving,controller]);
  useEffect(()=>{if(state.notice)toast({tone:'success',message:systemMessage(state.notice)});},[state.notice]);
  useEffect(()=>{if(state.error&&!state.conflict&&!state.dirty&&!directoryOpen)toast({tone:'error',message:systemMessage(state.error)});},[state.error]);
  const lastTask=useRef<{id:string;status:string}|null>(null);
  useEffect(()=>{
    if(!task){lastTask.current=null;return;}
    const previous=lastTask.current;lastTask.current={id:task.id,status:task.status};
    if(!previous||task.status==='running')return;
    if((previous.id===task.id&&previous.status==='running')||previous.id!==task.id){
      if(task.status==='complete')toast({tone:'success',message:t("{value0}已完成",{value0:taskLabel(task.kind)}),...(task.kind==='export'?{action:{label:t("查看成片"),run:()=>openPanel('exports')}}:{})});
      else if(task.status==='cancelled')toast({tone:'info',message:t("{value0}已取消",{value0:taskLabel(task.kind)})});
    }
  },[task?.id,task?.status]);
  useEffect(()=>{
    const studio=studioRef.current;if(!studio)return;
    const keyboard=(e:KeyboardEvent)=>{const target=e.target instanceof Element?e.target:null;if(e.defaultPrevented||target?.closest('[role=dialog]'))return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&!isHome){e.preventDefault();setWordOpen(open=>!open);return;}
      if(e.key==='Escape'&&wordOpen){e.preventDefault();setWordOpen(false);return;}
      if(target?.closest('input, textarea, select, [contenteditable=true]')||locked)return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?controller.redo():controller.undo();}
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();void controller.flush();}
      if(e.key==='?'||(e.shiftKey&&e.key==='/')){e.preventDefault();setKeysOpen(open=>!open);}
      if(e.key==='['||e.key===']'){const current=controller.getSnapshot(),film=current.snapshot?.project;if(!film?.shots.length)return;const ids=[...film.shotOrder.filter(id=>film.shots.some(shot=>shot.id===id)),...film.shots.map(shot=>shot.id).filter(id=>!film.shotOrder.includes(id))];e.preventDefault();const index=ids.indexOf(current.selected||'');const next=e.key===']'?ids[(Math.max(index,0)+1)%ids.length]:ids[(index<=0?ids.length:index)-1];controller.select(next);graphRef.current?.focus(next);}
    };studio.addEventListener('keydown',keyboard);return()=>studio.removeEventListener('keydown',keyboard);
  },[controller,locked,wordOpen,isHome]);
  async function importFiles(files:FileList|null){if(!files)return;for(const file of Array.from(files))await controller.importFile(file);}
  async function refreshPreview(){if(state.sourceDraft){toast({tone:'warning',message:t("本工程有源码草稿。请在源码面板保存或丢弃草稿后再刷新预览。")});return;}autoPreviewedRef.current=`${project?.id||''}:${project?.revision??''}`;await controller.action('preview');}
  async function modify(){if(!instruction.trim()||(editScope==='shot'&&!selectedShot))return;await controller.generate('modify',instruction,editScope==='shot'?selectedShot?.id:undefined);if(!controller.getSnapshot().error){setInstruction('');setWordOpen(false);}}
  function connectOrder(ids:string[]){if(!project)return;const next=reorderShots(project,ids);next.extensions={...next.extensions,graphEdges:ids.map((id,index)=>({from:id,to:ids[index+1]||'film-output'}))};commit(next);}
  const ordered=project?[...project.shotOrder.map(id=>project.shots.find(s=>s.id===id)).filter((s):s is Shot=>Boolean(s)),...project.shots.filter(s=>!project.shotOrder.includes(s.id))]:[];
  const relatedSessions=project?projectSessions(project.id,sessions,state.sessionBindings):[];
  const coverAsset=project?.assets.find(asset=>asset.kind==='image');
  const coverUrls=project&&coverAsset?{[project.id]:assetUrl(coverAsset)}:{};
  function addShotAfterSelection(){if(!project)return;const after=selectedShot&&project.shotOrder.includes(selectedShot.id)?selectedShot.id:undefined;const next=addShot(project,undefined,after,getLocale());commit(next);const created=next.shots.find(shot=>!project.shots.some(old=>old.id===shot.id));if(created)requestAnimationFrame(()=>controller.select(created.id));}
  function removeShot(shot:Shot){
    const current=controller.getSnapshot().snapshot?.project;
    if(!current||current.id!==project?.id||!current.shots.some(item=>item.id===shot.id))return;
    const result=controller.editWithUndo(deleteShot(current,shot.id));
    if(result)toast({message:t("已删除镜头「{value0}」",{value0:shot.title}),action:undoAction(result.undo)});
  }
  async function removeAsset(asset:Asset){
    if(!project)return;const uses=project.shots.filter(shot=>shot.assetIds.includes(asset.id)||shot.referenceIds.includes(asset.id)).length;
    if(!await confirmAction({title:t("删除资产「{value0}」？",{value0:asset.name}),body:uses?t("它正被 {value0} 个镜头使用，删除后这些关联会一并移除。可以立即撤销，或在修改历史中恢复。",{value0:uses}):t("资产会从工程中移除。可以立即撤销，或在修改历史中恢复。"),confirmLabel:t("删除资产"),tone:'danger'}))return;
    const state=controller.getSnapshot(),current=state.snapshot?.project;
    if(state.workspaceView!=='studio'||!current||current.id!==project.id||!current.assets.some(item=>item.id===asset.id))return;
    const result=controller.editWithUndo(deleteAsset(current,asset.id));
    if(result)toast({message:t("已删除资产「{value0}」",{value0:asset.name}),action:undoAction(result.undo)});
  }
  async function generate(kind:'storyboard'|'scenes'){
    if(!project)return;
    if(kind==='storyboard'&&project.shots.length&&((state.history?.entries.length||0)>1||project.shots.some(shot=>shot.assetIds.length||shot.referenceIds.length))){
      if(!await confirmAction({title:t("重新生成分镜？"),body:t("模型会用新的方案替换当前 {value0} 个镜头及其编排。之前的版本保留在「修改历史」中，可以随时恢复。",{value0:project.shots.length}),confirmLabel:t("重新生成"),tone:'danger'}))return;
      const current=controller.getSnapshot();
      if(current.workspaceView!=='studio'||current.snapshot?.project?.id!==project.id||current.snapshot.project.revision!==project.revision)return;
    }
    await controller.generate(kind);
  }
  function onStep(id:StageId){
    if(id==='storyboard'){if(stageMode==='monitor')setStageMode('canvas');requestAnimationFrame(()=>graphRef.current?.fit());}
    else if(id==='scenes')openPanel(project?.productionPolicy?.baseMode==='model_video'?'media':'source');
    else if(id==='preview'){if(stageMode==='canvas')setStageMode('monitor');}
    else openPanel('exports');
  }
  const runningKind=task?.status==='running'?task.kind:'';
  const steps:StepInfo[]=project?(()=>{
    const storyboardDone=project.shots.length>0&&!!graphCheck?.ok;
    const scenesDone=!!snapshot?.previewUrl&&snapshot.previewRevision!==null;
    const previewFresh=scenesDone&&snapshot?.previewRevision===project.revision;
    const latest=project.outputs.at(-1);
    return [
      {id:'storyboard',label:t("分镜"),state:runningKind==='storyboard'?'running':storyboardDone?'done':project.shots.length?'warning':'current',hint:storyboardDone?t("{value0} 个镜头，主链完整",{value0:project.shots.length}):project.shots.length?t("主链待连接"):t("画布上的镜头")},
      {id:'scenes',label:t("画面"),state:runningKind==='scenes'||runningKind==='modify'?'running':scenesDone?'done':storyboardDone?'current':'todo',hint:t("模型与素材")},
      {id:'preview',label:t("预览"),state:runningKind==='preview'||state.previewing?'running':previewFresh?'done':scenesDone?'stale':'todo',hint:previewFresh?t("预览与当前版本一致"):t("影片预览")},
      {id:'export',label:t("成片"),state:runningKind==='export'?'running':latest&&latest.revision===project.revision?'done':latest?'stale':previewFresh?'current':'todo',hint:latest?t("最近导出 v{value0}",{value0:latest.revision}):t("历史成片")},
    ];
  })():[];
  const menu:MenuItem[]=project?[
    {id:'output',label:t("输出设定"),icon:'film',onSelect:()=>setOutputOpen(true)},
    ...(relatedSessions.length>0&&onOpenSession?[{id:'continue',label:t("继续会话 ↗"),icon:'external',onSelect:()=>setSessionDialog({project,mode:'continue'})}]:[]),
    {id:'associate',label:relatedSessions.length?t("{value0} 个关联会话",{value0:relatedSessions.length})+' · '+t("关联会话"):t("关联会话"),icon:'link',disabled:state.relationPending,onSelect:()=>setSessionDialog({project,mode:'associate'})},
    {id:'reveal',label:t("打开项目文件夹 "),icon:'folder',disabled:!snapshot?.root,onSelect:()=>{if(snapshot?.root)void controller.action('reveal',{path:snapshot.root});}},
    {id:'media',label:t("媒体模型"),icon:'spark',separatorBefore:true,onSelect:()=>openPanel('media')},
    {id:'environment',label:t("运行环境"),icon:'settings',onSelect:()=>openPanel('environment')},
    {id:'keys',label:t("快捷键"),icon:'keyboard',hint:'?',onSelect:()=>setKeysOpen(true)},
    {id:'new',label:t("新建影片"),icon:'plus',separatorBefore:true,disabled:busy,onSelect:()=>setNewOpen(true)},
    {id:'home',label:t("影片首页"),icon:'grid',onSelect:()=>void controller.showProjects()},
  ]:[];
  const drawerTabs:DrawerTab<PanelTab>[]=[
    {id:'audio',label:t("声音与配音"),icon:'music'},{id:'media',label:t("模型与素材生成"),icon:'spark'},{id:'source',label:t("前端源码"),icon:'code'},
    {id:'workflow',label:t("协作制作"),icon:'users'},{id:'spec',label:t("制作要求"),icon:'doc'},{id:'history',label:t("修改历史"),icon:'history'},
    {id:'tasks',label:t("任务记录"),icon:'tasks',badge:task?.status==='failed'||task?.status==='interrupted'?<i className="vs-tab-dot is-danger"/>:task?.status==='running'?<i className="vs-tab-dot is-busy"/>:undefined},
    {id:'exports',label:t("历史成片"),icon:'film',badge:project?.outputs.length?<small className="vs-tab-count">{project.outputs.length}</small>:undefined},
    {id:'environment',label:t("运行环境"),icon:'settings'},
  ];
  const failedTask=task&&(task.status==='failed'||task.status==='interrupted')&&task.id!==dismissedTask?task:null;
  const bannerError=state.error&&(state.conflict||state.dirty)?state.error:'';
  const lockReason=generating?t("正在生成，完成后可以继续编辑"):t("正在处理，请稍候…");
  const effectiveDrawerOpen=drawerOpen||(layout==='narrow'&&pane==='panels');
  return <main ref={studioRef} className={`vs-studio ${isHome?'vs-home-shell':''}`} data-scheme={state.scheme} data-layout={layout} lang={getLocale()==='en'?'en':'zh-CN'}>
    {isHome||!project?<header className="vs-topbar">
      <button type="button" className="vs-brand vs-brand-home" onClick={()=>void controller.showProjects()} aria-label={t("返回影片首页")}><span className="vs-brandmark"><VideoStudioIcon/></span><span><strong>{t("映流")}</strong><small>{t("DSH 影片首页")}</small></span></button>
      <div className="vs-top-actions">
        {state.snapshot?.project&&<Button icon="arrow" onClick={controller.showStudio}>{t("继续上次工程 ↗")}</Button>}
        <Button icon="spark" title={t("打开媒体模型中心")} onClick={()=>setHomeModal('media')}>{t("媒体模型")}</Button>
        <Button icon="settings" title={t("打开运行环境")} onClick={()=>setHomeModal('environment')}>{t("环境设置")}</Button>
      </div>
    </header>:<StudioHeader project={project} state={state} providers={snapshot?.providers||[]} steps={steps} task={task} busy={busy} graphOk={!!graphCheck?.ok} canExport={!!graphCheck?.ok}
      onHome={()=>void controller.showProjects()} onRename={title=>commit({...project,title,revision:project.revision+1,updatedAt:new Date().toISOString()})}
      onStep={onStep} onGenerate={kind=>void generate(kind)} onExport={()=>void controller.action('export')} onCancel={()=>void controller.action('cancel')} onHistory={()=>openPanel('history')}
      onRoute={controller.setRoute} menu={menu}/>}
    {state.loading?<div className="vs-loading"><div className="vs-skeleton-grid" aria-hidden="true"><i/><i/><i/><i/></div><span>{t("正在打开工作台…")}</span></div>:isHome||!project?<ProjectHome controller={controller} projects={state.projects} bindings={state.sessionBindings} loading={state.libraryLoading} {...sessionProps} coverUrls={coverUrls} onCreate={()=>{setNewStyleId('');setNewOpen(true);}} onOpenDirectory={()=>{setDirectoryOpen(true);setOpenPath('');}} onEnvironment={()=>setHomeModal('environment')} onManageStyles={()=>{void controller.refreshStyles();setStyleLibraryOpen(true);}} onManageSession={(film,mode)=>setSessionDialog({project:film,mode})}/>:<>
      {(bannerError||state.sourceDraft||failedTask)&&<div className="vs-banners">
        {bannerError&&<div className="vs-banner is-danger" role="alert"><Icon name="warning"/><span>{systemMessage(bannerError)}</span>{state.dirty&&<Button size="sm" icon="download" onClick={()=>downloadText(t("{value0}-本地参数副本.json", {value0: project.title||t("影片")}),JSON.stringify(project,null,2),'application/json;charset=utf-8')}>{t("保存本地参数副本")}</Button>}{state.conflict?<Button size="sm" icon="refresh" onClick={()=>void controller.load(true)}>{state.dirty?t("放弃本地参数并重新读取"):t("重新读取工程（保留源码草稿）")}</Button>:state.dirty?<Button size="sm" icon="check" onClick={()=>void controller.flush()}>{t("重试保存")}</Button>:null}</div>}
        {failedTask&&<div className="vs-banner is-warning" role="status"><Icon name="warning"/><span><strong>{systemMessage(failedTask.message)||taskLabel(failedTask.kind)}</strong>{failedTask.error&&<small className="vs-task-error">{systemMessage(failedTask.error)}</small>}</span><Button size="sm" icon="tasks" onClick={()=>openPanel('tasks')}>{t("查看任务记录")}</Button><IconButton icon="close" label={t("关闭提示")} onClick={()=>setDismissedTask(failedTask.id)}/></div>}
        {state.sourceDraft&&<div className="vs-banner is-info vs-draft-banner" role="status"><Icon name="code"/><span>{t("{value0} 份源码草稿已保留。保存后才会进入预览和成片。", {value0: state.sourceDraftCount})}</span><Button size="sm" onClick={()=>{openPanel('source');const draft=controller.sourceDrafts().find(value=>project.shots.some(shot=>shot.id===value.shotId));controller.select(draft?.shotId||null);}}>{t("查看源码草稿")}</Button></div>}
      </div>}
      <div className={`vs-workbench ${assetsOpen?'is-assets-open':''}`} data-pane={pane} data-drawer={effectiveDrawerOpen?'open':'closed'}>
        <AssetsPanel project={project} selectedId={state.selected} assetUrl={assetUrl} pending={state.pending} locked={generating||validatingPreview}
          onSelect={id=>{controller.select(id);if(layout==='narrow')setPane('properties');}} onImport={files=>void importFiles(files)} onAddText={()=>setTextOpen(true)} onDelete={asset=>void removeAsset(asset)}
          onClose={layout!=='wide'?()=>setAssetsOpen(false):undefined}/>
        {assetsOpen&&layout==='medium'&&<button type="button" className="vs-scrim" aria-label={t("收起资产库")} onClick={()=>setAssetsOpen(false)}/>}
        <Stage project={project} snapshot={snapshot!} state={state} controller={controller} playhead={playhead} layout={layout} stageMode={stageMode} onStageMode={setStageMode}
          assetsOpen={assetsOpen} onToggleAssets={()=>{if(layout==='narrow')setPane('assets');else setAssetsOpen(open=>!open);}} onOutputSettings={()=>setOutputOpen(true)}
          duration={duration} selectedShot={selectedShot} locked={locked} busy={busy} graphCheck={graphCheck} canvasRef={canvasRef} minimapRef={minimapRef} graphRef={graphRef} zoom={zoom}
          onAddShot={addShotAfterSelection} onRefreshPreview={()=>void refreshPreview()} onConnectOrder={connectOrder} ordered={ordered}
          wordOpen={wordOpen} onWordOpen={setWordOpen} editScope={editScope} onEditScope={setEditScope} instruction={instruction} onInstruction={setInstruction} onModify={()=>void modify()}/>
        <Timeline shots={ordered} fps={fps} playhead={playhead} selectedId={selectedShot?.id||null} locked={locked} onSelect={id=>{controller.select(id);if(canvasVisible)graphRef.current?.focus(id);}} onReorder={connectOrder} onAdd={addShotAfterSelection} onDelete={id=>{const shot=project.shots.find(s=>s.id===id);if(shot)removeShot(shot);}}/>
        <div className="vs-pane-switch vs-segmented" role="tablist" aria-label={t("切换面板")}>
          {([['properties','info',selectedShot?t("镜头属性"):selectedAsset?t("资产属性"):t("影片设定")],['assets','image',t("资产库")],['panels','drawer',t("工作面板")]] as const).map(([id,icon,label])=><button type="button" role="tab" key={id} aria-selected={pane===id} className={pane===id?'is-active':''} onClick={()=>setPane(id)}><Icon name={icon}/><span>{label}</span></button>)}
        </div>
        <PropertiesPanel project={project} controller={controller} selectedShot={selectedShot} selectedAsset={selectedAsset} assetUrl={assetUrl} fps={fps} duration={duration}
          locked={locked} lockReason={lockReason} commit={commit} onOpenPanel={openPanel} onDeleteShot={removeShot} onDeleteAsset={asset=>void removeAsset(asset)}
          onDuplicateShot={shot=>commit(duplicateShot(project,shot.id,getLocale()))}/>
        <BottomDrawer tabs={drawerTabs} active={panel} open={effectiveDrawerOpen} height={drawerHeight} flash={flash}
          onSelect={tab=>{setPanel(tab);store.set('vs-drawer-tab',tab);setDrawerOpen(true);}} onToggle={()=>setDrawerOpen(open=>!open)} onResize={height=>{setDrawerHeight(height);store.set('vs-drawer-height',height);}}>
          {panel==='workflow'?<WorkflowPanel key={project.id} controller={controller} project={project} selectedShot={selectedShot} plugin/>:panel==='media'?<MediaPanel controller={controller} project={project} selectedShot={selectedShot} mediaOnly/>:panel==='history'?<HistoryPanel controller={controller}/>:panel==='tasks'?<TaskPanel controller={controller}/>:panel==='exports'?<ExportPanel project={project} controller={controller}/>:panel==='audio'?<AudioPanel project={project} snapshot={snapshot!} controller={controller} assetUrl={assetUrl} selectedShot={selectedShot} busy={busy}/>:panel==='spec'?<div className="vs-spec-view"><ProductionPolicySettings project={project} controller={controller}/>{spec?<><div className="vs-spec-meta"><span>{t("{value0} 个镜头", {value0: spec.shots.length})}</span><span>{t("{value0} 秒", {value0: spec.durationSeconds.toFixed(1)})}</span><Button size="sm" icon="copy" onClick={()=>void navigator.clipboard.writeText(specMarkdown(spec,getLocale())).then(()=>controller.notify('制作要求已复制。')).catch(()=>controller.notify('复制失败，可以在下方选择文本。'))}>{t("复制")}</Button><Button size="sm" icon="download" onClick={()=>downloadText(t("{value0}-制作要求.md", {value0: project.title}),specMarkdown(spec,getLocale()),'text/markdown;charset=utf-8')}>{t("导出 Markdown")}</Button><Button size="sm" icon="download" onClick={()=>downloadText(t("{value0}-制作要求.json", {value0: project.title}),JSON.stringify(spec,null,2),'application/json;charset=utf-8')}>{t("导出 JSON")}</Button></div><pre>{specMarkdown(spec,getLocale())}</pre></>:<div className="vs-dock-empty"><Icon name="grid"/><p>{t("把镜头连接成一条主链，制作要求会自动整理。")}</p><small>{graphCheck?.errors.map(systemMessage).join(t('；'))}</small></div>}</div>:panel==='source'?<SourceEditor controller={controller} selectedShot={selectedShot} busy={busy} version={`${project.revision}:${task?.status==='complete'?task.id:''}`}/>:<EnvironmentPanel controller={controller} snapshot={snapshot!}/>}
        </BottomDrawer>
      </div>
    </>}
    {snapshot&&homeModal==='media'&&<Dialog label={t("媒体模型中心")} onClose={()=>setHomeModal(null)} className="vs-model-modal"><div className="vs-section-header"><h2>{t("媒体模型中心")}</h2><IconButton icon="close" label={t("关闭模型中心")} onClick={()=>setHomeModal(null)}/></div><ModelCenter api={controller.api} mediaOnly blocked={busy}/></Dialog>}
    {snapshot&&homeModal==='environment'&&<Dialog label={t("运行环境")} onClose={()=>setHomeModal(null)} className="vs-environment-modal"><div className="vs-section-header"><h2>{t("运行环境")}</h2><IconButton icon="close" label={t("关闭")} onClick={()=>setHomeModal(null)}/></div><EnvironmentPanel controller={controller} snapshot={snapshot}/></Dialog>}
    {sessionDialog&&<SessionPicker project={sessionDialog.project} mode={sessionDialog.mode} projects={state.projects} bindings={state.sessionBindings} controller={controller} {...sessionProps} onClose={()=>setSessionDialog(null)}/>}
    {styleLibraryOpen&&<StyleLibrary styles={state.styles} onClose={()=>setStyleLibraryOpen(false)} onSave={style=>controller.saveStyle(style)} onDelete={id=>controller.deleteStyle(id)} onUse={(style:VideoStyle)=>{setNewStyleId(style.id);setStyleLibraryOpen(false);setNewOpen(true);}}/>}
    {outputOpen&&project&&<Dialog label={t("输出设定")} onClose={()=>setOutputOpen(false)} className="vs-output-modal"><div className="vs-section-header"><h2>{t("输出设定")}</h2><IconButton icon="close" label={t("关闭输出设定")} onClick={()=>setOutputOpen(false)}/></div><fieldset className="vs-property-scroll" disabled={locked}><OutputSettings project={project} onChange={commit}/></fieldset></Dialog>}
    {newOpen&&<CreateFilmDialog controller={controller} state={state} sessions={sessions} initialStyleId={newStyleId} onClose={()=>{setNewOpen(false);setNewStyleId('');}}/>}
    {directoryOpen&&<Dialog label={t("打开工程目录")} onClose={()=>setDirectoryOpen(false)} busy={busy}><div className="vs-section-header"><div><h2>{t("打开已有影片工程")}</h2><p className="vs-modal-lead">{t("选择包含 project.json 的本地工程目录，素材与源码会一起打开。")}</p></div><IconButton icon="close" label={t("关闭工程目录")} onClick={()=>setDirectoryOpen(false)} disabled={busy}/></div>
      <Field label={t("打开现有项目目录")}><input autoFocus data-dialog-autofocus value={openPath} onChange={event=>setOpenPath(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&isAbsolutePath(openPath.trim())&&!state.pending){event.preventDefault();void controller.action('open',{path:openPath.trim()}).then(ok=>{if(ok)setDirectoryOpen(false);});}}} placeholder={t("粘贴工程文件夹的绝对路径")} aria-invalid={openPath.trim()!==''&&!isAbsolutePath(openPath.trim())||undefined}/></Field>
      {openPath.trim()!==''&&!isAbsolutePath(openPath.trim())&&<p className="vs-field-hint is-warn">{t("请输入以 / 或盘符开头的绝对路径。")}</p>}
      {!!snapshot?.recent?.length&&<div className="vs-recent-list"><p className="vs-eyebrow">{t("最近打开")}</p>{snapshot.recent.slice(0,5).map(item=><button type="button" key={item.path} onClick={()=>setOpenPath(item.path)} title={item.path}><Icon name="folder"/><span><strong>{item.title}</strong><small>{item.path}</small></span></button>)}</div>}
      {state.error&&<p className="vs-inline-error" role="alert">{systemMessage(state.error)}</p>}
      <div className="vs-modal-actions"><button type="button" onClick={()=>setDirectoryOpen(false)} disabled={busy}>{t("取消")}</button><Button variant="primary" icon="folder" disabled={!isAbsolutePath(openPath.trim())||state.pending} onClick={()=>void controller.action('open',{path:openPath.trim()}).then(ok=>{if(ok)setDirectoryOpen(false);})}>{t("打开项目")}</Button></div></Dialog>}
    {textOpen&&<Dialog label={t("添加文字资产")} onClose={()=>setTextOpen(false)} busy={state.pending}><div className="vs-section-header"><div><h2>{t("添加文字资产")}</h2><p className="vs-modal-lead">{t("文案、故事或风格说明都可以连接到镜头，成为画面或参考。")}</p></div><IconButton icon="close" label={t("关闭")} onClick={()=>setTextOpen(false)}/></div><textarea className="vs-textasset-input" aria-label={t("文字素材")} rows={10} value={textAsset} onChange={e=>setTextAsset(e.target.value)} placeholder={t("粘贴文案、故事、产品介绍或风格参考…")} data-dialog-autofocus/><div className="vs-modal-actions"><Button variant="primary" icon="plus" disabled={!textAsset.trim()||state.pending} onClick={()=>void controller.action('import',{name:truncate(textAsset.trim().split('\n')[0]||t("文字素材"),22),mime:'text/plain',text:textAsset}).then(()=>{if(!controller.getSnapshot().error){setTextOpen(false);setTextAsset('');}})}>{t("加入资产库")}</Button></div></Dialog>}
    {keysOpen&&<Dialog label={t("快捷键")} onClose={()=>setKeysOpen(false)} className="vs-keys-modal"><div className="vs-section-header"><h2>{t("快捷键")}</h2><IconButton icon="close" label={t("关闭快捷键")} onClick={()=>setKeysOpen(false)}/></div><ul className="vs-keys">
      <li><span>{t("播放或暂停")}</span><span><kbd>{t("空格")}</kbd></span></li>
      <li><span>{t("上一帧 / 下一帧")}</span><span><kbd>Alt</kbd><kbd>←</kbd><kbd>→</kbd></span></li>
      <li><span>{t("上一个 / 下一个镜头")}</span><span><kbd>[</kbd><kbd>]</kbd></span></li>
      <li><span>{t("在时间线上移动镜头")}</span><span><kbd>Alt</kbd><kbd>←</kbd><kbd>→</kbd></span></li>
      <li><span>{t("用文字修改")}</span><span><kbd>⌘ K</kbd></span></li>
      <li><span>{t("提交改词")}</span><span><kbd>⌘ Enter</kbd></span></li>
      <li><span>{t("撤销 / 重做")}</span><span><kbd>⌘ Z</kbd><kbd>⇧ ⌘ Z</kbd></span></li>
      <li><span>{t("保存工程")}</span><span><kbd>⌘ S</kbd></span></li>
      <li><span>{t("删除选中镜头 / 解除资产关联")}</span><span><kbd>Delete</kbd></span></li>
      <li><span>{t("收起大预览")}</span><span><kbd>Esc</kbd></span></li>
    </ul></Dialog>}
    <ConfirmHost/>
    <Toasts store={toasts}/>
  </main>;
}

function isAbsolutePath(value:string):boolean{return value.startsWith('/')||value.startsWith('~')||/^[a-zA-Z]:[\\/]/.test(value)||value.startsWith('\\\\');}
function truncate(value:string,length:number):string{const units=[...value];return units.length>length?units.slice(0,length-1).join('')+'…':value;}
function downloadText(name:string,text:string,mime:string):void{const blob=new Blob([text],{type:mime});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name.replace(/[\\/:*?"<>|]/g,'-');document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
