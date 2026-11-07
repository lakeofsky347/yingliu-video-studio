import {DIRECTOR_RULESET_VERSION,compileDirectorShot,referencedCharacterIds,validateDirectorPlan,type DirectorPlan} from '../director/index.ts';
import type {VideoProject} from '../shared/types.ts';
import type {WorkflowRequest} from './contracts.ts';
export interface ShotPlan {shotId:string;prompt:string;narration:string}
/** Accept legacy short storyboard responses without inventing detailed performance evidence. */
export function makeDirectorPlan(value:Record<string,any>,project:VideoProject,plans:ShotPlan[],request:WorkflowRequest):DirectorPlan {
  const origin=value.directorPlan??value,raw=Array.isArray(origin.shots)?origin.shots:[];
  const remap=new Map<string,string>();
  for(const [i,s]of raw.entries())if(s?.shotId!==undefined){if(typeof s.shotId!=='string'||!s.shotId.trim()||remap.has(s.shotId)||!plans[i])throw new Error('导演临时镜头 ID 必须有效、唯一并与本轮镜头对应');remap.set(s.shotId,plans[i]!.shotId);}
  const fps=project.target.fps.num/project.target.fps.den;
  const plan:DirectorPlan={version:1,ruleSetVersion:DIRECTOR_RULESET_VERSION,filmKind:request.filmKind??origin.filmKind??'general',
    characters:origin.characters??[],worldLayouts:origin.worldLayouts??[],identityMap:origin.identityMap??[],
    storyBeats:(origin.storyBeats??[]).map((b:any)=>({...b,shotIds:Array.isArray(b.shotIds)?b.shotIds.map((id:string)=>remap.get(id)??id):b.shotIds})),
    shots:plans.map((p,i)=>{const s=raw.find((s:any)=>s.shotId===p.shotId)??raw[i]??{},shot=project.shots.find(s=>s.id===p.shotId)!;return {
      shotId:p.shotId,title:s.title??shot.title,visualPrompt:s.visualPrompt??s.prompt??p.prompt,narration:p.narration,durationSeconds:shot.durationFrames/fps,
      audioStrategy:request.directorPlan?s.audioStrategy:request.audioStrategy??(request.visual==='video'?'native':request.narration?'external':'silent'),
      performance:s.performance??[],dialogue:s.dialogue??[],events:s.events??[],references:s.references??[],acceptance:s.acceptance??[],
    };})};
  const check=validateDirectorPlan(plan);if(!check.ok)throw new Error(check.errors.join('\n'));
  for(const binding of plan.identityMap)if(!project.assets.some(a=>a.id===binding.assetId&&a.kind==='image')||!request.imageAssetIds?.includes(binding.assetId))throw new Error('人物身份映射引用了不存在或未授权的图片：'+binding.assetId);
  for(const shot of plan.shots){
    if(request.audioStrategy&&shot.audioStrategy!==request.audioStrategy)throw new Error('导演计划声音策略与本轮明确选择不符');
    if(request.visual==='video'&&shot.audioStrategy==='external'&&!request.narration)throw new Error('外配音策略需要明确开启配音');
    if(request.visual==='video'&&shot.audioStrategy!=='external'&&request.narration)throw new Error('原生声音或静音策略不能同时启动外配音');
    const visible=referencedCharacterIds(shot);
    for(const binding of plan.identityMap)if(visible.has(binding.characterId)&&!shot.references.some(r=>r.assetId===binding.assetId&&r.purpose==='identity'))throw new Error('身份映射必须绑定到该镜头的身份参考：'+binding.assetId);
    for(const ref of shot.references){if(!project.assets.some(a=>a.id===ref.assetId&&a.kind==='image'))throw new Error('当前工作流参考仅支持已有图片：'+ref.assetId);const target=project.shots.find(s=>s.id===shot.shotId)!;if(![...target.assetIds,...target.referenceIds].includes(ref.assetId))throw new Error('镜头尚未关联指定参考：'+ref.assetId);if(!request.imageAssetIds?.includes(ref.assetId))throw new Error('导演不能自行增加本轮未授权的上传参考：'+ref.assetId);}
  }
  return plan;
}
export function compiledPlans(plan:DirectorPlan):ShotPlan[]{return plan.shots.map(s=>({shotId:s.shotId,prompt:compileDirectorShot(plan,s.shotId).prompt,narration:s.narration}));}
