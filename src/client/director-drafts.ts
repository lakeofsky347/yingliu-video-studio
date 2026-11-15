import type {DirectorDocument,DirectorPlan} from '../director/contracts.ts';
export interface DirectorDraft {projectId:string;baseVersion:number;baseHash?:string;plan:DirectorPlan;updatedAt:string}
/** History can restore an earlier version number; content identity prevents an ABA overwrite. */
export function directorDraftMatchesDocument(draft:Pick<DirectorDraft,'baseVersion'|'baseHash'>,document?:Pick<DirectorDocument,'version'|'hash'>):boolean {
  return draft.baseVersion===(document?.version??0)&&draft.baseHash===document?.hash;
}
type DraftStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const memory=new Map<string,DirectorDraft>();
const prefix='yingliu-video-studio.director-draft.v1.';
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==='string');
/** Validate renderable structure, allowing unfinished editable text and invalid business constraints. */
function draftShape(value:unknown,projectId:string):value is DirectorDraft {
  if(!object(value)||value.projectId!==projectId||!Number.isSafeInteger(value.baseVersion)||value.baseVersion<0||value.baseHash!==undefined&&typeof value.baseHash!=='string'||typeof value.updatedAt!=='string')return false;
  const plan=value.plan;if(!object(plan)||plan.version!==1||typeof plan.filmKind!=='string'||typeof plan.ruleSetVersion!=='string')return false;
  if(!['characters','shots','storyBeats','worldLayouts','identityMap'].every(key=>Array.isArray(plan[key])))return false;
  if(!plan.characters.every((character:unknown)=>object(character)&&['id','name','identity'].every(key=>typeof character[key]==='string')&&(character.features===undefined||strings(character.features))&&(character.referenceAssetIds===undefined||strings(character.referenceAssetIds))&&(character.voice===undefined||typeof character.voice==='string')))return false;
  if(!plan.identityMap.every((binding:unknown)=>object(binding)&&typeof binding.characterId==='string'&&typeof binding.assetId==='string'))return false;
  return plan.shots.every((shot:unknown)=>object(shot)&&['shotId','title','visualPrompt','narration','audioStrategy'].every(key=>typeof shot[key]==='string')&&Number.isFinite(shot.durationSeconds)&&(shot.characterIds===undefined||strings(shot.characterIds))&&['performance','dialogue','events','references','acceptance'].every(key=>Array.isArray(shot[key]))&&[...shot.performance,...shot.dialogue].every(beat=>object(beat)&&typeof beat.characterId==='string')&&shot.events.every((event:unknown)=>object(event)&&Array.isArray(event.screenPositions)&&event.screenPositions.every((position:unknown)=>object(position)&&typeof position.characterId==='string')&&(event.relationships===undefined||Array.isArray(event.relationships)&&event.relationships.every((relation:unknown)=>object(relation)&&typeof relation.from==='string'&&typeof relation.to==='string'))));
}
export class DirectorDraftStore {
  warning='';private storage?:DraftStorage;
  constructor(storage?:DraftStorage){try{this.storage=storage??(typeof window==='undefined'?undefined:window.localStorage);}catch{this.warning='本地存储不可用，导演草稿仅在本次会话保留。';}}
  get(projectId:string):DirectorDraft|undefined {
    const cached=memory.get(projectId);if(cached)return structuredClone(cached);
    try{const raw=this.storage?.getItem(prefix+projectId);if(!raw)return;const value:unknown=JSON.parse(raw);if(!draftShape(value,projectId)){this.warning='本地导演草稿结构损坏，原始内容仍保留；请先备份本地草稿，再建立新的编辑草稿。';return;}memory.set(projectId,value);return structuredClone(value);}catch{this.warning='导演草稿无法从本地存储读取，已有工程计划仍保留。';return;}
  }
  set(value:DirectorDraft):void {memory.set(value.projectId,structuredClone(value));try{this.storage?.setItem(prefix+value.projectId,JSON.stringify(value));}catch{this.warning='本地存储不可用，导演草稿仅在本次会话保留。';}}
  delete(projectId:string):void {memory.delete(projectId);try{this.storage?.removeItem(prefix+projectId);}catch{this.warning='旧草稿未能从本地存储清除。';}}
}
