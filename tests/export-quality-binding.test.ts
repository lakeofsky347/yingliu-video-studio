import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StudioService} from '../src/host/service.ts';
import {VideoRenderer} from '../src/host/renderer.ts';
import {ExportQualityReport} from '../src/client/ExportQualityReport.tsx';
import type {HostContext} from '../src/host/platform.ts';
import type {StudioSnapshot,VideoProject} from '../src/shared/types.ts';
import type {LocalQualityReport} from '../src/workflows/local-quality.ts';

const context={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('Export binding test must not call a provider');}}} as unknown as HostContext;
async function call<T=StudioSnapshot>(service:StudioService,endpoint:string,payload:unknown={}):Promise<T>{const result=await service.rpc(endpoint,payload);assert.equal(result.ok,true,result.ok?'':result.error.message);return (result.ok?result.value:undefined) as T;}
async function settled(service:StudioService){const deadline=Date.now()+10000;while(Date.now()<deadline){const snapshot=await service.snapshot();if(snapshot.task?.status!=='running')return snapshot;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Export binding task did not settle');}

test('export retains its QC evidence across a concurrent editor save, output revision advance and restart',async t=>{
  t.mock.method(VideoRenderer.prototype,'assetBaseUrl',async()=> 'http://127.0.0.1:1/fixture/');
  t.mock.method(VideoRenderer.prototype,'preview',async()=> 'http://127.0.0.1:1/fixture/index.html');
  t.mock.method(VideoRenderer.prototype,'audioPreview',async()=>null);
  t.mock.method(VideoRenderer.prototype,'captureCandidate',async()=>{throw new Error('fixture capture unavailable');});
  let begin!:()=>void,release!:()=>void;const began=new Promise<void>(resolve=>{begin=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  t.mock.method(VideoRenderer.prototype,'export',async(root:string,project:VideoProject)=>{begin();await blocked;return {id:'qc-evidence-output',path:join(root,'exports/qc-evidence-output/video.mp4'),createdAt:new Date().toISOString(),revision:project.revision,width:project.target.width,height:project.target.height,frameCount:1,duration:1};});
  const base=await mkdtemp(join(tmpdir(),'export-qc-binding-'));let service=new StudioService(context,{baseDirectory:base});
  try{
    let snapshot=await call(service,'create',{productionMode:'code_animation',title:'导出报告绑定'});const exportedRevision=snapshot.project!.revision,projectId=snapshot.project!.id;
    await call(service,'export',{expectedRevision:exportedRevision});await began;
    const edited=structuredClone(snapshot.project!);edited.title='导出期间的新编辑';await call(service,'save',{project:edited,expectedRevision:exportedRevision});release();snapshot=await settled(service);
    assert.equal(snapshot.task?.status,'complete',snapshot.task?.error);assert.equal(snapshot.project!.revision,exportedRevision+2);assert.equal(snapshot.project!.title,edited.title);
    const output=snapshot.project!.outputs[0]!,report=output.localQuality!;assert.ok(report);assert.equal(output.revision,exportedRevision);assert.equal(report.revision,exportedRevision);assert.equal(report.projectId,projectId);assert.equal(report.decision,'needs-review');assert.equal(report.scope.checkedFrames.length,0);assert.ok(report.scope.unchecked.length>0);
    assert.equal(await call(service,'quality.last'),null,'the historical report must not be mislabelled as the current editor check');
    assert.deepEqual(JSON.parse(await readFile(join(snapshot.root!,'.studio/quality/exports/'+output.id+'.json'),'utf8')),report);
    const markup=renderToStaticMarkup(createElement(ExportQualityReport,{report,revision:output.revision}));assert.match(markup,/本次导出检查/);assert.match(markup,/有待查看项目/);assert.ok(markup.includes(report.candidateHash));assert.match(markup,/实际分析 0/);assert.match(markup,/未检查范围不代表通过/);assert.match(markup,/声轨/);
    await service.dispose();service=new StudioService(context,{baseDirectory:base});snapshot=await call(service,'current');assert.deepEqual(snapshot.project!.outputs[0]!.localQuality,report);
    const loaded=await call<LocalQualityReport|null>(service,'quality.last');assert.equal(loaded,null);
  }finally{release();await service.dispose();await rm(base,{recursive:true,force:true});}
});
