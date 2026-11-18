import type { SessionDirectoryEntry } from './session-directory.ts';
import {t} from './i18n.ts';

export interface Observable<T>{getSnapshot():T;subscribe(listener:()=>void):()=>void}
export interface HostSessionRow {
  id:string;displayTitle?:string;title?:string;cwd?:string;running?:boolean;updatedAt?:number;
  origin?:'subagent';parentId?:string;retainedBy?:Record<string,number>;projectionValues?:Record<string,unknown>;
}
export interface HostSessionList {
  ids:string[];byId:Record<string,HostSessionRow>;phase?:string;
  projectionsBySession?:Record<string,{values?:Record<string,unknown>}>;
}
export interface HostWorkspaceList {items?:readonly {path:string;sessionIds:readonly string[]}[];archivedSessionIds:readonly string[]}
export type SessionTarget=string|{parentSessionId:string;childSessionId:string;mode:'one-shot'|'continuable'};
function object(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}

/** Enumerate host catalog members and durable children, never unrelated retained fallback rows. */
export function sessionDirectory(list:HostSessionList,workspaces:HostWorkspaceList):SessionDirectoryEntry[]{
  const rows=new Map<string,SessionDirectoryEntry>(),archived=new Set(workspaces.archivedSessionIds);
  const put=(id:string,extra:Partial<SessionDirectoryEntry>={})=>{
    const host=list.byId[id],old=rows.get(id);
    rows.set(id,{id,displayTitle:host?.displayTitle??host?.title??old?.displayTitle??id,cwd:host?.cwd??old?.cwd,
      running:host?.running??false,updatedAt:host?.updatedAt??old?.updatedAt??0,origin:host?.origin??old?.origin,
      parentId:host?.parentId??old?.parentId,kind:host?.origin==='subagent'?'subagent':'user',archived:archived.has(id),...old,...extra});
  };
  for(const id of list.ids)put(id);
  const parents=[...list.ids],queued=new Set(parents);
  for(let at=0;at<parents.length;at++){
    const parentId=parents[at],parent=rows.get(parentId);
    const values=list.projectionsBySession?.[parentId]?.values??list.byId[parentId]?.projectionValues??{};
    if(Array.isArray(values.subagentCatalog))for(const child of values.subagentCatalog){
      const item=object(child);if(typeof item.id!=='string')continue;
      put(item.id,{origin:'subagent',parentId,kind:'subagent',displayTitle:list.byId[item.id]?.title??list.byId[item.id]?.displayTitle??(typeof item.label==='string'?item.label:item.id),cwd:list.byId[item.id]?.cwd??parent?.cwd,
        originLabel:t(item.mode==='continuable'?'可继续子代理':'子代理'),navigable:item.mode==='one-shot'||item.mode==='continuable',archived:!!parent?.archived||archived.has(item.id)});
      if(!queued.has(item.id)){queued.add(item.id);parents.push(item.id);}
    }
    const team=object(values.agentTeam);
    if(Array.isArray(team.members))for(const member of team.members){
      const item=object(member);if(typeof item.id!=='string'||item.role==='lead'||item.phase!=='active')continue;
      put(item.id,{origin:'subagent',parentId,kind:'team',teamId:parentId,originLabel:t('团队成员'),navigable:true,
        displayTitle:list.byId[item.id]?.title??list.byId[item.id]?.displayTitle??(typeof item.name==='string'?item.name:item.id),cwd:list.byId[item.id]?.cwd??parent?.cwd,archived:!!parent?.archived||archived.has(item.id)});
      if(!queued.has(item.id)){queued.add(item.id);parents.push(item.id);}
    }
  }
  for(const row of rows.values()){
    let owner=row;const seen=new Set<string>();
    while(owner.origin==='subagent'&&owner.parentId&&!seen.has(owner.id)){
      seen.add(owner.id);const parent=rows.get(owner.parentId);if(!parent)break;owner=parent;
    }
    row.rootSessionId=owner.id;
  }
  const time=(value:string|number|undefined)=>typeof value==='number'?value:Date.parse(value??'')||0;
  return [...rows.values()].sort((a,b)=>time(b.updatedAt)-time(a.updatedAt));
}

/** Child navigation requires its durable direct-parent address, rather than a plain Session ID. */
export function sessionTarget(id:string,list:HostSessionList,address:(id:string)=>SessionTarget|undefined):SessionTarget{
  const known=address(id);if(known)return known;
  const row=list.byId[id];
  for(const {id:parentId} of sessionDirectory(list,{archivedSessionIds:[]})){
    const values=list.projectionsBySession?.[parentId]?.values??list.byId[parentId]?.projectionValues??{};
    const catalog=Array.isArray(values.subagentCatalog)?values.subagentCatalog:[];
    const child=catalog.map(object).find(item=>item.id===id);
    if(child&&(child.mode==='one-shot'||child.mode==='continuable'))return {parentSessionId:parentId,childSessionId:id,mode:child.mode};
    const members=object(values.agentTeam).members;
    if(Array.isArray(members)&&members.map(object).some(item=>item.id===id&&item.role==='teammate'&&item.phase==='active'))return {parentSessionId:parentId,childSessionId:id,mode:'continuable'};
  }
  if(row?.origin==='subagent')throw new Error('此子代理的宿主地址暂不可用，请刷新会话列表');
  if(!list.ids.includes(id))throw new Error('此会话暂不可用，请刷新或选择其他会话');
  return id;
}
