import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MediaTaskService} from '../src/jobs/media-tasks.ts';
import {mediaUploadDestination,type MediaRequest,type MediaTask} from '../src/jobs/contracts.ts';
import type {ResolvedModel} from '../src/models/contracts.ts';
import {createSessionTools} from '../src/host/session-tools.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {ProjectHub} from '../src/host/project-hub.ts';
import type {JobHooks} from '@deepseek-ai/dsh-jobs';

const connection:ResolvedModel['connection']={id:'connection',name:'Fixture',protocol:'volc-video',baseUrl:'https://fixture.invalid/v3',
  auth:'none',credentialRef:'fixture',enabled:true,revision:1,requestTimeoutMs:5000,concurrency:2};
const model:ResolvedModel['model']={id:'model',connectionId:connection.id,model:'doubao-seedance-2-5-260628',name:'Fixture',enabled:true,
  inputModalities:['text','image'],outputModalities:['video'],parameters:{}};
const image=()=>{const bytes=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(2,16);bytes.writeUInt32BE(2,20);return bytes;};

test('a new external operation binds consent to the selected provider and exact input hashes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-consent-'));
  let source=image(),posts=0,refsRead=0;
  let activeConnection=connection,activeModel=model;
  const service=new MediaTaskService(directory,{resolve:async()=>({connection:activeConnection,model:activeModel}),credential:async()=>undefined},{
    inspect:async()=>({revision:3,shotIds:['shot']}),
    readImage:async()=>{refsRead++;return {bytes:source,mime:'image/png'};},validateArtifact:async()=>({}),applyResult:async()=>({revision:4,assetIds:[]}),
  },{maxConcurrent:0,fetch:async()=>{posts++;throw new Error('not expected');}});
  try{
    const input:MediaRequest={projectId:'film',shotId:'shot',expectedRevision:3,operation:'first-last-frame-video',prompt:'Scene',imageAssetIds:['first','last'],referenceRoles:['first_frame','last_frame']};
    const destination=mediaUploadDestination({connection,model});
    activeConnection={...connection,baseUrl:'https://other.invalid/v3',revision:2};
    await assert.rejects(service.authorizeUpload(input,destination),{code:'MEDIA_DESTINATION_CHANGED'});
    activeConnection=connection;
    activeModel={...model,model:'different-model'};
    await assert.rejects(service.authorizeUpload(input,destination),{code:'MEDIA_DESTINATION_CHANGED'});
    await assert.rejects(service.authorizeUpload(input,undefined),{code:'MEDIA_DESTINATION_CHANGED'});
    assert.equal(refsRead,0);
    activeModel=model;
    await assert.rejects(service.generate(input),/重新确认/);
    const grant=await service.authorizeUpload(input,destination);
    source=Buffer.from(source);source.writeUInt32BE(3,20);
    await assert.rejects(service.generate({...input,...grant}),/重新确认/);
    const valid=await service.authorizeUpload(input,destination);
    await service.generate({...input,...valid});
    await assert.rejects(service.generate({...input,...valid}),/重新确认/);
    assert.equal(posts,0);
  }finally{await service.dispose();await rm(directory,{recursive:true,force:true});}
});

test('DSH media jobs only report success when every task has an available output',async()=>{
  let tasks:Pick<MediaTask,'id'|'projectId'|'phase'|'observation'|'message'>[]=[],hooks:JobHooks|undefined;
  const notices:string[]=[];
  const ctx={jobs:{start(spec){hooks=spec.run({id:'fixture-job',append:notice=>notices.push(notice),updateProgress:()=>{}});return 'fixture-job';}}} as HostContext;
  const hub={resolveProject:async()=>({projectId:'film'}),call:async(operation:string)=>operation==='media.batch'?{tasks}:tasks[0]} as unknown as ProjectHub;
  const tool=createSessionTools(ctx,hub).find(item=>item.name==='video_media')!;
  async function submit(phases:MediaTask['phase'][],status:'completed'|'failed'|'killed'){
    tasks=phases.map((phase,index)=>({id:'task-'+index,projectId:'film',phase,observation:'paused',message:phase}));
    const args={action:phases.length>1?'batch':'generate',expectedRevision:1,...(phases.length>1?{items:tasks,batchId:'batch'}:{})};
    await tool.execute(args,{name:tool.name,callId:'call',rootCallId:'call',arguments:args,token:Symbol(),agent:{id:'session',options:{provider:'fixture',model:'fixture'}},signal:new AbortController().signal});
    const outcome=await hooks!.done;
    assert.equal(outcome.status,status);
    const latest=JSON.parse(notices.at(-1)!);
    assert.deepEqual((latest.tasks??[latest.task]).map((task:MediaTask)=>task.phase),phases);
  }
  await submit(['unknown'],'failed');
  await submit(['running'],'failed');
  await submit(['ready','cancelled'],'failed');
  await submit(['cancelled','cancelled'],'killed');
  await submit(['ready','complete'],'completed');
});

test('a batch preflights all items and reuses the same task IDs after restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-batch-'));
  const make=()=>new MediaTaskService(directory,{resolve:async()=>({connection,model}),credential:async()=>undefined},{
    inspect:async()=>({revision:3,shotIds:['one','two']}),
    readImage:async()=>{throw new Error('not expected');},validateArtifact:async()=>({}),applyResult:async()=>({revision:4,assetIds:[]}),
  },{maxConcurrent:0});
  let service=make();
  try{
    const input:MediaRequest={projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'Scene'};
    await assert.rejects(service.generateBatch('bad',[{...input,shotId:'one'},{...input,shotId:'missing'}]),/镜头不存在/);
    assert.deepEqual(await service.list(),[]);
    const items=[{...input,shotId:'one'},{...input,shotId:'two'}];
    const first=await service.generateBatch('batch',items);
    await service.dispose();service=make();
    const retry=await service.generateBatch('batch',items);
    assert.deepEqual(first.map(task=>task.id),retry.map(task=>task.id));
    await assert.rejects(service.generateBatch('batch',[items[1]!,items[0]!]),/稳定请求 ID/);
  }finally{await service.dispose();await rm(directory,{recursive:true,force:true});}
});

test('a reference batch requires a distinct grant for every shot, preserving the original single request flow',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-batch-refs-'));
  const service=new MediaTaskService(directory,{resolve:async()=>({connection,model}),credential:async()=>undefined},{
    inspect:async()=>({revision:3,shotIds:['one','two']}),readImage:async()=>({bytes:image(),mime:'image/png'}),
    validateArtifact:async()=>({}),applyResult:async()=>({revision:4,assetIds:[]}),
  },{maxConcurrent:0});
  try{
    const input:MediaRequest={projectId:'film',expectedRevision:3,operation:'image-to-video',prompt:'Reference',imageAssetIds:['shared'],allowImageUpload:true};
    const items=[{...input,shotId:'one'},{...input,shotId:'two'}];
    const destination=mediaUploadDestination({connection,model});
    await assert.rejects(service.generateBatch('references',items),/重新确认上传/);
    const one=await service.authorizeUpload(items[0]!,destination),two=await service.authorizeUpload(items[1]!,destination);
    await assert.rejects(service.generateBatch('references',items.map(item=>({...item,uploadConsentId:one.uploadConsentId}))),/重新确认上传/);
    assert.deepEqual(await service.list(),[]);
    const queued=await service.generateBatch('references',items.map((item,index)=>({...item,uploadConsentId:index===0?one.uploadConsentId:two.uploadConsentId})));
    assert.deepEqual(queued.map(item=>item.shotId),['one','two']);
    assert.deepEqual((await service.generateBatch('references',items)).map(item=>item.id),queued.map(item=>item.id));
    assert.equal((await service.generate(items[0]!)).phase,'pending');
  }finally{await service.dispose();await rm(directory,{recursive:true,force:true});}
});

test('a copied DSH grant queues nothing and only admits the approved revision and request identity',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-dsh-grant-'));let revision=3;
  const service=new MediaTaskService(directory,{resolve:async()=>({connection,model}),credential:async()=>undefined},{
    inspect:async()=>({revision,shotIds:['shot']}),readImage:async()=>({bytes:image(),mime:'image/png'}),
    validateArtifact:async()=>({}),applyResult:async()=>({revision:5,assetIds:[]}),
  },{maxConcurrent:0});
  try{
    const shown:MediaRequest={projectId:'film',shotId:'shot',expectedRevision:revision,operation:'first-last-frame-video',prompt:'Scene',clientRequestId:'approved-request',imageAssetIds:['first','last'],referenceRoles:['first_frame','last_frame']};
    const grant=await service.authorizeUpload(shown,mediaUploadDestination({connection,model}));
    assert.deepEqual(await service.list(),[]);
    assert.equal(grant.expectedRevision,revision);
    assert.ok(grant.expiresAt>Date.now()&&grant.expiresAt<=Date.now()+300_000);
    const request={...shown,uploadConsentId:grant.uploadConsentId,ownerSessionId:'intended-session'};
    await assert.rejects(service.generate({...request,clientRequestId:'modified-request'}),/重新确认上传/);
    await assert.rejects(service.generate({...request,prompt:'Changed prompt'}),/重新确认上传/);
    revision++;
    await assert.rejects(service.generate({...request,expectedRevision:revision}),/重新确认上传/);
    assert.deepEqual(await service.list(),[]);
    const renewed=await service.authorizeUpload({...shown,expectedRevision:revision},mediaUploadDestination({connection,model}));
    const exact={...request,expectedRevision:renewed.expectedRevision,uploadConsentId:renewed.uploadConsentId};
    const task=await service.generate(exact);
    assert.equal(task.ownerSessionId,'intended-session');
    assert.equal((await service.generate(exact)).id,task.id);
  }finally{await service.dispose();await rm(directory,{recursive:true,force:true});}
});
