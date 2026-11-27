import type { ModelSelection, ProviderConnection, ModelDefinition, ResolvedModel } from '../models/contracts.ts';

export const MEDIA_OPERATIONS=['text-to-image','text-to-video','image-to-video','first-last-frame-video','image-compose','lip-sync-video'] as const;
export type MediaOperation=typeof MEDIA_OPERATIONS[number];
export function mediaOutput(operation:MediaOperation):'image'|'video'{
  return operation==='text-to-image'||operation==='image-compose'?'image':'video';
}
export function hasImageInputs(operation:MediaOperation):boolean{
  return operation==='image-to-video'||operation==='image-compose'||operation==='first-last-frame-video';
}
export type RemoteStatus='queued'|'running'|'succeeded'|'failed'|'cancelled';
export type MediaPhase='pending'|'submitting'|'queued'|'running'|'downloading'|'validating'|'ready'|'applying'|'complete'|'failed'|'cancelled'|'unknown';
export interface MediaUsage { inputTokens?:number;outputTokens?:number;cost?:number;currency?:string;[key:string]:unknown }
export interface MediaArtifact {url?:string;base64?:string;mimeType:string;name?:string;sameOriginAuth?:boolean}
export interface RemoteJob {jobId:string;status:RemoteStatus;progress?:number;artifacts?:MediaArtifact[];error?:string;usage?:MediaUsage}
export interface GeneratedFile {path:string;mimeType:string;name:string;bytes:number;sha256:string;metadata:Record<string,unknown>}
export interface MediaRequest {
  projectId:string;shotId?:string;expectedRevision:number;operation:MediaOperation;prompt:string;
  /** Stable workflow step request ID; repeated requests return the original task. */
  clientRequestId?:string;
  modelId?:string;connectionId?:string;imageAssetIds?:string[];allowImageUpload?:boolean;
  parameters?:Record<string,string|number|boolean>;ownerSessionId?:string;
  referenceRoles?:string[];requiresAudio?:boolean;
  videoAssetId?:string;audioAssetId?:string;uploadConsentId?:string;
}
export interface MediaTask {
  version:1;id:string;clientRequestId:string;projectId:string;shotId?:string;startRevision:number;
  operation:MediaOperation;prompt:string;imageAssetIds:string[];inputHashes:{assetId:string;sha256:string}[];
  connection:ProviderConnection;model:ModelDefinition;parameters:Record<string,string|number|boolean>;
  ownerSessionId?:string;phase:MediaPhase;observation:'active'|'paused';remoteStatus?:RemoteStatus;remoteJobId?:string;
  progress:number;message:string;error?:string;createdAt:string;updatedAt:string;
  artifacts?:MediaArtifact[];files:GeneratedFile[];usage?:MediaUsage;applied?:{assetIds:string[];revision:number};
  cancelRequested?:boolean;resumeOnStart?:boolean;
  /** Captured by the host, never supplied by the model/client. */
  productionPolicyFingerprint?:string;referenceRoles?:string[];requiresAudio?:boolean;
  videoAssetId?:string;audioAssetId?:string;
  metrics?:{submittedAt?:string;remoteCompletedAt?:string;readyAt?:string;appliedAt?:string;generationMs?:number;downloadMs?:number;downloadBytes?:number};
}
export interface MediaRegistryPort {
  resolve(selection:ModelSelection):Promise<ResolvedModel>;
  credential(connection:ProviderConnection|string):Promise<string|undefined>;
  acquire?(connectionId:string,modelId?:string):()=>void;
  setUsageGuard?(guard:(connectionId:string,modelId?:string)=>boolean|Promise<boolean>):void;
}
export interface MediaProjectPort {
  inspect(projectId:string):Promise<{revision:number;shotIds:string[]}>;
  authorizeOperation?(projectId:string,operation:MediaOperation,shotId?:string,expectedFingerprint?:string):Promise<string>;
  /** Holds the project mutation queue through the actual POST so policy changes cannot race submission. */
  submitAuthorized?<T>(projectId:string,operation:MediaOperation,shotId:string|undefined,expectedFingerprint:string|undefined,submit:()=>Promise<T>):Promise<T>;
  /** Must enforce current project/shot asset membership and filesystem boundaries. */
  readImage(projectId:string,assetId:string,shotId?:string):Promise<{bytes:Uint8Array;mime:string}>;
  readLipSyncAsset?(projectId:string,assetId:string,kind:'video'|'audio',shotId?:string):Promise<{bytes:Uint8Array;mime:string}>;
  /** Must inspect actual media, not merely trust extension or provider content type. */
  validateArtifact(path:string,mimeType:string,projectId:string,signal?:AbortSignal):Promise<Record<string,unknown>>;
  /** One CAS transaction; idempotent for provenance.taskId in case response is lost. */
  applyResult(input:{projectId:string;shotId?:string;expectedRevision:number;files:GeneratedFile[];productionPolicyFingerprint?:string;provenance:{taskId:string;connectionId:string;model:string;operation:MediaOperation;prompt:string;inputHashes:{assetId:string;sha256:string}[]}}):Promise<{assetIds:string[];revision:number}>;
}
export interface MediaTaskOptions {fetch?:typeof fetch;pollIntervalMs?:number;maxConcurrent?:number;maxArtifactBytes?:number;maxTaskBytes?:number;onChange?:(task:MediaTask)=>void}
