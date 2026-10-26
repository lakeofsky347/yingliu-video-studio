import type { Asset, SceneSource, StudioSnapshot, VideoProject } from '../shared/types.ts';
import type { MediaTask, GeneratedFile } from '../jobs/contracts.ts';

export interface WorkflowRequest {
  projectId:string;expectedRevision:number;prompt:string;shotIds?:string[];
  visual:'code'|'image'|'video';narration:boolean;review:boolean;
  allowImageUpload:boolean;imageAssetIds?:string[];maxTasks?:number;maxCost?:number;
  textRoute?:{provider:string;model:string};ownerSessionId?:string;
}
export interface WorkflowModelCall {
  role:'director'|'scene'|'vision';status:'running'|'complete'|'failed';startedAt:string;finishedAt?:string;durationMs?:number;
}
export interface WorkflowStep {
  id:string;shotId?:string;kind:'plan'|'code'|'image'|'video'|'speech'|'review'|'commit';
  status:'pending'|'running'|'complete'|'failed';message:string;taskId?:string;
  startedAt?:string;finishedAt?:string;durationMs?:number;modelCalls?:WorkflowModelCall[];
  source?:SceneSource;assetIds?:string[];review?:string;reviewCandidateHash?:string;mediaAttempt?:number;previousTaskIds?:string[];submissionUncertain?:boolean;frameEvidence?:{frame:number;sha256:string}[];
}
export interface WorkflowRecord {
  version:1;id:string;projectId:string;request:WorkflowRequest;
  status:'running'|'paused'|'failed'|'awaiting-apply'|'complete';
  message:string;error?:string;createdAt:string;updatedAt:string;
  startRevision:number;committedRevision?:number;steps:WorkflowStep[];
  usage:{cost:number|null;currency?:string;generatedTasks:number;mediaCost?:number};
}
export interface WorkflowCandidate {project:VideoProject;sources:Record<string,SceneSource>}
export interface WorkflowPort {
  snapshot(projectId:string):Promise<StudioSnapshot>;
  source(projectId:string,shotId:string):Promise<SceneSource>;
  text(role:'director'|'scene'|'vision',prompt:string,signal:AbortSignal,request:WorkflowRequest,images?:{bytes:Uint8Array;mime:string}[]):Promise<string>;
  commit(projectId:string,expectedRevision:number,project:VideoProject,sources:Record<string,SceneSource>,label:string):Promise<StudioSnapshot>;
  /** Trusted staging only: writes immutable media files, never changes the project head. */
  stageMedia(projectId:string,task:MediaTask,files:GeneratedFile[],signal:AbortSignal):Promise<Asset[]>;
  voice(projectId:string,shotId:string,text:string,signal:AbortSignal):Promise<Asset>;
  capture(projectId:string,frame:number,signal:AbortSignal,candidate?:WorkflowCandidate):Promise<{bytes:Uint8Array;mime:string;sha256:string}>;
}
