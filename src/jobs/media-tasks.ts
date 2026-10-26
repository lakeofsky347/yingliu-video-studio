import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,rename,open,rm,stat,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {cancelVideo,generateImage,getVideo,lookupVideo,submitVideo,type AdapterContext,type AdapterInput} from '../models/adapters/media.ts';
import {downloadArtifact,mediaSignature} from './download.ts';
import type {MediaTask,MediaRequest,MediaRegistryPort,MediaProjectPort,MediaTaskOptions,RemoteJob} from './contracts.ts';

const terminal=new Set(['complete','failed','cancelled']);
const safeId=/^[a-zA-Z0-9_-]{1,100}$/;
function errorText(error:unknown){return error instanceof Error?error.message:String(error);}
function wait(ms:number,signal:AbortSignal):Promise<void>{return new Promise((accept,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);accept();},ms);const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
function imageDimensions(bytes:Uint8Array):{width:number;height:number}|undefined {
  const b=Buffer.from(bytes);const mime=mediaSignature(b);
  if(mime==='image/png'&&b.length>=24)return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
  if(mime==='image/jpeg'){let offset=2;while(offset+9<b.length){if(b[offset]!==255)return;const marker=b[offset+1];offset+=2;if(marker===217||marker===218)break;const length=b.readUInt16BE(offset);if(length<2||offset+length>b.length)return;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return {height:b.readUInt16BE(offset+3),width:b.readUInt16BE(offset+5)};offset+=length;}}
  if(mime==='image/webp'&&b.length>=30){const kind=b.subarray(12,16).toString();if(kind==='VP8X')return {width:1+b.readUIntLE(24,3),height:1+b.readUIntLE(27,3)};if(kind==='VP8 ')return {width:b.readUInt16LE(26)&16383,height:b.readUInt16LE(28)&16383};if(kind==='VP8L'){const bits=b.readUInt32LE(21);return {width:1+(bits&16383),height:1+((bits>>>14)&16383)};}}
}
/** Independent durable jobs. Remote generation and local observation have separate lifetimes. */
export class MediaTaskService {
  private readonly directory:string;private tasks=new Map<string,MediaTask>();private running=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private journal=Promise.resolve();private submissions:Promise<unknown>=Promise.resolve();private initialized?:Promise<void>;private stopped=false;private applying=new Set<string>();private adoptions=new Set<Promise<MediaTask>>();
  constructor(dataDirectory:string,private registry:MediaRegistryPort,private projects:MediaProjectPort,private options:MediaTaskOptions={}){
    this.directory=join(resolve(dataDirectory),'media-tasks');
    registry.setUsageGuard?.((connectionId,modelId)=>this.hasUnfinished(connectionId,modelId));
  }
  async initialize():Promise<void>{return this.initialized??=(async()=>{await mkdir(this.directory,{recursive:true});
    for(const name of await readdir(this.directory)){if(!/^[a-zA-Z0-9_-]{1,100}\.json$/.test(name))continue;
      const task=JSON.parse(await readFile(join(this.directory,name),'utf8')) as MediaTask;
      if(task.version!==1||!safeId.test(task.id)||name!==task.id+'.json'||!task.connection||!task.model||!task.projectId||!Array.isArray(task.files))throw new Error('媒体任务日志格式无效');
      for(const file of task.files)if(!resolve(file.path).startsWith(join(this.directory,task.id)+sep))throw new Error('媒体任务产物路径越界');
      if(task.phase==='applying'){task.phase='ready';task.message='上次采用回执未完成，可重新采用并核对已有结果';}
      this.tasks.set(task.id,task);
    }
  })();}
  private public(task:MediaTask):MediaTask {const copy=structuredClone(task);copy.connection.credentialRef='';delete copy.artifacts;return copy;}
  private async persist(task:MediaTask):Promise<void>{task.updatedAt=new Date().toISOString();const copy=structuredClone(task);const work=this.journal.then(async()=>{const destination=join(this.directory,copy.id+'.json'),temporary=destination+'.tmp-'+randomUUID();try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(copy,null,2)+'\n');await handle.sync();}finally{await handle.close();}await rename(temporary,destination);try{const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}}catch(error){if(!['EINVAL','ENOTSUP','EISDIR','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}finally{await rm(temporary,{force:true});}});this.journal=work.catch(()=>{});await work;this.options.onChange?.(this.public(task));}
  private async required(id:string){await this.initialize();if(!safeId.test(id))throw new Error('媒体任务 ID 无效');const task=this.tasks.get(id);if(!task)throw new Error('媒体任务不存在');return task;}
  async list(projectId?:string):Promise<MediaTask[]>{await this.initialize();return [...this.tasks.values()].filter(task=>!projectId||task.projectId===projectId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(task=>this.public(task));}
  async get(taskId:string):Promise<MediaTask>{return this.public(await this.required(taskId));}
  async hasUnfinished(connectionId:string,modelId?:string):Promise<boolean>{await this.initialize();return [...this.tasks.values()].some(task=>task.connection.id===connectionId&&(!modelId||task.model.id===modelId)&&!terminal.has(task.phase));}
  generate(input:MediaRequest):Promise<MediaTask>{const captured=structuredClone(input);const next=this.submissions.then(()=>this.create(captured));this.submissions=next.then(()=>undefined,()=>undefined);return next;}
  private async create(input:MediaRequest):Promise<MediaTask>{
    await this.initialize();if(this.stopped)throw new Error('媒体任务服务正在关闭');
    if(!input||!['text-to-image','text-to-video','image-to-video'].includes(input.operation)||typeof input.projectId!=='string'||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000)throw new Error('请填写有效的工程、生成类型和提示词');
    if(input.clientRequestId!==undefined){
      if(typeof input.clientRequestId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(input.clientRequestId))throw new Error('稳定生成请求 ID 无效');
      const existing=[...this.tasks.values()].find(task=>task.clientRequestId===input.clientRequestId);
      if(existing){const changed=existing.projectId!==input.projectId||existing.shotId!==input.shotId||existing.operation!==input.operation||existing.prompt!==input.prompt.trim()||input.modelId!==undefined&&existing.model.id!==input.modelId||input.connectionId!==undefined&&existing.connection.id!==input.connectionId||JSON.stringify(existing.imageAssetIds)!==JSON.stringify(input.imageAssetIds??[])||Object.entries(input.parameters??{}).some(([key,value])=>existing.parameters[key]!==value)||input.ownerSessionId!==undefined&&existing.ownerSessionId!==input.ownerSessionId;
        if(changed)throw new Error('稳定请求 ID 已用于不同的生成内容或工程');return this.public(existing);
      }
    }
    const project=await this.projects.inspect(input.projectId);if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision!==project.revision)throw Object.assign(new Error('工程版本已变化，请刷新后生成'),{code:'REVISION_CONFLICT'});
    if(input.shotId&&!project.shotIds.includes(input.shotId))throw new Error('生成目标镜头不存在');
    const resolved=await this.registry.resolve({role:input.operation==='text-to-image'?'image':'video',...(input.modelId?{modelId:input.modelId}:{}),...(input.connectionId?{connectionId:input.connectionId}:{})});
    const release=this.registry.acquire?.(resolved.connection.id,resolved.model.id);try {
    const output=input.operation==='text-to-image'?'image':'video';if(resolved.connection.protocol!==(output==='image'?'images':'video-gateway')||!resolved.model.outputModalities.includes(output))throw new Error('所选模型不支持此生成操作');
    if(!resolved.model.inputModalities.includes('text'))throw new Error('所选模型不支持文字提示输入');
    if(input.operation==='image-to-video'&&!resolved.model.inputModalities.includes('image'))throw new Error('所选模型不支持图片输入');
    // Resolve now to reject unavailable credentials before registering work. Resolve again per HTTP operation.
    await this.registry.credential(resolved.connection);
    const ids=input.imageAssetIds??[];if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length||ids.length>3)throw new Error('每次最多选择 3 张不同参考图片');
    if(input.operation==='image-to-video'&&(!input.allowImageUpload||ids.length===0))throw new Error('图生视频需要选择图片并明确允许本次上传');
    if(input.operation!=='image-to-video'&&ids.length)throw new Error('此操作不支持参考图片');
    const allowed=output==='image'?['size','quality','style','response_format','background','output_format','n']:['durationSeconds','width','height','fps','aspectRatio','seed','negativePrompt'];
    if(input.parameters&&Object.keys(input.parameters).some(key=>!allowed.includes(key)))throw new Error('请求包含当前协议不支持的生成参数');
    const parameters:Record<string,string|number|boolean>={};for(const [key,value]of Object.entries({...resolved.model.parameters,...input.parameters})){if(!allowed.includes(key))continue;if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value)||typeof value==='string'&&value.length>4000)throw new Error('生成参数无效：'+key);parameters[key]=value;}
    if(output==='image'){for(const [key,value]of Object.entries(parameters))if(key!=='n'&&typeof value!=='string')throw new Error('生图参数须为文本：'+key);if(parameters.n!==undefined&&(!Number.isSafeInteger(parameters.n)||Number(parameters.n)<1||Number(parameters.n)>4))throw new Error('每次生图数量须为 1–4');}
    if(parameters.negativePrompt!==undefined&&typeof parameters.negativePrompt!=='string')throw new Error('负向提示须为文本');
    for(const key of ['width','height','seed'])if(parameters[key]!==undefined&&!Number.isSafeInteger(parameters[key]))throw new Error('生成参数须为整数：'+key);
    if(parameters.aspectRatio!==undefined&&(typeof parameters.aspectRatio!=='string'||parameters.aspectRatio.length>32))throw new Error('画面比例参数无效');
    for(const [key,limitKey]of [['durationSeconds','maxDurationSeconds'],['width','maxWidth'],['height','maxHeight'],['fps','maxFps']] as const){const value=parameters[key],hardLimit={durationSeconds:120,width:8192,height:8192,fps:120}[key],configured=resolved.model.parameters[limitKey];if(configured!==undefined&&(typeof configured!=='number'||!Number.isFinite(configured)||configured<=0))throw new Error('模型参数上限无效：'+limitKey);const limit=Math.min(hardLimit,typeof configured==='number'?configured:hardLimit);if(value!==undefined&&(typeof value!=='number'||value<=0||value>limit))throw new Error('生成参数超过模型范围：'+key);}
    const now=new Date().toISOString(),task:MediaTask={version:1,id:randomUUID(),clientRequestId:input.clientRequestId??randomUUID(),projectId:input.projectId,...(input.shotId?{shotId:input.shotId}:{}),startRevision:project.revision,operation:input.operation,prompt:input.prompt.trim(),imageAssetIds:[...ids],inputHashes:[],connection:structuredClone(resolved.connection),model:structuredClone(resolved.model),parameters,phase:'pending',observation:'active',progress:0,message:'等待生成',createdAt:now,updatedAt:now,files:[],resumeOnStart:true,...(input.ownerSessionId?{ownerSessionId:input.ownerSessionId}:{})};
    await this.inputs(task,false);this.tasks.set(task.id,task);try{await this.persist(task);}catch(error){this.tasks.delete(task.id);throw error;}this.schedule();return this.public(task);
    }finally{release?.();}
  }
  private async inputs(task:MediaTask,verify=true):Promise<AdapterInput['inputs']>{let total=0;const inputs:AdapterInput['inputs']=[],hashes:MediaTask['inputHashes']=[];
    for(const assetId of task.imageAssetIds){const image=await this.projects.readImage(task.projectId,assetId,task.shotId);total+=image.bytes.byteLength;const mime=mediaSignature(image.bytes),dimensions=imageDimensions(image.bytes);if(total>6*1024*1024||!dimensions||dimensions.width<1||dimensions.height<1||Math.max(dimensions.width,dimensions.height)>4096||dimensions.width*dimensions.height>16_777_216||mime!==image.mime||!mime?.startsWith('image/'))throw new Error('参考图片格式、像素尺寸或总大小超出限制');
      const sha256=createHash('sha256').update(image.bytes).digest('hex');hashes.push({assetId,sha256});inputs.push({type:'image',dataUrl:`data:${mime};base64,${Buffer.from(image.bytes).toString('base64')}`});}
    if(verify&&JSON.stringify(hashes)!==JSON.stringify(task.inputHashes))throw new Error('参考图片已变化，请重新创建生成请求');task.inputHashes=hashes;return inputs;
  }
  private schedule():void {if(this.stopped)return;for(const task of this.tasks.values()){
    if(this.running.size>=(this.options.maxConcurrent??4))break;
    if(this.running.has(task.id)||task.observation!=='active'||terminal.has(task.phase)||['ready','applying','unknown'].includes(task.phase))continue;
    const active=[...this.running.keys()].filter(id=>this.tasks.get(id)?.connection.id===task.connection.id).length;if(active>=Math.max(1,task.connection.concurrency??2))continue;
    const controller=new AbortController();const promise=Promise.resolve().then(()=>this.run(task,controller.signal)).finally(()=>{this.running.delete(task.id);this.schedule();});this.running.set(task.id,{controller,promise});void promise.catch(()=>{});
  }}
  private async context(task:MediaTask,signal:AbortSignal):Promise<AdapterContext>{return {connection:task.connection,key:await this.registry.credential(task.connection),signal,fetch:this.options.fetch};}
  private applyRemote(task:MediaTask,remote:RemoteJob):void {task.remoteJobId=remote.jobId;task.remoteStatus=remote.status;task.progress=remote.progress??task.progress;task.usage=remote.usage??task.usage;task.artifacts=remote.artifacts??task.artifacts;
    if(remote.status==='failed'){task.phase='failed';task.message='远程生成失败';task.error='远程生成失败，请检查服务端任务记录';}
    else if(remote.status==='cancelled'){task.phase='cancelled';task.message='云端已确认取消';}
    else if(remote.status==='succeeded'){task.metrics??={};task.metrics.remoteCompletedAt??=new Date().toISOString();if(task.metrics.submittedAt)task.metrics.generationMs=Date.parse(task.metrics.remoteCompletedAt)-Date.parse(task.metrics.submittedAt);task.phase='downloading';task.message='生成完成，正在获取素材';}
    else {task.phase=remote.status;task.message=remote.status==='queued'?'云端排队中':'云端生成中';}
  }
  private async run(task:MediaTask,signal:AbortSignal):Promise<void>{try{
    signal.throwIfAborted();let remote:RemoteJob|null=null;
    if(task.phase==='pending'){
      const inputs=await this.inputs(task),context=await this.context(task,signal);task.phase='submitting';task.metrics??={};task.metrics.submittedAt??=new Date().toISOString();task.message='正在提交生成请求';await this.persist(task);signal.throwIfAborted();
      const input:AdapterInput={clientRequestId:task.clientRequestId,model:task.model,operation:task.operation,prompt:task.prompt,inputs,parameters:task.parameters};
      remote=task.operation==='text-to-image'?await generateImage(context,input):await submitVideo(context,input);
      this.applyRemote(task,remote);await this.persist(task);
    }else if(task.operation!=='text-to-image'){
      remote=task.remoteJobId?await getVideo(await this.context(task,signal),task.remoteJobId):await lookupVideo(await this.context(task,signal),task.clientRequestId);
      if(!remote){task.phase='unknown';task.observation='paused';task.message='未查到提交结果；没有重新发起计费请求';await this.persist(task);return;}this.applyRemote(task,remote);await this.persist(task);
    }else if(!task.artifacts?.length){task.phase='unknown';task.observation='paused';task.message='生图提交结果未确认，兼容接口不支持查单；请核对服务记录';await this.persist(task);return;}
    while(task.remoteStatus==='queued'||task.remoteStatus==='running'){
      await wait(this.options.pollIntervalMs??1500,signal);remote=await getVideo(await this.context(task,signal),task.remoteJobId!);this.applyRemote(task,remote);await this.persist(task);
    }
    signal.throwIfAborted();if(task.remoteStatus!=='succeeded')return;
    let total=0;const files=[];for(let index=0;index<(task.artifacts?.length??0);index++){
      task.phase='downloading';task.message='下载生成素材 '+(index+1);await this.persist(task);
      const file=await downloadArtifact(task.artifacts![index]!,join(this.directory,task.id),index,{signal,fetch:this.options.fetch,maxBytes:Math.min(this.options.maxArtifactBytes??512*1024*1024,(this.options.maxTaskBytes??1024*1024*1024)-total),expected:task.operation==='text-to-image'?'image':'video'});total+=file.bytes;
      task.phase='validating';task.message='检查真实媒体格式';await this.persist(task);const metadata=await this.projects.validateArtifact(file.path,file.mimeType,task.projectId,signal);signal.throwIfAborted();files.push({...file,metadata});
    }
    if(!files.length)throw new Error('生成结果没有可采用素材');task.files=files;task.metrics??={};task.metrics.readyAt=new Date().toISOString();task.metrics.downloadBytes=total;if(task.metrics.remoteCompletedAt)task.metrics.downloadMs=Date.parse(task.metrics.readyAt)-Date.parse(task.metrics.remoteCompletedAt);task.phase='ready';task.progress=1;task.message='素材已就绪，等待采用';task.observation='paused';delete task.error;await this.persist(task);
  }catch(error){
    task.observation='paused';task.error=await this.redact(task,errorText(error));if(signal.aborted){task.message='已停止本地等待，云端状态以查询结果为准';}
    else if(task.phase==='submitting'){task.phase='unknown';task.message='提交结果待确认；没有重新提交';}
    else {task.message=task.remoteStatus==='succeeded'?'素材获取或检查失败，可重试获取':'任务已暂停，可恢复查询';}
    await this.persist(task);
  }}
  private async redact(task:MediaTask,value:string):Promise<string>{try{const key=await this.registry.credential(task.connection);return (key?value.split(key).join('[redacted]'):value).slice(0,2000);}catch{return value.slice(0,2000);}}
  async recover():Promise<void>{await this.initialize();for(const task of this.tasks.values())if(task.resumeOnStart!==false&&!terminal.has(task.phase)&&!['ready','applying'].includes(task.phase)){task.observation='active';if(task.phase==='unknown')task.phase='submitting';}this.schedule();}
  async retry(taskId:string):Promise<MediaTask>{const task=await this.required(taskId);if(this.stopped)throw new Error('媒体任务服务正在关闭');const finishing=this.running.get(taskId);if(finishing){if(task.observation==='active')return this.public(task);await finishing.promise;}if(terminal.has(task.phase))throw new Error('已结束的生成不能重投；如需新结果请明确新建生成任务');if(task.phase==='ready')return this.public(task);task.observation='active';task.resumeOnStart=true;if(task.phase==='unknown')task.phase='submitting';delete task.error;task.message='恢复查询或素材获取';await this.persist(task);this.schedule();return this.public(task);}
  async pause(taskId:string):Promise<MediaTask>{const task=await this.required(taskId);task.observation='paused';task.resumeOnStart=false;const running=this.running.get(taskId);running?.controller.abort(new Error('用户已停止本地等待'));await running?.promise;task.message=terminal.has(task.phase)||task.phase==='ready'?task.message:'已停止本地等待，云端任务可能仍在执行';await this.persist(task);return this.public(task);}
  async cancel(taskId:string):Promise<MediaTask>{const task=await this.required(taskId);await this.pause(taskId);if(task.remoteStatus==='succeeded'||terminal.has(task.phase)||task.phase==='ready')return this.public(task);
    task.cancelRequested=true;if(task.phase==='pending'&&!task.remoteJobId){task.phase='cancelled';task.message='已取消尚未提交的本地任务';await this.persist(task);return this.public(task);}if(task.operation==='text-to-image'||!task.remoteJobId||task.model.parameters.supportsCancel===false){task.message='已停止等待；此任务尚不能确认云端取消';await this.persist(task);return this.public(task);}
    try{const remote=await cancelVideo(await this.context(task,new AbortController().signal),task.remoteJobId);this.applyRemote(task,remote);task.message=remote.status==='cancelled'?'云端已确认取消':remote.status==='succeeded'?'云端已完成，可恢复获取素材':'已请求云端取消，尚未确认';}
    catch(error){task.error=await this.redact(task,errorText(error));task.message='云端取消未确认；可恢复查询';}await this.persist(task);return this.public(task);
  }
  /** Trusted host-only staging hook; never expose raw paths as client apply inputs. */
  async prepare(taskId:string):Promise<MediaTask['files']>{const task=await this.required(taskId);if(!['ready','complete'].includes(task.phase))throw new Error('生成素材尚未就绪');
      for(const file of task.files){const actual=await realpath(file.path),base=await realpath(join(this.directory,task.id));if(!actual.startsWith(base+sep))throw new Error('生成素材路径越界');const info=await stat(actual);if(!info.isFile()||info.size!==file.bytes)throw new Error('生成素材已变化');const hash=createHash('sha256');for await(const chunk of createReadStream(actual))hash.update(chunk);if(hash.digest('hex')!==file.sha256)throw new Error('生成素材校验失败');await this.projects.validateArtifact(actual,file.mimeType,task.projectId);}
    return structuredClone(task.files);
  }
  apply(taskId:string,expectedRevision:number):Promise<MediaTask>{if(this.stopped)return Promise.reject(new Error('媒体任务服务正在关闭'));const work=this.applyTask(taskId,expectedRevision);this.adoptions.add(work);void work.finally(()=>this.adoptions.delete(work)).catch(()=>{});return work;}
  private async applyTask(taskId:string,expectedRevision:number):Promise<MediaTask>{const task=await this.required(taskId);if(task.phase==='complete')return this.public(task);if(task.phase!=='ready'||this.applying.has(taskId))throw new Error('素材尚未就绪或正在采用');if(!Number.isSafeInteger(expectedRevision))throw new Error('采用素材需要当前工程版本');
    this.applying.add(taskId);try{const project=await this.projects.inspect(task.projectId);if(project.revision!==expectedRevision)throw Object.assign(new Error('工程版本已变化，生成素材仍保留为待采用'),{code:'REVISION_CONFLICT'});if(task.shotId&&!project.shotIds.includes(task.shotId))throw new Error('目标镜头已删除，生成素材仍保留；可复制或重新关联镜头后采用');
      await this.prepare(taskId);
      task.phase='applying';task.message='正在采用生成素材';await this.persist(task);task.applied=await this.projects.applyResult({projectId:task.projectId,shotId:task.shotId,expectedRevision,files:structuredClone(task.files),provenance:{taskId:task.id,connectionId:task.connection.id,model:task.model.model,operation:task.operation,prompt:task.prompt,inputHashes:task.inputHashes}});task.phase='complete';task.metrics??={};task.metrics.appliedAt=new Date().toISOString();task.message='素材已采用';delete task.error;await this.persist(task);return this.public(task);
    }catch(error){task.phase='ready';task.error=await this.redact(task,errorText(error));task.message='素材仍可采用，请处理工程冲突或检查错误';await this.persist(task);throw error;}finally{this.applying.delete(taskId);}
  }
  async dispose():Promise<void>{this.stopped=true;await this.submissions;for(const item of this.running.values())item.controller.abort(new Error('应用正在关闭'));await Promise.allSettled([...this.running.values()].map(item=>item.promise));await Promise.allSettled([...this.adoptions]);await this.journal;}
}
