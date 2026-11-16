import type { SessionBinding } from '../shared/types.ts';
import {t,formatDate} from './i18n.ts';

/** A view of the host directory; the plugin does not maintain a second Session catalog. */
export interface SessionDirectoryEntry {
  id:string; displayTitle:string; cwd?:string; running?:boolean; updatedAt?:string|number;
  origin?:string; parentId?:string; rootSessionId?:string; archived?:boolean;
  kind?:'user'|'subagent'|'team'; originLabel?:string; teamId?:string; teamRole?:string; navigable?:boolean;
}
export interface SessionDirectoryProps {
  sessions?:SessionDirectoryEntry[]; sessionsLoading?:boolean; sessionsError?:string;
  onRefreshSessions?:(sessionId?:string)=>void|Promise<void>; currentSessionId?:string;
  onOpenSession?:(sessionId:string)=>void|Promise<void>;
}
export function isDelegatedSession(session:SessionDirectoryEntry):boolean {
  return session.kind==='subagent'||session.kind==='team'||session.origin==='subagent';
}
export function resolveSessionBinding(sessionId:string,sessions:SessionDirectoryEntry[],bindings:Record<string,SessionBinding>):{binding?:SessionBinding;ownerSessionId?:string;inherited:boolean} {
  const byId=new Map(sessions.map(session=>[session.id,session]));
  const visited=new Set<string>();let id:string|undefined=sessionId;
  while(id&&!visited.has(id)){
    visited.add(id);if(bindings[id])return {binding:bindings[id],ownerSessionId:id,inherited:id!==sessionId};
    const row=byId.get(id);id=row&&isDelegatedSession(row)?row.parentId||(row.rootSessionId!==id?row.rootSessionId:undefined):undefined;
  }
  return {inherited:false};
}
export function projectSessions(projectId:string,sessions:SessionDirectoryEntry[],bindings:Record<string,SessionBinding>):SessionDirectoryEntry[] {
  return sessions.filter(session=>resolveSessionBinding(session.id,sessions,bindings).binding?.relatedProjectIds.includes(projectId));
}
export function sessionName(sessionId:string,sessions:SessionDirectoryEntry[]):string {
  return sessions.find(session=>session.id===sessionId)?.displayTitle||t('不可用会话 · {0}',{0:sessionId.slice(0,8)});
}
export function sessionUpdatedAt(value:string|number|undefined):string {
  if(value===undefined)return '';const date=new Date(value);return Number.isNaN(date.valueOf())?'':formatDate(date.toISOString(),{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
