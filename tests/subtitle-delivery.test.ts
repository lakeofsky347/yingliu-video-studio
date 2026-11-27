import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileSpec,createProject,deleteShot} from '../src/core/index.ts';
import {formatAss,formatSrt,projectSubtitles,sliceSubtitles} from '../src/core/subtitles.ts';
import {StudioService} from '../src/host/service.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {SubtitleCue} from '../src/shared/types.ts';

test('subtitles carry millisecond rounding, preserve Chinese multiline text and suppress ASS override syntax',()=>{
  const cue={id:'cue',startSeconds:1.9998,endSeconds:3.25,text:'第一行\n第二行 {\\b1} <字>',speaker:'导演'};
  assert.match(formatSrt([cue]),/00:00:02,000 --> 00:00:03,250\n导演：第一行\n第二行 .*&lt;字&gt;/);
  const target={width:1280,height:720,fps:{num:24000,den:1001},audioMode:'none' as const};
  assert.match(formatAss([cue],target),/00:00:02\.00,00:00:03\.25.*导演：第一行\\N第二行 ｛＼b1｝/);
});

test('explicit subtitles retain project-frame boundaries and rebase when reviewing a selected shot',()=>{
  let project=createProject('字幕剪辑','测试','code_animation');
  project.target.fps={num:24000,den:1001};
  const last=project.shots[1]!;
  const before=compileSpec(project),boundary=before.shots[1]!.startFrame*1001/24000;
  const cue:SubtitleCue={id:'cue',shotId:last.id,startSeconds:boundary,endSeconds:boundary+.5,text:'中文'};
  project={...project,subtitles:[cue]};
  const spec=compileSpec(project);
  assert.deepEqual(projectSubtitles(project),[cue]);
  assert.equal(sliceSubtitles(spec.subtitles,[spec.shots[1]!],spec.target)?.[0]?.startSeconds,0);
  assert.deepEqual(deleteShot(project,last.id).subtitles,[]);
  assert.deepEqual(projectSubtitles({...project,subtitles:[]}),[]);
});

test('subtitle export uses the saved revision and writes a separate sidecar',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yingliu-subtitle-test-'));
  const context={llm:{listProviders:()=>[]}} as unknown as HostContext;
  const service=new StudioService(context,{baseDirectory:root,restoreRecent:false});
  try{
    const created=await service.rpc('create',{title:'字幕测试',productionMode:'code_animation'});
    assert.equal(created.ok,true);
    const project=(await service.snapshot()).project!;
    project.subtitles=[{id:'cue',startSeconds:0,endSeconds:1,text:'这是一行字幕'}];
    assert.equal((await service.rpc('save',{project,expectedRevision:project.revision})).ok,true);
    const result=await service.rpc('subtitles.export',{format:'srt',expectedRevision:project.revision+1});
    assert.equal(result.ok,true,JSON.stringify(result));
    if(result.ok)assert.match(await readFile((result.value as {path:string}).path,'utf8'),/这是一行字幕/);
    assert.equal((await service.rpc('subtitles.export',{format:'ass',expectedRevision:project.revision})).ok,false);
  }finally{await service.dispose();await rm(root,{recursive:true,force:true});}
});
