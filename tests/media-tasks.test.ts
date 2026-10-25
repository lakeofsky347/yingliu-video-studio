import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ModelRegistry} from '../src/models/registry.ts';
import {MediaTaskService} from '../src/jobs/media-tasks.ts';
import type {MediaProjectPort,MediaTask} from '../src/jobs/contracts.ts';
import {startMediaGateway,pngFixture} from './media-gateway.ts';
import {parseRemoteJob} from '../src/models/adapters/media.ts';

async function settle(service:MediaTaskService,id:string,predicate:(task:MediaTask)=>boolean){for(let count=0;count<300;count++){const task=await service.get(id);if(predicate(task))return task;await new Promise(r=>setTimeout(r,10));}throw new Error('task did not settle');}
async function fixture(t:TestContext,options:Parameters<typeof startMediaGateway>[0]={}){
  const directory=await mkdtemp(join(tmpdir(),'media-task-test-')),gateway=await startMediaGateway(options);const values=new Map<string,string>();const registry=new ModelRegistry(directory,{async get(ref){return values.get(ref);},async set(ref,value){values.set(ref,value);},async delete(ref){values.delete(ref);}});
  const image=await registry.saveConnection({id:'images',name:'Images',protocol:'images',baseUrl:gateway.url+'/v1',apiKey:'fixture-secret'}),video=await registry.saveConnection({id:'video',name:'Video',protocol:'video-gateway',baseUrl:gateway.url,apiKey:'fixture-secret'});
  await registry.saveModel({id:'image-model',connectionId:image.id,model:'image-test'});await registry.bindRole('image','image-model');
  await registry.saveModel({id:'video-model',connectionId:video.id,model:'video-test',inputModalities:['text','image']});await registry.bindRole('video','video-model');let revision=3,applies=0;
  const port:MediaProjectPort={async inspect(){return {revision,shotIds:['shot-1']};},async readImage(){return {bytes:pngFixture,mime:'image/png'};},async validateArtifact(path,mime){assert.ok((await readFile(path)).length>10);return {mime};},async applyResult(input){if(input.expectedRevision!==revision)throw new Error('revision conflict');applies++;revision++;return {assetIds:['asset-'+applies],revision};}};
  let service=new MediaTaskService(directory,registry,port,{pollIntervalMs:10});t.after(async()=>{await service.dispose();await gateway.close();await rm(directory,{recursive:true,force:true});});
  return {directory,gateway,registry,port,get service(){return service;},async restart(){await service.dispose();service=new MediaTaskService(directory,registry,port,{pollIntervalMs:10});await service.recover();return service;},setRevision(value:number){revision=value;},get applies(){return applies;}};
}

test('images become validated candidates, do not send credentials to artifact host, and apply with CAS',async t=>{
  const f=await fixture(t);const started=await f.service.generate({projectId:'film',shotId:'shot-1',expectedRevision:3,operation:'text-to-image',prompt:'a test image'});const ready=await settle(f.service,started.id,t=>t.phase==='ready');
  assert.equal(ready.files.length,1);assert.equal(ready.artifacts,undefined);assert.equal(ready.connection.credentialRef,'');assert.equal(ready.usage?.cost,undefined);
  assert.equal(f.gateway.requests.find(r=>r.path.includes('images/generations'))?.authorization,'Bearer fixture-secret');assert.equal(f.gateway.requests.find(r=>r.path.includes('artifacts/'))?.authorization,undefined);
  await assert.rejects(f.registry.removeConnection('images'),/任务/);await assert.rejects(f.registry.removeModel('image-model'),/任务/);await assert.rejects(f.registry.saveConnection({id:'images',baseUrl:'https://changed.example/v1'}),/任务/);await assert.rejects(f.registry.saveModel({id:'image-model',connectionId:'images',model:'different-model'}),/任务/);f.setRevision(4);await assert.rejects(f.service.apply(started.id,3),/版本/);assert.equal((await f.service.get(started.id)).phase,'ready');
  const applied=await f.service.apply(started.id,4);assert.equal(applied.phase,'complete');assert.equal(f.applies,1);await f.service.apply(started.id,5);assert.equal(f.applies,1);await f.registry.removeConnection('images');
});
test('lost video submission is reconciled after restart without another POST',async t=>{
  const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypmp42'),Buffer.alloc(20)]);const f=await fixture(t,{loseSubmitResponse:true,video});
  const task=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'a test video'});await settle(f.service,task.id,t=>t.phase==='unknown');await f.restart();const ready=await settle(f.service,task.id,t=>t.phase==='ready');assert.equal(ready.remoteStatus,'succeeded');assert.equal(f.gateway.requests.filter(r=>r.method==='POST'&&r.path==='/v1/media/jobs').length,1);assert.ok(f.gateway.requests.some(r=>r.path.startsWith('/v1/media/jobs?clientRequestId=')));
});
test('image download retry never regenerates a paid image',async t=>{
  const f=await fixture(t,{failDownloadOnce:true});const task=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-image',prompt:'a test image'});await settle(f.service,task.id,t=>t.observation==='paused'&&t.remoteStatus==='succeeded');await f.service.retry(task.id);await settle(f.service,task.id,t=>t.phase==='ready');assert.equal(f.gateway.requests.filter(r=>r.path==='/v1/images/generations').length,1);
});
test('reference image upload needs explicit consent and stores only hashes',async t=>{
  const f=await fixture(t,{queued:true});await assert.rejects(f.service.generate({projectId:'film',expectedRevision:3,operation:'image-to-video',prompt:'animate',imageAssetIds:['image-1']}),/明确允许/);
  const task=await f.service.generate({projectId:'film',expectedRevision:3,operation:'image-to-video',prompt:'animate',imageAssetIds:['image-1'],allowImageUpload:true});await settle(f.service,task.id,t=>t.remoteStatus==='running');await f.service.pause(task.id);const record=await readFile(join(f.directory,'media-tasks',task.id+'.json'),'utf8');assert.ok(!record.includes('data:image'));assert.ok(!record.includes('fixture-secret'));assert.equal(JSON.parse(record).inputHashes.length,1);
});
test('pause survives restart and unsupported cancellation never claims cloud cancellation',async t=>{
  const f=await fixture(t,{queued:true,cancelSupported:false});const task=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'test'});await settle(f.service,task.id,t=>t.remoteStatus==='running');const cancelled=await f.service.cancel(task.id);assert.notEqual(cancelled.phase,'cancelled');assert.equal(cancelled.observation,'paused');assert.match(cancelled.message,/未确认/);const before=f.gateway.requests.length;await f.restart();await new Promise(r=>setTimeout(r,30));assert.equal(f.gateway.requests.length,before);
});
test('artifact mutation and forged paths are rejected before adoption',async t=>{
  const f=await fixture(t);const task=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-image',prompt:'test'});const ready=await settle(f.service,task.id,t=>t.phase==='ready');await writeFile(ready.files[0]!.path,'tampered');await assert.rejects(f.service.apply(task.id,3),/变化|校验/);assert.equal(f.applies,0);
});
test('gateway refuses invalid statuses, successful empty results, and invalid progress',()=>{
  assert.throws(()=>parseRemoteJob({jobId:'x',status:'done'}),/状态/);assert.throws(()=>parseRemoteJob({jobId:'x',status:'succeeded'}),/产物/);assert.throws(()=>parseRemoteJob({jobId:'x',status:'running',progress:20}),/进度/);
});

test('connection concurrency bounds submissions and a released slot starts the next task',async t=>{
  const f=await fixture(t,{queued:true});await f.registry.saveConnection({id:'video',concurrency:1});
  const a=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'first'}),b=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'second'});
  await settle(f.service,a.id,t=>t.remoteStatus==='running');await new Promise(r=>setTimeout(r,30));assert.equal(f.gateway.requests.filter(r=>r.method==='POST'&&r.path==='/v1/media/jobs').length,1);assert.equal((await f.service.get(b.id)).phase,'pending');await f.service.pause(a.id);await settle(f.service,b.id,t=>t.remoteStatus==='running');assert.equal(f.gateway.requests.filter(r=>r.method==='POST'&&r.path==='/v1/media/jobs').length,2);
});
test('poll and cancel resolve rotated keys, and shutdown does not cancel the remote job',async t=>{
  const f=await fixture(t,{queued:true});const task=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'test'});const running=await settle(f.service,task.id,t=>t.remoteStatus==='running');
  await f.registry.saveConnection({id:'video',apiKey:'rotated-key'});const afterRotation=f.gateway.requests.length,pollPath='/v1/media/jobs/'+encodeURIComponent(running.remoteJobId!);
  // Wait for an actual post-rotation poll: Windows journal writes can delay it beyond a fixed sleep.
  await settle(f.service,task.id,()=>f.gateway.requests.slice(afterRotation).some(r=>r.method==='GET'&&r.path===pollPath&&r.authorization==='Bearer rotated-key')).catch(async cause=>{
    const current=await f.service.get(task.id);
    throw new Error(`Rotated-key GET not observed for ${pollPath}; task phase=${current.phase}, observation=${current.observation}, remoteStatus=${current.remoteStatus??'unknown'}, error=${current.error??'none'}`,{cause});
  });
  assert.ok(f.gateway.requests.slice(afterRotation).some(r=>r.method==='GET'&&r.path===pollPath&&r.authorization==='Bearer rotated-key'));
  await f.service.dispose();assert.equal(f.gateway.requests.filter(r=>r.path.endsWith('/cancel')).length,0);await f.restart();await settle(f.service,task.id,t=>t.observation==='active');const result=await f.service.cancel(task.id);assert.equal(result.remoteStatus,'cancelled');assert.equal(result.phase,'cancelled');assert.equal(f.gateway.requests.find(r=>r.path.endsWith('/cancel'))?.authorization,'Bearer rotated-key');
});

test('published gateway examples remain accepted by both clients',async()=>{
  const examples=JSON.parse(await readFile(new URL('../docs/media-gateway-v1/examples.json',import.meta.url),'utf8'));
  for(const name of ['queued','running','succeeded','cancelled'])assert.equal(parseRemoteJob(examples[name]).status,name);
});
test('invalid parameters and missing credentials fail before generation is submitted',async t=>{
  const f=await fixture(t);await assert.rejects(f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'test',parameters:{authorization:'not-allowed'}}),/不支持/);
  await assert.rejects(f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'test',parameters:{width:100.5}}),/整数/);
  await f.registry.saveConnection({id:'video',apiKey:''});await assert.rejects(f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'test'}),/API Key/);assert.equal(f.gateway.requests.length,0);assert.equal((await f.service.list()).length,0);
});

test('stable workflow request IDs deduplicate concurrent calls and survive a missing workflow receipt',async t=>{
  const f=await fixture(t);const input={clientRequestId:'workflow-1.step-1',projectId:'film',shotId:'shot-1',expectedRevision:3,operation:'text-to-image' as const,prompt:'one paid image'};
  const [a,b]=await Promise.all([f.service.generate(input),f.service.generate(input)]);assert.equal(a.id,b.id);await settle(f.service,a.id,t=>t.phase==='ready');await f.restart();f.setRevision(4);
  const resumed=await f.service.generate(input);assert.equal(resumed.id,a.id);assert.equal(f.gateway.requests.filter(r=>r.path==='/v1/images/generations').length,1);assert.equal((await f.service.list()).length,1);
  await assert.rejects(f.service.generate({...input,projectId:'another-film'}),/不同/);await assert.rejects(f.service.generate({...input,prompt:'a different request'}),/不同/);
});


test('temporarily unavailable credentials before submission remain safely retryable',async t=>{
  const f=await fixture(t);const credential=f.registry.credential.bind(f.registry);let reads=0;
  f.registry.credential=async connection=>{if(++reads===2)throw new Error('credential service unavailable');return credential(connection);};
  const task=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-image',prompt:'retry after unlocking'});
  await settle(f.service,task.id,t=>t.observation==='paused');assert.equal((await f.service.get(task.id)).phase,'pending');assert.equal(f.gateway.requests.length,0);
  await f.service.retry(task.id);await settle(f.service,task.id,t=>t.phase==='ready');assert.equal(f.gateway.requests.filter(r=>r.path==='/v1/images/generations').length,1);
});
test('protocol parameter limits cannot be widened by model configuration',async t=>{
  const f=await fixture(t);await f.registry.saveModel({id:'video-model',connectionId:'video',model:'video-test',parameters:{maxWidth:50000}});
  await assert.rejects(f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'test',parameters:{width:10000}}),/范围/);
  await assert.rejects(f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'test',parameters:{negativePrompt:false}}),/文本/);
  await assert.rejects(f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-image',prompt:'test',parameters:{n:0}}),/1–4/);
  await assert.rejects(f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-image',prompt:'test',parameters:{quality:1}}),/文本/);
  await f.registry.saveModel({id:'video-model',connectionId:'video',model:'video-test',parameters:{maxWidth:'invalid'}});
  await assert.rejects(f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'test',parameters:{width:1024}}),/上限无效/);
  assert.equal(f.gateway.requests.length,0);assert.equal((await f.service.list()).length,0);
});
test('shutdown waits for an accepted adoption and its durable receipt',async t=>{
  const f=await fixture(t);const task=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-image',prompt:'test'});await settle(f.service,task.id,t=>t.phase==='ready');
  let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});const apply=f.port.applyResult;
  f.port.applyResult=async input=>{entered();await gate;return apply(input);};
  const adoption=f.service.apply(task.id,3);await began;let stopped=false;const shutdown=f.service.dispose().then(()=>{stopped=true;});await new Promise(r=>setTimeout(r,20));assert.equal(stopped,false);
  release();await adoption;await shutdown;assert.equal(JSON.parse(await readFile(join(f.directory,'media-tasks',task.id+'.json'),'utf8')).phase,'complete');
  await assert.rejects(f.service.apply(task.id,4),/关闭/);
});

test('base64 images are decoded and checked without an artifact request',async t=>{
  const f=await fixture(t,{imageBase64:true});const task=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-image',prompt:'base64 result'});const ready=await settle(f.service,task.id,t=>t.phase==='ready');
  assert.deepEqual(await readFile(ready.files[0]!.path),pngFixture);assert.equal(ready.files[0]!.mimeType,'image/png');assert.equal(f.gateway.requests.length,1);
});
test('a lost image submission remains unknown across restart and retry without a second paid POST',async t=>{
  const f=await fixture(t,{loseImageResponse:true});const task=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-image',prompt:'uncertain image'});await settle(f.service,task.id,t=>t.phase==='unknown');
  await f.restart();await settle(f.service,task.id,t=>t.phase==='unknown');await f.service.retry(task.id);await settle(f.service,task.id,t=>t.phase==='unknown');
  assert.equal(f.gateway.requests.filter(r=>r.path==='/v1/images/generations').length,1);await assert.rejects(f.registry.removeConnection('images'),/任务/);
});

test('cancelling a queued local task never submits it or claims a remote cancellation',async t=>{
  const f=await fixture(t,{queued:true});await f.registry.saveConnection({id:'video',concurrency:1});const first=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'occupy slot'});await settle(f.service,first.id,t=>t.remoteStatus==='running');
  const queued=await f.service.generate({projectId:'film',expectedRevision:3,operation:'text-to-video',prompt:'cancel before submit'});const cancelled=await f.service.cancel(queued.id);assert.equal(cancelled.phase,'cancelled');assert.equal(cancelled.remoteStatus,undefined);assert.match(cancelled.message,/本地/);
  await f.service.pause(first.id);await new Promise(r=>setTimeout(r,20));assert.equal(f.gateway.requests.filter(r=>r.method==='POST'&&r.path==='/v1/media/jobs').length,1);assert.equal(f.gateway.requests.filter(r=>r.path.endsWith('/cancel')).length,0);await assert.rejects(f.service.retry(queued.id),/已结束/);
});
