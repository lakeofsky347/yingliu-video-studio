import {accessSync,constants,lstatSync,mkdirSync,readFileSync,realpathSync,statSync,symlinkSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import semver from 'semver';

function isFile(file,executable=false){
  try{if(!statSync(file).isFile())return false;accessSync(file,executable?constants.X_OK:constants.R_OK);return true;}
  catch{return false;}
}

function packageBin(packageRoot){
  try{
    const manifest=JSON.parse(readFileSync(path.join(packageRoot,'package.json'),'utf8'));
    if(manifest.name!=='@deepseek-ai/dsh')return null;
    const bin=typeof manifest.bin==='string'?manifest.bin:manifest.bin?.dsh;
    if(typeof bin!=='string')return null;
    const entry=path.resolve(packageRoot,bin),relative=path.relative(packageRoot,entry);
    if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return null;
    return /\.(?:mjs|cjs|js)$/i.test(entry)&&isFile(entry)?entry:null;
  }catch{return null;}
}

function launchFor(file,platform,nodeExecutable){
  if(!isFile(file))return null;
  if(platform==='win32'&&/\.(?:cmd|bat)$/i.test(file)){
    // npm writes local .bin and global-prefix shims. Never execute their shell text.
    const directory=path.dirname(file);
    const entry=[path.resolve(directory,'../@deepseek-ai/dsh'),path.join(directory,'node_modules/@deepseek-ai/dsh')]
      .map(packageBin).find(Boolean);
    if(!entry)throw new Error(`Cannot safely launch ${file}. Set DSH_CLI to the official @deepseek-ai/dsh JavaScript bin (lib/bin.js).`);
    return {command:nodeExecutable,prefixArgs:[entry],sourcePath:file};
  }
  const actual=realpathSync(file);
  if(/\.(?:mjs|cjs|js)$/i.test(actual))return {command:nodeExecutable,prefixArgs:[actual],sourcePath:file};
  if(platform==='win32'&&!/\.(?:exe|com)$/i.test(file))return null;
  if(platform!=='win32'&&!isFile(file,true))return null;
  return {command:file,prefixArgs:[],sourcePath:file};
}

/** Return a shell-free command and arguments; an explicit override never falls back. */
export function resolveDshCli({env=process.env,platform=process.platform,cwd=process.cwd(),nodeExecutable=process.execPath,macDefault='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'}={}){
  const pathValue=Object.entries(env).find(([key])=>platform==='win32'?key.toLowerCase()==='path':key==='PATH')?.[1]??'';
  const directories=pathValue.split(platform==='win32'?';':':').filter(Boolean).map(directory=>path.resolve(cwd,directory.replace(/^"(.*)"$/,'$1')));
  const candidates=name=>{
    const extensions=platform==='win32'&&!path.extname(name)?['.exe','.com','.cmd','.bat']:[''];
    return directories.flatMap(directory=>extensions.map(extension=>path.join(directory,name+extension)));
  };
  if(env.DSH_CLI!==undefined){
    if(!env.DSH_CLI.trim())throw new Error('DSH_CLI is empty. Specify a DSH executable or JavaScript bin.');
    const explicit=path.resolve(cwd,env.DSH_CLI);
    const files=isFile(explicit)?[explicit]:(!env.DSH_CLI.includes('/')&&!env.DSH_CLI.includes('\\')?candidates(env.DSH_CLI):[explicit]);
    for(const file of files){const launch=launchFor(file,platform,nodeExecutable);if(launch)return launch;}
    throw new Error(`DSH_CLI is unavailable or not executable: ${env.DSH_CLI}`);
  }
  for(const file of candidates('dsh')){const launch=launchFor(file,platform,nodeExecutable);if(launch)return launch;}
  if(platform==='darwin'){const launch=launchFor(macDefault,platform,nodeExecutable);if(launch)return launch;}
  throw new Error('DSH was not found on PATH. Install the official DSH host or set DSH_CLI to its executable / JavaScript bin.');
}

/** Link package directories without requiring Windows file-symlink privileges. */
export function ensureDirectoryLink(target,link,{platform=process.platform}={}){
  const destination=realpathSync(target);
  if(!statSync(destination).isDirectory())throw new Error(`Dependency directory does not exist: ${target}`);
  let current;
  try{current=lstatSync(link);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(current){
    if(!current.isSymbolicLink())throw new Error(`Refusing to replace an existing directory or file: ${link}`);
    try{if(path.relative(realpathSync(link),destination)==='')return;}catch(error){if(error.code!=='ENOENT')throw error;}
    unlinkSync(link);
  }
  mkdirSync(path.dirname(link),{recursive:true});
  symlinkSync(destination,link,platform==='win32'?'junction':'dir');
}

/** Validate every peer before creating any link. This leaves the plugin lockfile intact. */
export function linkHostDependencies(root,hostNodeModules){
  const manifest=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
  const peers=Object.entries(manifest.peerDependencies??{}).map(([name,expected])=>{
    const target=path.join(hostNodeModules,name),peer=JSON.parse(readFileSync(path.join(target,'package.json'),'utf8'));
    if(peer.name!==name)throw new Error(`Unexpected host package at ${target}`);
    // Match DSH's prerelease-aware loader without tying development to a host release.
    const compatible=typeof peer.version==='string'&&semver.satisfies(peer.version,expected,{includePrerelease:true});
    if(!compatible)throw new Error(`Host peer ${name}@${peer.version} does not satisfy ${expected}`);
    return {target,link:path.join(root,'node_modules',name)};
  });
  for(const {target,link} of peers)ensureDirectoryLink(target,link);
  return peers.length;
}
