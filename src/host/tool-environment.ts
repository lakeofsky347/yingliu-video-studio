import {accessSync, constants, statSync} from 'node:fs';
import path from 'node:path';
import type {EnvironmentInfo, EnvironmentSettings} from '../shared/types.js';

/** Injectable platform inputs keep discovery testable without changing the host process. */
export interface ToolEnvironmentOptions {
  platform?:NodeJS.Platform;
  env?:NodeJS.ProcessEnv;
  isExecutable?:(file:string,platform:NodeJS.Platform)=>boolean;
}

/** A health check verifies a launchable file, not merely an existing directory. */
export function isExecutableFile(file:string,platform:NodeJS.Platform=process.platform):boolean {
  if(!file)return false;
  try {
    if(!statSync(file).isFile())return false;
    // Windows has no POSIX executable bit. Direct spawn supports native executables,
    // whereas .cmd/.bat need a shell and are deliberately not selected here.
    if(platform==='win32'&&!/\.(?:exe|com)$/i.test(file))return false;
    accessSync(file,platform==='win32'?constants.F_OK:constants.X_OK);
    return true;
  }catch{return false;}
}

function context(options:ToolEnvironmentOptions) {
  const platform=options.platform??process.platform,env=options.env??process.env;
  const paths=platform==='win32'?path.win32:path.posix;
  const environment=(name:string):string=>{
    if(platform!=='win32')return env[name]??'';
    const key=Object.keys(env).find(key=>key.toUpperCase()===name.toUpperCase());
    return key?env[key]??'':'';
  };
  const directories=environment('PATH').split(platform==='win32'?';':':')
    .map(folder=>platform==='win32'?folder.replace(/^"(.*)"$/,'$1'):folder).filter(Boolean);
  return {platform,paths,environment,directories,isExecutable:options.isExecutable??isExecutableFile};
}

export function findToolExecutable(name:'ffmpeg'|'ffprobe',options:ToolEnvironmentOptions={}):string {
  const {platform,paths,directories,isExecutable}=context(options);
  const defaults=platform==='darwin'?['/opt/homebrew/bin','/usr/local/bin','/usr/bin']:
    platform==='linux'?['/usr/local/bin','/usr/bin','/bin','/snap/bin']:[];
  const filename=platform==='win32'?name+'.exe':name;
  const candidates=[...directories,...defaults].map(folder=>paths.join(folder,filename));
  return [...new Set(candidates)].find(file=>isExecutable(file,platform))??'';
}

export function findBrowserExecutable(options:ToolEnvironmentOptions={}):string {
  const {platform,paths,environment,directories,isExecutable}=context(options);
  let candidates:string[]=[];
  if(platform==='win32') {
    const roots=['LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)'].map(environment).filter(Boolean);
    candidates=roots.flatMap(root=>[
      paths.join(root,'Google','Chrome','Application','chrome.exe'),
      paths.join(root,'Chromium','Application','chrome.exe'),
      paths.join(root,'Microsoft','Edge','Application','msedge.exe')
    ]);
    candidates.push(...directories.flatMap(folder=>['chrome.exe','chromium.exe','msedge.exe'].map(name=>paths.join(folder,name))));
  }else if(platform==='darwin') {
    const home=environment('HOME'),roots=['/Applications',...(home?[paths.join(home,'Applications')]:[])];
    candidates=roots.flatMap(root=>[
      paths.join(root,'Google Chrome.app','Contents','MacOS','Google Chrome'),
      paths.join(root,'Chromium.app','Contents','MacOS','Chromium'),
      paths.join(root,'Microsoft Edge.app','Contents','MacOS','Microsoft Edge')
    ]);
    candidates.push(...[...directories,'/opt/homebrew/bin','/usr/local/bin'].flatMap(folder=>
      ['google-chrome','chromium','chrome','msedge'].map(name=>paths.join(folder,name))));
  }else if(platform==='linux') {
    const folders=[...directories,'/usr/local/bin','/usr/bin','/opt/google/chrome','/snap/bin'];
    candidates=folders.flatMap(folder=>['google-chrome','google-chrome-stable','chromium','chromium-browser','chrome','microsoft-edge','microsoft-edge-stable'].map(name=>paths.join(folder,name)));
    candidates.push('/snap/chromium/current/usr/lib/chromium-browser/chrome');
  }
  return [...new Set(candidates)].find(file=>isExecutable(file,platform))??'';
}

export function inspectToolEnvironment(settings:Partial<EnvironmentSettings>={},options:ToolEnvironmentOptions={}):EnvironmentInfo {
  const {platform,isExecutable}=context(options);
  // Explicit paths are retained even when invalid, so the environment page can
  // show the failing selection instead of hiding it behind automatic discovery.
  const browserPath=settings.browserPath||findBrowserExecutable(options);
  const ffmpegPath=settings.ffmpegPath||findToolExecutable('ffmpeg',options);
  const ffprobePath=settings.ffprobePath||findToolExecutable('ffprobe',options);
  return {browserPath,ffmpegPath,ffprobePath,...(settings.maxVideoBytes!==undefined?{maxVideoBytes:settings.maxVideoBytes}:{}),
    browserAvailable:!!browserPath&&isExecutable(browserPath,platform),
    ffmpegAvailable:!!ffmpegPath&&isExecutable(ffmpegPath,platform),
    ffprobeAvailable:!!ffprobePath&&isExecutable(ffprobePath,platform),
    platform,localSpeechAvailable:platform==='darwin'&&isExecutable('/usr/bin/say',platform)};
}
