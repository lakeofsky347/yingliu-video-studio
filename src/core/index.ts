import type { Asset, Shot, VideoProject, VideoSpec, VideoTarget } from '../shared/types.js';
import {inspectProjectPaths,safeRelativeProjectPath as safeRelativePath} from './project-paths.js';
export { defaultSceneSource } from './default-source.js';

export interface ValidationResult { ok:boolean; errors:string[]; warnings:string[] }
export interface StoryEdge { from:string; to:string }

let fallbackId=0;
function id(prefix:string):string {
  const unique=globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++fallbackId).toString(36)}`;
  return `${prefix}-${unique}`;
}
function copy<T>(value:T):T { return structuredClone(value); }
function changed(project:VideoProject):VideoProject {
  const next=copy(project); next.revision+=1; next.updatedAt=new Date().toISOString(); return next;
}
function shotOf(project:VideoProject,shotId:string):Shot {
  const shot=project.shots.find(s=>s.id===shotId);
  if(!shot)throw new Error(`找不到镜头：${shotId}`);
  return shot;
}
function assertUnique(values:string[],label:string,errors:string[]):void {
  if(values.some(v=>typeof v!=='string'||!v.trim()))errors.push(`${label}含空或无效 ID`);
  if(new Set(values).size!==values.length)errors.push(`${label}含重复 ID`);
}
function plainObject(value:unknown):value is Record<string,unknown> {
  return typeof value==='object' && value!==null && !Array.isArray(value);
}

/** Migrate in memory: stable IDs, revision and historical snapshots are not rewritten. */
export function migrateProject(project:VideoProject):VideoProject {
  if(!project||![1,2].includes(project.schemaVersion))throw new Error('不支持的项目版本');
  const migrated=copy(project);migrated.schemaVersion=2;migrated.videoClips??=[];return migrated;
}

/** New projects have three editable ten-second scenes; media is never invented. */
export function createProject(title:string,topic=''):VideoProject {
  const now=new Date().toISOString();
  const shots=Array.from({length:3},(_,i)=>defaultShot(i));
  return {schemaVersion:2,id:id('film'),title:title.trim()||'未命名视频',topic,
    targetDuration:30,createdAt:now,updatedAt:now,revision:0,
    target:{width:1920,height:1080,fps:{num:30,den:1},audioMode:'none'},
    assets:[],shots,shotOrder:shots.map(s=>s.id),
    graph:{positions:Object.fromEntries(shots.map((s,i)=>[s.id,[i*370,120] as [number,number]])),groups:[]},
    outputs:[],audioClips:[],videoClips:[],sessionIds:[],extensions:{}};
}

export function defaultShot(index=0,fps={num:30,den:1}):Shot {
  if(!Number.isFinite(index)||!Number.isInteger(fps.num)||!Number.isInteger(fps.den)||fps.num<=0||fps.den<=0)
    throw new Error('镜头序号或 FPS 无效');
  const shotId=id('shot');
  return {id:shotId,title:`镜头 ${index+1}`,intent:'说明本镜头要传达的一件事',
    composition:'明确标题与主体层次，图片与文字各有阅读空间',action:'平缓进入并保留阅读停留',
    durationFrames:Math.max(1,Math.round(10*fps.num/fps.den)),assetIds:[],referenceIds:[],transition:'cut',
    params:{text:`镜头 ${index+1}`,subtitle:'编辑文字、绑定图片，或让 AI 设计这个镜头',
      background:'#111827',foreground:'#f9fafb',accent:'#a3e635',imageX:74,imageY:50,imageScale:1,
      imageFit:'contain',fontSize:72,motion:'fade'},sourcePath:`shots/${shotId}`};
}

/** Data validation permits an incomplete graph to be saved. compileSpec also validates its chain. */
export function validateProject(project:VideoProject,options:{portablePaths?:boolean}={}):ValidationResult {
  const errors:string[]=[],warnings:string[]=[];
  if(!plainObject(project))return {ok:false,errors:['项目必须是对象'],warnings};
  if(project.schemaVersion!==1&&project.schemaVersion!==2)errors.push('不支持的项目版本');
  if(typeof project.id!=='string'||!project.id.trim())errors.push('项目 ID 不能为空');
  if(typeof project.title!=='string'||!project.title.trim())errors.push('项目标题不能为空');
  if(typeof project.topic!=='string')errors.push('主题必须是文字');
  if(!Number.isInteger(project.revision)||project.revision<0)errors.push('项目 revision 无效');
  if(!Number.isFinite(project.targetDuration)||project.targetDuration<=0)errors.push('目标时长必须大于零');
  const target=project.target;
  if(!plainObject(target)||!plainObject(target.fps))errors.push('输出规格缺失');
  else {
    if(!Number.isInteger(target.width)||!Number.isInteger(target.height)||target.width<64||target.height<64||target.width>8192||target.height>8192||target.width%2||target.height%2)
      errors.push('画面尺寸须为 64–8192 范围内的偶数');
    if(!Number.isInteger(target.fps.num)||!Number.isInteger(target.fps.den)||target.fps.num<=0||target.fps.den<=0||target.fps.num/target.fps.den>120)
      errors.push('FPS 须为正整数分子/分母，且不超过 120');
    if(!['none','mixed'].includes(target.audioMode))errors.push('音频模式无效');
    if(target.quality!==undefined&&!['standard','high','small'].includes(target.quality))errors.push('编码质量无效');
  }
  if(!Array.isArray(project.shots)||!Array.isArray(project.assets)||!Array.isArray(project.shotOrder))
    return {ok:false,errors:[...errors,'镜头、资产和镜头顺序须为数组'],warnings};
  if(project.shots.some(s=>!plainObject(s))||project.assets.some(a=>!plainObject(a)))
    return {ok:false,errors:[...errors,'镜头与资产必须是对象'],warnings};
  assertUnique(project.shots.map(s=>s.id),'镜头',errors);
  assertUnique(project.assets.map(a=>a.id),'资产',errors);
  assertUnique(project.shotOrder,'镜头顺序',errors);
  const assetIds=new Set(project.assets.map(a=>a.id)),shotIds=new Set(project.shots.map(s=>s.id));
  for(const asset of project.assets) {
    if(!['image','text','audio','video'].includes(asset.kind))errors.push(`资产 ${asset.id} 类型不支持`);
    if(typeof asset.name!=='string'||!asset.name.trim())errors.push(`资产 ${asset.id} 缺少名称`);
    if(asset.kind==='image' && (typeof asset.path!=='string'||!safeRelativePath(asset.path)))errors.push(`图片 ${asset.id} 需要项目内相对路径`);
    if(asset.kind==='text' && typeof asset.text!=='string')errors.push(`文字资产 ${asset.id} 缺少文本`);
    if(asset.kind==='video'){
      if(asset.originalPath!==undefined&&(!safeRelativePath(asset.originalPath)||asset.originalPath===asset.path))errors.push(`视频 ${asset.id} 原始文件路径无效`);
      if(typeof asset.path!=='string'||!safeRelativePath(asset.path)||!Number.isFinite(asset.duration)||asset.duration!<=0)errors.push(`视频 ${asset.id} 需要有效路径和时长`);
      if(!Number.isInteger(asset.width)||!Number.isInteger(asset.height)||asset.width!<1||asset.height!<1||asset.width!>8192||asset.height!>8192)errors.push(`视频 ${asset.id} 尺寸无效`);
      if(!asset.fps||!Number.isInteger(asset.fps.num)||!Number.isInteger(asset.fps.den)||asset.fps.num<=0||asset.fps.den<=0||asset.fps.num/asset.fps.den>120)errors.push(`视频 ${asset.id} FPS 无效`);
      if(asset.frameCount!==undefined&&(!Number.isSafeInteger(asset.frameCount)||asset.frameCount<=0))errors.push(`视频 ${asset.id} 帧数无效`);
      if(typeof asset.hasAudio!=='boolean')errors.push(`视频 ${asset.id} 音轨信息无效`);
    }
    if(asset.kind==='audio'&&(typeof asset.path!=='string'||!safeRelativePath(asset.path)||!Number.isFinite(asset.duration)||asset.duration!<=0))errors.push(`音频 ${asset.id} 需要有效路径和时长`);
  }
  for(const shot of project.shots) {
    if(typeof shot.title!=='string'||!shot.title.trim())errors.push(`镜头 ${shot.id} 缺少标题`);
    if(!Number.isInteger(shot.durationFrames)||shot.durationFrames<=0||shot.durationFrames>1000000)errors.push(`镜头 ${shot.id} 时长须为正整数帧`);
    if(typeof shot.sourcePath!=='string'||!safeRelativePath(shot.sourcePath))errors.push(`镜头 ${shot.id} 源码路径无效`);
    if(!['cut','fade'].includes(shot.transition))errors.push(`镜头 ${shot.id} 转场无效`);
    for(const field of ['assetIds','referenceIds'] as const) {
      if(!Array.isArray(shot[field])) {errors.push(`镜头 ${shot.id} 的 ${field} 须为数组`);continue;}
      assertUnique(shot[field],`镜头 ${shot.id} 的 ${field}`,errors);
      for(const aid of shot[field])if(!assetIds.has(aid))errors.push(`镜头 ${shot.id} 引用了不存在的资产 ${aid}`);
    }
    if(!plainObject(shot.params))errors.push(`镜头 ${shot.id} 参数缺失`);
    else {
      for(const [key,value] of Object.entries(shot.params))
        if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))errors.push(`镜头 ${shot.id} 参数 ${key} 无效`);
      for(const key of ['text','subtitle','background','foreground','accent'] as const)
        if(typeof shot.params[key]!=='string')errors.push(`镜头 ${shot.id} 参数 ${key} 须为文字`);
      for(const key of ['imageX','imageY','imageScale','fontSize'] as const)
        if(typeof shot.params[key]!=='number'||!Number.isFinite(shot.params[key]))errors.push(`镜头 ${shot.id} 参数 ${key} 须为有限数值`);
      if(shot.params.imageScale<=0||shot.params.fontSize<=0)errors.push(`镜头 ${shot.id} 图片缩放和字号须大于零`);
      if(!['cover','contain'].includes(shot.params.imageFit))errors.push(`镜头 ${shot.id} imageFit 无效`);
      if(!['fade','slide','zoom','none'].includes(shot.params.motion))errors.push(`镜头 ${shot.id} motion 无效`);
    }
  }
  for(const sid of project.shotOrder)if(!shotIds.has(sid))errors.push(`镜头顺序包含不存在的镜头 ${sid}`);
  for(const sid of shotIds)if(!project.shotOrder.includes(sid))warnings.push(`镜头 ${sid} 尚未连入主链`);
  if(!plainObject(project.graph)||!plainObject(project.graph.positions)||!Array.isArray(project.graph.groups))errors.push('画布布局缺失');
  else for(const [node,position] of Object.entries(project.graph.positions))
    if(!Array.isArray(position)||position.length!==2||!position.every(Number.isFinite))errors.push(`节点 ${node} 的画布位置无效`);
  if(!plainObject(project.extensions))errors.push('扩展数据须为对象');
  for(const clip of project.audioClips??[]){
    if(!clip||typeof clip.id!=='string'||!project.assets.some(a=>a.id===clip.assetId&&a.kind==='audio')){errors.push('音频片段引用无效');continue;}
    if(clip.shotId&&!shotIds.has(clip.shotId))errors.push(`音频片段 ${clip.id} 引用的镜头不存在`);
    if(!['voice','music','sfx'].includes(clip.role))errors.push(`音频片段 ${clip.id} 角色无效`);
    for(const key of ['startSeconds','trimStart','volume','fadeIn','fadeOut'] as const)if(!Number.isFinite(clip[key])||clip[key]<0)errors.push(`音频片段 ${clip.id} ${key} 无效`);
    if(clip.trimEnd!==undefined&&(!Number.isFinite(clip.trimEnd)||clip.trimEnd<=clip.trimStart))errors.push(`音频片段 ${clip.id} 裁剪区间无效`);
  }
  if(project.videoClips!==undefined&&!Array.isArray(project.videoClips))errors.push('视频片段须为数组');
  else {
    const clips=project.videoClips??[];
    assertUnique(clips.map(clip=>clip?.id),'视频片段',errors);assertUnique(clips.map(clip=>clip?.shotId),'视频镜头绑定',errors);
    for(const clip of clips){
      if(!plainObject(clip)){errors.push('视频片段无效');continue;}
      const asset=project.assets.find(asset=>asset.id===clip.assetId&&asset.kind==='video');
      if(!asset||!shotIds.has(clip.shotId)){errors.push('视频片段引用的素材或镜头不存在');continue;}
      if(!Number.isFinite(clip.trimStart)||clip.trimStart<0||clip.trimStart>=asset.duration!)errors.push('视频裁剪起点超出素材时长');
      if(clip.trimEnd!==undefined&&(!Number.isFinite(clip.trimEnd)||clip.trimEnd<=clip.trimStart||clip.trimEnd>asset.duration!+.000001))errors.push('视频裁剪终点超出素材时长');
      if(!Number.isFinite(clip.speed)||clip.speed<.25||clip.speed>4)errors.push('视频速度须为 0.25–4 倍');
      if(!['cover','contain'].includes(clip.fit))errors.push('视频适应方式无效');
      if(!['mute','keep','extract'].includes(clip.audio))errors.push('视频原声策略无效');
    }
  }
  const graph=validateGraph(project);warnings.push(...graph.errors.map(e=>`主链草稿：${e}`));
  (options.portablePaths?errors:warnings).push(...inspectProjectPaths(project).map(issue=>issue.message));
  return {ok:errors.length===0,errors,warnings};
}

/** shotOrder is the semantic source; graph positions never determine timing. */
export function validateGraph(project:VideoProject):ValidationResult {
  const errors:string[]=[],warnings:string[]=[];
  if(!Array.isArray(project.shots)||!Array.isArray(project.shotOrder))return {ok:false,errors:['镜头主链缺失'],warnings};
  const ids=project.shots.filter(plainObject).map(s=>s.id),order=project.shotOrder;
  if(!ids.length)errors.push('至少需要一个镜头');
  assertUnique(ids,'镜头',errors);assertUnique(order,'主链',errors);
  if(order.length!==ids.length||ids.some(s=>!order.includes(s))||order.some(s=>!ids.includes(s)))errors.push('主链必须恰好包含全部镜头，不能断开、遗漏或引用未知镜头');
  const raw=project.extensions?.graphEdges;
  if(raw!==undefined) {
    if(!Array.isArray(raw))errors.push('graphEdges 必须是数组');
    else {
      const edges=readEdges(raw,errors);
      if(edges)validateEdges(edges,ids,order,errors);
    }
  }
  return {ok:errors.length===0,errors,warnings};
}

function readEdges(raw:unknown[],errors:string[]):StoryEdge[]|null {
  if(raw.some(e=>!plainObject(e)||typeof e.from!=='string'||typeof e.to!=='string')) {
    errors.push('主链连线须包含 from/to 镜头 ID');return null;
  }
  return raw as StoryEdge[];
}
function validateEdges(edges:StoryEdge[],ids:string[],order:string[],errors:string[]):void {
  const output='film-output',incoming=new Map<string,number>(),outgoing=new Map<string,number>();
  const seen=new Set<string>();
  for(const edge of edges) {
    if(!ids.includes(edge.from)||!ids.includes(edge.to)&&edge.to!==output)errors.push(`主链连线包含未知节点 ${edge.from} → ${edge.to}`);
    if(edge.from===edge.to)errors.push('主链不能自连接');
    const key=`${edge.from}\0${edge.to}`;if(seen.has(key))errors.push('主链包含重复连线');seen.add(key);
    incoming.set(edge.to,(incoming.get(edge.to)||0)+1);outgoing.set(edge.from,(outgoing.get(edge.from)||0)+1);
  }
  if([...incoming.values()].some(n=>n>1)||[...outgoing.values()].some(n=>n>1))errors.push('主链不能分叉或合流');
  for(let i=0;i<order.length-1;i++)if(!seen.has(`${order[i]}\0${order[i+1]}`))errors.push(`主链断开：${order[i]} → ${order[i+1]}`);
  const expected=new Set(order.slice(0,-1).map((s,i)=>`${s}\0${order[i+1]}`));
  if(order.length)expected.add(`${order.at(-1)}\0${output}`);
  if(order.length&&!seen.has(`${order.at(-1)}\0${output}`))errors.push('末镜头必须连接到视频输出节点');
  for(const key of seen)if(!expected.has(key))errors.push('主链连线与镜头顺序不一致，可能存在循环或逆序');
}

export function compileSpec(project:VideoProject):VideoSpec {
  const validation=validateProject(project),graph=validateGraph(project);
  const errors=[...validation.errors,...graph.errors];
  if(errors.length)throw new Error(`无法编译视频要求：\n${[...new Set(errors)].join('\n')}`);
  let frame=0;
  const shots=project.shotOrder.map(sid=>{
    const shot=copy(shotOf(project,sid));const startFrame=frame;frame+=shot.durationFrames;
    const videoClip=project.videoClips?.find(clip=>clip.shotId===shot.id);
    return {...shot,startFrame,endFrame:frame,assets:project.assets.filter(a=>shot.assetIds.includes(a.id)||a.id===videoClip?.assetId).map(copy),...(videoClip?{videoClip:copy(videoClip)}:{})};
  });
  if(frame>1000000)throw new Error('全片超过 1,000,000 帧限制');
  return {projectId:project.id,title:project.title,topic:project.topic,target:copy(project.target),
    durationFrames:frame,durationSeconds:frame*project.target.fps.den/project.target.fps.num,shots};
}

/** Allocate an exact integer frame budget, preserving relative duration weights. */
export function normalizeSceneDurations(shots:Shot[],targetFrames:number):Shot[] {
  if(!shots.length||!Number.isInteger(targetFrames)||targetFrames<shots.length||targetFrames>1000000)
    throw new Error('帧预算必须为整数，至少为每个镜头保留一帧，并不超过 1,000,000 帧');
  if(shots.some(s=>!Number.isFinite(s.durationFrames)||s.durationFrames<=0))throw new Error('镜头时长权重须为有限正数');
  const total=shots.reduce((sum,s)=>sum+s.durationFrames,0),remaining=targetFrames-shots.length;
  if(!Number.isFinite(total))throw new Error('镜头时长权重总和超出数值范围');
  const quotas=shots.map((s,index)=>{const exact=remaining*s.durationFrames/total;return {index,base:Math.floor(exact),remainder:exact-Math.floor(exact)};});
  let spare=remaining-quotas.reduce((sum,q)=>sum+q.base,0);
  for(const quota of [...quotas].sort((a,b)=>b.remainder-a.remainder||a.index-b.index)){if(spare--<=0)break;quota.base+=1;}
  return shots.map((shot,index)=>({...copy(shot),durationFrames:1+quotas[index].base}));
}

export function specMarkdown(spec:VideoSpec):string {
  const {target}=spec,fps=target.fps.num/target.fps.den;
  const lines=[`# ${spec.title}：视频制作要求`,'',`主题：${spec.topic||'尚未填写'}`,
    `画面：${target.width} × ${target.height}；FPS：${target.fps.num}/${target.fps.den}；${target.audioMode==='mixed'?'含音频':'无声'} MP4；质量：${target.quality??'high'}。`,
    `总时长：${formatSeconds(spec.durationSeconds)} 秒（${spec.durationFrames} 帧）；共 ${spec.shots.length} 个镜头。`,
    '', '顺序以镜头主链为准；画布位置仅用于组织节点。每个镜头的源码须读取共享参数、由帧号独立求值。',''];
  spec.shots.forEach((shot,index)=>{
    lines.push(`## ${index+1}. ${shot.title}`, '',
      `镜头 ID：${shot.id}；帧区间：[${shot.startFrame}, ${shot.endFrame})；时长：${formatSeconds(shot.durationFrames/fps)} 秒。`,
      `观众应理解：${shot.intent||'待细化'}`,`构图：${shot.composition||'待细化'}`,`动作：${shot.action||'待细化'}`,
      `进入转场：${shot.transition==='fade'?'淡入':'直接切入'}`,`画面文字：${shot.params.text||'无'}`,
      `字幕／补充文字：${shot.params.subtitle||'无'}`,
      `旁白：${shot.narration||'无'}`,
      `视频底图：${shot.videoClip?shot.videoClip.assetId+'；源区间 '+shot.videoClip.trimStart+'–'+(shot.videoClip.trimEnd??'结尾')+' 秒；'+shot.videoClip.speed+' 倍速；'+shot.videoClip.fit+'；原声 '+shot.videoClip.audio:'无'}；代码可在其上叠加文字和图形。`,
      `生产资产：${shot.assets.length?shot.assets.map(a=>`${a.name} (${a.id}，${a.kind}${a.description?`，${a.description}`:''})`).join('；'):'尚未绑定'}`,
      `参考资产 ID：${shot.referenceIds.join('、')||'无'}`,`源码目录：${shot.sourcePath}`,
      '', '画面参数：', '', '```json',JSON.stringify(shot.params,null,2),'```','');
  });
  lines.push('## 实现与验收','',
    '- 图片在 ready 阶段完成 decode，字体等待就绪。render(ctx) 每帧可重复、可逆序调用，不使用真实时钟驱动画面。',
    '- 预览与导出读取同一项目版本、镜头源码、共享参数和本地资产；输出所有整数帧，不跳帧。',
    '- 中文文字可见、无截断，图片符合构图，切镜和淡入符合说明；自动媒体检查与人工观看分别记录。','');
  return lines.join('\n');
}
function formatSeconds(seconds:number):string{return Number(seconds.toFixed(3)).toString();}

/** Rewrite sequence edges after an explicit reorder. Asset bindings stay in their fields. */
function syncEdges(project:VideoProject):void {
  if(project.extensions.graphEdges===undefined)return;
  const raw=project.extensions.graphEdges;
  const hadOutput=Array.isArray(raw)&&raw.some(e=>plainObject(e)&&e.to==='film-output');
  project.extensions.graphEdges=project.shotOrder.slice(0,-1).map((from,i)=>({from,to:project.shotOrder[i+1]}));
  if(hadOutput&&project.shotOrder.length)(project.extensions.graphEdges as StoryEdge[]).push({from:project.shotOrder.at(-1)!,to:'film-output'});
}

/** Store the raw graph even if broken. Never invent links to fill a disconnected draft. */
export function reorderFromGraph(project:VideoProject,edges:StoryEdge[]):VideoProject {
  const next=changed(project);next.extensions.graphEdges=copy(edges);
  const ids=new Set(next.shots.map(s=>s.id));
  const incoming=new Map<string,number>(),outgoing=new Map<string,string[]>();
  for(const edge of edges) {
    if(ids.has(edge.to))incoming.set(edge.to,(incoming.get(edge.to)||0)+1);
    if(ids.has(edge.from)){const list=outgoing.get(edge.from)||[];list.push(edge.to);outgoing.set(edge.from,list);}
  }
  const starts=next.shots.filter(s=>!incoming.has(s.id));next.shotOrder=[];
  if(starts.length!==1)return next;
  let current=starts[0].id;const visited=new Set<string>();
  while(ids.has(current)&&!visited.has(current)) {
    next.shotOrder.push(current);visited.add(current);
    const candidates=outgoing.get(current)||[];
    if(candidates.length!==1)break;
    current=candidates[0];
  }
  return next;
}

export function reorderShots(project:VideoProject,shotOrder:string[]):VideoProject {
  const ids=project.shots.map(s=>s.id);
  if(shotOrder.length!==ids.length||new Set(shotOrder).size!==ids.length||shotOrder.some(s=>!ids.includes(s)))throw new Error('重排必须包含每个镜头且只包含一次');
  const next=changed(project);next.shotOrder=[...shotOrder];syncEdges(next);return next;
}
export function addShot(project:VideoProject,shot=defaultShot(project.shots.length,project.target.fps),afterId?:string):VideoProject {
  if(project.shots.some(s=>s.id===shot.id))throw new Error(`镜头 ID 已存在：${shot.id}`);
  if(afterId!==undefined&&!project.shotOrder.includes(afterId))throw new Error('插入位置不存在');
  const next=changed(project);next.shots.push(copy(shot));
  const index=afterId===undefined?next.shotOrder.length:next.shotOrder.indexOf(afterId)+1;next.shotOrder.splice(index,0,shot.id);
  next.graph.positions[shot.id]=[index*370,120];syncEdges(next);return next;
}
export function deleteShot(project:VideoProject,shotId:string):VideoProject {
  shotOf(project,shotId);const next=changed(project);next.shots=next.shots.filter(s=>s.id!==shotId);next.shotOrder=next.shotOrder.filter(s=>s!==shotId);
  delete next.graph.positions[shotId];next.audioClips=next.audioClips?.filter(c=>c.shotId!==shotId);next.videoClips=next.videoClips?.filter(c=>c.shotId!==shotId);syncEdges(next);return next;
}
export function duplicateShot(project:VideoProject,shotId:string):VideoProject {
  const original=shotOf(project,shotId),shot=copy(original);shot.id=id('shot');shot.title+= '（副本）';shot.sourcePath=`shots/${shot.id}`;
  const next=addShot(project,shot,shotId),position=project.graph.positions[shotId];
  const copies=plainObject(next.extensions.sourceCopies)?next.extensions.sourceCopies:{};
  next.extensions.sourceCopies={...copies,[shot.id]:original.sourcePath};
  const video=project.videoClips?.find(clip=>clip.shotId===shotId);if(video)next.videoClips=[...(next.videoClips??[]),{...copy(video),id:id('video-clip'),shotId:shot.id}];
  if(position)next.graph.positions[shot.id]=[position[0]+60,position[1]+80];return next;
}
export function updateShot(project:VideoProject,shotId:string,patch:Partial<Shot>):VideoProject {
  if(patch.id!==undefined&&patch.id!==shotId)throw new Error('不能改写镜头 ID');
  const next=changed(project),shot=shotOf(next,shotId);Object.assign(shot,copy(patch));return next;
}
export function bindAsset(project:VideoProject,shotId:string,assetId:string,kind:'asset'|'reference'='asset'):VideoProject {
  if(!project.assets.some(a=>a.id===assetId))throw new Error(`找不到资产：${assetId}`);
  const field=kind==='reference'?'referenceIds':'assetIds';
  if(shotOf(project,shotId)[field].includes(assetId))return copy(project);
  const next=changed(project);shotOf(next,shotId)[field].push(assetId);return next;
}
export function unbindAsset(project:VideoProject,shotId:string,assetId:string,kind:'asset'|'reference'='asset'):VideoProject {
  const field=kind==='reference'?'referenceIds':'assetIds';shotOf(project,shotId);
  const next=changed(project),shot=shotOf(next,shotId);shot[field]=shot[field].filter(s=>s!==assetId);return next;
}
export function deleteAsset(project:VideoProject,assetId:string):VideoProject {
  if(!project.assets.some(a=>a.id===assetId))throw new Error(`找不到资产：${assetId}`);
  const next=changed(project);next.assets=next.assets.filter(a=>a.id!==assetId);delete next.graph.positions[assetId];
  for(const shot of next.shots){shot.assetIds=shot.assetIds.filter(a=>a!==assetId);shot.referenceIds=shot.referenceIds.filter(a=>a!==assetId);}
  next.audioClips=next.audioClips?.filter(c=>c.assetId!==assetId);next.videoClips=next.videoClips?.filter(c=>c.assetId!==assetId);
  return next;
}
export function addAsset(project:VideoProject,asset:Asset):VideoProject {
  if(project.assets.some(a=>a.id===asset.id))throw new Error(`资产 ID 已存在：${asset.id}`);
  const next=changed(project);next.assets.push(copy(asset));return next;
}

/** Keep timing in seconds when changing the output timebase. Persist original second lengths
 * across FPS-only changes so repeated 24 ↔ 60 changes do not accumulate rounding drift. */
export function updateTarget(project:VideoProject,patch:Partial<VideoTarget>):VideoProject {
  const next=changed(project),target={...next.target,...copy(patch)};
  const oldFps=project.target.fps.num/project.target.fps.den,newFps=target.fps.num/target.fps.den;
  if(!Number.isFinite(newFps)||newFps<=0||newFps>120)throw new Error('FPS须大于0且不超过120');
  if(newFps!==oldFps){
    const retained=project.extensions.timebaseSeconds as Record<string,{frames:number;fps:number;seconds:number}>|undefined;
    const timing:Record<string,{frames:number;fps:number;seconds:number}>={};
    next.shots=next.shots.map(shot=>{
      const saved=retained?.[shot.id];
      const seconds=saved&&saved.frames===shot.durationFrames&&saved.fps===oldFps?saved.seconds:shot.durationFrames/oldFps;
      const frames=Math.max(1,Math.round(seconds*newFps));timing[shot.id]={frames,fps:newFps,seconds};
      return {...shot,durationFrames:frames};
    });next.extensions.timebaseSeconds=timing;
  }
  next.target=target;
  const check=validateProject(next);if(!check.ok)throw new Error(check.errors.join('\n'));
  return next;
}

/** Snapshots isolate caller edits and discard redo after any new edit. */
export class UndoHistory<T> {
  private values:T[];private index=0;readonly limit:number;
  constructor(initial:T,limit=50){this.limit=Math.max(2,Math.floor(limit));this.values=[copy(initial)];}
  get current():T{return copy(this.values[this.index]);}
  get canUndo():boolean{return this.index>0;}
  get canRedo():boolean{return this.index<this.values.length-1;}
  push(value:T):T {this.values.splice(this.index+1);this.values.push(copy(value));if(this.values.length>this.limit)this.values.shift();this.index=this.values.length-1;return this.current;}
  undo():T {if(this.canUndo)this.index-=1;return this.current;}
  redo():T {if(this.canRedo)this.index+=1;return this.current;}
  reset(value:T):T {this.values=[copy(value)];this.index=0;return this.current;}
}
