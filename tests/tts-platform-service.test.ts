import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StudioService} from '../src/host/service.ts';
import type {HostContext} from '../src/host/platform.ts';

function context(values:Map<string,string>,canDelete=true):HostContext {
  return {llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No model request');}},get:(name:string)=>name==='credentials'?{resolve:async(ref:string)=>values.has(ref)?{value:values.get(ref)!}:undefined,set:async(ref:string,value:string)=>{values.set(ref,value);},...(canDelete?{unset:async(ref:string)=>{values.delete(ref);}}:{})}:undefined} as unknown as HostContext;
}
test('clearing a stored speech key is independent of a migrated unavailable endpoint',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-tts-platform-')),values=new Map([['DSH_VIDEO_STUDIO_TTS_API_KEY','fixture-secret']]);
  await writeFile(join(base,'tts.json'),JSON.stringify({endpoint:'local:say',model:'',voice:'',speed:1,enabled:true}));
  const service=new StudioService(context(values),{baseDirectory:base,restoreRecent:false});
  try{const result=await service.rpc('tts',{apiKey:''});assert.equal(result.ok,true,result.ok?'':result.error.message);assert.equal(values.size,0);assert.equal((await service.snapshot()).tts?.endpoint,'local:say');}
  finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
test('a host without key deletion reports failure instead of claiming the stored key was removed',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-tts-no-delete-')),values=new Map([['DSH_VIDEO_STUDIO_TTS_API_KEY','fixture-secret']]);
  const service=new StudioService(context(values,false),{baseDirectory:base,restoreRecent:false});
  try{const result=await service.rpc('tts',{apiKey:''});assert.equal(result.ok,false);if(!result.ok)assert.match(result.error.message,/无法清除/);assert.equal(values.size,1);}
  finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
test('speech configuration across project services checks origin before reusing the stored key',async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-tts-origin-')),values=new Map<string,string>();
  const first=new StudioService(context(values),{baseDirectory:base,restoreRecent:false});
  const second=new StudioService(context(values),{baseDirectory:base,restoreRecent:false});
  try{
    await Promise.all([first.snapshot(),second.snapshot()]);
    const endpoint='https://tts-old.invalid/v1';
    assert.equal((await first.rpc('tts',{endpoint,model:'fixture',voice:'fixture',enabled:true,apiKey:'first-fixture'})).ok,true);
    const blocked=await second.rpc('tts',{endpoint:'https://tts-new.invalid/v1'});
    assert.equal(blocked.ok,false);
    if(!blocked.ok)assert.match(blocked.error.message,/更换语音接口域名/);
    assert.equal((await second.workflowVoiceSettings()).endpoint,endpoint);
    assert.equal((await second.rpc('tts',{endpoint:'https://tts-old.invalid/v2'})).ok,true);
    assert.equal((await first.workflowVoiceSettings()).apiKey,'first-fixture');

    const replacement='https://tts-new.invalid/v1';
    assert.equal((await first.rpc('tts',{endpoint:replacement,apiKey:'replacement-fixture'})).ok,true);
    const settings=await second.workflowVoiceSettings();
    assert.equal(settings.endpoint,replacement);
    assert.equal(settings.apiKey,'replacement-fixture');
    assert.equal((await second.rpc('tts',{apiKey:''})).ok,true);
    assert.equal((await first.rpc('tts',{endpoint:'https://tts-other.invalid/v1'})).ok,true);
    assert.equal((await second.workflowVoiceSettings()).apiKey,undefined);
  }finally{await Promise.all([first.dispose(),second.dispose()]);await rm(base,{recursive:true,force:true});}
});
test('enabling an unavailable local service does not persist its key or configuration',{skip:process.platform==='darwin'},async()=>{
  const base=await mkdtemp(join(tmpdir(),'dsh-tts-unavailable-')),values=new Map<string,string>();
  const service=new StudioService(context(values),{baseDirectory:base,restoreRecent:false});
  try{const result=await service.rpc('tts',{endpoint:'local:say',enabled:true,apiKey:'must-not-save'});assert.equal(result.ok,false);assert.equal(values.size,0);assert.equal((await service.snapshot()).tts?.enabled,false);}
  finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});
