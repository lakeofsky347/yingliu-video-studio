import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {VideoRenderer} from '../src/host/renderer.ts';
import {ProjectStore} from '../src/host/store.ts';
import {createCodeProject} from './fixtures/production.ts';

// These failures happen before browser/encoder launch. Existing executable paths
// satisfy discovery without starting media processes in this regression test.
const settings={browserPath:process.execPath,ffmpegPath:process.execPath,ffprobePath:process.execPath};

test('failed export publication releases snapshot listeners and preserves the live preview',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'renderer-export-lifetime-'));
  const store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
  try{
    const created=await store.create(createCodeProject('导出失败清理')),live=await renderer.preview(created.root,created.project);
    const html=await(await fetch(live)).text(),rename=fs.rename,opened:string[]=[];
    const server=(renderer as any).server.bind(renderer);
    t.mock.method(renderer as any,'server',async(...args:any[])=>{
      const result=await server(...args);if(result.root.includes(path.sep+'exports'+path.sep))opened.push(result.origin);return result;
    });
    t.mock.method(fs,'rename',async(from:any,to:any)=>{
      if(String(to).includes(path.sep+'exports'+path.sep)&&String(to).endsWith(path.join('snapshot','index.html')))
        throw Object.assign(new Error('injected snapshot publication failure'),{code:'ENOSPC',syscall:'rename'});
      return rename(from,to);
    });
    await assert.rejects(renderer.export(created.root,created.project,settings,new AbortController().signal,()=>{}),/injected snapshot publication failure/);
    assert.ok(opened.length>1,'the regression must reach compositor and scene listeners');
    for(const origin of new Set(opened))await assert.rejects(fetch(origin+'/index.html'),/fetch failed/);
    assert.equal(await(await fetch(live)).text(),html,'export cleanup must retain the live immutable runtime');
  }finally{await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('failed export diagnostics cannot hide the original capture error or retain snapshot listeners',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'renderer-export-diagnostic-'));
  const store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
  try{
    const created=await store.create(createCodeProject('保留导出失败首因')),opened:string[]=[];
    const server=(renderer as any).server.bind(renderer),writeFile=fs.writeFile;
    t.mock.method(renderer as any,'server',async(...args:any[])=>{const result=await server(...args);opened.push(result.origin);return result;});
    const original=Object.assign(new Error('injected browser launch failure'),{code:'BROWSER_FIXTURE'});
    t.mock.method(renderer as any,'openPage',async()=>{throw original;});
    t.mock.method(fs,'writeFile',async(file:any,...args:any[])=>{
      if(['ffmpeg.log','failure.json'].includes(path.basename(String(file))))throw Object.assign(new Error('injected diagnostic disk failure'),{code:'ENOSPC'});
      return (writeFile as any)(file,...args);
    });
    await assert.rejects(renderer.export(created.root,created.project,settings,new AbortController().signal,()=>{}),error=>error===original);
    assert.ok(opened.length>1);
    for(const origin of new Set(opened))await assert.rejects(fetch(origin+'/index.html'),/fetch failed/);
  }finally{await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});
