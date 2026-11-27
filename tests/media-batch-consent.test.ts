import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MediaTaskService} from '../src/jobs/media-tasks.ts';
import type {MediaRequest} from '../src/jobs/contracts.ts';
import type {ResolvedModel} from '../src/models/contracts.ts';

const connection:ResolvedModel['connection']={id:'connection',name:'Fixture',protocol:'volc-video',baseUrl:'https://fixture.invalid/v3',
  auth:'none',credentialRef:'fixture',enabled:true,revision:1,requestTimeoutMs:5000,concurrency:2};
const model:ResolvedModel['model']={id:'model',connectionId:connection.id,model:'doubao-seedance-2-5-260628',name:'Fixture',enabled:true,
  inputModalities:['text','image'],outputModalities:['video'],parameters:{}};
const image=()=>{const bytes=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(2,16);bytes.writeUInt32BE(2,20);return bytes;};

test('a new external operation binds consent to the selected provider and exact input hashes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-consent-'));
  let source=image(),posts=0;
  const service=new MediaTaskService(directory,{resolve:async()=>({connection,model}),credential:async()=>undefined},{
    inspect:async()=>({revision:3,shotIds:['shot']}),
    readImage:async()=>({bytes:source,mime:'image/png'}),validateArtifact:async()=>({}),applyResult:async()=>({revision:4,assetIds:[]}),
  },{maxConcurrent:0,fetch:async()=>{posts++;throw new Error('not expected');}});
  try{
    const input:MediaRequest={projectId:'film',shotId:'shot',expectedRevision:3,operation:'first-last-frame-video',prompt:'Scene',imageAssetIds:['first','last'],referenceRoles:['first_frame','last_frame']};
    await assert.rejects(service.generate(input),/重新确认/);
    const grant=await service.authorizeUpload(input);
    source=Buffer.from(source);source.writeUInt32BE(3,20);
    await assert.rejects(service.generate({...input,...grant}),/重新确认/);
    const valid=await service.authorizeUpload(input);
    await service.generate({...input,...valid});
    await assert.rejects(service.generate({...input,...valid}),/重新确认/);
    assert.equal(posts,0);
  }finally{await service.dispose();await rm(directory,{recursive:true,force:true});}
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
