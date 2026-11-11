import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MediaTaskService} from '../src/jobs/media-tasks.ts';
import type {MediaTask,MediaProjectPort,MediaRegistryPort} from '../src/jobs/contracts.ts';

// Synthetic durable journals and fetch responses only; no provider or valid-video quality claim.
const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypmp42'),Buffer.alloc(20)]);
async function until(service:MediaTaskService,id:string,check:(task:MediaTask)=>boolean){
  for(let count=0;count<500;count++){const task=await service.get(id);if(check(task))return task;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('media recovery did not settle');
}
async function fixture(t:TestContext,embedded:boolean){
  const directory=await mkdtemp(join(tmpdir(),'plugin-media-recovery-')),folder=join(directory,'media-tasks');await mkdir(folder);
  const now=new Date().toISOString();const task:MediaTask={version:1,id:'persisted-task',clientRequestId:'persisted-request',projectId:'film',startRevision:1,operation:'text-to-video',prompt:'fixture',imageAssetIds:[],inputHashes:[],
    connection:{id:'fixture',name:'Fixture',protocol:'video-gateway',baseUrl:'https://media.example.test',auth:'none',credentialRef:'',enabled:true,revision:1,requestTimeoutMs:1000,concurrency:1},
    model:{id:'fixture-model',connectionId:'fixture',model:'fixture',name:'Fixture',enabled:true,inputModalities:['text'],outputModalities:['video'],parameters:{}},parameters:{},
    phase:'validating',observation:'paused',remoteStatus:'succeeded',remoteJobId:embedded?'local-receipt-only':'remote-job',progress:1,message:'素材检查失败',createdAt:now,updatedAt:now,files:[],resumeOnStart:true,
    artifacts:[embedded?{base64:video.toString('base64'),mimeType:'video/mp4'}:{url:'https://media.example.test/expired.mp4',mimeType:'video/mp4'}]};
  await writeFile(join(folder,task.id+'.json'),JSON.stringify(task));
  const requests:{method:string;path:string}[]=[];let validations=0,failValidation=false;
  const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));requests.push({method:init?.method??'GET',path:url.pathname});
    if(url.pathname==='/v1/media/jobs/remote-job')return Response.json({jobId:'remote-job',status:'succeeded',artifacts:[{url:'https://media.example.test/fresh.mp4',mimeType:'video/mp4'}]});
    if(url.pathname==='/fresh.mp4')return new Response(new Uint8Array(video),{headers:{'Content-Type':'video/mp4'}});
    throw new Error('Unexpected network request: '+url.pathname);
  }) as typeof fetch;
  const registry:MediaRegistryPort={async resolve(){return {connection:task.connection,model:task.model};},async credential(){return undefined;}};
  const port:MediaProjectPort={async inspect(){return {revision:1,shotIds:[]};},async readImage(){throw new Error('unexpected image read');},
    async validateArtifact(path){validations++;assert.deepEqual(await readFile(path),video);if(failValidation){failValidation=false;throw new Error('fixture validation failure');}return {hasAudio:true};},
    async applyResult(){throw new Error('recovery does not adopt results');}};
  let service=new MediaTaskService(directory,registry,port,{fetch:fetcher,pollIntervalMs:1});const services=[service];
  t.after(async()=>{for(const value of services)await value.dispose();await rm(directory,{recursive:true,force:true});});
  return {task,requests,get validations(){return validations;},failNextValidation(){failValidation=true;},get service(){return service;},
    async restart(){await service.dispose();service=new MediaTaskService(directory,registry,port,{fetch:fetcher,pollIntervalMs:1});services.push(service);await service.recover();}};
}

test('restart reuses saved successful embedded video bytes without polling a receipt or resubmitting',async t=>{
  const f=await fixture(t,true);await f.service.recover();const ready=await until(f.service,f.task.id,task=>task.phase==='ready');
  assert.equal(ready.files.length,1);assert.equal(f.validations,1);assert.deepEqual(f.requests,[]);
});

test('explicit retry of failed embedded-result validation remains local and restart-safe',async t=>{
  const f=await fixture(t,true);f.failNextValidation();await f.service.recover();await until(f.service,f.task.id,task=>task.observation==='paused'&&!!task.error);
  await f.service.retry(f.task.id);await until(f.service,f.task.id,task=>task.phase==='ready');
  await f.restart();assert.equal((await f.service.get(f.task.id)).phase,'ready');assert.equal(f.validations,2);assert.deepEqual(f.requests,[]);
});

test('real remote job IDs still refresh URL artifacts and never repeat the generation POST',async t=>{
  const f=await fixture(t,false);await f.service.recover();const ready=await until(f.service,f.task.id,task=>task.phase==='ready');
  assert.equal(ready.files.length,1);assert.deepEqual(f.requests,[{method:'GET',path:'/v1/media/jobs/remote-job'},{method:'GET',path:'/fresh.mp4'}]);
});
