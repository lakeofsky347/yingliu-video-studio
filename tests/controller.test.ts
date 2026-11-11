import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../src/client/controller.ts';
import { createProject } from '../src/core/index.ts';
import type { StudioApi, StudioSnapshot } from '../src/shared/types.ts';

function snapshot():StudioSnapshot{return {project:createProject('控制器回归','保存与导入'),root:'/test',task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false}};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

test('import blocks an old canvas draft and preserves imported assets for the next save',async()=>{
  let state=snapshot();const imported=deferred<StudioSnapshot>();const saved:StudioSnapshot['project'][]=[];
  const api={async call(endpoint:string,payload:any){if(endpoint==='catalog')return structuredClone(state);if(endpoint==='import')return imported.promise;if(endpoint==='save'){saved.push(payload.project);state={...state,project:payload.project};return structuredClone(state);}throw new Error(endpoint);}} as StudioApi;
  const controller=new StudioController(api);await controller.load();const before=structuredClone(controller.getSnapshot().snapshot!.project!);
  const action=controller.action('import');await Promise.resolve();
  controller.edit({...before,revision:before.revision+1,graph:{...before.graph,groups:[{id:'old',title:'旧画布事件',bounds:[0,0,100,100]}]}});
  state.project!.assets.push({id:'image-new',kind:'image',name:'新图',description:'',path:'assets/new.webp'});state.project!.revision++;
  imported.resolve(structuredClone(state));await action;
  const current=controller.getSnapshot().snapshot!.project!;controller.edit({...current,title:'继续编辑',revision:current.revision+1});await controller.flush();
  assert.equal(saved.length,1);assert.equal(saved[0]!.assets[0]!.id,'image-new');assert.equal(saved[0]!.graph.groups.length,0);await controller.dispose();
});

test('an earlier current response cannot overwrite a newer action or its task',async()=>{
  const state=snapshot(),old=deferred<StudioSnapshot>();
  const api={async call(endpoint:string){if(endpoint==='catalog')return structuredClone(state);if(endpoint==='current')return old.promise;if(endpoint==='open')return {...state,project:{...state.project!,id:'new-project',title:'新打开项目'}};throw new Error(endpoint);}} as StudioApi;
  const controller=new StudioController(api);await controller.load();const poll=(controller as any).poll();await controller.action('open');old.resolve(state);await poll;
  assert.equal(controller.getSnapshot().snapshot!.project!.id,'new-project');await controller.dispose();
});

test('disposal flushes the last edit before its debounce expires',async()=>{
  const state=snapshot();let writes=0;
  const api={async call(endpoint:string,payload:any){if(endpoint==='catalog')return structuredClone(state);if(endpoint==='save'){writes++;return {...state,project:payload.project};}throw new Error(endpoint);}} as StudioApi;
  const controller=new StudioController(api);await controller.load();controller.edit({...state.project!,title:'退出前最后一笔',revision:1});await controller.dispose();assert.equal(writes,1);
});

test('project switching clears a previous session frame and failed focus stays on the existing project',async()=>{
  let state=snapshot();const first=state.project!.id;
  const api={async call(endpoint:string,payload:any){if(endpoint==='catalog')return structuredClone(state);if(endpoint==='focus'){if(payload.projectId==='missing')throw new Error('未找到视频工程');return structuredClone(state);}if(endpoint==='create'){state=snapshot();return structuredClone(state);}throw new Error(endpoint);}} as StudioApi;
  const controller=new StudioController(api);await controller.load();await controller.focusProject(first,{frame:700});assert.equal(controller.getSnapshot().focusFrame,700);
  await controller.action('create');assert.equal(controller.getSnapshot().focusFrame,null);assert.notEqual(controller.getSnapshot().snapshot!.project!.id,first);
  const current=controller.getSnapshot().snapshot!.project!.id;await assert.rejects(()=>controller.focusProject('missing',{frame:30}),/未找到/);assert.equal(controller.getSnapshot().snapshot!.project!.id,current);assert.equal(controller.getSnapshot().focusFrame,null);await controller.dispose();
});

test('all visible-project mutation callers carry the confirmed revision',async()=>{
  const state=snapshot();state.project!.revision=7;const calls:{endpoint:string;payload:any}[]=[];
  const api={async call(endpoint:string,payload:any){if(endpoint==='catalog')return structuredClone(state);if(['history','list','styles.list'].includes(endpoint))throw new Error('unneeded read');calls.push({endpoint,payload});return structuredClone(state);}} as StudioApi;
  const controller=new StudioController(api);await controller.load();
  for(const endpoint of ['import','audio','generate','saveSource','restoreSource','apply','rename','duplicate','undo','redo','retry','job.retry','video.clip.save','video.clip.remove','video.clip.extract'])assert.equal(await controller.action(endpoint),true,endpoint);
  assert.ok(calls.length>0);for(const call of calls){assert.equal(call.payload.expectedRevision,7,call.endpoint);assert.equal(call.payload.projectId,state.project!.id);}
  await controller.dispose();
});

test('library rename and duplicate read their target revision without using another visible project revision',async()=>{
  const visible=snapshot(),target=snapshot();visible.project!.revision=2;target.project!.revision=19;const calls:{endpoint:string;payload:any}[]=[];
  const api={async call(endpoint:string,payload:any){if(endpoint==='catalog')return structuredClone(visible);if(['history','list','styles.list'].includes(endpoint))throw new Error('unneeded read');calls.push({endpoint,payload});if(endpoint==='current'){assert.equal(payload.projectId,target.project!.id);return structuredClone(target);}if(endpoint==='rename'||endpoint==='duplicate')return structuredClone(target);throw new Error(endpoint);}} as StudioApi;
  const controller=new StudioController(api);await controller.load();
  assert.equal(await controller.action('rename',{projectId:target.project!.id,title:'改名'}),true);assert.equal(controller.getSnapshot().snapshot!.project!.id,visible.project!.id);
  assert.equal(await controller.action('duplicate',{projectId:target.project!.id,title:'副本'}),true);
  assert.deepEqual(calls.map(call=>call.endpoint),['current','rename','current','duplicate']);
  for(const call of calls.filter(call=>call.endpoint!=='current'))assert.equal(call.payload.expectedRevision,19);
  await controller.dispose();
});

test('failed foreign revision lookup never sends a mutation or silently uses the visible revision',async()=>{
  const state=snapshot();const mutations:string[]=[];
  const api={async call(endpoint:string){if(endpoint==='catalog')return structuredClone(state);if(endpoint==='current')throw new Error('目标工程读取失败');if(['history','list','styles.list'].includes(endpoint))throw new Error('unneeded read');mutations.push(endpoint);return structuredClone(state);}} as StudioApi;
  const controller=new StudioController(api);await controller.load();assert.equal(await controller.action('rename',{projectId:'other',title:'修改'}),false);assert.deepEqual(mutations,[]);assert.match(controller.getSnapshot().error,/目标工程读取失败/);await controller.dispose();
});
