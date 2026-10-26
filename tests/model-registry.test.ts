import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry } from '../src/models/registry.ts';
import type { ModelSecrets } from '../src/models/contracts.ts';

class Secrets implements ModelSecrets {
  values=new Map<string,string>();reads=0;
  async get(ref:string){this.reads++;return this.values.get(ref);}
  async set(ref:string,value:string){this.values.set(ref,value);}
  async delete(ref:string){this.values.delete(ref);}
}
async function fixture(work:(registry:ModelRegistry,secrets:Secrets,directory:string)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'studio-model-registry-'));try{const secrets=new Secrets(),registry=new ModelRegistry(directory,secrets);await registry.initialize();await work(registry,secrets,directory);}finally{await rm(directory,{recursive:true,force:true});}}

test('independent providers, models and roles survive restart without serializing credentials',()=>fixture(async(registry,secrets,directory)=>{
  const text=await registry.saveConnection({id:'text-a',name:'文本服务',baseUrl:'https://text.invalid/v1',apiKey:'synthetic-text-secret'});
  const video=await registry.saveConnection({id:'video-b',name:'视频服务',protocol:'video-gateway',baseUrl:'https://video.invalid/v1',apiKey:'synthetic-video-secret'});
  const director=await registry.saveModel({connectionId:text.id,model:'director-a'}),clip=await registry.saveModel({connectionId:video.id,model:'video-b'});
  await registry.bindRole('director',director.id);await registry.bindRole('video',clip.id);
  assert.notEqual(text.credentialRef,video.credentialRef);assert.equal(await registry.credential(text),'synthetic-text-secret');assert.equal(await registry.credential(video),'synthetic-video-secret');
  const persisted=await readFile(join(directory,'model-registry.json'),'utf8');assert.ok(!persisted.includes('synthetic-'));
  const reopened=new ModelRegistry(directory,secrets);assert.equal((await reopened.resolve('video')).model.id,clip.id);
  await assert.rejects(registry.bindRole('scene',clip.id),/协议/);await assert.rejects(registry.bindRole('vision',director.id),/能力/);
  await assert.rejects(registry.saveModel({connectionId:text.id,model:'director-a'}),/相同模型/);
  await registry.removeConnection(video.id);assert.equal(await secrets.get(video.credentialRef),undefined);assert.equal(await registry.credential(text),'synthetic-text-secret');await assert.rejects(registry.resolve('video'),/配置/);
}));

test('keyless connections never read a secret and catalogs use credential descriptions when supplied',()=>fixture(async(registry,secrets,directory)=>{
  const local=await registry.saveConnection({id:'local',name:'本地服务',baseUrl:'http://127.0.0.1:8042/v1',auth:'none'});
  const reads=secrets.reads;assert.equal(await registry.credential(local),undefined);await registry.list();assert.equal(secrets.reads,reads);
  let rawReads=0;const described=new ModelRegistry(join(directory,'described'),{get:async()=>{rawReads++;throw new Error('must not resolve');},set:async()=>{},delete:async()=>{},status:async()=>({available:true,backend:'test-vault',hasStoredKey:true})},{credentialRefFactory:id=>'TEST_'+id.toUpperCase()+'_KEY'});
  const connection=await described.saveConnection({id:'remote',name:'远程',baseUrl:'https://remote.invalid/v1'});assert.equal(connection.credentialRef,'TEST_REMOTE_KEY');assert.equal((await described.list()).connections[0]?.hasKey,true);assert.equal(rawReads,0);
}));

test('configuration writes serialize and running work prevents deletion while allowing credential rotation',()=>fixture(async(registry,secrets)=>{
  const connection=await registry.saveConnection({id:'a',name:'初始',baseUrl:'https://example.invalid/v1',apiKey:'old-synthetic-key'});
  await Promise.all([registry.saveConnection({id:'a',name:'改名'}),registry.saveConnection({id:'a',requestTimeoutMs:20000})]);
  const state=await registry.list();assert.equal(state.connections[0]?.name,'改名');assert.equal(state.connections[0]?.requestTimeoutMs,20000);
  const model=await registry.saveModel({connectionId:'a',model:'model-a'}),release=registry.acquire('a',model.id);
  await assert.rejects(registry.removeConnection('a'),/任务使用/);await assert.rejects(registry.removeModel(model.id),/任务使用/);await assert.rejects(registry.saveConnection({id:'a',baseUrl:'https://other.invalid/v1'}),/任务使用/);
  await registry.saveConnection({id:'a',apiKey:'rotated-synthetic-key'});assert.equal(await registry.credential(connection),'rotated-synthetic-key');
  release();registry.setUsageGuard(id=>id==='a');await assert.rejects(registry.removeConnection('a'),/任务使用/);registry.setUsageGuard(()=>false);await registry.removeConnection('a');assert.equal(secrets.values.size,0);
}));

test('registry rejects embedded URL credentials, sensitive model parameters and mismatched selections',()=>fixture(async registry=>{
  await assert.rejects(registry.saveConnection({name:'错误',baseUrl:'https://secret@example.invalid/v1'}),/无凭据/);
  await registry.saveConnection({id:'a',name:'接口',baseUrl:'https://example.invalid/v1'});
  await assert.rejects(registry.saveModel({connectionId:'a',model:'model',parameters:{apiKey:'do-not-store'}}),/凭据/);
  const model=await registry.saveModel({connectionId:'a',model:'model'});await assert.rejects(registry.resolve({modelId:model.id,connectionId:'different'}),/不匹配/);
}));


test('keyless connections remain removable without a credential service',()=>fixture(async(_registry,_secrets,directory)=>{
  const unavailable=new ModelRegistry(join(directory,'offline'),{get:async()=>{throw new Error('no credential service');},set:async()=>{throw new Error('no credential service');},delete:async()=>{throw new Error('no credential service');},status:async()=>({available:false,backend:'unavailable'})});
  const connection=await unavailable.saveConnection({name:'本地',baseUrl:'http://127.0.0.1:8042/v1',auth:'none'});await unavailable.removeConnection(connection.id);assert.equal((await unavailable.list()).connections.length,0);
}));
