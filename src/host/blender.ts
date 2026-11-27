import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {EnvironmentSettings} from '../shared/types.ts';
import type {PrevizLighting, PrevizObjectSpec, PrevizOutputMode, PrevizPose, PrevizSceneSpec} from '../shared/previz.ts';
import {mediaSignature} from '../jobs/download.ts';
import {videoByteLimit} from '../media/video.ts';
import {inspectToolEnvironment} from './tool-environment.ts';
import {PREVIZ_TEMPLATE_PY} from './blender-template.ts';

export interface PrevizRenderResult {
  keyframePng:Uint8Array;
  depthPng?:Uint8Array;
  videoMp4?:Uint8Array;
  width:number;
  height:number;
  fps:number;
  frameCount:number;
}

function vec3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 500))
    throw new Error(`${label} 须为 3 个 -500 至 500 的有限数值坐标`);
  return [value[0]!, value[1]!, value[2]!];
}
function safeColor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error('颜色须为 #RRGGBB 格式');
  return value;
}

const POSES: readonly PrevizPose[] = ['stand', 'walk', 'run', 'sit', 'point', 'crouch'];
const LIGHTINGS: readonly PrevizLighting[] = ['three_point', 'daylight', 'noir_rim', 'neon_night', 'golden_hour'];

export function validatePrevizSpec(input: unknown): Required<Pick<PrevizSceneSpec, 'output' | 'emitDepth' | 'width' | 'height' | 'fps' | 'durationSeconds' | 'engine' | 'lighting' | 'camera' | 'objects'>> & { background?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('预演场景参数须为对象');
  const raw = input as Record<string, unknown>;
  if (raw.output!==undefined && !['image','video','both'].includes(String(raw.output))) throw new Error('预演输出须为 image、video 或 both');
  if (raw.emitDepth!==undefined && typeof raw.emitDepth!=='boolean') throw new Error('预演深度选项须为布尔值');
  const output: PrevizOutputMode = raw.output === 'image' || raw.output === 'video' || raw.output === 'both' ? raw.output : 'both';
  const emitDepth = raw.emitDepth !== false;
  const width = raw.width === undefined ? 960 : Number(raw.width);
  const height = raw.height === undefined ? 540 : Number(raw.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 256 || height < 256 || width > 1920 || height > 1920 || width % 2 !== 0 || height % 2 !== 0)
    throw new Error('预演画面尺寸须为 256–1920 范围内的偶数');
  const fps = raw.fps === undefined ? 12 : Number(raw.fps);
  if (!Number.isSafeInteger(fps) || fps < 1 || fps > 60) throw new Error('预演 FPS 须为 1–60 的整数');
  const durationSeconds = raw.durationSeconds === undefined ? 3 : Number(raw.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30) throw new Error('单镜头预演时长须为 0–30 秒');
  const engine = raw.engine === 'BLENDER_EEVEE_NEXT' ? 'BLENDER_EEVEE_NEXT' : 'BLENDER_WORKBENCH';
  const lighting: PrevizLighting = LIGHTINGS.includes(raw.lighting as PrevizLighting) ? raw.lighting as PrevizLighting : 'three_point';
  const background = safeColor(raw.background);
  if (!raw.camera || typeof raw.camera !== 'object' || Array.isArray(raw.camera)) throw new Error('缺少预演机位 camera 参数');
  const cam = raw.camera as Record<string, unknown>;
  const lensMm = cam.lensMm === undefined ? 35 : Number(cam.lensMm);
  if (!Number.isFinite(lensMm) || lensMm < 10 || lensMm > 250) throw new Error('镜头焦距 lensMm 须在 10–250mm 之间');
  const rollDeg = cam.rollDeg === undefined ? undefined : Number(cam.rollDeg);
  if (rollDeg !== undefined && (!Number.isFinite(rollDeg) || Math.abs(rollDeg) > 60)) throw new Error('荷兰角 rollDeg 须在 -60 至 60 度之间');
  const fStop = cam.fStop === undefined ? undefined : Number(cam.fStop);
  if (fStop !== undefined && (!Number.isFinite(fStop) || fStop < 0.7 || fStop > 32)) throw new Error('光圈 fStop 须在 0.7–32 之间');
  const focusDistance = cam.focusDistance === undefined ? undefined : Number(cam.focusDistance);
  if (focusDistance !== undefined && (!Number.isFinite(focusDistance) || focusDistance <= 0.1 || focusDistance > 500)) throw new Error('对焦距离 focusDistance 须在 0.1–500 米之间');
  const startPos = vec3(cam.startPos, 'camera.startPos');
  const endPos = cam.endPos !== undefined ? vec3(cam.endPos, 'camera.endPos') : startPos;
  const startTarget = vec3(cam.startTarget, 'camera.startTarget');
  const endTarget = cam.endTarget !== undefined ? vec3(cam.endTarget, 'camera.endTarget') : startTarget;
  if (startPos.every((value,index)=>value===startTarget[index]) || endPos.every((value,index)=>value===endTarget[index])) throw new Error('预演机位与目标坐标不能重合');
  if (!Array.isArray(raw.objects) || raw.objects.length > 32) throw new Error('预演物体 objects 须为不超过 32 项的数组');
  const objects: PrevizObjectSpec[] = raw.objects.map((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`objects[${idx}] 须为对象`);
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(item.id) ? item.id : `obj-${idx + 1}`;
    const kind = ['character', 'box', 'cylinder', 'sphere', 'plane'].includes(String(item.kind)) ? item.kind as PrevizObjectSpec['kind'] : 'box';
    const position = vec3(item.position, `objects[${idx}].position`);
    const objEndPos = item.endPos !== undefined ? vec3(item.endPos, `objects[${idx}].endPos`) : undefined;
    const scale = item.scale !== undefined ? vec3(item.scale, `objects[${idx}].scale`) : undefined;
    if (scale?.some(value=>value<=0)) throw new Error(`objects[${idx}].scale 须为三个正数`);
    const heightVal = item.height !== undefined ? Number(item.height) : undefined;
    if (heightVal !== undefined && (!Number.isFinite(heightVal) || heightVal < 0.2 || heightVal > 10)) throw new Error(`objects[${idx}].height 无效`);
    const facingDeg = item.facingDeg !== undefined ? Number(item.facingDeg) : 0;
    if (!Number.isFinite(facingDeg)) throw new Error(`objects[${idx}].facingDeg 无效`);
    const endFacingDeg = item.endFacingDeg !== undefined ? Number(item.endFacingDeg) : undefined;
    if (endFacingDeg !== undefined && !Number.isFinite(endFacingDeg)) throw new Error(`objects[${idx}].endFacingDeg 无效`);
    const pose = item.pose !== undefined && POSES.includes(item.pose as PrevizPose) ? item.pose as PrevizPose : undefined;
    const color = safeColor(item.color);
    return {
      id, kind, position,
      ...(objEndPos ? { endPos: objEndPos } : {}),
      ...(scale ? { scale } : {}),
      ...(heightVal !== undefined ? { height: heightVal } : {}),
      facingDeg,
      ...(endFacingDeg !== undefined ? { endFacingDeg } : {}),
      ...(pose ? { pose } : {}),
      ...(color ? { color } : {}),
    };
  });
  if (new Set(objects.map(object=>object.id)).size!==objects.length) throw new Error('预演物体 ID 不能重复');
  return {
    output, emitDepth, width, height, fps, durationSeconds, engine, lighting,
    ...(background ? { background } : {}),
    camera: { lensMm, ...(rollDeg !== undefined ? { rollDeg } : {}), ...(fStop !== undefined ? { fStop } : {}), ...(focusDistance !== undefined ? { focusDistance } : {}), startPos, endPos, startTarget, endTarget },
    objects,
  };
}

async function runTool(command:string,args:string[],timeoutMs:number,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let log='',failure:unknown,force:ReturnType<typeof setTimeout>|undefined;
    const stop=(reason:unknown)=>{
      if(failure!==undefined)return;
      failure=reason;
      if(child.exitCode!==null||child.signalCode!==null)return;
      child.kill('SIGTERM');
      force=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1500);
      force.unref();
    };
    const abort=()=>stop(signal?.reason??new Error('Blender 预演已取消'));
    const timer=setTimeout(()=>stop(new Error('Blender 预演超时')),timeoutMs);
    timer.unref();
    signal?.addEventListener('abort',abort,{once:true});
    const append=(data:Buffer)=>{log=(log+data.toString()).slice(-4000);};
    child.stdout.on('data',append);child.stderr.on('data',append);
    child.once('error',error=>{failure??=error;});
    child.once('close',code=>{
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener('abort',abort);
      if(failure!==undefined)reject(failure);
      else if(code!==0)reject(new Error('预演工具运行失败：'+log.trim().slice(-600)));
      else resolve();
    });
    if(signal?.aborted)abort();
  });
}

async function readArtifact(file:string,mime:string,maxBytes:number):Promise<Uint8Array>{
  const info=await stat(file);
  if(!info.isFile()||!info.size||info.size>maxBytes)throw new Error('白模预演产物大小无效');
  const bytes=await readFile(file);
  if(mediaSignature(bytes)!==mime)throw new Error('白模预演产物格式无效');
  return bytes;
}

/** Blender receives only a bundled Python script and bounded, validated scene data. */
export async function renderBlenderPreviz(input:unknown,settings:Partial<EnvironmentSettings>,signal?:AbortSignal):Promise<PrevizRenderResult>{
  const spec=validatePrevizSpec(input);
  const wantsVideo=spec.output!=='image',frames=wantsVideo?Math.max(2,Math.round(spec.durationSeconds*spec.fps)):1;
  if(frames>360||spec.width*spec.height*frames>240_000_000)throw new Error('预演视频超过 360 帧或画面预算；请降低尺寸、帧率或时长');
  const env=inspectToolEnvironment(settings);
  if(!env.blenderAvailable||!env.blenderPath)throw new Error('未检测到 Blender，请在运行环境中配置可执行路径');
  if(wantsVideo&&(!env.ffmpegAvailable||!env.ffprobeAvailable))throw new Error('预演视频需要 FFmpeg 与 ffprobe；也可以仅渲染关键帧');
  signal?.throwIfAborted();
  const directory=await mkdtemp(join(tmpdir(),'yingliu-previz-'));
  const out=join(directory,'output'),scene=join(directory,'scene.json'),script=join(directory,'previz.py');
  try{
    await mkdir(out);
    await writeFile(scene,JSON.stringify({...spec,frames,outputDir:out}));
    await writeFile(script,PREVIZ_TEMPLATE_PY);
    await runTool(env.blenderPath,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',script,'--',scene],wantsVideo?180_000:60_000,signal);
    const [keyframePng,depthPng]=await Promise.all([
      readArtifact(join(out,'keyframe.png'),'image/png',20_000_000),
      spec.emitDepth?readArtifact(join(out,'depth.png'),'image/png',20_000_000):undefined,
    ]);
    let videoMp4:Uint8Array|undefined;
    if(wantsVideo){
      const video=join(out,'previz.mp4');
      await runTool(env.ffmpegPath,['-hide_banner','-loglevel','error','-y','-framerate',String(spec.fps),'-i',join(out,'frames','frame_%04d.png'),'-frames:v',String(frames),'-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',video],60_000,signal);
      videoMp4=await readArtifact(video,'video/mp4',Math.min(videoByteLimit(settings),64*1024*1024));
    }
    signal?.throwIfAborted();
    return {keyframePng,depthPng,videoMp4,width:spec.width,height:spec.height,fps:spec.fps,frameCount:frames};
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
}
