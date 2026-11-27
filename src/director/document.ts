import {createHash} from 'node:crypto';
import type {VideoProject} from '../shared/types.ts';
import {validateDirectorPlan} from './index.ts';
import type {DirectorDocument,DirectorPlan} from './contracts.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(object(value))return '{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
export function directorPlanHash(plan:DirectorPlan):string {return createHash('sha256').update(canonical(plan)).digest('hex');}
function fail(message:string,code='DIRECTOR_DOCUMENT_INVALID'):never {throw Object.assign(new Error(message),{code});}
function validPlan(input:unknown):DirectorPlan {
  let size:number;try{size=JSON.stringify(input).length;}catch{return fail('导演计划不是可保存的 JSON');}
  if(size>2*1024*1024)fail('导演计划超过 2 MiB 上限');
  const result=validateDirectorPlan(input);if(!result.ok||!result.plan)fail(result.errors.join('\n'));
  return result.plan;
}
function readDocument(value:unknown):DirectorDocument|undefined {
  if(value===undefined)return;
  if(!object(value)||value.schemaVersion!==1||!Number.isSafeInteger(value.version)||Number(value.version)<1||!['draft','approved'].includes(String(value.status))||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt)))fail('工程导演计划记录损坏；原内容已保留');
  const plan=validPlan(value.plan);
  if(value.hash!==directorPlanHash(plan)||value.status==='approved'&&(typeof value.approvedAt!=='string'||!Number.isFinite(Date.parse(value.approvedAt))))fail('导演计划内容与批准记录不一致');
  return structuredClone(value) as unknown as DirectorDocument;
}
/** Reading never creates, repairs or silently approves a document. */
export function readDirectorDocument(project:VideoProject):DirectorDocument|undefined {
  return readDocument(project.extensions.directorDocument);
}
export function readPreviousDirectorApproval(project:VideoProject):DirectorDocument|undefined {
  const document=readDocument(project.extensions.directorApprovedDocument);
  if(document&&document.status!=='approved')fail('上次导演批准记录损坏');
  return document;
}
export function validateProjectDirectorPlan(project:VideoProject,input:unknown):DirectorPlan {
  const plan=validPlan(input),shots=new Set(project.shots.map(shot=>shot.id));
  for(const shot of plan.shots)if(!shots.has(shot.shotId))fail('导演计划引用不存在的工程镜头：'+shot.shotId);
  const assets=new Map(project.assets.map(asset=>[asset.id,asset]));
  const images=[...plan.identityMap.map(binding=>binding.assetId),...plan.characters.flatMap(character=>character.referenceAssetIds??[]),
    ...(plan.locations??[]).flatMap(location=>location.referenceAssetIds??[]),...(plan.props??[]).flatMap(prop=>prop.referenceAssetIds??[])];
  for(const id of images)if(assets.get(id)?.kind!=='image')fail('导演计划引用的图片资产不存在：'+id);
  for(const shot of plan.shots){
    for(const reference of shot.references){
      const asset=assets.get(reference.assetId);
      if(!asset)fail('导演计划引用的参考资产不存在：'+reference.assetId);
      if(['depth','location','prop','first_frame','last_frame'].includes(reference.purpose)&&asset.kind!=='image')fail('此类导演参考须使用图片资产：'+reference.assetId);
    }
    if(shot.previz){
      const {imageAssetId,depthAssetId,videoAssetId,styledKeyframeAssetId,styledTailAssetId}=shot.previz;
      for(const id of [imageAssetId,depthAssetId,styledKeyframeAssetId,styledTailAssetId])if(id&&assets.get(id)?.kind!=='image')fail('预演引用的图片资产不存在：'+id);
      if(videoAssetId&&assets.get(videoAssetId)?.kind!=='video')fail('预演引用的视频资产不存在：'+videoAssetId);
    }
  }
  return plan;
}
function version(current:DirectorDocument|undefined,expected:number){if(!Number.isSafeInteger(expected)||expected<0)fail('请提供导演文档版本');if(expected!==(current?.version??0))fail('导演计划版本已变化，请重新读取后保存','REVISION_CONFLICT');}
function timestamp(value?:string){const result=value??new Date().toISOString();if(!Number.isFinite(Date.parse(result)))fail('导演计划时间无效');return result;}
/** Returns a new document; the host owns the project queue, CAS and durable commit. */
export function saveDirectorDocument(project:VideoProject,input:unknown,options:{expectedVersion:number;now?:string}):DirectorDocument {
  const current=readDirectorDocument(project);version(current,options.expectedVersion);const plan=validateProjectDirectorPlan(project,input);
  return {schemaVersion:1,version:(current?.version??0)+1,status:'draft',hash:directorPlanHash(plan),plan,updatedAt:timestamp(options.now)};
}
export function approveDirectorDocument(project:VideoProject,options:{expectedVersion:number;expectedHash:string;now?:string}):DirectorDocument {
  const current=readDirectorDocument(project);version(current,options.expectedVersion);if(!current)fail('请先保存导演计划');
  if(current.hash!==options.expectedHash)fail('导演计划内容已变化，请重新审阅','REVISION_CONFLICT');
  validateProjectDirectorPlan(project,current.plan);const at=timestamp(options.now);
  return {...current,version:current.version+1,status:'approved',updatedAt:at,approvedAt:at};
}
