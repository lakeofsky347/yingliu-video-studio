import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createProject, deleteShot } from '../src/core/index.ts';
import { StudioController, StudioRequestError } from '../src/client/controller.ts';
import { SourceDraftStore } from '../src/client/source-drafts.ts';
import { SourceEditor } from '../src/client/SourceEditor.tsx';
import { ExportPanel } from '../src/client/ExportPanel.tsx';
import { ProjectHome } from '../src/client/ProjectHome.tsx';
import type { ProjectHistory, SceneSource, StudioApi, StudioSnapshot, VideoProject } from '../src/shared/types.ts';

function memoryStorage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
function source(value='saved'):SceneSource{return {html:'<div>'+value+'</div>',css:'div {color:red}',js:'function renderFrame(){}'};}
function initial():StudioSnapshot{return {project:createProject('客户端第三版'),root:'/fixture',task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false}};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function fixture(){
  let snapshot=initial();const calls:{endpoint:string;payload:any}[]=[],projects=new Map<string,VideoProject>([[snapshot.project!.id,snapshot.project!]]),sources=new Map<string,SceneSource>();
  let held:ReturnType<typeof deferred<StudioSnapshot>>|null=null;
  const history:ProjectHistory={canUndo:true,canRedo:false,cursor:1,entries:[{id:'first',label:'新建工程',revision:0,createdAt:new Date().toISOString()},{id:'second',label:'修改镜头',revision:1,createdAt:new Date().toISOString()}]};
  const api={async call(endpoint:string,payload:any={}){
    calls.push({endpoint,payload:structuredClone(payload)});
    if(endpoint==='catalog'||endpoint==='current')return structuredClone(snapshot);
    if(endpoint==='list')return {projects:[...projects.values()].map(project=>({id:project.id,title:project.title,path:'/fixture/'+project.id}))};
    if(endpoint==='history')return structuredClone(history);
    if(endpoint==='source')return structuredClone(sources.get(payload.shotId)||source());
    if(endpoint==='focus'){const project=projects.get(payload.projectId);if(!project)throw new Error('未找到工程');snapshot={...snapshot,project};return structuredClone(snapshot);}
    if(['save','saveSource','retry','undo','redo','import'].includes(endpoint)){
      assert.equal(payload.expectedRevision??snapshot.project!.revision,snapshot.project!.revision);
      if(endpoint==='saveSource'&&held)return held.promise;
      if(endpoint==='save')snapshot={...snapshot,project:{...payload.project,revision:snapshot.project!.revision+1}};
      else{snapshot={...snapshot,project:{...snapshot.project!,revision:snapshot.project!.revision+1}};if(endpoint==='saveSource')sources.set(payload.shotId,structuredClone(payload.source));}
      projects.set(snapshot.project!.id,snapshot.project!);return structuredClone(snapshot);
    }
    if(endpoint==='preview'||endpoint==='export'||endpoint==='generate')return structuredClone(snapshot);
    throw new Error(endpoint);
  }} as StudioApi;
  return {api,calls,projects,history,sources,get snapshot(){return snapshot;},set snapshot(value:StudioSnapshot){snapshot=value;projects.set(value.project!.id,value.project!);},hold(){held=deferred<StudioSnapshot>();return held;}};
}

test('source drafts survive shot, project, page-equivalent and controller navigation without executing code',async()=>{
  const f=fixture(),storage=memoryStorage(),controller=new StudioController(f.api,new SourceDraftStore(storage));await controller.load();const first=f.snapshot.project!,shot=first.shots[0];
  controller.select(shot.id);controller.setSourceDraft(shot.id,source('local draft'));controller.select(first.shots[1].id);await controller.showProjects();assert.equal(controller.getSnapshot().workspaceView,'projects');controller.showStudio();assert.equal(controller.getSourceDraft(shot.id)?.source.html,'<div>local draft</div>');
  const second=createProject('第二工程');f.projects.set(second.id,second);await controller.focusProject(second.id,{frame:650});assert.equal(controller.getSnapshot().sourceDraftCount,0);assert.equal(controller.getSnapshot().focusFrame,650);
  await controller.focusProject(first.id,{shotId:shot.id,frame:149});assert.equal(controller.getSnapshot().sourceDraftCount,1);assert.equal(controller.getSnapshot().focusFrame,149);assert.equal(controller.getSnapshot().selected,shot.id);
  assert.equal(f.calls.filter(call=>call.endpoint==='saveSource').length,0);await controller.dispose();
  const reopened=new StudioController(f.api,new SourceDraftStore(storage));await reopened.load();assert.equal(reopened.getSourceDraft(shot.id)?.source.html,'<div>local draft</div>');await reopened.dispose();
});

test('automatic preview sends one preparation request and preserves concurrent edits',async()=>{
  const f=fixture(),base=f.api.call.bind(f.api);
  const controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));
  const entered=deferred<void>(),prepared=deferred<StudioSnapshot>();
  let requests=0;
  try{
    await controller.load();
    const before=f.snapshot,project=before.project!;
    f.api.call=async <T>(endpoint:string,payload:any)=>{
      if(endpoint!=='preview')return base<T>(endpoint,payload);
      requests++;
      assert.deepEqual(payload,{projectId:project.id,expectedRevision:project.revision,prepareOnly:true});
      entered.resolve();
      return prepared.promise as Promise<T>;
    };
    const first=controller.refreshPreview(),second=controller.refreshPreview();
    await entered.promise;
    assert.equal(await second,false);
    assert.equal(controller.getSnapshot().pending,false);
    controller.edit({...project,title:'预览期间修改',revision:project.revision+1});
    await controller.flush();
    prepared.resolve({...before,previewRevision:project.revision});
    assert.equal(await first,true);
    assert.equal(requests,1);
    assert.equal(controller.getSnapshot().previewing,false);
    assert.equal(controller.getSnapshot().dirty,false);
    assert.equal(controller.getSnapshot().snapshot?.project?.title,'预览期间修改');
    assert.equal(controller.confirmedRevision,project.revision+1);
  }finally{await controller.dispose();}
});

test('a deletion shortcut cannot undo newer edits or an edit batched with a deletion',async()=>{
  const f=fixture(),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));
  try{
    await controller.load();
    const project=f.snapshot.project!;
    const first=controller.editWithUndo(deleteShot(project,project.shots[0]!.id));
    assert.ok(first?.undo);
    assert.equal(first.undo.available(),true);
    const pending=controller.getSnapshot().snapshot!.project!;
    const coalesced=controller.editWithUndo(deleteShot(pending,pending.shots[0]!.id));
    assert.ok(coalesced);
    assert.equal(coalesced.undo,undefined);
    assert.equal(first.undo.available(),false);
    assert.equal(await first.undo.run(),false);
    assert.equal(f.calls.some(call=>call.endpoint==='undo'),false);
    await controller.flush();
    const saved=f.snapshot.project!;
    const last=controller.editWithUndo(deleteShot(saved,saved.shots[0]!.id));
    assert.ok(last?.undo);
    assert.equal(last.undo.available(),true);
    assert.equal(await last.undo.run(),true);
    assert.equal(f.calls.filter(call=>call.endpoint==='undo').length,1);
    assert.equal(f.calls.find(call=>call.endpoint==='undo')!.payload.expectedRevision,saved.revision+1);
  }finally{await controller.dispose();}
});

test('owned parameter autosave advances draft revision and source save clears only the submitted draft',async()=>{
  const f=fixture(),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const project=f.snapshot.project!,shot=project.shots[0];controller.setSourceDraft(shot.id,source('draft'));controller.edit({...project,title:'调整标题',revision:project.revision+1});await controller.flush();assert.equal(controller.getSourceDraft(shot.id)?.baseRevision,f.snapshot.project!.revision);
  assert.equal(await controller.saveSource(shot.id,source('draft')),true);assert.equal(controller.getSourceDraft(shot.id),undefined);assert.equal(f.calls.find(call=>call.endpoint==='save')?.payload.expectedRevision,0);assert.equal(f.calls.find(call=>call.endpoint==='saveSource')?.payload.expectedRevision,1);assert.equal(controller.getSnapshot().sourceDraft,false);await controller.dispose();
});

test('saving source before the parameter debounce sends the revision acknowledged by that flush',async()=>{
  const f=fixture(),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const project=f.snapshot.project!,shot=project.shots[0];
  controller.setSourceDraft(shot.id,source('draft'));controller.edit({...project,title:'尚在 debounce 中',revision:1});
  assert.equal(await controller.saveSource(shot.id,source('draft')),true);
  assert.equal(f.calls.find(call=>call.endpoint==='saveSource')?.payload.expectedRevision,1);
  assert.equal(controller.getSourceDraft(shot.id),undefined);await controller.dispose();
});

test('management of a different project explicitly reads that project revision and preserves the visible editor',async()=>{
  const f=fixture(),base=f.api.call.bind(f.api),other={...createProject('其他工程'),revision:19};f.projects.set(other.id,other);let targetRead=false;
  f.api.call=async <T>(endpoint:string,payload:any)=>{if(endpoint==='current'&&payload.projectId===other.id){targetRead=true;return structuredClone({...f.snapshot,project:other}) as T;}if(endpoint==='rename'){assert.equal(targetRead,true);assert.equal(payload.projectId,other.id);assert.equal(payload.expectedRevision,19);return structuredClone({...f.snapshot,project:{...other,revision:20}}) as T;}return base<T>(endpoint,payload);};
  const controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();
  assert.equal(await controller.action('rename',{projectId:other.id,title:'更名'}),true);assert.equal(controller.getSnapshot().snapshot?.project?.id,f.snapshot.project!.id);assert.equal(controller.getSnapshot().snapshot?.project?.revision,0);await controller.dispose();
});

test('background updates and source conflicts retain draft until an explicit current-version save',async()=>{
  const f=fixture(),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const shot=f.snapshot.project!.shots[0];controller.setSourceDraft(shot.id,source('my unsaved code'));
  f.snapshot={...f.snapshot,project:{...f.snapshot.project!,revision:3},task:{id:'background',kind:'scenes',status:'complete',progress:1,message:'完成',startedAt:new Date().toISOString()}};f.sources.set(shot.id,source('model code'));await (controller as any).poll();assert.equal(controller.getSourceDraft(shot.id)?.source.html,'<div>my unsaved code</div>');
  const original=f.api.call.bind(f.api);f.api.call=async <T>(endpoint:string,payload:any)=>{if(endpoint==='saveSource'&&payload.expectedRevision!==f.snapshot.project!.revision)throw new StudioRequestError('工程版本冲突','REVISION_CONFLICT');return original<T>(endpoint,payload);};
  assert.equal(await controller.saveSource(shot.id,source('my unsaved code')),false);assert.equal(controller.getSnapshot().conflict,true);assert.ok(controller.getSourceDraft(shot.id));assert.equal(await controller.saveSource(shot.id,source('my unsaved code'),true),true);assert.equal(controller.getSourceDraft(shot.id),undefined);assert.equal(controller.getSnapshot().conflict,false);await controller.dispose();
});

test('typing while source save is pending preserves the newer draft',async()=>{
  const f=fixture(),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const shot=f.snapshot.project!.shots[0],held=f.hold();controller.setSourceDraft(shot.id,source('A'));const save=controller.saveSource(shot.id,source('A'));await Promise.resolve();await Promise.resolve();controller.setSourceDraft(shot.id,source('B'));held.resolve({...f.snapshot,project:{...f.snapshot.project!,revision:1}});assert.equal(await save,true);assert.equal(controller.getSourceDraft(shot.id)?.source.html,'<div>B</div>');assert.equal(controller.getSnapshot().sourceDraft,true);await controller.dispose();
});

test('unsaved source prevents stale preview/export but allows navigation and survives rejected save',async()=>{
  const f=fixture(),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const shot=f.snapshot.project!.shots[0];controller.setSourceDraft(shot.id,source('draft'));assert.equal(await controller.action('export'),false);assert.equal(f.calls.filter(call=>call.endpoint==='export').length,0);assert.ok(controller.getSourceDraft(shot.id));assert.equal(await controller.showProjects(),true);controller.discardSourceDraft(shot.id);assert.equal(await controller.action('preview'),true);await controller.dispose();
});

test('persistent server history remains authoritative through edits, imports and undo calls',async()=>{
  const f=fixture(),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();assert.equal(controller.getSnapshot().canUndo,true);const project=f.snapshot.project!;controller.edit({...project,title:'编辑',revision:1});assert.equal(controller.getSnapshot().canUndo,true);await controller.flush();await controller.action('import');assert.equal(controller.getSnapshot().canUndo,true);assert.deepEqual(controller.getSnapshot().history,f.history);await controller.action('undo');assert.equal(f.calls.find(call=>call.endpoint==='undo')?.payload.expectedRevision,2);await controller.dispose();
});

test('project CAS failure exposes dirty state and preserves code drafts without automatic retry',async()=>{
  const f=fixture(),base=f.api.call.bind(f.api);let attempts=0;f.api.call=async <T>(endpoint:string,payload:any)=>{if(endpoint==='save'){attempts++;throw new StudioRequestError('版本冲突','REVISION_CONFLICT');}return base<T>(endpoint,payload);};const controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const project=f.snapshot.project!;controller.setSourceDraft(project.shots[0].id,source('draft'));controller.edit({...project,title:'本地参数',revision:1});await controller.flush();assert.equal(attempts,1);assert.equal(controller.getSnapshot().dirty,true);assert.equal(controller.getSnapshot().conflict,true);assert.equal(controller.getSnapshot().snapshot?.project?.title,'本地参数');await controller.load(true);assert.ok(controller.getSourceDraft(project.shots[0].id));await controller.dispose();
});

test('draft editor exposes retained source immediately, and export/home panels render persisted data',async()=>{
  const f=fixture(),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const project=f.snapshot.project!,shot=project.shots[0];controller.setSourceDraft(shot.id,source('not lost'));controller.select(shot.id);
  const editor=renderToStaticMarkup(createElement(SourceEditor,{controller,selectedShot:shot,busy:false,version:'0'}));assert.match(editor,/not lost/);assert.match(editor,/草稿已保留/);assert.match(editor,/丢弃草稿/);
  project.outputs=[{id:'old',path:'/fixture/old.mp4',url:'http://localhost/old.mp4',createdAt:new Date().toISOString(),revision:2,width:1280,height:720,duration:10,frameCount:300},{id:'new',path:'/fixture/new.mp4',url:'http://localhost/new.mp4',createdAt:new Date().toISOString(),revision:3,width:1080,height:1920,duration:8,frameCount:240}];const exports=renderToStaticMarkup(createElement(ExportPanel,{project,controller}));assert.ok(exports.indexOf('data-output-id="new"')<exports.indexOf('data-output-id="old"'));assert.match(exports,/1280/);assert.match(exports,/240/);
  const home=renderToStaticMarkup(createElement(ProjectHome,{controller,projects:[{id:project.id,title:project.title,path:'/fixture',updatedAt:new Date().toISOString()}],loading:false,onCreate(){},onOpenDirectory(){}}));assert.match(home,/DSH 会话/);assert.match(home,/1 份源码草稿/);assert.match(home,/重命名/);assert.match(home,/归档/);await controller.dispose();
});

test('panel re-entry accepts external changes to its visible project and retains source drafts and focus',async()=>{
  const f=fixture(),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const project=f.snapshot.project!,shot=project.shots[0];
  await controller.focusProject(project.id,{shotId:shot.id,frame:149});controller.setSourceDraft(shot.id,source('local work'));
  const changed=structuredClone(project);changed.revision=2;changed.shots[0].params.subtitle='Session 后台修改';changed.target.audioMode='mixed';
  f.snapshot={...f.snapshot,project:changed};await controller.refreshVisibleProject();
  assert.equal(controller.getSnapshot().snapshot?.project?.shots[0].params.subtitle,'Session 后台修改');assert.equal(controller.getSnapshot().snapshot?.project?.target.audioMode,'mixed');
  assert.equal(controller.getSourceDraft(shot.id)?.source.html,'<div>local work</div>');assert.equal(controller.getSourceDraft(shot.id)?.baseRevision,0);assert.equal(controller.getSnapshot().selected,shot.id);assert.equal(controller.getSnapshot().focusFrame,149);assert.equal(controller.getSnapshot().conflict,false);
  assert.equal(f.calls.filter(call=>call.endpoint==='current').at(-1)?.payload.projectId,project.id);await controller.dispose();
});

test('panel re-entry never follows a different Session global selection',async()=>{
  const f=fixture(),base=f.api.call.bind(f.api),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const visible=structuredClone(f.snapshot.project!);visible.revision=1;visible.title='A 已在会话中更新';f.projects.set(visible.id,visible);
  const other=createProject('另一个 Session 的 B');f.snapshot={...f.snapshot,project:other};
  f.api.call=async <T>(endpoint:string,payload:any)=>{if(endpoint==='current'){assert.equal(payload.projectId,visible.id);return {...f.snapshot,project:structuredClone(f.projects.get(payload.projectId)!)} as T;}return base<T>(endpoint,payload);};
  await controller.refreshVisibleProject();assert.equal(controller.getSnapshot().snapshot?.project?.id,visible.id);assert.equal(controller.getSnapshot().snapshot?.project?.title,visible.title);assert.equal(f.snapshot.project?.id,other.id);assert.equal(f.calls.filter(call=>call.endpoint==='catalog').length,1);await controller.dispose();
});

test('re-entry waits for owned parameter save and does not invent a revision conflict',async()=>{
  const f=fixture(),base=f.api.call.bind(f.api),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const project=f.snapshot.project!,shot=project.shots[0],entered=deferred<void>(),saved=deferred<StudioSnapshot>();
  f.api.call=async <T>(endpoint:string,payload:any)=>{if(endpoint==='save'){entered.resolve();return saved.promise as Promise<T>;}return base<T>(endpoint,payload);};
  controller.setSourceDraft(shot.id,source('local draft'));controller.edit({...project,title:'我自己的参数修改',revision:1});const saving=controller.flush();await entered.promise;
  const refreshing=controller.refreshVisibleProject();assert.equal(f.calls.filter(call=>call.endpoint==='current').length,0);
  f.snapshot={...f.snapshot,project:{...project,title:'我自己的参数修改',revision:1}};saved.resolve(structuredClone(f.snapshot));await Promise.all([saving,refreshing]);
  assert.equal(controller.getSnapshot().conflict,false);assert.equal(controller.getSnapshot().dirty,false);assert.equal(controller.confirmedRevision,1);assert.equal(controller.getSourceDraft(shot.id)?.baseRevision,1);assert.equal(f.calls.filter(call=>call.endpoint==='current').length,1);await controller.dispose();
});

test('old panel refresh cannot overwrite an in-flight source save or the newer typed draft',async()=>{
  const f=fixture(),base=f.api.call.bind(f.api),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const before=structuredClone(f.snapshot),shot=before.project!.shots[0],read=deferred<StudioSnapshot>(),saveEntered=deferred<void>(),saved=f.hold();let reads=0;
  f.api.call=async <T>(endpoint:string,payload:any)=>{if(endpoint==='current'){reads++;assert.equal(payload.projectId,before.project!.id);return read.promise as Promise<T>;}if(endpoint==='saveSource')saveEntered.resolve();return base<T>(endpoint,payload);};
  const refreshing=controller.refreshVisibleProject();controller.setSourceDraft(shot.id,source('A'));const saving=controller.saveSource(shot.id,source('A'));await saveEntered.promise;
  await controller.refreshVisibleProject();assert.equal(reads,1);controller.setSourceDraft(shot.id,source('B'));
  f.snapshot={...f.snapshot,project:{...before.project!,revision:1}};saved.resolve(structuredClone(f.snapshot));assert.equal(await saving,true);read.resolve(before);await refreshing;
  assert.equal(controller.confirmedRevision,1);assert.equal(controller.getSnapshot().snapshot?.project?.revision,1);assert.equal(controller.getSourceDraft(shot.id)?.source.html,'<div>B</div>');assert.equal(controller.getSnapshot().conflict,false);await controller.dispose();
});

test('re-entry preserves dirty parameters and reports only actual external version conflicts',async()=>{
  const f=fixture(),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const project=f.snapshot.project!,shot=project.shots[0];
  controller.setSourceDraft(shot.id,source('draft'));controller.edit({...project,title:'尚未保存的本地标题',revision:1});f.snapshot={...f.snapshot,project:{...project,title:'外部已提交标题',revision:2}};
  await controller.refreshVisibleProject();assert.equal(controller.getSnapshot().snapshot?.project?.title,'尚未保存的本地标题');assert.equal(controller.getSnapshot().dirty,true);assert.equal(controller.getSnapshot().conflict,true);assert.equal(controller.getSourceDraft(shot.id)?.source.html,'<div>draft</div>');assert.equal(f.calls.filter(call=>call.endpoint==='save').length,0);await controller.dispose();
});

test('a newer panel read supersedes old task poll status and old history replies',async()=>{
  const f=fixture(),base=f.api.call.bind(f.api),controller=new StudioController(f.api,new SourceDraftStore(memoryStorage()));await controller.load();const before=structuredClone(f.snapshot),oldRead=deferred<StudioSnapshot>(),oldHistory=deferred<ProjectHistory>();let reads=0,historyReads=0;
  f.api.call=async <T>(endpoint:string,payload:any)=>{if(endpoint==='current'&&++reads===1)return oldRead.promise as Promise<T>;if(endpoint==='history'&&++historyReads===1)return oldHistory.promise as Promise<T>;return base<T>(endpoint,payload);};
  const history=controller.refreshHistory(),poll=(controller as any).poll() as Promise<void>;
  f.snapshot={...f.snapshot,project:{...before.project!,revision:2},task:{id:'done',kind:'export',status:'complete',progress:1,message:'导出完成',startedAt:new Date().toISOString()}};await controller.refreshVisibleProject();
  oldRead.resolve({...before,task:{id:'done',kind:'export',status:'running',progress:.5,message:'旧进度',startedAt:new Date().toISOString()}});oldHistory.resolve({canUndo:false,canRedo:true,cursor:0,entries:[]});await Promise.all([history,poll]);
  assert.equal(controller.confirmedRevision,2);assert.equal(controller.getSnapshot().snapshot?.task?.status,'complete');assert.equal(controller.getSnapshot().canUndo,true);assert.equal(controller.getSnapshot().canRedo,false);await controller.dispose();
});
