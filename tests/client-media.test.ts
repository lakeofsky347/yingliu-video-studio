import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, defaultSceneSource } from '../src/core/index.ts';
import { StudioController } from '../src/client/controller.ts';
import { mediaModels, mediaUsageLabel } from '../src/client/MediaPanel.tsx';
import type { StudioApi, StudioSnapshot } from '../src/shared/types.ts';
import type { RegistrySnapshot } from '../src/models/contracts.ts';

function fixture(){
  let snapshot:StudioSnapshot={project:createProject('生成素材工程'),root:'/fixture',task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false}};
  const calls:{endpoint:string;payload:Record<string,any>}[]=[];
  const api:StudioApi={async call<T>(endpoint:string,payload:Record<string,any>={}){calls.push({endpoint,payload:structuredClone(payload)});if(endpoint==='catalog'||endpoint==='current')return structuredClone(snapshot) as T;if(endpoint==='history')return {canUndo:false,canRedo:false,entries:[],cursor:0} as T;if(endpoint==='list')return {projects:[]} as T;if(endpoint==='styles.list')return {styles:[]} as T;if(endpoint==='save'){assert.equal(payload.expectedRevision,snapshot.project!.revision);snapshot={...snapshot,project:{...payload.project,revision:snapshot.project!.revision+1}};return structuredClone(snapshot) as T;}if(endpoint.startsWith('media.'))return {id:'task-1',phase:'ready'} as T;throw new Error(endpoint);}};
  return {api,calls,get snapshot(){return snapshot;}};
}

test('media generation flushes edits and uses the acknowledged revision rather than a caller-supplied revision',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();const project=f.snapshot.project!;controller.edit({...project,title:'已修改标题',revision:project.revision+1});
  const task=await controller.mediaCommand<{id:string}>('media.generate',{expectedRevision:999,operation:'text-to-image',prompt:'镜头图片'});
  assert.equal(task.id,'task-1');assert.equal(f.calls.filter(call=>call.endpoint==='save').length,1);
  const request=f.calls.find(call=>call.endpoint==='media.generate')!;assert.equal(request.payload.expectedRevision,1);assert.equal(request.payload.projectId,project.id);assert.ok(f.calls.findIndex(call=>call.endpoint==='save')<f.calls.indexOf(request));await controller.dispose();
});

test('failed parameter save blocks media generation and does not discard the draft',async()=>{
  const f=fixture(),base=f.api.call.bind(f.api);f.api.call=async <T>(endpoint:string,payload:unknown)=>{if(endpoint==='save')throw new Error('版本冲突');return base<T>(endpoint,payload);};
  const controller=new StudioController(f.api);await controller.load();controller.edit({...f.snapshot.project!,title:'尚未保存'});
  await assert.rejects(controller.mediaCommand('media.generate',{prompt:'不会发出'}),/版本冲突/);
  assert.equal(f.calls.filter(call=>call.endpoint==='media.generate').length,0);assert.equal(controller.getSnapshot().dirty,true);assert.equal(controller.getSnapshot().snapshot?.project?.title,'尚未保存');await controller.dispose();
});

test('stopping observation remains possible while edits are unsaved, and does not send a stale revision',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();controller.edit({...f.snapshot.project!,title:'正在编辑'});
  await controller.mediaCommand('media.pause',{taskId:'task-1'});
  const request=f.calls.find(call=>call.endpoint==='media.pause')!;assert.equal(request.payload.expectedRevision,undefined);assert.equal(controller.getSnapshot().dirty,true);assert.equal(f.calls.filter(call=>call.endpoint==='save').length,0);await controller.dispose();
});

test('adopting a media result refreshes only the same project and preserves a typed task response',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();const task=await controller.mediaCommand<{id:string}>('media.apply',{taskId:'task-1'},true);
  assert.equal(task.id,'task-1');assert.equal(controller.getSnapshot().snapshot?.project?.id,f.snapshot.project!.id);assert.equal(f.calls.filter(call=>call.endpoint==='current').at(-1)?.payload.projectId,f.snapshot.project!.id);await controller.dispose();
});

test('image-to-video selection requires an enabled video connection and explicit image capability',()=>{
  const connection={id:'video',name:'Video',protocol:'video-gateway' as const,baseUrl:'http://localhost',auth:'none' as const,credentialRef:'unused',enabled:true,revision:1,requestTimeoutMs:90000,concurrency:1,hasKey:false};
  const model={id:'text-video',connectionId:'video',model:'v',name:'Video',enabled:true,inputModalities:['text'] as ['text'],outputModalities:['video'] as ['video'],parameters:{}};
  const catalog:RegistrySnapshot={version:1,connections:[connection,{...connection,id:'disabled',enabled:false}],models:[model,{...model,id:'reference-video',inputModalities:['text','image']},{...model,id:'disabled-video',connectionId:'disabled',inputModalities:['text','image']}],roles:[]};
  assert.deepEqual(mediaModels(catalog,'image-to-video').map(value=>value.id),['reference-video']);assert.deepEqual(mediaModels(catalog,'text-to-image'),[]);
  assert.equal(mediaUsageLabel({}), '费用未知');assert.match(mediaUsageLabel({usage:{cost:0,currency:'USD'}}),/0\.0000 USD/);
});


test('workflow completion keeps local edits and flags a revision conflict instead of replacing the draft',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();controller.edit({...f.snapshot.project!,title:'本地尚未保存的标题'});
  f.snapshot.project={...f.snapshot.project!,revision:4,title:'工作流已经提交'};await controller.refreshMediaProject();
  assert.equal(controller.getSnapshot().snapshot?.project?.title,'本地尚未保存的标题');assert.equal(controller.getSnapshot().dirty,true);assert.equal(controller.getSnapshot().conflict,true);assert.equal(f.calls.filter(call=>call.endpoint==='save').length,0);await controller.dispose();
});

test('workflow completion cannot advance the save revision beneath an unsaved source draft',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();controller.setSourceDraft('draft-shot',defaultSceneSource());
  await assert.rejects(controller.mediaCommand('media.generate',{prompt:'不得提交'}),/草稿/);assert.equal(f.calls.filter(call=>call.endpoint==='media.generate').length,0);
  f.snapshot.project={...f.snapshot.project!,revision:3};await controller.refreshMediaProject();
  assert.equal(controller.getSnapshot().snapshot?.project?.revision,0);assert.equal(controller.getSnapshot().sourceDraft,true);assert.equal(controller.getSnapshot().conflict,true);await controller.dispose();
});


test('large video selection is rejected before reading a browser file into memory',async()=>{
  const f=fixture(),controller=new StudioController(f.api);await controller.load();
  await controller.importFile({name:'large-video.mp4',type:'video/mp4',size:33*1024*1024} as File);
  assert.match(controller.getSnapshot().error,/32 MiB.*本地路径/);assert.equal(f.calls.filter(call=>call.endpoint==='import').length,0);await controller.dispose();
});
