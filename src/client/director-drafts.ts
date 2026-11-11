import type {DirectorDocument,DirectorPlan} from '../director/contracts.ts';
export interface DirectorDraft {projectId:string;baseVersion:number;baseHash?:string;plan:DirectorPlan;updatedAt:string}
/** History can restore an earlier version number; content identity prevents an ABA overwrite. */
export function directorDraftMatchesDocument(draft:Pick<DirectorDraft,'baseVersion'|'baseHash'>,document?:Pick<DirectorDocument,'version'|'hash'>):boolean {
  return draft.baseVersion===(document?.version??0)&&draft.baseHash===document?.hash;
}
type DraftStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const memory=new Map<string,DirectorDraft>();
const prefix='yingliu-video-studio.director-draft.v1.';
export class DirectorDraftStore {
  warning='';private storage?:DraftStorage;
  constructor(storage?:DraftStorage){try{this.storage=storage??(typeof window==='undefined'?undefined:window.localStorage);}catch{this.warning='本地存储不可用，导演草稿仅在本次会话保留。';}}
  get(projectId:string):DirectorDraft|undefined {
    const cached=memory.get(projectId);if(cached)return structuredClone(cached);
    try{const raw=this.storage?.getItem(prefix+projectId);if(!raw)return;const value=JSON.parse(raw);if(value?.projectId!==projectId||!Number.isSafeInteger(value.baseVersion)||value.baseVersion<0||value.plan?.version!==1||!Array.isArray(value.plan.shots))return;memory.set(projectId,value);return structuredClone(value);}catch{this.warning='导演草稿无法从本地存储读取，已有工程计划仍保留。';return;}
  }
  set(value:DirectorDraft):void {memory.set(value.projectId,structuredClone(value));try{this.storage?.setItem(prefix+value.projectId,JSON.stringify(value));}catch{this.warning='本地存储不可用，导演草稿仅在本次会话保留。';}}
  delete(projectId:string):void {memory.delete(projectId);try{this.storage?.removeItem(prefix+projectId);}catch{this.warning='旧草稿未能从本地存储清除。';}}
}
