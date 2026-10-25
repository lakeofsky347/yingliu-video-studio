import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {atomicRename} from '../src/host/atomic-rename.ts';

function failure(code:string){return Object.assign(new Error(`fixture ${code}`),{code});}

test('transient Windows replacements keep the prior target intact until the same rename succeeds',async()=>{
  const folder=await fs.mkdtemp(join(tmpdir(),'dsh-atomic-rename-')),target=join(folder,'state.json'),source=join(folder,'state.json.tmp');
  await fs.writeFile(target,'committed version');await fs.writeFile(source,'complete next version');
  const delays:number[]=[];let calls=0;
  try{
    await atomicRename(source,target,{
      platform:'win32',
      async rename(from,to){
        calls++;assert.equal(from,source);assert.equal(to,target);
        assert.equal(await fs.readFile(target,'utf8'),'committed version');
        assert.equal(await fs.readFile(source,'utf8'),'complete next version');
        if(calls<3)throw failure(calls===1?'EPERM':'EBUSY');
        await fs.rename(from,to);
      },
      async delay(milliseconds){
        delays.push(milliseconds);assert.equal(await fs.readFile(target,'utf8'),'committed version');
      },
    });
    // The final real rename may itself briefly contend on a Windows runner.
    assert.ok(calls>=3&&calls<=7);assert.deepEqual(delays.slice(0,2),[10,20]);assert.equal(delays.length,calls-1);
    assert.equal(await fs.readFile(target,'utf8'),'complete next version');
    await assert.rejects(fs.stat(source),{code:'ENOENT'});
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('each supported Windows lock code is retried, and immediate success does not wait',async()=>{
  for(const code of ['EPERM','EACCES','EBUSY']){
    let calls=0;const delays:number[]=[];
    await atomicRename('source','target',{platform:'win32',async rename(){if(++calls===1)throw failure(code);},async delay(ms){delays.push(ms);}});
    assert.equal(calls,2);assert.deepEqual(delays,[10]);
  }
  let calls=0;
  await atomicRename('source','target',{platform:'win32',async rename(){calls++;},async delay(){assert.fail('Successful rename must not wait');}});
  assert.equal(calls,1);
});

test('persistent Windows lock exhausts its bounded budget and rethrows the original error with both files intact',async()=>{
  const folder=await fs.mkdtemp(join(tmpdir(),'dsh-atomic-locked-')),target=join(folder,'state.json'),source=join(folder,'state.json.tmp');
  await fs.writeFile(target,'committed version');await fs.writeFile(source,'complete next version');
  const error=failure('EACCES'),delays:number[]=[];let calls=0;
  try{
    await assert.rejects(atomicRename(source,target,{platform:'win32',async rename(){calls++;throw error;},async delay(ms){delays.push(ms);}}),value=>value===error);
    assert.equal(calls,7);assert.deepEqual(delays,[10,20,40,80,160,320]);
    assert.equal(delays.reduce((sum,value)=>sum+value,0),630);
    assert.equal(await fs.readFile(target,'utf8'),'committed version');
    assert.equal(await fs.readFile(source,'utf8'),'complete next version');
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('hard Windows errors propagate immediately and non-Windows errors are never retried',async()=>{
  for(const platform of ['win32','darwin','linux'] as const){
    const codes=platform==='win32'?['ENOENT','ENOTDIR','EXDEV','EIO','EEXIST']:['EPERM','EACCES','EBUSY'];
    for(const code of codes){
      const error=failure(code);let calls=0;
      await assert.rejects(atomicRename('source','target',{platform,async rename(){calls++;throw error;},async delay(){assert.fail('This error must not be retried');}}),value=>value===error);
      assert.equal(calls,1);
    }
  }
});
