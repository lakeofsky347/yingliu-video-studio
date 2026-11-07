import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaTaskService } from '../src/jobs/media-tasks.ts';
import type { MediaProjectPort, MediaRegistryPort, MediaRequest, MediaTask } from '../src/jobs/contracts.ts';
import type { ResolvedModel } from '../src/models/contracts.ts';
import { MediaCapabilityError } from '../src/models/capabilities.ts';
import { pngFixture } from './media-gateway.ts';

async function fixture(t:TestContext,options:{parameters?:Record<string,string|number|boolean>;metadata?:Record<string,unknown>;maxConcurrent?:number}={}){
  const directory=await mkdtemp(join(tmpdir(),'media-capability-boundary-'));
  const resolved:ResolvedModel={connection:{id:'native',name:'mock native endpoint',protocol:'openai-videos',baseUrl:'https://fixture.invalid/v1',auth:'none',credentialRef:'none',enabled:true,revision:1,requestTimeoutMs:5000,concurrency:1},model:{id:'sora',connectionId:'native',name:'historical Sora protocol fixture',model:'sora-2',enabled:true,inputModalities:['text','image'],outputModalities:['video'],parameters:options.parameters??{}}};
  let posts=0,reads=0,downloads=0;const bodies:Record<string,unknown>[]=[];
  const registry:MediaRegistryPort={resolve:async()=>structuredClone(resolved),credential:async()=>undefined};
  const project:MediaProjectPort={inspect:async()=>({revision:1,shotIds:['shot']}),readImage:async()=>{reads++;return {bytes:pngFixture,mime:'image/png'};},validateArtifact:async()=>options.metadata??{},applyResult:async()=>({assetIds:['adopted'],revision:2})};
  const fetchImpl:typeof fetch=async(url,init)=>{
    if(init?.method==='POST'){posts++;bodies.push(JSON.parse(String(init.body)));return Response.json({id:'remote-task',status:'completed'});}
    if(String(url).endsWith('/content')){downloads++;return new Response(Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypmp42'),Buffer.alloc(24)]),{headers:{'Content-Type':'video/mp4'}});}
    throw new Error('Unexpected fixture request: '+String(url));
  };
  let service=new MediaTaskService(directory,registry,project,{fetch:fetchImpl,pollIntervalMs:1,maxConcurrent:options.maxConcurrent});
  t.after(async()=>{await service.dispose();await rm(directory,{recursive:true,force:true});});
  const input:MediaRequest={projectId:'project',shotId:'shot',expectedRevision:1,operation:'text-to-video',prompt:'有声音的纸船',parameters:{durationSeconds:4}};
  return {directory,registry,project,input,bodies,get service(){return service;},get posts(){return posts;},get reads(){return reads;},get downloads(){return downloads;},async reopen(){await service.dispose();service=new MediaTaskService(directory,registry,project,{fetch:fetchImpl,pollIntervalMs:1});await service.recover();}};
}
async function paused(service:MediaTaskService,id:string):Promise<MediaTask>{
  const deadline=Date.now()+5000;let last:MediaTask|undefined;
  while(Date.now()<deadline){last=await service.get(id);if(last.observation==='paused')return last;await new Promise(r=>setTimeout(r,5));}
  throw new Error('Task did not pause: '+JSON.stringify(last&&{phase:last.phase,error:last.error}));
}

test('job creation rejects native multi-reference and unsupported parameters before reading files or registering work',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.generate({...f.input,operation:'image-to-video',imageAssetIds:['one','two'],allowImageUpload:true}),e=>e instanceof MediaCapabilityError);
  await assert.rejects(f.service.generate({...f.input,parameters:{fps:24}}),e=>e instanceof MediaCapabilityError);
  await assert.rejects(f.service.generate({...f.input,operation:'image-to-video',imageAssetIds:['one'],allowImageUpload:true,referenceRoles:['character']}),e=>e instanceof MediaCapabilityError);
  assert.equal(f.reads,0);assert.equal(f.posts,0);assert.deepEqual(await f.service.list(),[]);
});

test('unsupported configured defaults are rejected instead of silently filtered from a paid request',async t=>{
  const f=await fixture(t,{parameters:{aspect_ratio:'16:9'}});
  await assert.rejects(f.service.generate(f.input),e=>e instanceof MediaCapabilityError&&e.submissionUncertain===false);
  assert.equal(f.posts,0);assert.equal(f.reads,0);assert.deepEqual(await f.service.list(),[]);
});

test('explicit local limit and cancellation metadata are not forwarded as generation parameters',async t=>{
  const f=await fixture(t,{parameters:{maxDurationSeconds:8,maxWidth:1280,maxHeight:1280,maxFps:30,supportsCancel:false},metadata:{hasAudio:true}});
  const task=await f.service.generate(f.input),done=await paused(f.service,task.id);
  assert.equal(done.phase,'ready');assert.deepEqual(f.bodies[0],{model:'sora-2',prompt:f.input.prompt,seconds:'4'});assert.equal(f.posts,1);
});

for(const hasAudio of [undefined,false])test('requiresAudio blocks ready/adoption when actual metadata.hasAudio is '+String(hasAudio),async t=>{
  const f=await fixture(t,{metadata:hasAudio===undefined?{}:{hasAudio}});
  const task=await f.service.generate({...f.input,requiresAudio:true}),failed=await paused(f.service,task.id);
  assert.notEqual(failed.phase,'ready');assert.notEqual(failed.phase,'unknown');assert.match(failed.error??'',/音轨/);
  assert.equal(f.posts,1);assert.equal(f.downloads,1);await assert.rejects(f.service.apply(task.id,1));
  await f.service.retry(task.id);const again=await paused(f.service,task.id);
  assert.notEqual(again.phase,'ready');assert.equal(f.posts,1,'retry may download or validate but must not pay again');
});

test('requiresAudio allows ready only after actual artifact audio is confirmed',async t=>{
  const f=await fixture(t,{metadata:{hasAudio:true}}),task=await f.service.generate({...f.input,requiresAudio:true});
  const ready=await paused(f.service,task.id);assert.equal(ready.phase,'ready');assert.equal(ready.files[0]!.metadata.hasAudio,true);assert.equal(f.posts,1);
});

test('pending tasks recheck captured capabilities after restart and local rejection never becomes unknown',async t=>{
  const f=await fixture(t,{maxConcurrent:0});
  const task=await f.service.generate(f.input);assert.equal(task.phase,'pending');await f.service.dispose();
  const path=join(f.directory,'media-tasks',task.id+'.json'),saved=JSON.parse(await readFile(path,'utf8'));
  saved.parameters.fps=24;await writeFile(path,JSON.stringify(saved));
  await f.reopen();const failed=await paused(f.service,task.id);
  assert.equal(failed.phase,'failed');assert.match(failed.message,/未发起/);assert.match(failed.error??'',/fps/);assert.equal(f.posts,0);
});

test('stable request IDs cannot silently change audio or reference-role requirements',async t=>{
  const f=await fixture(t,{maxConcurrent:0});
  await f.service.generate({...f.input,clientRequestId:'same-request'});
  await assert.rejects(f.service.generate({...f.input,clientRequestId:'same-request',requiresAudio:true}),/稳定请求 ID/);
  const ref={...f.input,operation:'image-to-video' as const,imageAssetIds:['first'],allowImageUpload:true,referenceRoles:['first_frame'],clientRequestId:'same-reference'};
  await f.service.generate(ref);await assert.rejects(f.service.generate({...ref,referenceRoles:['character']}),/稳定请求 ID/);
  assert.equal(f.posts,0);
});

test('legacy ready candidates require trusted adoption confirmation without another generation request',async t=>{
  const f=await fixture(t,{metadata:{hasAudio:true}}),fingerprint='current-user-decision';let adopted=0;
  f.project.authorizeOperation=async(_projectId,_operation,_shotId,expected)=>{
    if(expected!==undefined&&expected!==fingerprint)throw new Error('制作模式或许可已变化');
    return fingerprint;
  };
  f.project.applyResult=async input=>{adopted++;assert.equal(input.productionPolicyFingerprint,fingerprint);return {assetIds:['adopted'],revision:2};};
  const task=await f.service.generate(f.input);assert.equal((await paused(f.service,task.id)).phase,'ready');
  await f.service.dispose();
  const path=join(f.directory,'media-tasks',task.id+'.json'),legacy=JSON.parse(await readFile(path,'utf8'));
  delete legacy.productionPolicyFingerprint;await writeFile(path,JSON.stringify(legacy));await f.reopen();
  const postsBeforeAdoption=f.posts;
  await assert.rejects(f.service.apply(task.id,1),error=>error instanceof Error&&'code' in error&&error.code==='PRODUCTION_CONFIRMATION_REQUIRED');
  const stillReady=await f.service.get(task.id);assert.equal(stillReady.phase,'ready');assert.equal(stillReady.productionPolicyFingerprint,undefined);assert.equal(adopted,0);
  const complete=await f.service.apply(task.id,1,true);
  assert.equal(complete.phase,'complete');assert.equal(complete.productionPolicyFingerprint,fingerprint);assert.equal(adopted,1);
  assert.equal(f.posts,postsBeforeAdoption,'migration adoption never submits a new paid generation');
  assert.equal(JSON.parse(await readFile(path,'utf8')).productionPolicyFingerprint,fingerprint);
});

test('legacy confirmation cannot replace an existing revoked candidate authorization',async t=>{
  const f=await fixture(t,{metadata:{hasAudio:true}});let fingerprint='initial-user-decision',adopted=0;
  f.project.authorizeOperation=async(_projectId,_operation,_shotId,expected)=>{
    if(expected!==undefined&&expected!==fingerprint)throw new Error('制作模式或许可已变化');
    return fingerprint;
  };
  f.project.applyResult=async()=>{adopted++;return {assetIds:['adopted'],revision:2};};
  const task=await f.service.generate(f.input);assert.equal((await paused(f.service,task.id)).phase,'ready');
  fingerprint='replacement-user-decision';const postsBeforeAdoption=f.posts;
  await assert.rejects(f.service.apply(task.id,1,true),/许可已变化/);
  const rejected=await f.service.get(task.id);assert.equal(rejected.phase,'ready');assert.equal(rejected.productionPolicyFingerprint,'initial-user-decision');
  assert.equal(adopted,0);assert.equal(f.posts,postsBeforeAdoption);
});
