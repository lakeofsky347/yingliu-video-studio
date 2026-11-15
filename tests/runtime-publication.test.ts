import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {VideoRenderer,writeRuntimeFile} from '../src/host/renderer.ts';
import {ProjectStore} from '../src/host/store.ts';
import {createCodeProject} from './fixtures/production.ts';
import {defaultSceneSource} from '../src/core/index.ts';
import {sanitizeTaskFailure,taskFailure,withTaskFailure} from '../src/shared/task-diagnostic.ts';

function manifestUrl(html:string,base:string):string {const value=/<meta name="video-studio-spec" content="([^"]+)"/.exec(html)?.[1];assert.ok(value);return new URL(value,base).href;}

test('immutable runtime graphs survive later publication without widening scene resource permissions',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-publish-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
  try{
    let project=createCodeProject('固定版本预览');project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);
    const created=await store.create(project);project=created.project;
    const firstUrl=await renderer.preview(created.root,project),firstHtml=await(await fetch(firstUrl)).text(),firstManifest=manifestUrl(firstHtml,firstUrl);
    const first=await(await fetch(firstManifest)).json(),shotId=project.shots[0]!.id,firstOrigin=first.codeOrigins[shotId];
    const oldCode=await(await fetch(firstOrigin+'/runtime/code-spec-'+shotId+'.json')).json(),oldModule=new URL(oldCode.sources[0].moduleUrl,firstOrigin+'/runtime/frame.mjs');
    const oldBytes=await(await fetch(oldModule)).text();
    const source=defaultSceneSource();source.js='export function render(ctx){ctx.root.textContent="new version";}';project.revision++;
    project=await store.commit(created.root,project,{[shotId]:source});
    const secondUrl=await renderer.preview(created.root,project),secondHtml=await(await fetch(secondUrl)).text(),second=await(await fetch(manifestUrl(secondHtml,secondUrl))).json();
    assert.notEqual(secondUrl,firstUrl);assert.notEqual(second.codeOrigins[shotId],firstOrigin);
    assert.equal(await(await fetch(firstUrl)).text(),firstHtml);assert.deepEqual(await(await fetch(firstManifest)).json(),first);
    assert.equal(await(await fetch(oldModule)).text(),oldBytes);
    const newCode=await(await fetch(second.codeOrigins[shotId]+'/runtime/code-spec-'+shotId+'.json')).json();
    assert.equal((await fetch(new URL(newCode.sources[0].moduleUrl,firstOrigin+'/runtime/frame.mjs'))).status,403);
    assert.equal((await fetch(new URL(oldCode.sources[0].moduleUrl,second.codeOrigins[shotId]+'/runtime/frame.mjs'))).status,403);
    assert.equal((await fetch(firstOrigin+'/project.json')).status,403);
    assert.match((await fetch(firstOrigin+'/code.html')).headers.get('content-security-policy')!,/media-src 'none'/);
    const currentManifest=await(await fetch(new URL('/runtime/spec.json',secondUrl))).json();assert.deepEqual(currentManifest,second);
    project.productionPolicy!.decisionId=randomUUID();project.revision++;project=await store.commit(created.root,project,{});
    const latestUrl=await renderer.preview(created.root,project);
    assert.equal((await fetch(firstUrl)).status,403);assert.equal((await fetch(firstOrigin+'/code.html')).status,403);
    const unconfirmed=structuredClone(project);unconfirmed.revision++;unconfirmed.productionPolicy!.decisionId=randomUUID();unconfirmed.productionPolicy!.mode='unresolved';
    await assert.rejects(renderer.preview(created.root,unconfirmed),/模式|确认/);
    assert.equal((await fetch(latestUrl)).status,403,'A newly unrenderable policy must still revoke the preceding runtime');
  }finally{await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('publication repairs missing or damaged immutable dependencies and leaves the old index on failure',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-repair-')),store=new ProjectStore({baseDirectory:directory}),renderer=new VideoRenderer(store);
  try{
    const created=await store.create(createCodeProject('修复运行文件')),url=await renderer.preview(created.root,created.project),html=await(await fetch(url)).text();
    const manifest=manifestUrl(html,url),file=path.join(created.root,new URL(manifest).pathname),bytes=await fs.readFile(file);
    await fs.writeFile(file,'corrupt');await renderer.preview(created.root,created.project);assert.deepEqual(await fs.readFile(file),bytes);
    await fs.rm(file);await renderer.preview(created.root,created.project);assert.deepEqual(await fs.readFile(file),bytes);
    const index=await fs.readFile(path.join(created.root,'index.html'),'utf8'),rename=fs.rename;
    t.mock.method(fs,'rename',async(from:any,to:any)=>{if(String(to)===path.join(created.root,'index.html'))throw Object.assign(new Error('fixture publication failure'),{code:'ENOSPC',syscall:'rename'});return rename(from,to);});
    await assert.rejects(renderer.preview(created.root,{...created.project,title:'new title'}),(error:any)=>error.failure?.operation==='runtime_index_publish'&&error.failure?.ioCode==='ENOSPC');
    assert.equal(await fs.readFile(path.join(created.root,'index.html'),'utf8'),index);
    assert.ok(!(await fs.readdir(created.root)).some(name=>name.includes('.tmp-')));
  }finally{await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('HTTP headers and body use the same opened inode, including HEAD and empty files',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-inode-')),renderer=new VideoRenderer();
  try{
    const destination=path.join(directory,'sample.txt'),retained=path.join(directory,'retained-generation.txt');
    const previous='old bytes',replacement='a different and longer generation';
    // Both pathname generations differ from the retained handle, catching path
    // stat calls made either before or after open returns.
    await fs.writeFile(destination,'intermediate pathname generation');await fs.writeFile(retained,previous);const base=await renderer.assetBaseUrl(directory),open=fs.open;
    let replaced=false;t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
      if(String(args[0])===destination&&!replaced){
        replaced=true;
        // Keep a real old-generation handle while the requested pathname points
        // to new bytes. The pathname being replaced is not open on Windows.
        const handle=await open(retained,'r');
        try{const temporary=destination+'.replacement';await fs.writeFile(temporary,replacement);await fs.rename(temporary,destination);return handle;}
        catch(error){await handle.close();throw error;}
      }
      return open(...args);
    });
    const response=await fetch(base+'sample.txt');assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(Buffer.byteLength(previous)));assert.equal(await response.text(),previous);
    assert.equal(await fs.readFile(destination,'utf8'),replacement);assert.ok((await fs.stat(destination)).size>Buffer.byteLength(previous));
    const head=await fetch(base+'sample.txt',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(Buffer.byteLength(replacement)));assert.equal(await head.text(),'');
    await fs.writeFile(path.join(directory,'empty.txt'),'');const empty=await fetch(base+'empty.txt');assert.equal(empty.status,200);assert.equal(empty.headers.get('content-length'),'0');assert.equal(await empty.text(),'');
  }finally{await renderer.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('Windows runtime retry is limited to EPERM rename and preserves committed bytes',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-retry-')),destination=path.join(directory,'index.html'),rename=fs.rename;
  try{
    await fs.writeFile(destination,'old');let attempts=0;
    t.mock.method(fs,'rename',async(from:any,to:any)=>{attempts++;assert.equal(await fs.readFile(destination,'utf8'),'old');if(attempts<3)throw Object.assign(new Error('locked'),{code:'EPERM',syscall:'rename'});return rename(from,to);});
    await writeRuntimeFile(destination,'complete','win32');assert.equal(attempts,3);assert.equal(await fs.readFile(destination,'utf8'),'complete');
    const later=Object.assign(new Error('other error'),{code:'EIO',syscall:'rename'});attempts=0;
    t.mock.method(fs,'rename',async()=>{attempts++;if(attempts===1)throw Object.assign(new Error('locked'),{code:'EPERM',syscall:'rename'});throw later;});
    await assert.rejects(writeRuntimeFile(destination,'next','win32'),error=>error===later);assert.equal(attempts,2);assert.equal(await fs.readFile(destination,'utf8'),'complete');
    const denied=Object.assign(new Error('not a replacement lock'),{code:'EACCES',syscall:'rename'});attempts=0;t.mock.method(fs,'rename',async()=>{attempts++;throw denied;});
    await assert.rejects(writeRuntimeFile(destination,'next','win32'),error=>error===denied);assert.equal(attempts,1);
    const first=Object.assign(new Error('first lock'),{code:'EPERM',syscall:'rename'});attempts=0;
    t.mock.method(fs,'rename',async()=>{attempts++;throw attempts===1?first:Object.assign(new Error('later lock'),{code:'EPERM',syscall:'rename'});});
    await assert.rejects(writeRuntimeFile(destination,'next','win32'),error=>error===first);assert.ok(attempts>=1&&attempts<=8);assert.equal(await fs.readFile(destination,'utf8'),'complete');
    assert.deepEqual(await fs.readdir(directory),['index.html']);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('diagnostics retain fixed classifications without paths, secrets or arbitrary properties',()=>{
  const error=Object.assign(new Error('/private/token?key=secret'),{code:'EPERM',syscall:'rename',path:'/private/file',failure:{category:'IO_ERROR',operation:'runtime_index_publish',secret:'key'}});
  assert.deepEqual(taskFailure(error,'task_work'),{category:'IO_ERROR',operation:'runtime_index_publish',ioCode:'EPERM',syscall:'rename'});
  assert.equal(JSON.stringify(taskFailure(error,'task_work')).includes('secret'),false);
  assert.equal(sanitizeTaskFailure({category:'IO_ERROR',operation:'/secret'}),undefined);
  const frozen=Object.freeze(error),wrapped=withTaskFailure(frozen,'task_work');assert.equal(wrapped.cause,frozen);assert.equal(wrapped.failure.operation,'runtime_index_publish');
  assert.equal(taskFailure(new Error('Task cancelled'),'render_frame').category,'CANCELLED');
});
