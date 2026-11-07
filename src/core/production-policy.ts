import type {Asset, ProductionMode, ProductionOperation, ProductionPolicy, Shot, VideoProject} from '../shared/types.js';

const modes:ProductionMode[]=['unresolved','code_animation','model_video','hybrid'];
const visualKinds=['unresolved','code','model_video','imported_video','hybrid'];
let decisionSequence=0;
const decisionSession=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
function newDecisionId():string {
  return globalThis.crypto?.randomUUID?.()??`decision-${decisionSession}-${(++decisionSequence).toString(36)}`;
}
/** Every trusted confirmation receives a fresh identity, even when its permissions match an earlier decision. */
export function defaultProductionPolicy(mode:ProductionMode='unresolved'):ProductionPolicy {
  return {version:1,decisionId:newDecisionId(),mode,allowGeneratedImages:false,allowImportedVideo:false};
}
export function productionMode(project:VideoProject):ProductionMode {return project.productionPolicy?.mode??'unresolved';}
export function usesCodeVisual(shot:Shot):boolean {return shot.visual?.kind==='code'||shot.visual?.kind==='hybrid';}
export function usesVideoVisual(shot:Shot):boolean {return ['model_video','imported_video','hybrid'].includes(shot.visual?.kind??'');}
export function assetOrigin(asset:Asset):NonNullable<Asset['provenance']>['origin'] {
  return asset.provenance?.origin??(asset.generation?'model_generation':'unknown');
}
function stable(value:unknown):unknown {
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)]));
  return value;
}
/** Full canonical value, not a collision-prone digest. Any policy edit invalidates queued authority. */
export function productionPolicyFingerprint(project:VideoProject):string {
  return JSON.stringify(stable({projectId:project.id,policy:project.productionPolicy??{mode:'unresolved',decisionId:null}}));
}
export function validateProductionPolicy(project:VideoProject):string[] {
  const errors:string[]=[],policy=project.productionPolicy;
  if(project.schemaVersion!==3)return errors;
  if(!policy||policy.version!==1||typeof policy.decisionId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(policy.decisionId)||!modes.includes(policy.mode)||typeof policy.allowGeneratedImages!=='boolean'||typeof policy.allowImportedVideo!=='boolean')return ['制作策略或用户决定标识缺失或无效'];
  if(policy.hybridGrants!==undefined&&!Array.isArray(policy.hybridGrants))errors.push('混合许可必须为数组');
  const ids=new Set<string>();
  for(const grant of Array.isArray(policy.hybridGrants)?policy.hybridGrants:[]){
    if(!grant||typeof grant.id!=='string'||!grant.id||ids.has(grant.id)||grant.projectId!==project.id||!Array.isArray(grant.shotIds)||!grant.shotIds.length||grant.shotIds.some(id=>typeof id!=='string'||!id)||!Array.isArray(grant.operations)||!grant.operations.length||grant.operations.some(op=>op!=='code'&&op!=='video')||typeof grant.confirmedAt!=='string'||!Number.isFinite(Date.parse(grant.confirmedAt)))errors.push('混合许可范围或用户决定凭据无效');
    if(grant?.id)ids.add(grant.id);
  }
  if(policy.mode!=='hybrid'&&policy.hybridGrants?.length)errors.push('非混合模式不得携带混合许可');
  if(policy.mode==='hybrid'&&!['code_animation','model_video'].includes(policy.baseMode??''))errors.push('混合模式须保留明确的基础制作方式');
  if(policy.mode!=='hybrid'&&policy.baseMode!==undefined)errors.push('非混合模式不得携带混合基础方式');
  for(const shot of project.shots??[])if(!shot.visual||!visualKinds.includes(shot.visual.kind))errors.push(`镜头 ${shot.id} 缺少画面来源标记`);
  for(const asset of project.assets??[])if(asset.provenance&&(!['user_import','model_generation','code_render','unknown'].includes(asset.provenance.origin)||!['reference_only','production'].includes(asset.provenance.usage)))errors.push(`资产 ${asset.id} 来源或用途无效`);
  return errors;
}
function failure(message:string):never {throw Object.assign(new Error(message),{code:'PRODUCTION_POLICY_VIOLATION',submissionUncertain:false});}
function assertPolicy(project:VideoProject):ProductionPolicy {
  const errors=validateProductionPolicy(project);if(errors.length)failure(errors.join('\n'));
  if(project.schemaVersion!==3||!project.productionPolicy||productionMode(project)==='unresolved')failure('请先由用户确认本工程的制作模式');
  return project.productionPolicy!;
}
function authorized(policy:ProductionPolicy,projectId:string,shotId:string,operation:'code'|'video'):boolean {
  return !!policy.hybridGrants?.some(grant=>grant.projectId===projectId&&grant.shotIds.includes(shotId)&&grant.operations.includes(operation));
}
export function assertProductionOperation(project:VideoProject,operation:ProductionOperation,shotIds?:string[]):void {
  const policy=assertPolicy(project);
  if(!['code','image','video'].includes(operation))failure('未知制作操作');
  const ids=shotIds??project.shotOrder;
  if(ids.some(id=>!project.shots.some(shot=>shot.id===id)))failure('制作操作引用不存在的镜头');
  if(operation==='image'){if(!policy.allowGeneratedImages)failure('本工程尚未允许生成图片素材');return;}
  if(policy.mode==='code_animation'&&operation==='code'||policy.mode==='model_video'&&operation==='video')return;
  if(policy.mode==='hybrid'&&(operation==='code'&&policy.baseMode==='code_animation'||operation==='video'&&policy.baseMode==='model_video'||ids.length&&ids.every(id=>authorized(policy,project.id,id,operation))))return;
  failure(operation==='video'?'当前模式或镜头许可不允许视频模型生成；不能跨模式替代':'当前模式或镜头许可不允许执行自由动画源码');
}
/** Only inspect active composition. Historical source and disabled clips may remain on disk. */
export function assertProductionComposition(project:VideoProject,options:{forExport?:boolean}={}):void {
  const policy=assertPolicy(project);
  for(const id of project.shotOrder){
    const shot=project.shots.find(item=>item.id===id);if(!shot)failure('主链引用不存在的镜头');
    if(shot.visual?.kind==='unresolved')failure(`镜头 ${id} 尚未确认画面来源`);
    if(usesCodeVisual(shot))assertProductionOperation(project,'code',[id]);
    if(usesVideoVisual(shot)){
      assertProductionOperation(project,'video',[id]);
      const clip=project.videoClips?.find(item=>item.shotId===id),asset=project.assets.find(item=>item.id===clip?.assetId);
      if(!clip||!asset||asset.kind!=='video')failure(`镜头 ${id} 尚未采用视频，禁止用代码或占位画面替代`);
      if(asset.provenance?.usage==='reference_only')failure(`参考专用视频 ${asset.id} 不得进入成片`);
      const origin=assetOrigin(asset);
      if(origin==='code_render'){
        if(policy.mode!=='hybrid')failure('代码渲染视频不能伪装为模型或导入视频进入成片');
        assertProductionOperation(project,'code',[id]);
      }else if(origin!=='model_generation'&&!policy.allowImportedVideo)failure(`镜头 ${id} 使用自有或未知来源视频前须得到用户许可`);
      if(shot.visual?.kind==='model_video'&&origin!=='model_generation')failure(`镜头 ${id} 的模型视频来源标记与实际资产不符`);
      if(shot.visual?.kind==='imported_video'&&origin==='model_generation')failure(`镜头 ${id} 的导入视频来源标记与实际资产不符`);
      if(options.forExport){
        const seconds=shot.durationFrames*project.target.fps.den/project.target.fps.num;
        const available=(Math.min(clip.trimEnd??asset.duration!,asset.duration!)-clip.trimStart)/clip.speed;
        if(available+1e-6<seconds)failure(`镜头 ${id} 视频长度不足，不能自动冻结末帧补齐成片`);
      }
    }
    for(const assetId of shot.assetIds){
      const asset=project.assets.find(item=>item.id===assetId);if(!asset)continue;
      if(asset.provenance?.usage==='reference_only')failure(`参考专用资产 ${assetId} 不得绑定为成片素材`);
      if(asset.kind==='video')failure(`视频 ${assetId} 须通过明确的视频画面绑定使用，不能暴露给自由源码`);
    }
  }
  for(const clip of project.audioClips??[])if(project.assets.find(asset=>asset.id===clip.assetId)?.provenance?.usage==='reference_only')failure('参考专用音频不得进入成片音轨');
}
/** Trusted host only. This is a transformation, not proof of a user decision. */
export function applyProductionPolicy(project:VideoProject,input:ProductionPolicy):VideoProject {
  const next=structuredClone(project);next.schemaVersion=3;next.productionPolicy=structuredClone(input);
  for(const shot of next.shots){
    if(input.mode==='unresolved')shot.visual={kind:'unresolved'};
    else if(input.mode==='code_animation')shot.visual={kind:'code'};
    else if(input.mode==='model_video'){
      const clip=next.videoClips?.find(item=>item.shotId===shot.id),asset=next.assets.find(item=>item.id===clip?.assetId);
      shot.visual={kind:asset&&assetOrigin(asset)!=='model_generation'?'imported_video':'model_video'};
    }else if(!shot.visual||shot.visual.kind==='unresolved'){
      const clip=next.videoClips?.find(item=>item.shotId===shot.id),asset=next.assets.find(item=>item.id===clip?.assetId);
      shot.visual={kind:asset?(assetOrigin(asset)==='model_generation'?'model_video':'imported_video'):'code'};
    }
  }
  const errors=validateProductionPolicy(next);if(errors.length)failure(errors.join('\n'));
  next.revision+=1;next.updatedAt=new Date().toISOString();return next;
}
