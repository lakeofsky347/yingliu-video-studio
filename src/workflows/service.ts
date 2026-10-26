import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSceneSource, validateProject } from '../core/index.ts';
import { normalizeStoryboard, parseModelJson, parseSceneSource } from '../host/generator.ts';
import type { Asset, SceneSource, VideoProject } from '../shared/types.ts';
import type { MediaTaskService } from '../jobs/media-tasks.ts';
import type { MediaTask } from '../jobs/contracts.ts';
import type { WorkflowPort, WorkflowRecord, WorkflowRequest, WorkflowStep, WorkflowModelCall, WorkflowCandidate } from './contracts.ts';

interface ShotPlan { shotId:string; prompt:string; narration:string }
interface StoredWorkflow extends WorkflowRecord {
  baseline?:VideoProject; plan?:ShotPlan[]; assets?:Record<string,Asset[]>;
  initialization?:{project:VideoProject;plan:ShotPlan[]};
  candidate?:WorkflowCandidate & {expectedRevision:number};adoptionRevision?:number;
}
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
function delay(signal:AbortSignal):Promise<void>{return new Promise((accept,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);accept();},250);const stop=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});}
/** Mirror the host's voice fitting before review so the reviewed timeline is the committed one. */
function fitCandidateAudio(project:VideoProject){
  const check=validateProject(project);if(!check.ok)throw new Error(check.errors.join('\n'));if(project.target.audioMode==='none')return;
  const fps=project.target.fps.num/project.target.fps.den;
  for(const clip of project.audioClips??[]){
    if(clip.role!=='voice'||clip.loop)continue;const asset=project.assets.find(item=>item.id===clip.assetId)!;
    const end=clip.startSeconds+Math.min(clip.trimEnd??asset.duration!,asset.duration!)-clip.trimStart;
    if(clip.trimStart>=asset.duration!)throw new Error('旁白裁剪起点超出音频长度');
    if(clip.shotId){const shot=project.shots.find(item=>item.id===clip.shotId)!;if(end>shot.durationFrames/fps+1e-6){if(project.extensions.lockDuration===true)throw new Error('旁白超出镜头时长，请调整裁剪、旁白或解除时长锁定');shot.durationFrames=Math.ceil((end+.25)*fps);}}
    else if(end>project.shots.reduce((sum,shot)=>sum+shot.durationFrames/fps,0)+1e-6)throw new Error('全片旁白超出成片时长，请延长镜头或裁剪音频');
  }
}

/** Fixed production workflow. Parallel computation never bypasses the project CAS. */
export class WorkflowService {
  private records=new Map<string,StoredWorkflow>();
  private running=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private projectQueues=new Map<string,Promise<unknown>>();
  private stepStarts=new Map<string,number>();
  private writes=Promise.resolve();private initialized?:Promise<void>;private stopped=false;
  private readonly directory:string;
  constructor(directory:string,private media:MediaTaskService,private port:WorkflowPort){this.directory=join(directory,'workflows');}
  private initialize(){return this.initialized??=(async()=>{
    await mkdir(this.directory,{recursive:true});
    for(const name of await readdir(this.directory)){
      if(!/^[a-zA-Z0-9_-]{1,100}\.json$/.test(name))continue;
      const record=JSON.parse(await readFile(join(this.directory,name),'utf8')) as StoredWorkflow;
      if(record.version!==1||record.id+'.json'!==name||!record.projectId||!Array.isArray(record.steps))throw new Error('协作任务记录无效');
      if(record.status==='running'){record.status='paused';record.message='上次制作已中断；继续时复用已完成产物';for(const step of record.steps)if(step.status==='running'){step.status='pending';if(step.kind==='speech'&&!step.assetIds?.length)step.submissionUncertain=true;}}
      this.records.set(record.id,record);
    }
  })();}
  private public(record:StoredWorkflow):WorkflowRecord {const {baseline,plan,assets,initialization,candidate,adoptionRevision,...value}=structuredClone(record);return value;}
  private persist(record:StoredWorkflow){for(const step of record.steps)if(step.status!=='running')this.finishStep(step);record.updatedAt=new Date().toISOString();const snapshot=structuredClone(record);const work=this.writes.then(async()=>{const destination=join(this.directory,record.id+'.json'),temporary=destination+'.tmp-'+randomUUID();await writeFile(temporary,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});await rename(temporary,destination);});this.writes=work.catch(()=>{});return work;}
  private beginStep(step:WorkflowStep){
    if(step.status==='complete')return;step.status='running';step.startedAt=new Date().toISOString();delete step.finishedAt;delete step.durationMs;this.stepStarts.set(step.id,performance.now());
  }
  private finishStep(step:WorkflowStep){
    const started=this.stepStarts.get(step.id);if(started===undefined)return;step.finishedAt=new Date().toISOString();step.durationMs=Math.max(0,Math.round(performance.now()-started));this.stepStarts.delete(step.id);
  }
  private async text(record:StoredWorkflow,step:WorkflowStep,role:'director'|'scene'|'vision',prompt:string,signal:AbortSignal,images?:{bytes:Uint8Array;mime:string}[]){
    const call:WorkflowModelCall={role,startedAt:new Date().toISOString(),status:'running'};step.modelCalls??=[];step.modelCalls.push(call);await this.persist(record);
    const started=performance.now();call.startedAt=new Date().toISOString();
    try{const result=await this.port.text(role,prompt,signal,record.request,images);call.status='complete';return result;}
    catch(error){call.status='failed';throw error;}
    finally{call.finishedAt=new Date().toISOString();call.durationMs=Math.max(0,Math.round(performance.now()-started));await this.persist(record);}
  }
  private async required(id:string){await this.initialize();const value=this.records.get(id);if(!value)throw new Error('协作任务不存在');return value;}
  async list(projectId?:string){await this.initialize();return [...this.records.values()].filter(item=>!projectId||item.projectId===projectId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(item=>this.public(item));}
  async get(id:string){return this.public(await this.required(id));}
  private projectLock<T>(projectId:string,work:()=>Promise<T>):Promise<T>{
    const previous=this.projectQueues.get(projectId)??Promise.resolve();
    const next=previous.catch(()=>{}).then(work);this.projectQueues.set(projectId,next);
    void next.finally(()=>{if(this.projectQueues.get(projectId)===next)this.projectQueues.delete(projectId);}).catch(()=>{});return next;
  }
  private assertProjectIdle(projectId:string,except?:string){if([...this.records.values()].some(record=>record.projectId===projectId&&record.id!==except&&(record.status==='running'||this.running.has(record.id))))throw new Error('此工程已有协作制作任务');}
  private checkTaskBudget(record:StoredWorkflow,count=record.plan?.length??record.initialization?.plan.length??1){
    const tasks=count*(record.request.narration?2:1)+(record.request.review?1:0)+1;
    if(tasks>(record.request.maxTasks??40))throw new Error('制作步骤超过本轮任务上限，请缩小镜头范围');
  }
  private candidatesReady(record:StoredWorkflow){return !!record.plan?.length&&record.plan.every(plan=>record.steps.some(step=>step.kind===record.request.visual&&step.shotId===plan.shotId&&step.status==='complete')&&(!record.request.narration||record.steps.some(step=>step.kind==='speech'&&step.shotId===plan.shotId&&step.status==='complete')));}
  private async reconcile(record:StoredWorkflow){
    const project=(await this.port.snapshot(record.projectId)).project;if(!project)throw new Error('工程不存在');
    const revision=(project.extensions.workflowApplications as Record<string,unknown>|undefined)?.[record.id];
    if(Number.isSafeInteger(revision)&&Number(revision)>0&&Number(revision)<=project.revision){
      record.committedRevision=Number(revision);const step=this.step(record,'commit');step.status='complete';step.message='结果已保存为工程 v'+revision;await this.persist(record);
    }
  }
  async run(input:WorkflowRequest):Promise<WorkflowRecord>{
    await this.initialize();if(this.stopped)throw new Error('协作服务正在关闭');
    if(!input||typeof input.projectId!=='string'||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000||!['code','image','video'].includes(input.visual))throw new Error('请填写工程、制作要求和画面类型');
    if(input.review&&!input.allowImageUpload)throw new Error('视觉检查需要明确允许本次工作流上传关键帧');
    if(input.maxTasks!==undefined&&(!Number.isSafeInteger(input.maxTasks)||input.maxTasks<1||input.maxTasks>100))throw new Error('任务上限须为 1–100');
    if(input.maxCost!==undefined&&(!Number.isFinite(input.maxCost)||input.maxCost<=0))throw new Error('费用上限须为正数');
    if((input.imageAssetIds?.length??0)>3||new Set(input.imageAssetIds).size!==(input.imageAssetIds?.length??0))throw new Error('最多选择 3 张不同参考图片');
    return this.projectLock(input.projectId,async()=>{
    this.assertProjectIdle(input.projectId);
    const snapshot=await this.port.snapshot(input.projectId);if(!snapshot.project||snapshot.project.revision!==input.expectedRevision)throw Object.assign(new Error('工程版本已变化，请刷新后制作'),{code:'REVISION_CONFLICT'});
    if(input.shotIds?.some(id=>!snapshot.project!.shots.some(shot=>shot.id===id)))throw new Error('所选镜头不存在');
    const now=new Date().toISOString(),record:StoredWorkflow={version:1,id:randomUUID(),projectId:input.projectId,request:structuredClone(input),status:'running',message:'导演正在规划',createdAt:now,updatedAt:now,startRevision:input.expectedRevision,steps:[],usage:{cost:null,generatedTasks:0},baseline:structuredClone(snapshot.project),assets:{}};
    this.records.set(record.id,record);await this.persist(record);this.start(record);return this.public(record);
    });
  }
  private start(record:StoredWorkflow){if(this.running.has(record.id)||this.stopped)return;const controller=new AbortController();const promise=this.execute(record,controller.signal).finally(()=>this.running.delete(record.id));this.running.set(record.id,{controller,promise});void promise.catch(()=>{});}
  async pause(id:string){const record=await this.required(id);const active=this.running.get(id);active?.controller.abort(new Error('已停止等待'));await active?.promise;
    for(const step of record.steps)if(step.taskId){const task=await this.media.get(step.taskId);if(task.observation==='active'&&!['ready','complete','failed','cancelled'].includes(task.phase))await this.media.pause(step.taskId);}
    if(record.status!=='complete'&&record.status!=='awaiting-apply'){record.status='paused';record.message='已暂停本地制作；云端生成可能仍在执行';await this.persist(record);}return this.public(record);}
  async retry(id:string){const record=await this.required(id);return this.projectLock(record.projectId,async()=>{
    if(record.status==='complete')return this.public(record);const finishing=this.running.get(id);if(finishing){if(record.status==='running')return this.public(record);await finishing.promise;}if(this.stopped)throw new Error('协作服务正在关闭');this.assertProjectIdle(record.projectId,id);
    for(const step of record.steps)if(step.status==='failed'||step.status==='running'){
      if(step.taskId){const task=await this.media.get(step.taskId);if(['failed','cancelled'].includes(task.phase)){step.previousTaskIds=[...(step.previousTaskIds??[]),step.taskId];delete step.taskId;step.mediaAttempt=(step.mediaAttempt??0)+1;}}
      step.status='pending';
    }
    record.status='running';delete record.error;record.message='继续制作，复用已完成产物';await this.persist(record);this.start(record);return this.public(record);
  });}
  private step(record:StoredWorkflow,kind:WorkflowStep['kind'],shotId?:string){let step=record.steps.find(item=>item.kind===kind&&item.shotId===shotId);if(!step){step={id:randomUUID(),kind,shotId,status:'pending',message:'等待处理'};record.steps.push(step);}return step;}
  private async finishInitialization(record:StoredWorkflow){
    const initialization=record.initialization!;this.checkTaskBudget(record,initialization.plan.length);
    const latest=(await this.port.snapshot(record.projectId)).project!;
    const applied=(latest.extensions.workflowInitializations as Record<string,{revision:number}>|undefined)?.[record.id];
    if(applied&&Number.isSafeInteger(applied.revision)&&applied.revision>0&&applied.revision<=latest.revision){
      record.startRevision=applied.revision;record.baseline={...structuredClone(initialization.project),revision:applied.revision};
    }else{
      if(latest.revision!==record.startRevision)throw Object.assign(new Error('工程在分镜初始化前发生变化，请从当前版本新建制作'),{code:'REVISION_CONFLICT'});
      const project=(await this.port.commit(record.projectId,record.startRevision,initialization.project,Object.fromEntries(initialization.project.shots.map(shot=>[shot.id,defaultSceneSource()])),'协作导演建立分镜')).project!;
      record.startRevision=project.revision;record.baseline=structuredClone(project);
    }
    record.plan=structuredClone(initialization.plan);const step=this.step(record,'plan');step.status='complete';step.message='镜头计划已确认';await this.persist(record);
  }
  private async plan(record:StoredWorkflow,signal:AbortSignal){
    if(record.plan){this.checkTaskBudget(record);return;}
    if(record.initialization){await this.finishInitialization(record);return;}
    const snapshot=await this.port.snapshot(record.projectId),project=snapshot.project!;
    if(project.revision!==record.startRevision)throw Object.assign(new Error('工程在规划前发生变化，请从当前版本新建制作'),{code:'REVISION_CONFLICT'});
    const selected=record.request.shotIds?.length?project.shots.filter(shot=>record.request.shotIds!.includes(shot.id)):project.shots;
    this.checkTaskBudget(record,selected.length||1);
    const step=this.step(record,'plan');this.beginStep(step);await this.persist(record);
    const prompt=JSON.stringify({request:record.request.prompt,project:{title:project.title,topic:project.topic,targetDuration:project.targetDuration,target:project.target},shots:selected,output:selected.length?{shots:[{shotId:'必须使用给定镜头ID',prompt:'该镜头画面制作要求',narration:'旁白文字'}]}:{shots:[{title:'镜头标题',intent:'目标',durationSeconds:6,params:{text:'屏幕标题'},prompt:'画面制作要求',narration:'旁白文字'}]},instruction:'输出严格JSON，只安排选定镜头。空工程生成1–12个镜头。不要输出API地址或凭据。'});
    const value=parseModelJson(await this.text(record,step,'director',prompt,signal));signal.throwIfAborted();
    if(!Array.isArray(value.shots)||value.shots.length<1||value.shots.length>12)throw new Error('导演须返回 1–12 个镜头计划');
    if(!project.shots.length){
      const next=structuredClone(project);next.shots=normalizeStoryboard(value,next);next.shotOrder=next.shots.map(shot=>shot.id);delete next.extensions.graphEdges;next.shots.forEach((shot,index)=>{next.graph.positions[shot.id]=[420+index*340,160];});
      const plan=next.shots.map((shot,index)=>({shotId:shot.id,prompt:String(value.shots[index]?.prompt??shot.intent??record.request.prompt),narration:String(value.shots[index]?.narration??shot.narration??'')}));
      next.extensions.workflowInitializations={...(next.extensions.workflowInitializations as object??{}),[record.id]:{revision:record.startRevision+1}};
      record.initialization={project:next,plan};this.checkTaskBudget(record,plan.length);await this.persist(record);signal.throwIfAborted();await this.finishInitialization(record);
    }else{
      const ids=new Set(selected.map(shot=>shot.id)),planned:ShotPlan[]=value.shots.map((shot:Record<string,unknown>)=>({shotId:String(shot.shotId??''),prompt:String(shot.prompt??record.request.prompt),narration:String(shot.narration??'')}));
      if(planned.length!==ids.size||new Set(planned.map(shot=>shot.shotId)).size!==ids.size||planned.some(shot=>!ids.has(shot.shotId)))throw new Error('导演计划必须保留本轮所有镜头 ID');record.plan=planned;this.checkTaskBudget(record);step.status='complete';step.message='镜头计划已确认';await this.persist(record);
    }
  }
  private async visual(record:StoredWorkflow,plan:ShotPlan,signal:AbortSignal){
    const step=this.step(record,record.request.visual,plan.shotId);if(step.status==='complete')return;
    this.beginStep(step);step.message='正在生成镜头';await this.persist(record);
    try{
      if(record.request.visual==='code'){
        const project=record.baseline!,shot=project.shots.find(item=>item.id===plan.shotId)!;
        const current=await this.port.source(record.projectId,plan.shotId);
        const prompt=JSON.stringify({request:plan.prompt,shot,target:project.target,assets:project.assets.filter(asset=>shot.assetIds.includes(asset.id)||shot.referenceIds.includes(asset.id)),current,contract:'输出严格JSON {html,css,js}；JS导出render(ctx)，按ctx.localFrame/time独立求值，使用ctx.params。无外网、Node、IPC。ctx.hasVideo为true时宿主已绘制视频底图，只叠加文字图形，不用不透明全屏背景遮住底图，也不自行启动video播放。所有用户未要求修改的字段保持。'});
        step.source=parseSceneSource(await this.text(record,step,'scene',prompt,signal));
      }else{
        let task:MediaTask;
        if(step.taskId){task=await this.media.get(step.taskId);if(!['ready','complete'].includes(task.phase))task=await this.media.retry(step.taskId);}
        else{
          const latest=(await this.port.snapshot(record.projectId)).project!;
          const shot=latest.shots.find(item=>item.id===plan.shotId);if(!shot)throw new Error('生成目标镜头已删除，已有产物会保留');
          const ids=(record.request.imageAssetIds??[]).filter(id=>[...shot.assetIds,...shot.referenceIds].includes(id));
          task=await this.media.generate({clientRequestId:`${record.id}.${step.id}.${step.mediaAttempt??0}`,projectId:record.projectId,shotId:plan.shotId,expectedRevision:latest.revision,operation:record.request.visual==='image'?'text-to-image':ids.length?'image-to-video':'text-to-video',prompt:plan.prompt,...(record.request.visual==='video'?{imageAssetIds:ids,allowImageUpload:record.request.allowImageUpload}:{}),ownerSessionId:record.request.ownerSessionId});
          step.taskId=task.id;record.usage.generatedTasks++;await this.persist(record);
        }
        while(!['ready','complete','failed','cancelled','unknown'].includes(task.phase)){signal.throwIfAborted();await delay(signal);task=await this.media.get(task.id);if(task.observation==='paused'&&!['ready','complete','failed','cancelled','unknown'].includes(task.phase))throw new Error('媒体生成已停止等待，请继续该制作任务');}
        if(!['ready','complete'].includes(task.phase))throw new Error(task.error??task.message);
        signal.throwIfAborted();const files=await this.media.prepare(task.id);const assets=await this.port.stageMedia(record.projectId,task,files,signal);record.assets![step.id]=assets;step.assetIds=assets.map(asset=>asset.id);
      }
      signal.throwIfAborted();step.status='complete';step.message='候选画面已就绪';await this.persist(record);
    }catch(error){step.status=signal.aborted?'pending':'failed';step.message=message(error);await this.persist(record);throw error;}
  }
  private async voice(record:StoredWorkflow,plan:ShotPlan,signal:AbortSignal){
    if(!record.request.narration)return;const step=this.step(record,'speech',plan.shotId);if(step.status==='complete')return;
    if(step.submissionUncertain)throw new Error('上次配音提交结果待确认，不能自动重复合成；请检查供应商记录后明确新建制作');
    this.beginStep(step);step.submissionUncertain=true;await this.persist(record);
    try{if(!plan.narration.trim())throw Object.assign(new Error('导演未提供该镜头旁白'),{submissionUncertain:false});
      const asset=await this.port.voice(record.projectId,plan.shotId,plan.narration,signal);
      record.assets![step.id]=[asset];step.assetIds=[asset.id];step.submissionUncertain=false;step.status='complete';step.message='配音已就绪';await this.persist(record);signal.throwIfAborted();
    }catch(error){if(!step.assetIds?.length){step.status=signal.aborted?'pending':'failed';step.submissionUncertain=(error as {submissionUncertain?:boolean})?.submissionUncertain!==false;}step.message=message(error);await this.persist(record);throw error;}
  }
  private async updateUsage(record:StoredWorkflow){
    let total=0,known=true,currency:string|undefined,count=0;
    for(const step of record.steps)for(const id of [...(step.previousTaskIds??[]),...(step.taskId?[step.taskId]:[])]){const task=await this.media.get(id);count++;const next=typeof task.usage?.currency==='string'?task.usage.currency:undefined;if(typeof task.usage?.cost!=='number'||!Number.isFinite(task.usage.cost)||!next)known=false;else{total+=task.usage.cost;if(currency&&next!==currency)known=false;currency??=next;}}
    // Director, scene and speech charges are not yet reported. Never present the media subtotal as a complete bill.
    record.usage.cost=null;record.usage.generatedTasks=count;delete record.usage.mediaCost;delete record.usage.currency;
    if(known&&count){record.usage.mediaCost=total;record.usage.currency=currency;}
  }
  private async acknowledge(record:StoredWorkflow){
    if(record.committedRevision===undefined)return;
    for(const step of record.steps)if(step.taskId){
      const task=await this.media.get(step.taskId);if(task.phase==='complete')continue;
      const project=(await this.port.snapshot(record.projectId)).project!;
      const applied=(project.extensions.mediaApplications as Record<string,unknown>|undefined)?.[task.id];
      if(!applied)throw new Error('工程中的生成素材采用记录已撤销，不能自动重新应用；素材仍保留');
      await this.media.apply(task.id,project.revision);
    }
  }
  private async execute(record:StoredWorkflow,signal:AbortSignal){
    try{
      await this.reconcile(record);
      // The monetary cap covers every external model call, including the director.
      if(record.request.maxCost!==undefined){record.status='paused';record.message='供应商尚无可靠的预报价，无法保证费用上限；本次未调用模型。可改用任务数量上限新建制作。';await this.persist(record);return;}
      await this.plan(record,signal);this.checkTaskBudget(record);
      if(record.committedRevision===undefined){
        const queue=record.plan!.flatMap(plan=>[()=>this.visual(record,plan,signal),...(record.request.narration?[()=>this.voice(record,plan,signal)]:[])]);let cursor=0,failed=false;
        const workers=Array.from({length:Math.min(2,queue.length)},async()=>{while(cursor<queue.length&&!failed){signal.throwIfAborted();const operation=queue[cursor++]!;try{await operation();}catch(error){failed=true;throw error;}}});
        const results=await Promise.allSettled(workers);const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failure)throw failure.reason;
        signal.throwIfAborted();await this.updateUsage(record);await this.commit(record,record.adoptionRevision??record.startRevision,record.adoptionRevision!==undefined,signal);
      }
      await this.acknowledge(record);signal.throwIfAborted();await this.review(record,signal);record.status='complete';record.message='协作制作完成，可预览、编辑和导出';delete record.error;await this.persist(record);
    }catch(error){
      for(const step of record.steps)if(step.status==='running'){step.status=signal.aborted?'pending':'failed';this.finishStep(step);}
      const conflict=(error as {code?:string}).code==='REVISION_CONFLICT';record.status=signal.aborted?'paused':conflict&&this.candidatesReady(record)&&record.committedRevision===undefined?'awaiting-apply':'failed';record.error=message(error);
      record.message=record.status==='awaiting-apply'?'工程已变化，候选结果保留，等待明确采用':signal.aborted?'制作已暂停，已完成产物保留':conflict?'工程已变化，已有产物保留；请处理冲突后继续':'制作未完成，可重试失败步骤';await this.persist(record);
    }
  }
  private buildCandidate(record:StoredWorkflow,latest:VideoProject,expectedRevision:number):WorkflowCandidate & {expectedRevision:number}{
    const next=structuredClone(latest),sources:Record<string,SceneSource>={};
    for(const plan of record.plan??[]){
      const shot=next.shots.find(item=>item.id===plan.shotId);if(!shot)throw new Error('目标镜头已删除；生成素材仍保留在任务记录中');
      const visual=this.step(record,record.request.visual,plan.shotId);if(visual.status!=='complete')throw new Error('画面任务尚未完成');
      if(visual.source)sources[shot.id]=visual.source;
      const assets=record.assets?.[visual.id]??[];for(const asset of assets)if(!next.assets.some(item=>item.id===asset.id))next.assets.push(asset);
      for(const asset of assets){if(asset.kind==='image')shot.assetIds=[...new Set([...shot.assetIds,asset.id])];if(asset.kind==='video'){next.videoClips=[...(next.videoClips??[]).filter(clip=>clip.shotId!==shot.id),{id:randomUUID(),shotId:shot.id,assetId:asset.id,trimStart:0,trimEnd:asset.duration,speed:1,fit:'cover',audio:'mute'}];}}
      if(visual.taskId)next.extensions.mediaApplications={...(next.extensions.mediaApplications as object??{}),[visual.taskId]:{assetIds:assets.map(asset=>asset.id),revision:expectedRevision+1}};
      if(record.request.narration){const speech=this.step(record,'speech',plan.shotId),audio=record.assets?.[speech.id]?.[0];if(speech.status!=='complete'||!audio)throw new Error('配音任务尚未完成');if(!next.assets.some(item=>item.id===audio.id))next.assets.push(audio);shot.narration=plan.narration;next.audioClips=[...(next.audioClips??[]).filter(clip=>clip.shotId!==shot.id||clip.role!=='voice'),{id:randomUUID(),assetId:audio.id,shotId:shot.id,role:'voice',startSeconds:0,trimStart:0,volume:1,fadeIn:0,fadeOut:0}];next.target.audioMode='mixed';}
    }
    next.schemaVersion=2;next.extensions.workflowApplications={...(next.extensions.workflowApplications as object??{}),[record.id]:expectedRevision+1};
    fitCandidateAudio(next);
    return {expectedRevision,project:next,sources};
  }
  private async commit(record:StoredWorkflow,expectedRevision:number,explicit:boolean,signal:AbortSignal){
    await this.reconcile(record);if(record.committedRevision!==undefined)return;
    const latest=(await this.port.snapshot(record.projectId)).project!;
    if(latest.revision!==expectedRevision||!explicit&&expectedRevision!==record.startRevision)throw Object.assign(new Error('工程版本冲突；候选结果不会覆盖新修改'),{code:'REVISION_CONFLICT'});
    if(record.candidate?.expectedRevision!==expectedRevision){record.candidate=this.buildCandidate(record,latest,expectedRevision);await this.persist(record);}
    const candidate=record.candidate!;
    // Review the exact durable candidate before changing the project head. A restarted
    // review may reuse its receipt only while this candidate and base revision match.
    await this.review(record,signal,candidate);signal.throwIfAborted();
    if((await this.port.snapshot(record.projectId)).project?.revision!==expectedRevision)throw Object.assign(new Error('工程在候选审片期间已变化；请确认采用最新版本后重新审片'),{code:'REVISION_CONFLICT'});
    const step=this.step(record,'commit');this.beginStep(step);await this.persist(record);
    const saved=await this.port.commit(record.projectId,expectedRevision,candidate.project,candidate.sources,'采用协作制作结果');record.committedRevision=saved.project!.revision;step.status='complete';step.message='结果已保存为工程 v'+record.committedRevision;await this.persist(record);
  }
  private async review(record:StoredWorkflow,signal:AbortSignal,candidate?:WorkflowCandidate){if(!record.request.review)return;
    const step=this.step(record,'review'),candidateHash=candidate?createHash('sha256').update(JSON.stringify(candidate)).digest('hex'):undefined;
    if(step.status==='complete'&&(!candidate||step.reviewCandidateHash===candidateHash))return;
    if(step.status==='complete')step.status='pending';this.beginStep(step);delete step.reviewCandidateHash;delete step.review;await this.persist(record);
    try{const snapshot=await this.port.snapshot(record.projectId),project=candidate?.project??snapshot.project!,baseRevision=candidate?project.revision:record.committedRevision;
      const ensureRevision=async()=>{if((await this.port.snapshot(record.projectId)).project?.revision!==baseRevision)throw Object.assign(new Error('工程在关键帧检查期间已变化，本轮不提交候选结果；请按最新版本重新审片'),{code:'REVISION_CONFLICT'});};
      await ensureRevision();let frame=0;const picks:number[]=[];for(const id of project.shotOrder){const shot=project.shots.find(item=>item.id===id)!;if(record.plan?.some(plan=>plan.shotId===id))picks.push(frame+Math.floor(shot.durationFrames/2));frame+=shot.durationFrames;}const selected=picks.length<=3?picks:[picks[0]!,picks[Math.floor(picks.length/2)]!,picks.at(-1)!];
      const images=[];step.frameEvidence=[];for(const at of selected){signal.throwIfAborted();await ensureRevision();const image=await this.port.capture(record.projectId,at,signal,candidate?structuredClone(candidate):undefined);await ensureRevision();images.push({bytes:image.bytes,mime:image.mime});step.frameEvidence.push({frame:at,sha256:image.sha256});}
      await ensureRevision();step.review=await this.text(record,step,'vision',JSON.stringify({request:record.request.prompt,revision:project.revision,candidate:!!candidate,frames:selected,instruction:'检查实际候选关键帧的文字可读性、构图和一致性，指出可执行改进。只检查这些帧，不宣称看过完整视频。'}),signal,images);signal.throwIfAborted();await ensureRevision();step.reviewCandidateHash=candidateHash;step.status='complete';step.message='已检查 '+images.length+' 张实际'+(candidate?'候选':'')+'关键帧';await this.persist(record);
    }catch(error){step.status=signal.aborted?'pending':'failed';step.message=message(error);await this.persist(record);throw error;}}
  async apply(id:string,expectedRevision:number){const record=await this.required(id);return this.projectLock(record.projectId,async()=>{
    if(this.stopped)throw new Error('协作服务正在关闭');const finishing=this.running.get(id);if(finishing){if(record.status==='running')throw new Error('制作仍在运行');await finishing.promise;}this.assertProjectIdle(record.projectId,id);
    if(record.status!=='awaiting-apply')throw new Error('此制作没有待采用结果');
    if(!Number.isSafeInteger(expectedRevision)||(await this.port.snapshot(record.projectId)).project?.revision!==expectedRevision)throw Object.assign(new Error('工程版本冲突；请刷新后采用候选结果'),{code:'REVISION_CONFLICT'});
    record.adoptionRevision=expectedRevision;record.status='running';delete record.error;record.message=record.request.review?'按最新版本重新检查候选关键帧':'正在采用候选结果';await this.persist(record);this.start(record);return this.public(record);
  });}
  async dispose(){this.stopped=true;for(const active of this.running.values())active.controller.abort(new Error('应用正在关闭'));await Promise.allSettled([...this.running.values()].map(item=>item.promise));await this.writes;}
}
