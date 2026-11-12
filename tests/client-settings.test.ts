import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/core/index.ts';
import { canvasMetrics } from '../src/client/graph-adapter.ts';
import { aspectId, dimensionsForAspect, fpsLabel, targetLabel } from '../src/client/output-settings.tsx';
import { frameShotRange, keyframeNumbers, previewPlaybackFrame, shotFrameRange } from '../src/client/Preview.tsx';

test('canvas backing pixels follow DPR while logical graph coordinates remain CSS-sized',()=>{
  assert.deepEqual(canvasMetrics(641,333,2),{width:641,height:333,dpr:2,backingWidth:1282,backingHeight:666});
  assert.deepEqual(canvasMetrics(641,333,1.25),{width:641,height:333,dpr:1.25,backingWidth:801,backingHeight:416});
  assert.equal(canvasMetrics(641,333,1).width,canvasMetrics(641,333,2).width);
});

test('aspect presets produce even dimensions and reflect square, wide and portrait outputs accurately',()=>{
  assert.deepEqual(dimensionsForAspect('1:1',1080),{width:1080,height:1080});
  assert.deepEqual(dimensionsForAspect('21:9',1080),{width:2520,height:1080});
  assert.deepEqual(dimensionsForAspect('4:5',1080),{width:1080,height:1350});
  assert.deepEqual(dimensionsForAspect('3:4',720),{width:720,height:960});
  for(const aspect of ['16:9','9:16','1:1','4:5','4:3','3:4','21:9','16:10']){const d=dimensionsForAspect(aspect,1080);assert.equal(d.width%2,0);assert.equal(d.height%2,0);assert.equal(aspectId(d),aspect);}
  assert.equal(aspectId({width:1900,height:1100}),'custom');
});

test('output labels use actual dimensions and exact FPS rather than fixed 1080p metadata',()=>{
  const p=createProject('输出');p.target={...p.target,width:720,height:720,fps:{num:24000,den:1001}};
  assert.equal(fpsLabel(p.target.fps),'23.976');
  assert.equal(targetLabel(p.target),'1:1 · 720 × 720 · 23.976 FPS');
});

test('shot frames follow playback order and keyframe thumbnails stay within exclusive boundaries',()=>{
  const p=createProject('帧检查');p.shotOrder.reverse();
  assert.deepEqual(shotFrameRange(p,p.shotOrder[1]),{start:300,end:600});
  assert.deepEqual(keyframeNumbers(300,600),[300,449,599]);
  assert.deepEqual(keyframeNumbers(3,4),[3]);
  assert.deepEqual(shotFrameRange(p),{start:0,end:900});
});

test('current frame resolves the actual shot and local frame across forward and reverse boundaries',()=>{
  const p=createProject('当前帧');
  const checks=[[0,0,0],[149,0,149],[299,0,299],[300,1,0],[599,1,299],[600,2,0],[650,2,50],[899,2,299]];
  for(const check of [...checks,...[...checks].reverse()]){
    const [frame,index,localFrame]=check,r=frameShotRange(p,frame);
    assert.equal(r.shot?.id,p.shotOrder[index]);
    assert.deepEqual({start:r.start,end:r.end,localFrame:r.localFrame},{start:index*300,end:(index+1)*300,localFrame});
  }
  assert.equal(frameShotRange(p,-1).localFrame,0);
  assert.equal(frameShotRange(p,900).localFrame,299);
});

test('preview playback clamps a backwards animation clock instead of requesting frame -1',()=>{
  assert.deepEqual(previewPlaybackFrame(0,-16,12,null,24),{frame:0,ended:false});
  assert.deepEqual(previewPlaybackFrame(0,-0.1,30,null,24),{frame:0,ended:false});
  assert.deepEqual(previewPlaybackFrame(5,-80,12,null,24),{frame:5,ended:false});
  assert.deepEqual(previewPlaybackFrame(0,1000,12,null,24),{frame:12,ended:false});
  assert.deepEqual(previewPlaybackFrame(0,5000,12,null,24),{frame:23,ended:true});
  assert.deepEqual(previewPlaybackFrame(0,0,12,-0.02,24),{frame:0,ended:false});
  assert.deepEqual(previewPlaybackFrame(3,0,12,1,24),{frame:12,ended:false});
  assert.deepEqual(previewPlaybackFrame(0,0,12,null,0),{frame:0,ended:true});
});

test('current-frame identity follows playback order and edited duration rather than shot storage order',()=>{
  const p=createProject('重排');p.shots[0].durationFrames=120;p.shots[1].durationFrames=240;p.shots[2].durationFrames=360;
  p.shotOrder=[p.shots[2].id,p.shots[0].id,p.shots[1].id];
  for(const [frame,shotIndex,start,end,localFrame] of [[0,2,0,360,0],[359,2,0,360,359],[360,0,360,480,0],[479,0,360,480,119],[480,1,480,720,0],[650,1,480,720,170]]){
    const r=frameShotRange(p,frame);
    assert.equal(r.shot?.id,p.shots[shotIndex].id);
    assert.deepEqual({start:r.start,end:r.end,localFrame:r.localFrame},{start,end,localFrame});
  }
  p.shots=[];p.shotOrder=[];assert.deepEqual(frameShotRange(p,0),{start:0,end:0,localFrame:0});
});
