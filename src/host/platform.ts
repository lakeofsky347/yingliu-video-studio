import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { JobSpec, JobId } from '@deepseek-ai/dsh-jobs';
import type { ImageAttachmentRef, FileAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ModelSecrets } from '../models/contracts.ts';

interface HostCredentials {
  resolve(ref:string):Promise<{value:string}|undefined>;
  describe?(ref:string):Promise<{configured:boolean;writable:boolean;source?:string}>;
  set(ref:string,value:string):Promise<void>;
  unset?(ref:string):Promise<void>;
}

/** Resolve the active host service for each operation so rotated keys take effect immediately. */
export function modelSecrets(ctx:HostContext):ModelSecrets {
  const checked=(ref:string)=>{if(!/^DSH_VIDEO_STUDIO_[A-Z0-9_]+$/.test(ref))throw new Error('模型凭据必须属于本视频插件');return ref;};
  const active=()=>ctx.get?.('credentials') as HostCredentials|undefined;
  const required=()=>{const value=active();if(!value)throw new Error('DSH 凭据服务不可用，请先启用宿主凭据服务；模型密钥不会明文保存');return value;};
  return {
    async get(ref){return (await required().resolve(checked(ref)))?.value;},
    async set(ref,value){await required().set(checked(ref),value);},
    async delete(ref){const service=required();if(!service.unset)throw new Error('DSH 凭据服务不支持删除，请在宿主凭据设置中清除');await service.unset(checked(ref));},
    async status(ref){
      const service=active();if(!service)return {available:false,backend:'DSH credentials',error:'DSH 凭据服务不可用'};
      if(!ref)return {available:true,backend:'DSH credentials'};
      checked(ref);
      const info=service.describe?await service.describe(ref):{configured:!!(await service.resolve(ref)),writable:true};
      return {available:true,backend:info.source??'DSH credentials',hasStoredKey:info.configured};
    },
  };
}

/** Cold Session catalog facts needed for routing; forks do not carry origin=subagent. */
export interface SessionDirectoryRow {
  sessionId:string;running:boolean;parentSessionId?:string;origin?:'subagent';
  projections?:{values:Record<string,unknown>};
}

export interface HostContext {
  llm:{
    listProviders():{id:string;name:string}[];
    listModels(provider:string):Promise<{id:string;name:string;inputModalities?:string[]}[]>;
    resolveModelInfo?(provider:string,model:string,signal?:AbortSignal):Promise<{inputModalities?:string[]}>;
    stream(options:{provider:string;model:string;messages:unknown[];system:string;maxTokens:number;sessionId:string;signal:AbortSignal}):AsyncIterable<{type:string;text?:string;reason?:{kind:string;failure?:{message:string}}}>;
  };
  get?(name:string):unknown;
  tools?:{register(definition:ToolDefinition):()=>void};
  jobs?:{start(spec:JobSpec):JobId};
  sessionController?:{
    list(request:Record<string,never>,signal:AbortSignal):Promise<{items:readonly SessionDirectoryRow[]}>;
    projections?(request:{sessionId:string},signal:AbortSignal):Promise<{values:Record<string,unknown>}|null>;
  };
  attachments?:{
    readImage(ref:ImageAttachmentRef,signal?:AbortSignal):Promise<{data:Uint8Array}>;
    fileHostPath(ref:FileAttachmentRef):string|undefined;
  };
  connection:{fetch:{register(route:{path:string;methods:readonly ['POST'];requestBody:'buffered';fetch(request:Request):Promise<Response>}):()=>Promise<void>}};
  effect(factory:()=>void|(()=>void|Promise<void>),label?:string):unknown;
}
