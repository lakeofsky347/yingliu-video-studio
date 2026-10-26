/** Portable model contracts; credentials and running jobs never belong in projects. */
export type ModelProtocol = 'chat-completions' | 'images' | 'video-gateway' | 'speech';
export type ModelRole = 'director' | 'scene' | 'vision' | 'image' | 'video' | 'speech';
export type Modality = 'text' | 'image' | 'video' | 'audio';
export interface CredentialStatus { available:boolean; backend:string; hasStoredKey?:boolean; error?:string }
export interface ModelSecrets {
  get(ref:string):Promise<string|undefined>;
  set(ref:string,value:string):Promise<void>;
  delete(ref:string):Promise<void>;
  status?(ref?:string):Promise<CredentialStatus>;
  withUpdate?(ref:string,value:string|undefined,commit:()=>Promise<void>):Promise<void>;
}
export interface ProviderConnection {
  id:string; name:string; protocol:ModelProtocol; baseUrl:string;
  auth:'bearer'|'none'; credentialRef:string; enabled:boolean; revision:number;
  requestTimeoutMs:number; concurrency:number;
}
export interface ModelDefinition {
  /** Local stable ID, distinct from the API's model name. */
  id:string; connectionId:string; model:string; name:string; enabled:boolean;
  inputModalities:Modality[]; outputModalities:Modality[];
  parameters:Record<string,string|number|boolean>;
}
export interface RoleBinding { role:ModelRole; modelId:string }
export interface RegistryState { version:1; connections:ProviderConnection[]; models:ModelDefinition[]; roles:RoleBinding[] }
export interface ConnectionSummary extends ProviderConnection { hasKey:boolean; credentialStatus?:CredentialStatus }
export interface RegistrySnapshot extends Omit<RegistryState,'connections'> { connections:ConnectionSummary[] }
export interface ResolvedModel { connection:ProviderConnection; model:ModelDefinition }
export type ModelSelection = ModelRole | { role?:ModelRole; modelId?:string; connectionId?:string; provider?:string; model?:string; protocol?:ModelProtocol };
export type ConnectionInput = Partial<Omit<ProviderConnection,'revision'|'credentialRef'>> & { id?:string; apiKey?:string };
export type ModelInput = Partial<ModelDefinition> & { connectionId:string; model:string };
export type RegistrySeed = Omit<RegistryState,'version'>;
export const MODEL_ROLES:readonly ModelRole[]=['director','scene','vision','image','video','speech'];
export const MODEL_PROTOCOLS:readonly ModelProtocol[]=['chat-completions','images','video-gateway','speech'];
