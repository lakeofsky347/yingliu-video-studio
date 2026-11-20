import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, defaultShot, compileSpec, specMarkdown, validateProject, validateGraph,
  reorderShots, reorderFromGraph, addShot, duplicateShot, deleteShot, addAsset, bindAsset,
  unbindAsset, deleteAsset, UndoHistory, defaultSceneSource, normalizeSceneDurations,updateTarget,updateShot } from '../src/core/index.js';
import { normalizeStoryboard, parseSceneSource, parseModelJson } from '../src/host/generator.ts';

test('default project compiles three contiguous ten-second scenes in sequence order',()=>{
  const p=createProject('产品介绍','介绍工作流程');
  assert.equal(p.assets.length,0);assert.equal(p.targetDuration,30);
  const spec=compileSpec(p);
  assert.equal(spec.durationFrames,900);assert.equal(spec.durationSeconds,30);
  assert.deepEqual(spec.shots.map(s=>[s.startFrame,s.endFrame]),[[0,300],[300,600],[600,900]]);
  const q=reorderShots(p,[...p.shotOrder].reverse());q.graph.positions[p.shotOrder[0]]=[-999,0];
  assert.deepEqual(compileSpec(q).shots.map(s=>s.id),q.shotOrder);
  assert.equal(p.revision,0);assert.equal(q.revision,1);
  assert.match(specMarkdown(spec),/帧区间：\[0, 300\)/);
});

test('fractional FPS produces integer frame budgets without scaling time from canvas positions',()=>{
  const p=createProject('分数帧率');p.target.fps={num:30000,den:1001};
  p.shots=[defaultShot(0,p.target.fps),defaultShot(1,p.target.fps)];p.shotOrder=p.shots.map(s=>s.id);
  const spec=compileSpec(p);assert.equal(spec.durationFrames,600);assert.equal(spec.durationSeconds,20.02);
});

test('changing FPS preserves seconds without repeated rounding drift; edited shot timing takes precedence',()=>{
  let project=createProject('可切换时基');project.shots[0]!.durationFrames=31;const original=project.shots.map(s=>s.durationFrames);
  for(let i=0;i<8;i++){project=updateTarget(project,{fps:{num:24,den:1},width:1080,height:1080});project=updateTarget(project,{fps:{num:60,den:1}});project=updateTarget(project,{fps:{num:30,den:1}});}
  assert.deepEqual(project.shots.map(s=>s.durationFrames),original);assert.equal(project.target.width,1080);
  project=updateShot(project,project.shots[0]!.id,{durationFrames:90});project=updateTarget(project,{fps:{num:60,den:1}});
  assert.equal(project.shots[0]!.durationFrames,180);assert.equal(compileSpec(project).durationSeconds,23);
});

test('audio references follow shot removal and asset deletion while legacy silent projects remain valid',()=>{
  const project=createProject('音频数据');project.target.audioMode='mixed';project.assets.push({id:'voice',kind:'audio',name:'配音',description:'',path:'assets/voice.wav',duration:2,sampleRate:48000,channels:2});
  project.audioClips=[{id:'clip',assetId:'voice',role:'voice',shotId:project.shots[1]!.id,startSeconds:0,trimStart:0,volume:1,fadeIn:0,fadeOut:0}];
  assert.equal(validateProject(project).ok,true);assert.equal(deleteShot(project,project.shots[1]!.id).audioClips!.length,0);assert.equal(deleteAsset(project,'voice').audioClips!.length,0);
  const old=createProject('旧工程');delete old.audioClips;delete old.sessionIds;assert.equal(validateProject(old).ok,true);
});

test('duration normalization preserves exact budgets and one frame for every shot',()=>{
  const p=createProject('时长');p.shots[0].durationFrames=1;p.shots[1].durationFrames=1;p.shots[2].durationFrames=9;
  const normalized=normalizeSceneDurations(p.shots,5);
  assert.equal(normalized.reduce((sum,s)=>sum+s.durationFrames,0),5);
  assert.ok(normalized.every(s=>Number.isInteger(s.durationFrames)&&s.durationFrames>=1));
  assert.equal(p.shots[2].durationFrames,9);
  assert.throws(()=>normalizeSceneDurations(p.shots,2),/帧预算/);
  p.shots[0].durationFrames=Infinity;assert.throws(()=>normalizeSceneDurations(p.shots,30),/有限正数/);
});

test('binding, unbinding and deleting assets remove both production and reference links',()=>{
  let p=createProject('资产');const sid=p.shotOrder[0];
  p=addAsset(p,{id:'a',kind:'text',name:'文字',description:'脚本内容',text:'hello'});
  p=bindAsset(p,sid,'a');p=bindAsset(p,sid,'a','reference');
  assert.equal(bindAsset(p,sid,'a').revision,p.revision);
  const removed=unbindAsset(p,sid,'a');assert.deepEqual(removed.shots[0].assetIds,[]);
  assert.deepEqual(p.shots[0].assetIds,['a']);
  const clean=deleteAsset(p,'a');assert.equal(clean.assets.length,0);
  assert.deepEqual(clean.shots[0].assetIds,[]);assert.deepEqual(clean.shots[0].referenceIds,[]);
  assert.throws(()=>bindAsset(clean,sid,'missing'),/找不到资产/);
});

test('duplicate and delete update order without mutating original scene',()=>{
  const p=createProject('镜头');const q=duplicateShot(p,p.shotOrder[0]);
  assert.equal(q.shots.length,4);assert.notEqual(q.shotOrder[1],p.shotOrder[0]);
  assert.deepEqual(q.shots.at(-1)?.params,p.shots[0].params);
  assert.match(q.shots.at(-1)?.sourcePath||'',/^shots\//);
  assert.equal((q.extensions.sourceCopies as Record<string,string>)[q.shotOrder[1]],p.shots[0].sourcePath);
  const z=deleteShot(q,p.shotOrder[0]);assert.equal(z.shots.length,3);
  assert.equal(compileSpec(z).durationFrames,900);assert.equal(p.shots.length,3);
  assert.equal(addShot(p).shots.length,4);
});

test('duplicating a disconnected shot keeps the original graph and copies its source',()=>{
  const project=createProject('断开的分镜');
  const [a,b,c]=project.shotOrder;
  const draft=reorderFromGraph(project,[{from:a,to:b},{from:b,to:'film-output'}]);
  assert.ok(!draft.shotOrder.includes(c));
  const duplicate=duplicateShot(draft,c),copy=duplicate.shots.at(-1)!;
  assert.equal(duplicate.shots.length,draft.shots.length+1);
  assert.notEqual(copy.id,c);
  assert.deepEqual(duplicate.shotOrder,draft.shotOrder);
  assert.deepEqual(duplicate.extensions.graphEdges,draft.extensions.graphEdges);
  assert.equal((duplicate.extensions.sourceCopies as Record<string,string>)[copy.id],draft.shots[2]!.sourcePath);
  assert.equal(validateProject(duplicate).ok,true);
});

test('incomplete, branching and cyclic graph drafts save but cannot compile',()=>{
  const p=createProject('图');const [a,b,c]=p.shotOrder;
  const valid=[{from:a,to:b},{from:b,to:c},{from:c,to:'film-output'}];
  const linked=reorderFromGraph(p,valid);assert.equal(validateGraph(linked).ok,true);assert.equal(compileSpec(linked).durationFrames,900);
  for(const edges of [[],valid.slice(1),valid.slice(0,-1),[...valid,{from:a,to:c}],[...valid,{from:c,to:a}]]) {
    const draft=reorderFromGraph(p,edges);assert.equal(validateProject(draft).ok,true);
    assert.equal(validateGraph(draft).ok,false);assert.throws(()=>compileSpec(draft),/无法编译/);
  }
  const deleted=deleteShot(linked,b);assert.equal(validateGraph(deleted).ok,true);
  assert.deepEqual(deleted.extensions.graphEdges,[{from:a,to:c},{from:c,to:'film-output'}]);
});

test('bad order, noninteger timing, dangling assets and unsafe paths are rejected',()=>{
  const p=createProject('错误');
  const q=structuredClone(p);q.shotOrder=[p.shotOrder[0],p.shotOrder[0]];assert.throws(()=>compileSpec(q),/主链/);
  const z=structuredClone(p);z.shots[0].durationFrames=.5;z.shots[0].assetIds=['missing'];z.shots[0].sourcePath='../escape';
  const result=validateProject(z);assert.equal(result.ok,false);assert.match(result.errors.join('\n'),/正整数帧/);assert.match(result.errors.join('\n'),/不存在的资产/);assert.match(result.errors.join('\n'),/源码路径/);
});

test('undo history isolates snapshots, supports redo, and discards redo on a new edit',()=>{
  const history=new UndoHistory({n:1},3);history.push({n:2});history.push({n:3});
  const current=history.current;current.n=999;assert.equal(history.current.n,3);
  assert.equal(history.undo().n,2);assert.equal(history.redo().n,3);history.undo();history.push({n:4});assert.equal(history.canRedo,false);
  history.push({n:5});assert.equal(history.undo().n,4);assert.equal(history.undo().n,2);assert.equal(history.canUndo,false);
  history.reset({n:0});assert.equal(history.current.n,0);assert.equal(history.canUndo,false);
});

test('default source is real DOM and Canvas code using shared scene parameters',()=>{
  const source=defaultSceneSource();assert.match(source.html,/data-role="title"/);assert.match(source.js,/export async function ready/);
  assert.match(source.js,/export function render/);assert.match(source.js,/g.drawImage/);assert.match(source.js,/String\(p.text/);
  assert.doesNotMatch(source.js,/setInterval|requestAnimationFrame|Date\.now|Math\.random/);
});

test('fallback actually renders editable text and an image independently of frame order',async()=>{
  const source=defaultSceneSource();
  const module=new Function(source.js.replace(/export /g,'' )+';return {ready,render};')() as {ready:(ctx:any)=>Promise<void>;render:(ctx:any)=>void};
  const title={textContent:''},subtitle={textContent:''},layer={style:{opacity:'',transform:''}},vars:Record<string,string>={};
  const calls:unknown[][]=[];
  const root={style:{setProperty:(key:string,value:string)=>vars[key]=value},querySelector:(selector:string)=>selector==='[data-role="title"]'?title:selector==='[data-role="subtitle"]'?subtitle:layer};
  const g={save:()=>{},restore:()=>{},setTransform:()=>{},fillRect:(...args:unknown[])=>calls.push(['fill',...args]),beginPath:()=>{},rect:()=>{},clip:()=>{},drawImage:(...args:unknown[])=>calls.push(['image',...args])};
  const params=defaultShot().params;
  const ctx={root,ctx2d:g,params,assets:[{kind:'image',image:{naturalWidth:100,naturalHeight:200}}],width:1920,height:1080,time:3};
  await module.ready(ctx);module.render(ctx);const original=structuredClone(calls);calls.length=0;ctx.time=0;module.render(ctx);calls.length=0;ctx.time=3;module.render(ctx);
  assert.deepEqual(calls,original);assert.equal(title.textContent,params.text);assert.ok(calls.some(c=>c[0]==='image'));
  params.text='用户修改后的文字';module.render(ctx);assert.equal(title.textContent,'用户修改后的文字');assert.equal(vars['--copy-width'],'48%');
});

test('model storyboard normalization deduplicates bindings, sanitizes params and assigns exact frames',()=>{
  const p=createProject('模型');p.targetDuration=1;
  p.assets=[{id:'a',kind:'text',name:'说明',description:'',text:'hello'}];
  const shots=normalizeStoryboard({shots:Array.from({length:8},(_,i)=>({title:i?'标题':'',durationSeconds:i===0?Infinity:i===1?-2:6,assetIds:['a','a','unknown'],params:{fontSize:-1,motion:'invalid',imageFit:'invalid',imageScale:Infinity,text:'可修改'}}))},p);
  assert.equal(shots.reduce((sum,s)=>sum+s.durationFrames,0),30);
  assert.deepEqual(shots[0].assetIds,['a']);assert.equal(shots[0].title,'镜头 1');assert.equal(shots[0].params.fontSize,72);assert.equal(shots[0].params.motion,'fade');
  assert.equal(validateProject({...p,shots,shotOrder:shots.map(s=>s.id)}).ok,true);
});

test('model scene parsing preserves safe optional patches and reports malformed JSON shapes',()=>{
  for(const input of ['null','[]','3'])assert.throws(()=>parseModelJson(input),/须为对象/);
  const source=parseSceneSource(JSON.stringify({html:'<div></div>',css:'',js:'export function render(ctx){}',shotPatch:{id:'must-not-change',sourcePath:'outside',params:{text:'新的文案',fontSize:-4},assetIds:['a','a'],durationFrames:90}}));
  assert.equal(source.shotPatch?.params?.text,'新的文案');assert.equal(source.shotPatch?.id,undefined);assert.equal(source.shotPatch?.sourcePath,undefined);
  assert.deepEqual(source.shotPatch?.assetIds,['a']);assert.equal(source.shotPatch?.durationFrames,90);assert.equal(source.shotPatch?.params?.fontSize,undefined);
  assert.throws(()=>parseSceneSource('{"source": []}'),/场景源码/);
  assert.throws(()=>parseSceneSource(JSON.stringify({...source,shotPatch:{durationFrames:0}})),/正整数帧/);
});
