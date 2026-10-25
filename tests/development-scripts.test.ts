import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ensureDirectoryLink,linkHostDependencies,resolveDshCli} from '../scripts/dev-environment.mjs';

const exec=promisify(execFile);
async function directory(){return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-dev 空格-')));}
async function file(root:string,name:string,text='fixture'){const location=path.join(root,name);await fs.mkdir(path.dirname(location),{recursive:true});await fs.writeFile(location,text);return location;}
async function officialShim(root:string,global=false){
  const packageRoot=path.join(root,global?'node_modules/@deepseek-ai/dsh':'@deepseek-ai/dsh');
  const entry=await file(packageRoot,'lib/bin.js','console.log(JSON.stringify(process.argv.slice(2)));');
  await file(packageRoot,'package.json',JSON.stringify({name:'@deepseek-ai/dsh',type:'module',bin:{dsh:'lib/bin.js'}}));
  const shim=await file(root,global?'dsh.cmd':'.bin/dsh.cmd','@echo This arbitrary shell text must never run');
  return {shim,entry,packageRoot};
}

test('explicit DSH_CLI takes priority, including paths with spaces; invalid overrides never fall back',async()=>{
  const root=await directory();
  try{
    const explicit=await file(root,'自选 CLI.mjs',''),fallback=await file(root,'dsh','#!/usr/bin/env node\n');await fs.chmod(fallback,0o755);
    const selected=resolveDshCli({platform:'linux',cwd:root,env:{DSH_CLI:explicit,PATH:root}});
    assert.equal(selected.command,process.execPath);assert.deepEqual(selected.prefixArgs,[explicit]);
    assert.throws(()=>resolveDshCli({platform:'linux',cwd:root,env:{DSH_CLI:'missing-dsh',PATH:root}}),/DSH_CLI is unavailable/);
    assert.throws(()=>resolveDshCli({env:{DSH_CLI:'',PATH:root}}),/DSH_CLI is empty/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('PATH is searched before the macOS app fallback, and other platforms have no macOS fallback',async()=>{
  const root=await directory();
  try{
    const executable=await file(root,'dsh','#!/usr/bin/env node\n');await fs.chmod(executable,0o755);
    const app=await file(root,'macOS-fallback.mjs','');
    // A simulated Unix PATH must not contain a Windows drive colon.
    assert.equal(resolveDshCli({platform:'darwin',cwd:root,env:{PATH:'.'},macDefault:app}).command,executable);
    assert.equal(resolveDshCli({platform:'darwin',env:{PATH:''},macDefault:app}).prefixArgs[0],app);
    assert.throws(()=>resolveDshCli({platform:'linux',env:{PATH:''},macDefault:app}),/not found on PATH/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Windows local and global npm shims load the official JavaScript bin without invoking a shell',async()=>{
  const root=await directory();
  try{
    for(const global of [false,true]){
      const prepared=await officialShim(path.join(root,global?'global & prefix':'local & modules'),global);
      const launch=resolveDshCli({platform:'win32',env:{Path:path.dirname(prepared.shim)}});
      assert.equal(launch.command,process.execPath);assert.deepEqual(launch.prefixArgs,[prepared.entry]);
      const arguments_=['中文 空格','& do-not-execute','$(do-not-execute)','%DO_NOT_EXPAND%'];
      const result=await exec(launch.command,[...launch.prefixArgs,...arguments_],{shell:false});
      assert.deepEqual(JSON.parse(result.stdout),arguments_);
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Windows arbitrary .cmd files and untrusted or escaped package bins are rejected',async()=>{
  const root=await directory();
  try{
    const shim=await file(root,'dsh.cmd','@echo must-not-run');
    assert.throws(()=>resolveDshCli({platform:'win32',env:{DSH_CLI:shim}}),/Cannot safely launch/);
    const prepared=await officialShim(root,true);
    await file(prepared.packageRoot,'package.json',JSON.stringify({name:'other-package',bin:{dsh:'lib/bin.js'}}));
    assert.throws(()=>resolveDshCli({platform:'win32',env:{DSH_CLI:shim}}),/Cannot safely launch/);
    await file(prepared.packageRoot,'package.json',JSON.stringify({name:'@deepseek-ai/dsh',bin:{dsh:'../escaped.js'}}));
    assert.throws(()=>resolveDshCli({platform:'win32',env:{DSH_CLI:shim}}),/Cannot safely launch/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('directory links use the existing real target and replace stale links without overwriting real directories',async()=>{
  const root=await directory();
  try{
    const first=path.join(root,'插件 一'),second=path.join(root,'插件 二'),link=path.join(root,'profile/node_modules/plugin');
    await fs.mkdir(first);await fs.mkdir(second);ensureDirectoryLink(first,link);assert.equal(await fs.realpath(link),await fs.realpath(first));
    ensureDirectoryLink(first,link);ensureDirectoryLink(second,link);assert.equal(await fs.realpath(link),await fs.realpath(second));
    await fs.rm(second,{recursive:true});ensureDirectoryLink(first,link);assert.equal(await fs.realpath(link),await fs.realpath(first));
    const real=path.join(root,'real-directory');await fs.mkdir(real);
    assert.throws(()=>ensureDirectoryLink(first,real),/Refusing to replace/);
    assert.throws(()=>ensureDirectoryLink(path.join(root,'missing'),path.join(root,'bad-link')),/ENOENT/);
    await assert.rejects(fs.lstat(path.join(root,'bad-link')),/ENOENT/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('host peers are preflighted for names and versions before linking, preserving the lockfile',async()=>{
  const root=await directory();
  try{
    const plugin=path.join(root,'plugin'),host=path.join(root,'host/node_modules');
    await file(plugin,'package.json',JSON.stringify({peerDependencies:{'@deepseek-ai/cordis':'^4.0.4','@deepseek-ai/dsh-llm':'0.2.0-rc.2'}}));
    const lock=await file(plugin,'package-lock.json','untouched-lock');
    await file(host,'@deepseek-ai/cordis/package.json',JSON.stringify({name:'@deepseek-ai/cordis',version:'4.0.5'}));
    await file(host,'@deepseek-ai/dsh-llm/package.json',JSON.stringify({name:'@deepseek-ai/dsh-llm',version:'0.2.0-rc.1'}));
    assert.throws(()=>linkHostDependencies(plugin,host),/does not satisfy/);
    await assert.rejects(fs.lstat(path.join(plugin,'node_modules')));
    await file(host,'@deepseek-ai/dsh-llm/package.json',JSON.stringify({name:'wrong-package',version:'0.2.0-rc.2'}));
    assert.throws(()=>linkHostDependencies(plugin,host),/Unexpected host package/);
    await assert.rejects(fs.lstat(path.join(plugin,'node_modules')));
    await file(host,'@deepseek-ai/dsh-llm/package.json',JSON.stringify({name:'@deepseek-ai/dsh-llm',version:'0.2.0-rc.2'}));
    assert.equal(linkHostDependencies(plugin,host),2);assert.equal(await fs.readFile(lock,'utf8'),'untouched-lock');
    assert.equal(await fs.realpath(path.join(plugin,'node_modules/@deepseek-ai/dsh-llm')),await fs.realpath(path.join(host,'@deepseek-ai/dsh-llm')));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('release-independent DSH peers accept prereleases and future releases while the Cordis kernel range is enforced',async()=>{
  const root=await directory();
  try{
    const plugin=path.join(root,'plugin'),host=path.join(root,'host/node_modules');
    await file(plugin,'package.json',JSON.stringify({peerDependencies:{'@deepseek-ai/cordis':'^4.0.4','@deepseek-ai/dsh-llm':'*'}}));
    await file(host,'@deepseek-ai/cordis/package.json',JSON.stringify({name:'@deepseek-ai/cordis',version:'4.0.5'}));
    for(const version of ['0.2.1-rc.2','0.2.1-rc.3','0.2.2-alpha.1','0.3.0','1.0.0-rc.1','2.0.0']){
      await file(host,'@deepseek-ai/dsh-llm/package.json',JSON.stringify({name:'@deepseek-ai/dsh-llm',version}));
      assert.equal(linkHostDependencies(plugin,host),2,version);
    }
    await file(host,'@deepseek-ai/cordis/package.json',JSON.stringify({name:'@deepseek-ai/cordis',version:'5.0.0'}));
    assert.throws(()=>linkHostDependencies(plugin,host),/does not satisfy \^4.0.4/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('prepare-local refuses implicit personal paths and missing explicit references with setup guidance',async()=>{
  const env={...process.env};delete env.DSH_REFERENCE_PLUGIN;
  const script=path.resolve(import.meta.dirname,'../scripts/prepare-local.mjs');
  await assert.rejects(exec(process.execPath,[script],{env}),error=>error instanceof Error&&/DSH_REFERENCE_PLUGIN.*npm ci/.test(error.message));
  await assert.rejects(exec(process.execPath,[script],{env:{...env,DSH_REFERENCE_PLUGIN:path.join(os.tmpdir(),'missing-dsh-reference')}}),error=>error instanceof Error&&/Missing reference dependency/.test(error.message));
});

test('preview initializes an isolated profile, links a plugin with spaces and passes launcher arguments without a shell',async()=>{
  const root=await directory();
  try{
    const cli=await file(root,'测试 CLI.mjs',`import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),profile=args[args.indexOf('--profile')+1];
if(args.includes('--from-default-profile')){const target=path.join(process.env.DSH_HOME,'profiles',profile);fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'cordis.yml'),'[]\\n');fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({dependencies:{},dsh:{profile:{bundles:[]}}}));}
else console.log(JSON.stringify({args,home:process.env.DSH_HOME,projects:process.env.DSH_VIDEO_PROJECTS}));`);
    const plugin=path.join(root,'插件 & 目录'),home=path.join(root,'隔离 home'),projects=path.join(root,'工程 目录'),profile='影片 预览';
    await file(plugin,'lib/index.js','');
    const extra=await file(root,'extra.yml','- id: locale\n  config:\n    preference: zh\n');
    const result=await exec(process.execPath,[path.resolve(import.meta.dirname,'../scripts/preview.mjs')],{env:{...process.env,DSH_CLI:cli,DSH_PREVIEW_PLUGIN:plugin,DSH_PREVIEW_HOME:home,DSH_PREVIEW_PROJECTS:projects,DSH_PREVIEW_PROFILE:profile,DSH_PREVIEW_PORT:'19699',DSH_SESSION_FIXTURE:'1',DSH_OFFLINE:'1',DSH_PREVIEW_EXTRA_PATCH:extra},shell:false});
    const launched=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    assert.deepEqual(launched,{args:['--profile',profile,'--no-open','--port','19699'],home,projects});
    const location=path.join(home,'profiles',profile),manifest=JSON.parse(await fs.readFile(path.join(location,'package.json'),'utf8'));
    assert.equal(manifest.dependencies['dsh-video-studio'],`link:${plugin}`);
    assert.deepEqual(manifest.dsh.profile.bundles,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-video-studio']);
    assert.equal(await fs.realpath(path.join(location,'node_modules/dsh-video-studio')),await fs.realpath(plugin));
    const patch=await fs.readFile(path.join(location,'cordis.patch.yml'),'utf8');
    assert.match(patch,/video-studio-session-offline/);assert.match(patch,/preference: zh/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
