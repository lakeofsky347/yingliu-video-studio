import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,dirname,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {freezeLocalVideo} from '../src/host/local-import.ts';
import {StudioService} from '../src/host/service.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {StudioSnapshot} from '../src/shared/types.ts';

const denied=()=>Object.assign(new Error('fixture FlushFileBuffers denied'),{code:'EPERM',syscall:'fsync'});
/** Model Windows' writable-handle requirement on every native test host. */
function requireWritableSync(t:TestContext,match:(file:string)=>boolean,fail=false){
  const original=fs.open;let syncs=0;
  const mock=t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await original(...args);if(!match(String(args[0])))return handle;
    const flags=args[1]??'r',writable=typeof flags==='number'?(flags&(constants.O_WRONLY|constants.O_RDWR))!==0:flags.includes('+')||/^[wa]/.test(flags),sync=handle.sync.bind(handle);
    handle.sync=async()=>{syncs++;if(!writable||fail)throw denied();return sync();};return handle;
  });syncBuiltinESMExports();
  return {get syncs(){return syncs;},restore(){mock.mock.restore();syncBuiltinESMExports();}};
}

for(const fail of [false,true])test(`frozen video sync uses write access and ${fail?'propagates real EPERM':'preserves complete bytes'}`,async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'import-video-sync-')),source=join(directory,'source.mp4'),target=join(directory,'staging/fixed.video'),bytes=Buffer.alloc(1024,7);
  await fs.writeFile(source,bytes);await fs.chmod(source,0o444);const guard=requireWritableSync(t,file=>file===target,fail);
  try{
    if(fail){await assert.rejects(freezeLocalVideo({path:source},target,2048),{code:'EPERM'});await assert.rejects(fs.stat(target),{code:'ENOENT'});}
    else{const result=await freezeLocalVideo({path:source},target,2048);assert.equal(result?.input.path,target);assert.deepEqual(await fs.readFile(target),bytes);}
    assert.equal(guard.syncs,1);assert.deepEqual(await fs.readFile(source),bytes,'the source stays read-only and unchanged');
  }finally{guard.restore();await fs.chmod(source,0o600);await fs.rm(directory,{recursive:true,force:true});}
});

for(const fail of [false,true])test(`import asset sync uses write access and ${fail?'does not acknowledge EPERM':'commits a durable receipt'}`,async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'import-asset-sync-')),source=join(directory,'readonly-source.png');
  const ctx={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('unexpected provider');}}} as unknown as HostContext;
  const service=new StudioService(ctx,{baseDirectory:directory,restoreRecent:false});
  service.renderer.assetBaseUrl=async()=> 'http://127.0.0.1:1/';service.renderer.preview=async()=> 'http://127.0.0.1:1/preview';service.renderer.audioPreview=async()=>null;
  let guard:ReturnType<typeof requireWritableSync>|undefined;
  try{
    const created=await service.rpc('create',{productionMode:'code_animation'});assert.equal(created.ok,true);const initial=(created as {ok:true;value:StudioSnapshot}).value;
    const assets=join(initial.root!,'assets');guard=requireWritableSync(t,file=>dirname(file)===assets&&extname(file)==='.png',fail);
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yD1sAAAAASUVORK5CYII=','base64');
    await fs.writeFile(source,bytes);await fs.chmod(source,0o444);
    const result=await service.rpc('import',{expectedRevision:initial.project!.revision,requestId:'fixed-image',name:'fixture.png',mime:'image/png',path:source}),current=await service.snapshot();
    assert.equal(guard.syncs,1);assert.equal(result.ok,!fail);
    assert.deepEqual(await fs.readFile(source),bytes,'read-only user input remains readable and unchanged');
    const receipts=await fs.readdir(join(initial.root!,'.studio/imports')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    if(fail){if(!result.ok)assert.equal(result.error.code,'EPERM');assert.equal(current.project!.revision,initial.project!.revision);assert.equal(current.project!.assets.length,0);assert.equal(receipts.filter(file=>file.endsWith('.json')).length,0);}
    else{assert.equal(current.project!.revision,initial.project!.revision+1);assert.equal(current.project!.assets.length,1);assert.deepEqual(await fs.readFile(join(initial.root!,current.project!.assets[0]!.path!)),bytes);assert.equal(receipts.filter(file=>file.endsWith('.json')).length,1);}
  }finally{guard?.restore();await service.dispose();await fs.chmod(source,0o600).catch(error=>{if(error.code!=='ENOENT')throw error;});await fs.rm(directory,{recursive:true,force:true});}
});
