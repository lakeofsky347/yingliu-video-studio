import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createProject,defaultSceneSource} from '../src/core/index.ts';
import {defaultProductionPolicy} from '../src/core/production-policy.ts';
import {WorkflowService} from '../src/workflows/service.ts';
import type {WorkflowPort,WorkflowRecord,WorkflowRequest,WorkflowCandidate} from '../src/workflows/contracts.ts';
import type {Asset,SceneSource,StudioSnapshot,VideoProject} from '../src/shared/types.ts';
import type {MediaTaskService} from '../src/jobs/media-tasks.ts';
import type {MediaRequest,MediaTask} from '../src/jobs/contracts.ts';

const copy=<T>(value:T):T=>structuredClone(value);
async function until<T>(read:()=>Promise<T>,check:(value:T)=>boolean):Promise<T>{for(let n=0;n<1000;n++){const value=await read();if(check(value))return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('workflow did not settle');}
async function settled(service:WorkflowService,id:string){return until(()=>service.get(id),record=>record.status!=='running');}
function block(signal:AbortSignal):Promise<void>{return new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}

async function fixture(t:TestContext,shotCount=2){
  const directory=await mkdtemp(join(tmpdir(),'workflow-contract-'));let project=createProject('原始影片','','code_animation');project.shots=project.shots.slice(0,shotCount);project.shotOrder=project.shots.map(shot=>shot.id);project.shots.forEach(shot=>shot.durationFrames=12);project.target.fps={num:12,den:1};
  project.productionPolicy!.allowGeneratedImages=true;
  const original=copy(project),sources=new Map(project.shots.map(shot=>[shot.id,defaultSceneSource()]));
  const calls={director:0,directorPrompts:[] as string[],scenePrompts:[] as string[],scene:new Map<string,number>(),voice:new Map<string,number>(),vision:[] as {prompt:string;images?:{bytes:Uint8Array;mime:string}[]}[],capture:[] as number[],candidates:[] as WorkflowCandidate[],commit:[] as {project:VideoProject;sources:Record<string,SceneSource>;label:string}[],generate:[] as (MediaRequest&{clientRequestId?:string})[],submissions:0,stage:[] as string[],ack:[] as string[]};
  const hooks={directorResult:undefined as Record<string,unknown>|undefined,visionResult:undefined as string|undefined,stage:undefined as undefined|((task:MediaTask)=>Asset[]),scene:undefined as undefined|((shotId:string,signal:AbortSignal)=>Promise<void>),capture:undefined as undefined|((frame:number)=>void),vision:undefined as undefined|((signal:AbortSignal)=>Promise<void>),loseCommitReceipt:false,failCommit:0,failAck:0};
  const tasks=new Map<string,MediaTask>(),requests=new Map<string,string>();
  const fakeMedia={
    async generate(request:MediaRequest&{clientRequestId?:string}){
      calls.generate.push(copy(request));const prior=request.clientRequestId&&requests.get(request.clientRequestId);if(prior)return copy(tasks.get(prior)!);
      const id='media-'+(++calls.submissions),now=new Date().toISOString();const task:MediaTask={version:1,id,clientRequestId:request.clientRequestId??id,projectId:request.projectId,shotId:request.shotId,startRevision:request.expectedRevision,operation:request.operation,prompt:request.prompt,imageAssetIds:request.imageAssetIds??[],inputHashes:[],connection:{id:'fixture-connection',name:'Local fixture',protocol:'images',baseUrl:'http://127.0.0.1:1',auth:'none',credentialRef:'',enabled:true,revision:1,requestTimeoutMs:1000,concurrency:2},model:{id:'fixture-model',connectionId:'fixture-connection',model:'fixture',name:'Fixture',enabled:true,inputModalities:['text'],outputModalities:['image'],parameters:{}},parameters:{},phase:'ready',observation:'active',progress:1,message:'候选就绪',createdAt:now,updatedAt:now,files:[{path:'/fixture/'+id+'.png',mimeType:'image/png',name:id,bytes:1,sha256:'fixture',metadata:{}}]};
      tasks.set(id,task);if(request.clientRequestId)requests.set(request.clientRequestId,id);return copy(task);
    },
    async get(id:string){assert.ok(tasks.has(id),'expected a known media task');return copy(tasks.get(id)!);},
    async retry(id:string){const task=tasks.get(id)!;task.observation='active';task.phase='ready';return copy(task);},
    async pause(id:string){const task=tasks.get(id)!;task.observation='paused';return copy(task);},
    async prepare(id:string){return copy(tasks.get(id)!.files);},
    async apply(id:string,_revision:number){calls.ack.push(id);if(hooks.failAck-->0)throw new Error('fixture media receipt unavailable');const task=tasks.get(id)!;const receipt=(project.extensions.mediaApplications as Record<string,{assetIds:string[];revision:number}>|undefined)?.[id];assert.ok(receipt,'workflow must commit media provenance before acknowledging');task.phase='complete';task.applied=copy(receipt);return copy(task);},
  };
  const snapshot=()=>({project:copy(project),root:directory,task:null,previewUrl:null,previewRevision:null,providers:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false},recent:[]} satisfies StudioSnapshot);
  const port:WorkflowPort={
    async snapshot(){return snapshot();},async source(_id,shotId){return copy(sources.get(shotId)??defaultSceneSource());},
    async text(role,prompt,signal,_request,images){
      signal.throwIfAborted();const input=JSON.parse(prompt);
      if(role==='director'){calls.director++;calls.directorPrompts.push(prompt);return JSON.stringify(hooks.directorResult??{shots:input.shots.length?input.shots.map((shot:{id:string})=>({shotId:shot.id,prompt:'画面 '+shot.id,narration:'旁白 '+shot.id})):[{title:'新镜头',intent:'解释',prompt:'新画面',narration:'新旁白',durationSeconds:1,params:{text:'新标题'}}]});}
      if(role==='vision'){calls.vision.push({prompt,images:images?copy(images):undefined});await hooks.vision?.(signal);return hooks.visionResult??JSON.stringify({visual:{verdict:'pass',confidence:.95,message:'抽样帧中文字可读。'}});}
      calls.scenePrompts.push(prompt);const shotId=String(input.shot.id);calls.scene.set(shotId,(calls.scene.get(shotId)??0)+1);await hooks.scene?.(shotId,signal);signal.throwIfAborted();return JSON.stringify({html:'<main>'+shotId+'</main>',css:'main{color:white}',js:'export function render(ctx){ctx.root.dataset.frame=String(ctx.localFrame)}'});
    },
    async commit(_id,expectedRevision,next,changed,label){
      if(project.revision!==expectedRevision)throw Object.assign(new Error('fixture revision conflict'),{code:'REVISION_CONFLICT'});
      if(hooks.failCommit-->0)throw new Error('fixture commit failed before write');
      calls.commit.push({project:copy(next),sources:copy(changed),label});project=copy(next);project.revision=expectedRevision+1;for(const [id,source]of Object.entries(changed))sources.set(id,copy(source));
      if(hooks.loseCommitReceipt){hooks.loseCommitReceipt=false;throw new Error('fixture commit response lost after durable commit');}return snapshot();
    },
    async stageMedia(_id,task,_files,signal){signal.throwIfAborted();calls.stage.push(task.id);if(hooks.stage)return hooks.stage(task);return [{id:'asset-'+task.id,kind:'image',name:task.id,description:'test fixture',path:'assets/'+task.id+'.png',mime:'image/png',width:1,height:1}];},
    async voice(_id,shotId,_text,signal){signal.throwIfAborted();calls.voice.set(shotId,(calls.voice.get(shotId)??0)+1);return {id:'voice-'+shotId,kind:'audio',name:'旁白',description:'fixture',path:'assets/voice-'+shotId+'.wav',duration:1,sampleRate:48000,channels:2};},
    async capture(_id,frame,signal,candidate){signal.throwIfAborted();calls.capture.push(frame);if(candidate)calls.candidates.push(copy(candidate));hooks.capture?.(frame);const bytes=Buffer.from('captured pixels at frame '+frame);return {bytes,mime:'image/png',sha256:createHash('sha256').update(bytes).digest('hex')};},
  };
  let service=new WorkflowService(directory,fakeMedia as unknown as MediaTaskService,port);const services=[service];
  t.after(async()=>{for(const value of services)await value.dispose();await rm(directory,{recursive:true,force:true});});
  return {directory,calls,hooks,port,tasks,original,get project(){return project;},set project(value:VideoProject){project=copy(value);},get service(){return service;},async restart(){await service.dispose();service=new WorkflowService(directory,fakeMedia as unknown as MediaTaskService,port);services.push(service);return service;},request(patch:Partial<WorkflowRequest>={}):WorkflowRequest{return {projectId:project.id,expectedRevision:project.revision,prompt:'制作测试影片',visual:'code',narration:false,review:false,allowImageUpload:false,...patch};}};
}

test('director, scene and speech candidates enter an existing project in one commit',async t=>{
  const f=await fixture(t),started=await f.service.run(f.request({narration:true})),done=await settled(f.service,started.id);
  assert.equal(done.status,'complete',done.error);assert.equal(f.calls.director,1);assert.equal(f.calls.commit.length,1);assert.equal(f.calls.scene.size,2);assert.equal(f.calls.voice.size,2);assert.equal(f.project.revision,1);assert.equal(f.project.audioClips?.length,2);assert.deepEqual(f.project.shots.map(shot=>shot.id),f.original.shots.map(shot=>shot.id));assert.equal(Object.keys(f.calls.commit[0]!.sources).length,2);
});

test('retry regenerates only failed scene work and preserves completed speech and sources',async t=>{
  const f=await fixture(t),failedId=f.project.shots[1]!.id;let fail=true;f.hooks.scene=async id=>{if(id===failedId&&fail){fail=false;throw new Error('fixture scene failure');}};
  const started=await f.service.run(f.request({narration:true}));assert.equal((await settled(f.service,started.id)).status,'failed');assert.equal(f.calls.commit.length,0);
  const completed=(await f.service.get(started.id)).steps.filter(step=>step.status==='complete');await f.service.retry(started.id);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.director,1);assert.equal(f.calls.scene.get(f.project.shots[0]!.id),1);assert.equal(f.calls.scene.get(failedId),2);assert.equal(f.calls.commit.length,1);for(const step of completed)assert.equal(done.steps.find(item=>item.id===step.id)?.status,'complete');
});

test('CAS conflict keeps candidates pending and explicit adoption preserves newer project metadata',async t=>{
  const f=await fixture(t);let edited=false;f.hooks.scene=async()=>{if(!edited){edited=true;f.project={...f.project,title:'用户的新标题',revision:1};}};
  const started=await f.service.run(f.request()),pending=await settled(f.service,started.id);assert.equal(pending.status,'awaiting-apply');assert.equal(f.calls.commit.length,0);assert.equal(f.project.title,'用户的新标题');
  await assert.rejects(f.service.apply(started.id,0),/冲突/);await f.service.apply(started.id,1);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.commit.length,1);assert.equal(f.project.title,'用户的新标题');assert.equal(f.project.revision,2);assert.equal(f.calls.director,1);assert.ok([...f.calls.scene.values()].every(count=>count===1));
});

test('pause and process restart reuse completed scene output without another director request',async t=>{
  const f=await fixture(t),blocked=f.project.shots[1]!.id;f.hooks.scene=async(id,signal)=>{if(id===blocked)await block(signal);};
  const started=await f.service.run(f.request());await until(()=>f.service.get(started.id),record=>record.steps.some(step=>step.kind==='code'&&step.shotId!==blocked&&step.status==='complete')&&record.steps.some(step=>step.kind==='code'&&step.shotId===blocked&&step.status==='running'));
  const paused=await f.service.pause(started.id);assert.equal(paused.status,'paused');assert.equal(f.calls.commit.length,0);await f.restart();assert.equal((await f.service.get(started.id)).status,'paused');f.hooks.scene=undefined;
  await f.service.retry(started.id);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.director,1);assert.equal(f.calls.scene.get(f.project.shots[0]!.id),1);assert.equal(f.calls.scene.get(blocked),2);assert.equal(f.calls.commit.length,1);
});

test('review requires upload consent and forwards captured bytes with verifiable frame receipts',async t=>{
  const f=await fixture(t);await assert.rejects(f.service.run(f.request({review:true})),/允许/);assert.equal(f.calls.director,0);
  f.hooks.vision=async()=>{assert.equal(f.calls.commit.length,0,'candidate review precedes the only final commit');assert.equal(f.project.revision,f.original.revision);};
  const started=await f.service.run(f.request({review:true,allowImageUpload:true})),done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.deepEqual(f.calls.capture,[6,18]);assert.equal(f.calls.vision.length,1);
  const review=done.steps.find(step=>step.kind==='review')!;assert.equal(review.frameEvidence?.length,2);f.calls.vision[0]!.images!.forEach((image,index)=>{assert.equal(Buffer.from(image.bytes).toString(),'captured pixels at frame '+f.calls.capture[index]);assert.equal(review.frameEvidence![index]!.sha256,createHash('sha256').update(image.bytes).digest('hex'));});
  assert.equal(f.calls.candidates.length,2);assert.deepEqual(f.calls.candidates[0]!.project,f.calls.commit[0]!.project);assert.deepEqual(f.calls.candidates[0]!.sources,f.calls.commit[0]!.sources);assert.ok(review.reviewCandidateHash);
});

test('review refuses mixed revisions when a user edits between frame captures',async t=>{
  const f=await fixture(t);f.hooks.capture=()=>{if(f.calls.capture.length===1)f.project={...f.project,revision:f.project.revision+1};};
  const started=await f.service.run(f.request({review:true,allowImageUpload:true})),done=await settled(f.service,started.id);assert.equal(done.status,'awaiting-apply');assert.equal(f.calls.vision.length,0,'mixed-version screenshots must never be described as one reviewed revision');assert.equal(f.calls.commit.length,0);
});

test('unknown monetary budget pauses before text, media or an empty-project initialization',async t=>{
  const f=await fixture(t,0),started=await f.service.run(f.request({visual:'image',maxCost:1})),paused=await settled(f.service,started.id);assert.equal(paused.status,'paused');assert.equal(f.calls.director,0);assert.equal(f.calls.generate.length,0);assert.equal(f.calls.commit.length,0);assert.equal(paused.usage.cost,null);
  await f.service.retry(started.id);assert.equal((await settled(f.service,started.id)).status,'paused');assert.equal(f.calls.director,0);assert.equal(f.calls.commit.length,0);
});

test('task budget is enforced before empty-project initialization and cannot be bypassed by retry',async t=>{
  const f=await fixture(t,0),started=await f.service.run(f.request({maxTasks:1}));assert.equal((await settled(f.service,started.id)).status,'failed');assert.equal(f.calls.commit.length,0);assert.equal(f.calls.scene.size,0);
  await f.service.retry(started.id);assert.equal((await settled(f.service,started.id)).status,'failed');assert.equal(f.calls.commit.length,0);assert.equal(f.calls.scene.size,0);
});

test('media candidates are committed together and repeated completion does not regenerate or reapply',async t=>{
  const f=await fixture(t),started=await f.service.run(f.request({visual:'image'})),done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.submissions,2);assert.equal(f.calls.commit.length,1);assert.equal(f.project.assets.length,2);assert.equal(f.calls.ack.length,2);
  await f.service.retry(started.id);await f.restart();await f.service.retry(started.id);assert.equal(f.calls.submissions,2);assert.equal(f.calls.commit.length,1);assert.equal(f.project.assets.length,2);assert.equal(f.calls.ack.length,2);
});

test('a media acknowledgement failure retries acknowledgement without another project commit',async t=>{
  const f=await fixture(t);f.hooks.failAck=1;const started=await f.service.run(f.request({visual:'image'}));assert.equal((await settled(f.service,started.id)).status,'failed');assert.equal(f.calls.commit.length,1);
  await f.service.retry(started.id);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.commit.length,1);assert.equal(f.calls.submissions,2);assert.ok([...f.tasks.values()].every(task=>task.phase==='complete'),'every durable candidate must receive its committed receipt');
});

test('a lost durable commit response is reconciled from workflowApplications after restart',async t=>{
  const f=await fixture(t);f.hooks.loseCommitReceipt=true;const started=await f.service.run(f.request({visual:'image'}));assert.equal((await settled(f.service,started.id)).status,'failed');assert.equal(f.calls.commit.length,1);assert.equal((f.project.extensions.workflowApplications as Record<string,number>)[started.id],1);
  await f.restart();await f.service.retry(started.id);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(done.committedRevision,1);assert.equal(f.calls.commit.length,1);assert.equal(f.project.assets.length,2);assert.ok([...f.tasks.values()].every(task=>task.phase==='complete'));
});

test('same-project concurrent submissions permit only one running workflow',async t=>{
  const f=await fixture(t);f.hooks.scene=async(_id,signal)=>block(signal);const results=await Promise.allSettled([f.service.run(f.request()),f.service.run(f.request())]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((await f.service.list(f.project.id)).filter(record=>record.status==='running').length,1);
});

test('a paused old workflow cannot resume alongside a new running workflow on the same project',async t=>{
  const f=await fixture(t);f.hooks.scene=async(_id,signal)=>block(signal);const old=await f.service.run(f.request());await until(()=>f.service.get(old.id),record=>record.steps.some(step=>step.kind==='code'&&step.status==='running'));await f.service.pause(old.id);
  const next=await f.service.run(f.request());await assert.rejects(f.service.retry(old.id),/运行|制作|已有/);assert.equal((await f.service.get(old.id)).status,'paused');assert.equal((await f.service.get(next.id)).status,'running');
});

test('lost workflow linkage reuses a stable media request identity instead of another paid submission',async t=>{
  const f=await fixture(t,1),started=await f.service.run(f.request({visual:'image'}));assert.equal((await settled(f.service,started.id)).status,'complete');assert.ok(f.calls.generate[0]!.clientRequestId,'workflow must supply a durable, stable media clientRequestId');
  await f.service.dispose();const path=join(f.directory,'workflows',started.id+'.json'),record=JSON.parse(await readFile(path,'utf8'));
  record.status='running';delete record.committedRevision;record.steps=record.steps.filter((step:{kind:string})=>step.kind!=='commit');const visual=record.steps.find((step:{kind:string})=>step.kind==='image');visual.status='running';delete visual.taskId;delete visual.assetIds;record.assets={};
  await writeFile(path,JSON.stringify(record));f.project=f.original;for(const task of f.tasks.values()){task.phase='ready';delete task.applied;}await f.restart();await f.service.retry(started.id);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.submissions,1,'recovery must reuse remote submission identity');assert.equal(f.calls.generate[0]!.clientRequestId,f.calls.generate.at(-1)!.clientRequestId);assert.equal(f.project.assets.length,1);
});


test('step and model-call timings are recorded once and preserved for reused results',async t=>{
  const f=await fixture(t);let failed=false;const second=f.project.shots[1]!.id;
  f.hooks.scene=async id=>{await new Promise(resolve=>setTimeout(resolve,8));if(id===second&&!failed){failed=true;throw new Error('timed synthetic failure');}};
  const started=await f.service.run(f.request({review:true,allowImageUpload:true}));assert.equal((await settled(f.service,started.id)).status,'failed');
  const first=(await f.service.get(started.id)).steps.find(step=>step.kind==='code'&&step.shotId!==second)!;assert.equal(first.status,'complete');const firstTiming=copy(first);
  await f.service.retry(started.id);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);
  assert.deepEqual(done.steps.find(step=>step.id===first.id),firstTiming,'reused source must retain its original timing');
  for(const step of done.steps){assert.ok(step.startedAt,step.kind+' start');assert.ok(step.finishedAt,step.kind+' finish');assert.ok(typeof step.durationMs==='number'&&step.durationMs>=0,step.kind+' duration');}
  const modelCalls=done.steps.flatMap(step=>step.modelCalls??[]);assert.equal(modelCalls.filter(call=>call.role==='director').length,1);assert.equal(modelCalls.filter(call=>call.role==='scene').length,3);assert.equal(modelCalls.filter(call=>call.role==='vision').length,1);
  for(const call of modelCalls){assert.ok(call.startedAt&&call.finishedAt);assert.ok(typeof call.durationMs==='number'&&call.durationMs>=0);}
  assert.equal(modelCalls.filter(call=>call.status==='failed').length,1);assert.equal(done.usage.cost,null);
});

test('known speech preflight failure can retry without regenerating completed scenes',async t=>{
  const f=await fixture(t,1),voice=f.port.voice;let attempts=0;
  f.port.voice=async(...args)=>{if(++attempts===1)throw Object.assign(new Error('配音凭据尚未配置'),{submissionUncertain:false});return voice(...args);};
  const started=await f.service.run(f.request({narration:true}));const failed=await settled(f.service,started.id);assert.equal(failed.status,'failed');assert.equal(failed.steps.find(step=>step.kind==='speech')?.submissionUncertain,false);
  await f.service.retry(started.id);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(attempts,2);assert.equal(f.calls.director,1);assert.equal(f.calls.scene.get(f.project.shots[0]!.id),1);
});

test('unknown speech submission failure is never automatically submitted again',async t=>{
  const f=await fixture(t,1);let attempts=0;f.port.voice=async()=>{attempts++;throw new Error('连接在提交后中断');};
  const started=await f.service.run(f.request({narration:true}));const failed=await settled(f.service,started.id);assert.equal(failed.status,'failed');assert.equal(failed.steps.find(step=>step.kind==='speech')?.submissionUncertain,true);
  await f.service.retry(started.id);const retried=await settled(f.service,started.id);assert.equal(retried.status,'failed');assert.match(retried.error??'',/结果待确认/);assert.equal(attempts,1);assert.equal(f.calls.commit.length,0);
});

test('failed candidate vision never commits; retry reuses staged assets and completed generation',async t=>{
  const f=await fixture(t,1);let fail=true;
  f.hooks.vision=async()=>{assert.equal(f.calls.commit.length,0);if(fail){fail=false;throw new Error('fixture vision unavailable');}};
  const started=await f.service.run(f.request({visual:'image',review:true,allowImageUpload:true})),failed=await settled(f.service,started.id);
  assert.equal(failed.status,'failed');assert.equal(f.calls.commit.length,0);assert.equal(f.project.assets.length,0);assert.equal(f.calls.ack.length,0);assert.equal(f.calls.submissions,1);
  assert.equal(f.calls.candidates[0]!.project.assets.length,1,'capture must contain the staged generated asset');
  await f.service.retry(started.id);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.submissions,1);assert.equal(f.calls.stage.length,1);assert.equal(f.calls.vision.length,2);assert.equal(f.calls.commit.length,1);assert.equal(f.project.assets.length,1);
});

test('adopting a newer revision rebuilds and re-reviews the exact candidate before commit',async t=>{
  const f=await fixture(t,1);let edited=false;
  f.hooks.vision=async()=>{if(!edited){edited=true;f.project={...f.project,title:'用户审片中改的标题',revision:1};}};
  const started=await f.service.run(f.request({review:true,allowImageUpload:true})),pending=await settled(f.service,started.id);
  assert.equal(pending.status,'awaiting-apply');assert.equal(f.calls.commit.length,0);assert.equal(f.calls.vision.length,1);
  await f.service.apply(started.id,1);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.vision.length,2);assert.equal(f.calls.director,1);assert.ok([...f.calls.scene.values()].every(count=>count===1));
  const candidate=f.calls.candidates.at(-1)!;assert.equal(candidate.project.title,'用户审片中改的标题');assert.equal(candidate.project.revision,1);assert.deepEqual(candidate.project,f.calls.commit[0]!.project);assert.deepEqual(candidate.sources,f.calls.commit[0]!.sources);assert.equal(f.project.revision,2);
});

test('review receipts survive a precommit failure and process restart without another vision charge',async t=>{
  const f=await fixture(t,1);f.hooks.failCommit=1;
  const started=await f.service.run(f.request({review:true,allowImageUpload:true})),failed=await settled(f.service,started.id);
  assert.equal(failed.status,'failed');assert.equal(f.calls.commit.length,0);assert.equal(f.calls.vision.length,1);assert.equal(failed.steps.find(step=>step.kind==='review')?.status,'complete');
  await f.restart();await f.service.retry(started.id);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.vision.length,1);assert.equal(f.calls.capture.length,1);assert.equal(f.calls.commit.length,1);
});

test('pausing candidate review preserves the project head and completed generation',async t=>{
  const f=await fixture(t,1);f.hooks.vision=async signal=>block(signal);
  const started=await f.service.run(f.request({review:true,allowImageUpload:true}));await until(()=>f.service.get(started.id),record=>record.steps.some(step=>step.kind==='review'&&step.modelCalls?.some(call=>call.status==='running')));
  const paused=await f.service.pause(started.id);assert.equal(paused.status,'paused');assert.equal(f.calls.commit.length,0);assert.equal(f.project.revision,0);
  f.hooks.vision=undefined;await f.service.retry(started.id);const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.director,1);assert.ok([...f.calls.scene.values()].every(count=>count===1));assert.equal(f.calls.commit.length,1);
});

test('long speech is fitted before candidate capture so review and commit use identical timing',async t=>{
  const f=await fixture(t,1),voice=f.port.voice;f.port.voice=async(...args)=>({...await voice(...args),duration:2});
  const started=await f.service.run(f.request({narration:true,review:true,allowImageUpload:true})),done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);
  assert.equal(f.original.shots[0]!.durationFrames,12);assert.equal(f.calls.candidates[0]!.project.shots[0]!.durationFrames,27);assert.deepEqual(f.calls.capture,[13]);assert.equal(f.project.shots[0]!.durationFrames,27);assert.deepEqual(f.calls.candidates[0]!.project,f.calls.commit[0]!.project);
});

test('locked shot duration refuses overlong speech before review or commit',async t=>{
  const f=await fixture(t,1),voice=f.port.voice;f.project={...f.project,extensions:{...f.project.extensions,lockDuration:true}};f.port.voice=async(...args)=>({...await voice(...args),duration:2});
  const started=await f.service.run(f.request({narration:true,review:true,allowImageUpload:true})),done=await settled(f.service,started.id);assert.equal(done.status,'failed');assert.match(done.error??'',/时长/);assert.equal(f.calls.capture.length,0);assert.equal(f.calls.vision.length,0);assert.equal(f.calls.commit.length,0);assert.equal(f.project.revision,0);assert.equal(f.project.shots[0]!.durationFrames,12);
});

function useVideo(f:Awaited<ReturnType<typeof fixture>>,duration=1){
  const p=f.project;p.productionPolicy=defaultProductionPolicy('model_video');p.shots.forEach(s=>{s.visual={kind:'model_video'};});f.project=p;
  f.hooks.stage=task=>[{id:'asset-'+task.id,kind:'video',name:'原生视频',description:'fixture',path:'assets/'+task.id+'.mp4',mime:'video/mp4',width:640,height:360,duration,fps:{num:12,den:1},frameCount:Math.round(duration*12),hasAudio:true,provenance:{origin:'model_generation',usage:'production'}}];
}

test('code-only production refuses a video workflow before any external request',async t=>{const f=await fixture(t);await assert.rejects(f.service.run(f.request({visual:'video'})),/模式|视频/);assert.equal(f.calls.director,0);assert.equal(f.calls.submissions,0);});

test('video workflow generates no scene code, preserves native audio and requires exact-candidate review',async t=>{
  const f=await fixture(t,1);useVideo(f);const started=await f.service.run(f.request({visual:'video',review:true,allowImageUpload:true}));const pending=await settled(f.service,started.id);
  assert.equal(pending.status,'awaiting-apply',pending.error);assert.equal(f.calls.scene.size,0);assert.equal(f.calls.voice.size,0);assert.equal(f.calls.commit.length,0);assert.equal(pending.qualityReport?.decision,'needs-review');const preview=await f.service.reviewCandidate(started.id);assert.equal(preview.qualityReport.candidateHash,pending.qualityReport!.candidateHash);preview.candidate.project.title='mutated caller copy';assert.notEqual((await f.service.reviewCandidate(started.id)).candidate.project.title,'mutated caller copy');assert.equal(pending.qualityReport?.checks.find(c=>c.id==='sampled-frames')?.status,'pass');assert.equal(pending.qualityReport?.checks.find(c=>c.category==='timing')?.status,'unchecked');
  assert.equal(f.calls.candidates[0]!.project.videoClips![0]!.audio,'keep');assert.deepEqual(f.calls.candidates[0]!.sources,{});assert.equal(JSON.parse(f.calls.generate[0]!.prompt).audio.strategy,'native');
  const report=pending.qualityReport!,ids=report.checks.filter(c=>['unchecked','needs-review'].includes(c.status)).map(c=>c.id);
  await assert.rejects(f.service.apply(started.id,f.project.revision,{candidateHash:'stale',checkIds:ids}),/过期/);
  await f.service.apply(started.id,f.project.revision,{candidateHash:report.candidateHash,checkIds:ids});const done=await settled(f.service,started.id);
  assert.equal(done.status,'complete',done.error);assert.deepEqual(f.calls.commit[0]!.sources,{});assert.equal(f.project.videoClips![0]!.audio,'keep');assert.equal(f.project.schemaVersion,3);assert.equal(f.calls.submissions,1);assert.equal(f.calls.vision.length,1);assert.ok(done.qualityReport!.checks.some(c=>c.evidence?.some(e=>e.kind==='human')));
});

test('empty model-video initialization never creates default animation source',async t=>{
  const f=await fixture(t,0);useVideo(f,30);const started=await f.service.run(f.request({visual:'video'})),pending=await settled(f.service,started.id);
  assert.equal(pending.status,'awaiting-apply',pending.error);assert.equal(f.calls.commit.length,1);assert.deepEqual(f.calls.commit[0]!.sources,{});assert.equal(f.project.shots[0]!.visual?.kind,'model_video');assert.equal(f.calls.scene.size,0);
});

test('native video cannot silently start external narration; explicit external strategy mutes source voice',async t=>{
  const f=await fixture(t,1);useVideo(f);await assert.rejects(f.service.run(f.request({visual:'video',narration:true})),/external/);
  const started=await f.service.run(f.request({visual:'video',narration:true,audioStrategy:'external',review:true,allowImageUpload:true})),pending=await settled(f.service,started.id);
  assert.equal(pending.status,'awaiting-apply',pending.error);assert.equal(f.calls.voice.size,1);assert.equal(f.calls.candidates[0]!.project.videoClips![0]!.audio,'mute');assert.equal(f.calls.candidates[0]!.project.audioClips![0]!.role,'voice');
});

test('short generated video is a structured hard failure and cannot be committed by retry',async t=>{
  const f=await fixture(t,1);useVideo(f,.5);const started=await f.service.run(f.request({visual:'video'})),failed=await settled(f.service,started.id);
  assert.equal(failed.status,'failed');assert.equal(failed.qualityReport?.decision,'fail');assert.ok(failed.qualityReport?.checks.some(c=>c.id==='production-composition'&&c.status==='fail'));assert.equal(f.calls.commit.length,0);
  await assert.rejects(f.service.apply(started.id,0,{candidateHash:failed.qualityReport!.candidateHash,checkIds:['production-composition']}));await f.service.retry(started.id);assert.equal((await settled(f.service,started.id)).status,'failed');assert.equal(f.calls.submissions,1);assert.equal(f.calls.commit.length,0);
});

test('unstructured or low-confidence static review needs trusted confirmation; a hard visual failure blocks commit',async t=>{
  for(const result of ['文字好像正常。',JSON.stringify({visual:{verdict:'pass',confidence:.4,message:'不确定小字'}}),JSON.stringify({visual:{verdict:'fail',confidence:.95,message:'字被遮住'}})]){
    const f=await fixture(t,1);f.hooks.visionResult=result;const started=await f.service.run(f.request({review:true,allowImageUpload:true})),pending=await settled(f.service,started.id);
    assert.equal(f.calls.commit.length,0);assert.equal(pending.status,result.includes('遮住')?'failed':'awaiting-apply');assert.equal(pending.qualityReport?.decision,result.includes('遮住')?'fail':'needs-review');
  }
});

test('retry never exceeds reserved external-call budget',async t=>{
  const f=await fixture(t,1);f.hooks.scene=async()=>{throw new Error('first request failed');};const started=await f.service.run(f.request({maxTasks:2}));assert.equal((await settled(f.service,started.id)).usage.externalCalls,2);
  f.hooks.scene=undefined;await f.service.retry(started.id);const failed=await settled(f.service,started.id);assert.equal(failed.status,'failed');assert.match(failed.error!,/上限/);assert.equal(f.calls.scene.size,1);assert.equal([...f.calls.scene.values()][0],1);assert.equal(f.calls.commit.length,0);
});

test('policy change after generation blocks adoption and never changes mode automatically',async t=>{
  const f=await fixture(t,1);f.hooks.scene=async()=>{const p=f.project;p.productionPolicy!.allowGeneratedImages=false;f.project=p;};const started=await f.service.run(f.request()),done=await settled(f.service,started.id);assert.equal(done.status,'failed');assert.match(done.error!,/许可已变化/);assert.equal(f.calls.commit.length,0);assert.equal(f.project.productionPolicy!.mode,'code_animation');
});

test('provider returning an image to a video request cannot fall back to still or code',async t=>{
  const f=await fixture(t,1);useVideo(f);f.hooks.stage=undefined;const started=await f.service.run(f.request({visual:'video'})),done=await settled(f.service,started.id);assert.equal(done.status,'failed');assert.match(done.error!,/类型/);assert.equal(f.calls.commit.length,0);assert.equal(f.calls.scene.size,0);
});

test('supplied validated director plan skips the director model and enters the actual generation workflow',async t=>{
  const f=await fixture(t,1),id=f.project.shots[0]!.id;
  const directorPlan={version:1 as const,ruleSetVersion:'2026-11-06.1',filmKind:'explainer' as const,characters:[],storyBeats:[],worldLayouts:[],identityMap:[],shots:[{shotId:id,title:'科学解释',visualPrompt:'用两个圆说明关系',durationSeconds:1,narration:'',audioStrategy:'silent' as const,performance:[],dialogue:[],events:[],references:[],acceptance:[]}]};
  const started=await f.service.run(f.request({directorPlan,maxTasks:1})),done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.calls.director,0);assert.equal(f.calls.scene.get(id),1);assert.equal(done.usage.externalCalls,1);assert.equal(done.directorPlan?.filmKind,'explainer');
});

test('actual reference-only outputs are rejected by quality before entering production',async t=>{
  const f=await fixture(t,1);useVideo(f);const staged=f.hooks.stage!;f.hooks.stage=task=>staged(task).map(a=>({...a,provenance:{origin:'model_generation',usage:'reference_only'}}));
  const started=await f.service.run(f.request({visual:'video'})),done=await settled(f.service,started.id);assert.equal(done.status,'failed');assert.match(done.error!,/参考专用/);assert.equal(done.qualityReport?.decision,'fail');assert.equal(f.calls.commit.length,0);
});

test('human review of old candidate cannot authorize a rebuilt candidate on a newer revision',async t=>{
  const f=await fixture(t,1);useVideo(f);const started=await f.service.run(f.request({visual:'video'})),first=await settled(f.service,started.id),old=first.qualityReport!;f.project={...f.project,title:'更新标题',revision:1};
  await assert.rejects(f.service.apply(started.id,1,{candidateHash:old.candidateHash,checkIds:old.checks.filter(c=>c.status==='unchecked').map(c=>c.id)}),/过期/);
  await f.service.apply(started.id,1);const next=await settled(f.service,started.id);assert.equal(next.status,'awaiting-apply');assert.notEqual(next.qualityReport!.candidateHash,old.candidateHash);assert.equal(f.calls.submissions,1);assert.equal(f.calls.commit.length,0);assert.ok(next.qualityReport!.checks.some(c=>c.status==='unchecked'));
});

test('one selected model-video shot can be adopted while export still refuses other missing shots',async t=>{
  const f=await fixture(t,2);useVideo(f);const id=f.project.shots[0]!.id;const started=await f.service.run(f.request({visual:'video',shotIds:[id]})),pending=await settled(f.service,started.id);assert.equal(pending.status,'awaiting-apply',pending.error);assert.equal(f.calls.submissions,1);
  const report=pending.qualityReport!;await f.service.apply(started.id,f.project.revision,{candidateHash:report.candidateHash,checkIds:report.checks.filter(c=>c.status==='unchecked').map(c=>c.id)});const done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);assert.equal(f.project.videoClips?.length,1);
  const {assertProductionComposition}=await import('../src/core/production-policy.ts');assert.throws(()=>assertProductionComposition(f.project,{forExport:true}),/尚未采用视频/);
});

test('image workflow needs code production authority as well as generated-image permission',async t=>{
  const f=await fixture(t,1);useVideo(f);const p=f.project;p.productionPolicy!.allowGeneratedImages=true;f.project=p;await assert.rejects(f.service.run(f.request({visual:'image'})),/代码|源码/);assert.equal(f.calls.director,0);assert.equal(f.calls.generate.length,0);
});

test('native dialogue requires audio at media preflight and preserves planned interruptions in compiled prompt',async t=>{
  const f=await fixture(t,1);useVideo(f);const id=f.project.shots[0]!.id;
  const directorPlan={version:1 as const,ruleSetVersion:'2026-11-06.1',filmKind:'general' as const,characters:[{id:'C1',name:'甲',identity:'灰衣'}],storyBeats:[],worldLayouts:[],identityMap:[],shots:[{shotId:id,title:'截断',visualPrompt:'甲尝试辩解',durationSeconds:1,narration:'',audioStrategy:'native' as const,performance:[],dialogue:[{id:'d1',characterId:'C1',start:.1,end:.8,text:'我不是——',intentional:{truncation:true}}],events:[],references:[],acceptance:[]}]};
  const started=await f.service.run(f.request({visual:'video',directorPlan})),pending=await settled(f.service,started.id);assert.equal(pending.status,'awaiting-apply',pending.error);assert.equal(f.calls.generate[0]!.requiresAudio,true);assert.equal(JSON.parse(f.calls.generate[0]!.prompt).dialogue[0].intentional.truncation,true);
});

test('code generation receives resolved global director definitions with the original renderer contract',async t=>{
  const f=await fixture(t,1),id=f.project.shots[0]!.id,p=f.project;p.assets.push({id:'listener',kind:'image',name:'乙',description:'蓝衬衫',path:'assets/listener.png',mime:'image/png',width:1,height:1});p.shots[0]!.referenceIds.push('listener');f.project=p;
  const directorPlan={version:1 as const,ruleSetVersion:'2026-11-06.1',filmKind:'general' as const,characters:[{id:'A',name:'甲',identity:'灰衣'},{id:'B',name:'乙',identity:'蓝衬衫'},{id:'unused',name:'未入镜人物',identity:'红衣'}],storyBeats:[{id:'beat',function:'发现',change:'甲发现画外乙',shotIds:[id]}],worldLayouts:[{id:'room',description:'门窗的稳定世界位置',anchors:[{id:'door',position:[0,0,0] as [number,number,number]}]}],identityMap:[{characterId:'B',assetId:'listener'}],shots:[{shotId:id,title:'回头',visualPrompt:'甲看向画外乙',durationSeconds:1,narration:'',audioStrategy:'silent' as const,performance:[],dialogue:[],events:[{id:'e',start:0,end:1,segmentId:'standing',worldLayoutId:'room',camera:'甲近景',screenPositions:[{characterId:'A',x:.5,y:.5}],relationships:[{from:'A',to:'B',relation:'看向画外乙'}],action:'甲回头'}],references:[{assetId:'listener',purpose:'identity' as const,usage:'reference_only' as const}],acceptance:[]}]};
  const started=await f.service.run(f.request({directorPlan,imageAssetIds:['listener'],allowImageUpload:true,maxTasks:1})),pending=await settled(f.service,started.id);assert.equal(pending.status,'awaiting-apply',pending.error);assert.equal(f.calls.director,0);const input=JSON.parse(f.calls.scenePrompts[0]!),context=input.directorConstraints;
  assert.deepEqual(context.characters.map((c:any)=>c.id),['A','B']);assert.equal(context.identityMap[0].characterId,'B');assert.equal(context.worldLayouts[0].id,context.shotEvents[0].worldLayoutId);assert.deepEqual(context.storyBeats[0].shotIds,[id]);assert.match(input.contract,/JS导出render/);assert.equal(context.instruction,undefined,'neutral context must not inject the media-only no-code instruction');assert.equal(f.calls.generate.length,0);
});

test('zero captured frames cannot pass visual quality even if a model-shaped result claims certainty',async()=>{
  const {frameQuality}=await import('../src/workflows/quality.ts');const check=frameQuality(JSON.stringify({visual:{verdict:'pass',confidence:1,message:'模型声称全都清晰'}}),[]);assert.equal(check.status,'unchecked');assert.deepEqual(check.evidence,[]);
});

test('reviewing a shot outside the main chain does not call vision without actual frame evidence',async t=>{
  const f=await fixture(t,2),p=f.project,id=p.shots[1]!.id;p.shotOrder=[p.shots[0]!.id];f.project=p;
  const started=await f.service.run(f.request({shotIds:[id],review:true,allowImageUpload:true})),pending=await settled(f.service,started.id);assert.equal(pending.status,'awaiting-apply',pending.error);assert.deepEqual(f.calls.capture,[]);assert.equal(f.calls.vision.length,0);assert.equal(pending.usage.externalCalls,2,'only director and scene calls are charged');assert.equal(pending.qualityReport?.checks.find(c=>c.id==='sampled-frames')?.status,'unchecked');assert.equal(f.calls.commit.length,0);
});

test('empty-project temporary shot IDs map story beats and scoped prompts to real persistent IDs',async t=>{
  const f=await fixture(t,0);f.hooks.directorResult={filmKind:'explainer',storyBeats:[{id:'b2',function:'比较',change:'第二镜展示差异',shotIds:['draft-b']},{id:'b1',function:'提出问题',change:'第一镜给出疑问',shotIds:['draft-a']}],shots:[{shotId:'draft-a',title:'提问',intent:'提问',prompt:'第一镜',narration:'',durationSeconds:1},{shotId:'draft-b',title:'比较',intent:'比较',prompt:'第二镜',narration:'',durationSeconds:1}]};
  const started=await f.service.run(f.request()),done=await settled(f.service,started.id);assert.equal(done.status,'complete',done.error);const ids=f.project.shots.map(s=>s.id);assert.ok(ids.every(id=>!id.startsWith('draft-')));assert.deepEqual(done.directorPlan!.storyBeats.map(b=>b.shotIds),[[ids[1]],[ids[0]]]);assert.deepEqual(done.directorPlan!.shots.map(s=>s.shotId),ids);
  assert.match(JSON.parse(f.calls.directorPrompts[0]!).output.shots[0].shotId,/临时ID/);for(const raw of f.calls.scenePrompts){const input=JSON.parse(raw);assert.deepEqual(input.directorConstraints.storyBeats[0].shotIds,[input.shot.id]);}assert.equal(f.calls.commit.length,2);
});

test('duplicate temporary shot IDs fail before empty-project initialization or scene generation',async t=>{
  const f=await fixture(t,0);f.hooks.directorResult={storyBeats:[{id:'b',function:'介绍',change:'变化',shotIds:['draft']}],shots:[{shotId:'draft',title:'一',prompt:'一',durationSeconds:1},{shotId:'draft',title:'二',prompt:'二',durationSeconds:1}]};const started=await f.service.run(f.request()),done=await settled(f.service,started.id);assert.equal(done.status,'failed');assert.match(done.error!,/唯一/);assert.equal(f.calls.commit.length,0);assert.equal(f.calls.scene.size,0);
});
