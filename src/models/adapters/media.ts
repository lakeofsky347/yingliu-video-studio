import type { ProviderConnection, ModelDefinition } from '../contracts.ts';
import type { MediaArtifact, MediaOperation, RemoteJob } from '../../jobs/contracts.ts';

export interface AdapterInput {clientRequestId:string;model:ModelDefinition;operation:MediaOperation;prompt:string;inputs:{type:'image';dataUrl:string}[];parameters:Record<string,string|number|boolean>}
export interface AdapterContext {connection:ProviderConnection;key?:string;signal:AbortSignal;fetch?:typeof fetch}
export function mediaEndpoint(connection:ProviderConnection,path:string):string {
  const base=connection.baseUrl.replace(/\/+$/,'');
  return base+(connection.protocol==='video-gateway'&&!/\/v1$/.test(base)?'/v1':'')+path;
}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('媒体接口返回无效对象');return value as Record<string,unknown>;}
function number(value:unknown):number|undefined{return typeof value==='number'&&Number.isFinite(value)?value:undefined;}
export function parseRemoteJob(value:unknown):RemoteJob {
  const data=record(value);if(typeof data.jobId!=='string'||!data.jobId||data.jobId.length>500||!['queued','running','succeeded','failed','cancelled'].includes(String(data.status)))throw new Error('媒体网关任务 ID 或状态无效');
  let artifacts:MediaArtifact[]|undefined;
  if(data.artifacts!==undefined){if(!Array.isArray(data.artifacts)||data.artifacts.length>8)throw new Error('媒体网关产物数量无效');artifacts=data.artifacts.map(raw=>{const artifact=record(raw);if(typeof artifact.url!=='string'||artifact.url.length>16000||typeof artifact.mimeType!=='string')throw new Error('媒体网关产物地址或类型无效');return {url:artifact.url,mimeType:artifact.mimeType,...(typeof artifact.name==='string'?{name:artifact.name.slice(0,200)}:{})};});}
  if(data.status==='succeeded'&&!artifacts?.length)throw new Error('媒体网关成功状态缺少产物');
  const progress=number(data.progress);if(data.progress!==undefined&&(progress===undefined||progress<0||progress>1))throw new Error('媒体网关进度应为 0–1');
  const rawUsage=data.usage&&typeof data.usage==='object'&&!Array.isArray(data.usage)?record(data.usage):undefined;
  const usage=rawUsage?Object.fromEntries(Object.entries(rawUsage).filter(([key,value])=>['inputTokens','outputTokens','cost'].includes(key)&&typeof value==='number'&&Number.isFinite(value)&&value>=0||key==='currency'&&typeof value==='string'&&/^[A-Z]{3}$/.test(value))):undefined;
  if(usage?.cost!==undefined&&(typeof usage.cost!=='number'||!Number.isFinite(usage.cost)||usage.cost<0))throw new Error('媒体接口费用无效');
  return {jobId:data.jobId,status:data.status as RemoteJob['status'],...(progress!==undefined?{progress}:{}),...(artifacts?{artifacts}:{}),...(typeof data.error==='string'?{error:data.error.slice(0,1000)}:{}),...(usage?{usage}:{})};
}
async function request(context:AdapterContext,path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<Response>{
  if(context.connection.auth==='bearer'&&!context.key)throw Object.assign(new Error('媒体服务凭据不可用，请配置或解锁后重试'),{code:'NEEDS_CREDENTIALS'});
  return (context.fetch??fetch)(mediaEndpoint(context.connection,path),{method,redirect:'error',headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{}),...(context.connection.auth==='bearer'?{Authorization:'Bearer '+context.key}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([context.signal,AbortSignal.timeout(context.connection.requestTimeoutMs)])});
}
async function json(response:Response):Promise<unknown>{
  if(!response.ok)throw Object.assign(new Error('媒体接口请求失败（HTTP '+response.status+'）'),{httpStatus:response.status});
  if(!response.body)throw new Error('媒体接口响应为空');const reader=response.body.getReader();let size=0;const parts:Uint8Array[]=[];
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>48*1024*1024)throw new Error('媒体接口 JSON 响应超过 48 MiB');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new Error('媒体接口返回无效 JSON');}
}
export async function generateImage(context:AdapterContext,input:AdapterInput):Promise<RemoteJob>{
  if(input.operation!=='text-to-image')throw new Error('图片兼容接口只支持文生图');
  // Never spread provider parameters after identity fields: parameters cannot override model/prompt.
  const allowed=['size','quality','style','response_format','background','output_format','n'];const parameters=Object.fromEntries(Object.entries(input.parameters).filter(([key])=>allowed.includes(key)));
  if(parameters.n!==undefined&&(!Number.isInteger(parameters.n)||Number(parameters.n)<1||Number(parameters.n)>4))throw new Error('每次生图数量须为 1–4');
  const data=record(await json(await request(context,'/images/generations',{...parameters,model:input.model.model,prompt:input.prompt})));
  if(!Array.isArray(data.data)||!data.data.length||data.data.length>4)throw new Error('生图接口没有返回有效产物');
  const artifacts=data.data.map(raw=>{const artifact=record(raw);if(typeof artifact.b64_json==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(artifact.b64_json))return {base64:artifact.b64_json,mimeType:typeof data.output_format==='string'&&data.output_format==='jpeg'?'image/jpeg':typeof parameters.output_format==='string'&&parameters.output_format==='webp'?'image/webp':'image/png'};
    if(typeof artifact.url==='string')return {url:artifact.url,mimeType:'image/png'};throw new Error('生图产物缺少 URL 或 Base64');});
  return {jobId:input.clientRequestId,status:'succeeded',artifacts,...(data.usage&&typeof data.usage==='object'?{usage:Object.fromEntries(Object.entries(data.usage as Record<string,unknown>).filter(([key,value])=>['input_tokens','output_tokens','total_tokens','cost'].includes(key)&&typeof value==='number'&&Number.isFinite(value)&&value>=0||key==='currency'&&typeof value==='string'&&/^[A-Z]{3}$/.test(value)))}:{})};
}
export async function submitVideo(context:AdapterContext,input:AdapterInput):Promise<RemoteJob>{
  return parseRemoteJob(await json(await request(context,'/media/jobs',{clientRequestId:input.clientRequestId,model:input.model.model,operation:input.operation,prompt:input.prompt,inputs:input.inputs,parameters:input.parameters})));
}
export async function getVideo(context:AdapterContext,jobId:string):Promise<RemoteJob>{return parseRemoteJob(await json(await request(context,'/media/jobs/'+encodeURIComponent(jobId))));}
export async function lookupVideo(context:AdapterContext,clientRequestId:string):Promise<RemoteJob|null>{
  const response=await request(context,'/media/jobs?clientRequestId='+encodeURIComponent(clientRequestId));if(response.status===404)return null;
  const data=await json(response);if(data===null)return null;return parseRemoteJob(data);
}
export async function cancelVideo(context:AdapterContext,jobId:string):Promise<RemoteJob>{return parseRemoteJob(await json(await request(context,'/media/jobs/'+encodeURIComponent(jobId)+'/cancel',{})));}
