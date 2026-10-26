import type { ClientRpc, ModelRoute, ProjectHistory, ProjectLocation, SceneSource, SessionBindings, StudioApi, StudioSnapshot, VideoProject, VideoStyle } from '../shared/types.ts';
import { SourceDraftStore, type SourceDraft } from './source-drafts.ts';

export interface StudioState {
  snapshot:StudioSnapshot|null; loading:boolean; pending:boolean; saving:boolean; dirty:boolean; conflict:boolean;
  error:string; notice:string; scheme:'light'|'dark'; selected:string|null;
  route:ModelRoute; canUndo:boolean; canRedo:boolean; history:ProjectHistory|null;
  localImages:Record<string,string>; focusFrame:number|null; focusSerial:number;
  sourceDraft:boolean; sourceDraftCount:number; draftSerial:number;
  workspaceView:'projects'|'studio'; projects:ProjectLocation[]; libraryLoading:boolean;
  sessionBindings:SessionBindings; relationPending:boolean;
  styles:VideoStyle[];
}
export class StudioRequestError extends Error {constructor(message:string,readonly code:string){super(message);this.name='StudioRequestError';}}
export class RpcStudioApi implements StudioApi {
  constructor(private rpc:ClientRpc,private signal?:AbortSignal) {}
  async call<T>(endpoint:string,payload:unknown={}):Promise<T> {
    const response=await this.rpc.call('/api',`video-studio/${endpoint}`,payload,this.signal);
    if(!response.ok)throw new StudioRequestError(response.error.message,response.error.code);
    return response.value as T;
  }
}

/** The plugin owns drafts and polling across DSH page navigation. */
export class StudioController {
  private state:StudioState={snapshot:null,loading:true,pending:false,saving:false,dirty:false,conflict:false,error:'',notice:'',scheme:'dark',selected:null,route:{provider:'',model:''},canUndo:false,canRedo:false,history:null,localImages:{},focusFrame:null,focusSerial:0,sourceDraft:false,sourceDraftCount:0,draftSerial:0,workspaceView:'projects',projects:[],libraryLoading:false,sessionBindings:{},relationPending:false,styles:[]};
  private listeners=new Set<()=>void>(); private disposed=false;
  private saveTimer:ReturnType<typeof setTimeout>|undefined; private pollTimer:ReturnType<typeof setTimeout>|undefined;
  private editSerial=0; private dirty=false; private savingPromise:Promise<void>|null=null; private saveFailed=false;
  private polling=false; private actionEpoch=0; private snapshotReadSerial=0; private serverRevision:number|null=null; private serverProjectId:string|null=null;
  private drafts:SourceDraftStore;
  private libraryReadSerial=0;
  constructor(readonly api:StudioApi,drafts?:SourceDraftStore){this.drafts=drafts||new SourceDraftStore();}
  getSnapshot=():StudioState=>this.state;
  subscribe=(fn:()=>void):(()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private update(patch:Partial<StudioState>):void {if(this.disposed)return;this.state={...this.state,...patch};for(const fn of this.listeners)fn();}
  private draftState(projectId=this.state.snapshot?.project?.id):Pick<StudioState,'sourceDraft'|'sourceDraftCount'|'draftSerial'> {
    const count=projectId?this.drafts.list(projectId).length:0;return {sourceDraft:count>0,sourceDraftCount:count,draftSerial:this.state.draftSerial+1};
  }
  private accept(snapshot:StudioSnapshot,protectDraft=true,ownSave=false):void {
    const previous=this.state.snapshot?.project||null,same=previous?.id===snapshot.project?.id,previousRevision=this.serverRevision;
    const keepProject=protectDraft&&same&&this.dirty;
    const conflict=keepProject&&!ownSave&&snapshot.project?.revision!==this.serverRevision;
    if(!keepProject||ownSave){this.serverProjectId=snapshot.project?.id??null;this.serverRevision=snapshot.project?.revision??null;}
    if(ownSave&&same&&snapshot.project&&previousRevision!==null)for(const draft of this.drafts.list(snapshot.project.id)){if(draft.baseRevision===previousRevision)this.drafts.set({...draft,baseRevision:snapshot.project.revision});}
    const project=keepProject?previous:snapshot.project,changed=project?.id!==previous?.id;
    if(changed)this.dirty=false;
    const provider=snapshot.providers.find(p=>p.id===this.state.route.provider)||snapshot.providers.find(p=>p.models.length);
    const model=provider?.models.find(m=>m.id===this.state.route.model)||provider?.models[0],selected=this.state.selected;
    this.update({snapshot:{...snapshot,project},loading:false,dirty:this.dirty,...this.draftState(project?.id),
      ...(snapshot.bindings?{sessionBindings:snapshot.bindings}:{}),
      ...(changed?{selected:null,canUndo:false,canRedo:false,history:null,focusFrame:null,localImages:{},conflict:false}:{}),
      ...(conflict?{conflict:true,error:'工程已更新。本地修改仍保留，请保存本地副本后重新读取工程。'}:{}),
      ...(!selected||project?.shots.some(s=>s.id===selected)||project?.assets.some(a=>a.id===selected)?{}:{selected:null}),
      route:{provider:provider?.id||'',model:model?.id||''}});
    if(snapshot.task?.status==='running')this.schedulePoll();
  }
  async load(force=false):Promise<void>{try{const snapshot=await this.api.call<StudioSnapshot>('catalog');if(force){this.dirty=false;this.update({dirty:false,conflict:false,saving:false});}this.accept(snapshot,!force);if(!this.state.conflict)this.update({error:''});if(!snapshot.project)this.update({workspaceView:'projects'});await Promise.all([this.refreshHistory(),this.refreshProjects(),this.refreshStyles()]);}catch(e){this.update({loading:false,error:message(e)});}}
  private snapshotReadGuard(projectId:string):()=>boolean {
    const epoch=this.actionEpoch,revision=this.serverRevision,edits=this.editSerial,read=++this.snapshotReadSerial;
    return ()=>!this.disposed&&!this.state.pending&&!this.savingPromise&&this.state.snapshot?.project?.id===projectId&&this.actionEpoch===epoch&&this.serverRevision===revision&&this.editSerial===edits&&this.snapshotReadSerial===read;
  }
  /** Re-entering the panel follows its visible project, independently of another Session's selection. */
  async refreshVisibleProject():Promise<void>{
    if(this.disposed||this.state.pending)return;
    if(this.savingPromise)await this.savingPromise;
    if(this.disposed||this.state.pending)return;
    const projectId=this.state.snapshot?.project?.id;if(!projectId)return;
    const revision=this.serverRevision,current=this.snapshotReadGuard(projectId);
    try{
      const snapshot=await this.api.call<StudioSnapshot>('current',{projectId});
      if(!current()||snapshot.project?.id!==projectId||(revision!==null&&snapshot.project.revision<revision))return;
      this.accept(snapshot);await this.refreshHistory();
    }catch(error){if(current())this.update({error:message(error)});}
  }
  async refreshHistory():Promise<void>{const projectId=this.state.snapshot?.project?.id,revision=this.serverRevision,epoch=this.actionEpoch;if(!projectId)return;try{const history=await this.api.call<ProjectHistory>('history',{projectId});if(!this.disposed&&this.state.snapshot?.project?.id===projectId&&this.serverRevision===revision&&this.actionEpoch===epoch&&Array.isArray(history.entries))this.update({history,canUndo:history.canUndo,canRedo:history.canRedo});}catch{/* Reading history does not change an editor draft. */}}
  async refreshProjects():Promise<void>{
    const read=++this.libraryReadSerial;this.update({libraryLoading:true});
    try{
      const result=await this.api.call<{projects:ProjectLocation[];bindings?:SessionBindings;sessions?:Record<string,string>}>('list',{includeArchived:true});
      if(read!==this.libraryReadSerial)return;
      const bindings=result.bindings??Object.fromEntries(Object.entries(result.sessions??{}).map(([id,projectId])=>[id,{currentProjectId:projectId,relatedProjectIds:[projectId],updatedAt:''}]));
      if(Array.isArray(result.projects))this.update({projects:result.projects,sessionBindings:bindings});
    }catch(e){if(read===this.libraryReadSerial)this.update({error:message(e)});}
    finally{if(read===this.libraryReadSerial)this.update({libraryLoading:false});}
  }
  async refreshStyles():Promise<void>{
    try{const result=await this.api.call<{styles:VideoStyle[]}>('styles.list');if(Array.isArray(result.styles))this.update({styles:result.styles});}
    catch(e){this.update({error:message(e)});}
  }
  async saveStyle(style:Partial<VideoStyle>):Promise<VideoStyle>{
    const result=await this.api.call<{style:VideoStyle;styles:VideoStyle[]}>('styles.save',{style});
    if(Array.isArray(result.styles))this.update({styles:result.styles});return result.style;
  }
  async deleteStyle(id:string):Promise<void>{
    const result=await this.api.call<{styles:VideoStyle[]}>('styles.delete',{id});if(Array.isArray(result.styles))this.update({styles:result.styles});
  }
  async showProjects():Promise<boolean>{await this.flush();if(this.dirty){this.update({error:this.state.error||'工程修改尚未保存，请先处理保存错误。'});return false;}this.update({workspaceView:'projects'});await this.refreshProjects();return true;}
  showStudio=():void=>this.update({workspaceView:'studio'});
  async focusProject(project:string|{projectId?:string;path?:string;sessionId?:string;shotId?:string;frame?:number},focus:{shotId?:string;frame?:number;sessionId?:string}={}):Promise<void>{
    const payload=typeof project==='string'?{projectId:project,...focus}:project;
    if(!await this.action('focus',payload))throw new Error(this.state.error||'工程定位未完成');
    if(payload.projectId&&this.state.snapshot?.project?.id!==payload.projectId)throw new Error('工程定位未完成，请稍后重试');
    const selected=payload.shotId??this.state.snapshot?.focus?.shotId;if(selected)this.select(selected);
    const frame=payload.frame??this.state.snapshot?.focus?.frame;if(frame!==undefined)this.update({focusFrame:frame,focusSerial:this.state.focusSerial+1});
    this.showStudio();
  }
  /** Relation edits never replace the visible film or flush unrelated source/parameter drafts. */
  async bindSession(sessionId:string,projectId=this.state.snapshot?.project?.id,expectedCurrentProjectId?:string):Promise<void>{
    if(!projectId)throw new Error('请选择影片工程');
    await this.changeRelation('bindSession',{sessionId,projectId,select:false,expectedCurrentProjectId:expectedCurrentProjectId??this.state.sessionBindings[sessionId]?.currentProjectId??null},'工程已关联，并设为此会话的当前工程。');
  }
  async unbindSession(sessionId:string,projectId=this.state.snapshot?.project?.id):Promise<void>{
    if(!projectId)throw new Error('请选择影片工程');
    await this.changeRelation('unbindSession',{sessionId,projectId,expectedCurrentProjectId:this.state.sessionBindings[sessionId]?.currentProjectId??null},'已解除关联，影片和会话内容保留。');
  }
  private async changeRelation(endpoint:string,payload:unknown,notice:string):Promise<void>{
    if(this.state.relationPending)throw new Error('正在更新会话关联，请稍后再试');
    this.libraryReadSerial++;this.actionEpoch++;this.update({relationPending:true,error:this.state.conflict?this.state.error:'',notice:''});
    try{
      const result=await this.api.call<{bindings?:SessionBindings}>(endpoint,payload);
      if(result.bindings)this.update({sessionBindings:result.bindings});
      await this.refreshProjects();this.update({notice});
    }catch(error){this.update({error:message(error)});throw error;}
    finally{this.actionEpoch++;this.update({relationPending:false});}
  }
  async audio(payload:unknown):Promise<void>{await this.action('audio',payload);}
  private schedulePoll():void{if(this.disposed||this.polling||this.pollTimer)return;this.pollTimer=setTimeout(()=>{this.pollTimer=undefined;void this.poll();},700);}
  private async poll():Promise<void>{
    if(this.disposed||this.polling)return;this.polling=true;
    const projectId=this.state.snapshot?.project?.id,revision=this.serverRevision,current=projectId?this.snapshotReadGuard(projectId):()=>false;
    try{if(!projectId||this.state.pending||this.savingPromise)return;const snapshot=await this.api.call<StudioSnapshot>('current',{projectId});if(current()&&snapshot.project?.id===projectId&&(revision===null||snapshot.project.revision>=revision)){this.accept(snapshot);if(snapshot.task?.status!=='running')await this.refreshHistory();}}catch(e){if(current())this.update({error:message(e)});}
    finally{this.polling=false;if(this.state.snapshot?.task?.status==='running')this.schedulePoll();}
  }
  setScheme=(scheme:'light'|'dark'):void=>this.update({scheme});
  select=(selected:string|null):void=>this.update({selected});
  setRoute=(route:ModelRoute):void=>this.update({route});
  clearError=():void=>{if(!this.state.conflict)this.update({error:''});};
  notify=(notice:string):void=>this.update({notice});
  getSourceDraft(shotId:string,projectId=this.state.snapshot?.project?.id):SourceDraft|undefined{return projectId?this.drafts.get(projectId,shotId):undefined;}
  sourceDrafts(projectId=this.state.snapshot?.project?.id):SourceDraft[]{return projectId?this.drafts.list(projectId):[];}
  setSourceDraft(shotId:string,source:SceneSource,baseRevision?:number):void {
    const projectId=this.state.snapshot?.project?.id;if(!projectId)return;const previous=this.drafts.get(projectId,shotId);
    this.drafts.set({projectId,shotId,source,baseRevision:previous?.baseRevision??baseRevision??this.serverRevision??0,updatedAt:new Date().toISOString()});
    this.update({...this.draftState(),...(this.drafts.warning?{notice:this.drafts.warning}:{})});
  }
  discardSourceDraft(shotId:string,projectId=this.state.snapshot?.project?.id):void{if(!projectId)return;this.drafts.delete(projectId,shotId);this.update({...this.draftState(),...(!this.dirty?{conflict:false,error:''}:{}),notice:'源码草稿已丢弃，保存的源码保持原样。'});}
  persistDrafts():void{this.drafts.persist();if(this.drafts.warning)this.update({notice:this.drafts.warning});}
  get confirmedRevision():number|null{return this.serverRevision;}
  edit=(project:VideoProject,_record=true):void=>{
    if(!this.state.snapshot||this.state.pending||this.state.conflict)return;
    const task=this.state.snapshot.task;if(task?.status==='running'&&['storyboard','scenes','modify','audio'].includes(task.kind))return;
    this.editSerial++;this.dirty=true;this.update({snapshot:{...this.state.snapshot,project},saving:true,dirty:true,notice:'',error:''});
    clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>{this.saveTimer=undefined;void this.flush();},450);
  };
  undo=():void=>{void this.action('undo',{},'已撤销，修改历史保存在工程中。');};
  redo=():void=>{void this.action('redo',{},'已重做。');};
  async flush():Promise<void>{
    clearTimeout(this.saveTimer);this.saveTimer=undefined;
    if(this.savingPromise){await this.savingPromise;if(this.dirty&&!this.saveFailed&&!this.state.conflict)return this.flush();return;}
    const project=this.state.snapshot?.project;if(!project||!this.dirty||this.state.conflict)return;
    const serial=this.editSerial;this.saveFailed=false;
    const operation=(async()=>{try{
      const snapshot=await this.api.call<StudioSnapshot>('save',{project,expectedRevision:this.serverProjectId===project.id?this.serverRevision:undefined});
      if(serial===this.editSerial){this.dirty=false;this.accept(snapshot,false,true);this.update({saving:false,dirty:false,error:'',conflict:false});}
      else this.accept(snapshot,true,true);
      await this.refreshHistory();
    }catch(e){this.saveFailed=true;this.update({saving:false,error:message(e),conflict:isConflict(e)});}})();
    this.savingPromise=operation;await operation;if(this.savingPromise===operation)this.savingPromise=null;
    if(this.dirty&&!this.saveFailed&&!this.state.conflict&&serial!==this.editSerial)await this.flush();
  }
  async action(endpoint:string,payload:unknown={},notice=''):Promise<boolean>{
    if(this.state.pending)return false;this.actionEpoch++;this.update({pending:true,error:this.state.conflict?this.state.error:'',notice:''});
    try{
      await this.flush();if(this.dirty)throw new Error(this.state.error||'工程尚未保存，请重试保存。');
      if(this.state.sourceDraft&&['preview','export','generate','retry','undo','redo'].includes(endpoint))throw new Error('本工程有源码草稿。请在源码面板保存或丢弃草稿后再执行此操作；切换页面会保留草稿。');
      const targetId=(payload as {projectId?:string})?.projectId??this.state.snapshot?.project?.id;
      const guard=['saveSource','restoreSource','apply','rename','undo','redo','retry'].includes(endpoint)&&targetId===this.serverProjectId?{expectedRevision:this.serverRevision}:{};
      const request=['create','open','focus'].includes(endpoint)?payload:{projectId:this.state.snapshot?.project?.id,...guard,...payload as object};
      const snapshot=await this.api.call<StudioSnapshot>(endpoint,request);this.accept(snapshot,false,['saveSource','restoreSource','import','rename'].includes(endpoint));await this.refreshHistory();
      if(['create','rename','duplicate','archive','restore'].includes(endpoint))await this.refreshProjects();
      if(['create','open','focus','duplicate'].includes(endpoint))this.showStudio();
      this.update({notice,conflict:false,error:''});return true;
    }catch(e){this.update({error:message(e),...(isConflict(e)?{conflict:true}:{})});return false;}finally{this.update({pending:false});}
  }
  /** Background workflow refreshes never follow another project's global selection. */
  async refreshMediaProject():Promise<boolean>{
    if(this.state.pending)return false;const projectId=this.state.snapshot?.project?.id,epoch=this.actionEpoch;if(!projectId)return false;
    const snapshot=await this.api.call<StudioSnapshot>('current',{projectId});
    if(this.state.pending||this.actionEpoch!==epoch||this.state.snapshot?.project?.id!==projectId||snapshot.project?.id!==projectId)return false;
    if(this.serverRevision!==null&&snapshot.project.revision<this.serverRevision)return true;
    if(this.state.sourceDraft&&snapshot.project.revision!==this.serverRevision){this.update({conflict:true,error:'工程已由制作任务更新。前端源码草稿已保留，请先复制草稿，再重新载入已保存版本。'});return true;}
    this.accept(snapshot,true);await this.refreshHistory();return true;
  }
  /** Media jobs return task records, not StudioSnapshot; preserve the editor's CAS boundary. */
  async mediaCommand<T>(endpoint:string,payload:Record<string,unknown>={},refreshProject=false):Promise<T>{
    if(this.state.pending)throw new Error('已有界面操作进行中，请稍后重试');
    const projectId=this.state.snapshot?.project?.id;
    if(!projectId)throw new Error('请先创建或打开影片工程');
    const prepares=!['media.cancel','media.pause','workflows.pause'].includes(endpoint);
    this.actionEpoch++;this.update({pending:true});
    try{
      if(prepares){await this.flush();if(this.dirty||this.state.sourceDraft)throw new Error(this.state.error||'工程或源码草稿尚未保存，请保存后继续。');}
      if(this.state.snapshot?.project?.id!==projectId)throw new Error('工程已切换，请重新发起操作');
      const result=await this.api.call<T>(endpoint,{...payload,projectId,...(prepares?{expectedRevision:this.serverRevision}:{})});
      if(refreshProject){const snapshot=await this.api.call<StudioSnapshot>('current',{projectId});if(snapshot.project?.id!==projectId)throw new Error('工程刷新结果不匹配');this.accept(snapshot,true,true);await this.refreshHistory();}
      this.update({notice:'',...(!this.state.conflict?{error:''}:{})});return result;
    }catch(error){this.update({error:message(error)});throw error;}finally{this.update({pending:false});}
  }
  async generate(kind:'storyboard'|'scenes'|'modify',instruction='',shotId?:string):Promise<void>{if(this.busy)return;if(!this.state.route.provider||!this.state.route.model){this.update({error:'先选择一个 DSH 模型，再开始生成。'});return;}await this.action('generate',{kind,instruction,shotId,...this.state.route});}
  async readSource(shotId:string):Promise<SceneSource>{return this.api.call<SceneSource>('source',{shotId,projectId:this.state.snapshot?.project?.id});}
  async saveSource(shotId:string,source:SceneSource,useCurrentRevision=false):Promise<boolean>{
    const projectId=this.state.snapshot?.project?.id;if(!projectId)return false;
    await this.flush();if(this.dirty)return false;
    if(this.state.snapshot?.project?.id!==projectId){this.update({error:'工程已切换，源码草稿仍保留在原工程中。'});return false;}
    const draft=this.drafts.get(projectId,shotId);
    const success=await this.action('saveSource',{shotId,source,expectedRevision:useCurrentRevision?this.serverRevision:draft?.baseRevision??this.serverRevision},'源码已保存，可以刷新预览。');
    if(success){const current=this.drafts.get(projectId,shotId);if(!current||JSON.stringify(current.source)===JSON.stringify(source)){this.drafts.delete(projectId,shotId);this.update(this.draftState());}}
    return success;
  }
  async restoreSource(shotId:string):Promise<boolean>{const success=await this.action('restoreSource',{shotId},'已恢复上次可用源码。');if(success)this.discardSourceDraft(shotId);return success;}
  async importFile(file:File):Promise<void>{
    if(file.size>64*1024*1024){this.update({error:'此文件超过浏览器上传大小，请在“模型与素材生成”中通过本地路径导入。'});return;}
    if((file.type.startsWith('video/')||/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name))&&file.size>32*1024*1024){this.update({error:'视频文件超过 32 MiB，请在“模型与素材生成”中通过本地路径导入。'});return;}
    if(file.type.startsWith('image/')){const data=await readDataUrl(file);await this.action('import',{name:file.name,mime:file.type,dataBase64:data.slice(data.indexOf(',')+1)});const asset=[...(this.state.snapshot?.project?.assets||[])].reverse().find(a=>a.name===file.name&&a.kind==='image');if(asset)this.update({localImages:{...this.state.localImages,[asset.id]:data}});}
    else if(file.type.startsWith('text/')||/\.(txt|md)$/i.test(file.name))await this.action('import',{name:file.name,mime:'text/plain',text:await file.text()});
    else if(file.type.startsWith('audio/')||/\.(wav|mp3|m4a|aac|flac|ogg|aiff)$/i.test(file.name)){const data=await readDataUrl(file);await this.action('import',{name:file.name,mime:file.type,dataBase64:data.slice(data.indexOf(',')+1)});}
    else if(file.type.startsWith('video/')||/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)){const data=await readDataUrl(file);await this.action('import',{name:file.name,mime:file.type||'video/mp4',dataBase64:data.slice(data.indexOf(',')+1)});}
    else this.update({error:'请选择图片、文字、音频或 MP4、MOV、WebM 视频。'});
  }
  get busy():boolean{return this.state.pending||this.state.snapshot?.task?.status==='running';}
  async dispose():Promise<void>{clearTimeout(this.saveTimer);clearTimeout(this.pollTimer);this.persistDrafts();await this.flush();this.disposed=true;clearTimeout(this.saveTimer);clearTimeout(this.pollTimer);this.listeners.clear();}
}
function message(error:unknown):string{return error instanceof Error?error.message:'操作未完成';}
function isConflict(error:unknown):boolean{return error instanceof StudioRequestError&&error.code==='REVISION_CONFLICT'||/版本冲突|工程.*已更新|revision conflict/i.test(message(error));}
function readDataUrl(file:File):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('读取素材失败'));reader.readAsDataURL(file);});}
