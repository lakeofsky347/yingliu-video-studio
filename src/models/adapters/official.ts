import { createHmac } from 'node:crypto';
import type { ModelDiscoveryResult, ProviderConnection, ProviderModelOption } from '../contracts.ts';
import {mediaOutput,type MediaArtifact,type MediaOperation,type RemoteJob,type RemoteStatus} from '../../jobs/contracts.ts';
import { cancelVideo, generateImage, getVideo, lookupVideo, submitVideo, type AdapterContext, type AdapterInput } from './media.ts';
import { validateMediaRequest } from '../capabilities.ts';
import { protocolInfo } from '../protocols.ts';

type Json = Record<string, unknown>;
const record = (value: unknown, label: string): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label);
  return value as Json;
};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function endpoint(connection: ProviderConnection, path: string): string {
  const base = connection.baseUrl.replace(/\/+$/, '');
  return base + (path.startsWith('/') ? path : '/' + path);
}
function bearer(connection: ProviderConnection, key?: string): string {
  if (connection.auth === 'none') return '';
  if (!key) throw Object.assign(new Error('媒体服务凭据不可用，请配置或解锁后重试'), { code: 'NEEDS_CREDENTIALS' });
  if (connection.protocol === 'kling-video' && key.includes(':')) {
    const split = key.indexOf(':');
    const ak = key.slice(0, split).trim(), sk = key.slice(split + 1).trim();
    if (!ak || !sk) throw new Error('可灵密钥须为 Bearer Token，或 accessKey:secretKey');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: ak, exp: now + 1800, nbf: now - 5 })).toString('base64url');
    const body = header + '.' + payload;
    return body + '.' + createHmac('sha256', sk).update(body).digest('base64url');
  }
  return key;
}
function headers(connection: ProviderConnection, key: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const token = bearer(connection, key);
  const result: Record<string, string> = { Accept: 'application/json', ...extra };
  if (connection.auth === 'bearer' && token) result[connection.protocol.startsWith('gemini-') ? 'x-goog-api-key' : 'Authorization'] = connection.protocol.startsWith('gemini-') ? token : 'Bearer ' + token;
  return result;
}
async function readJson(response: Response, label: string, maxMiB = 48): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(label + '失败（HTTP ' + response.status + '）'), { httpStatus: response.status });
  }
  if (!response.body) throw new Error(label + '响应为空');
  const reader = response.body.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxMiB * 1024 * 1024) throw new Error(`${label} JSON 超过 ${maxMiB} MiB`);
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error(label + '返回无效 JSON'); }
}
async function call(context: AdapterContext, path: string, body?: unknown, options: {extraHeaders?:Record<string,string>;label?:string;maxMiB?:number} = {}): Promise<unknown> {
  const response = await (context.fetch ?? fetch)(endpoint(context.connection, path), {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: headers(context.connection, context.key, body === undefined ? options.extraHeaders : { 'Content-Type': 'application/json', ...options.extraHeaders }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(context.connection.requestTimeoutMs)]),
  });
  return readJson(response, options.label ?? '媒体接口', options.maxMiB);
}

export class ModelDiscoveryError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const maxCatalogPages = 10;
const maxCatalogModels = 1000;
const dashscopePageSize = 50;

/** The untrusted directory supplies suggestions only; never copy capabilities or parameters into the registry. */
function catalogOption(value: unknown, connection: ProviderConnection, key: string | undefined): ProviderModelOption | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Json;
  const source = protocolInfo(connection.protocol).modelDiscovery;
  if (source === 'volc' && row.domain && row.domain !== 'VideoGeneration') return;
  if (source === 'gemini' && Array.isArray(row.supportedGenerationMethods)) {
    const method = connection.protocol === 'gemini-video' ? 'predictLongRunning' : 'generateContent';
    if (!row.supportedGenerationMethods.includes(method)) return;
  }
  if (source === 'dashscope' && Array.isArray(row.capabilities) && !row.capabilities.includes('VG')) return;
  const rawId = source === 'gemini' ? text(row.name).replace(/^models\//, '') : text(source === 'dashscope' ? row.model : row.id);
  const id = rawId.trim();
  const safe = (value: string) => value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) && (!key || !value.includes(key));
  if (!safe(id)) return;
  const name = text(source === 'gemini' ? row.displayName : row.name).trim();
  return { id, name: safe(name) ? name : id };
}

export async function discoverProviderModels(context: AdapterContext): Promise<ModelDiscoveryResult> {
  const source = protocolInfo(context.connection.protocol).modelDiscovery;
  if (!source) throw new ModelDiscoveryError('MODEL_DISCOVERY_UNSUPPORTED', '此协议暂不支持查询模型目录，可手动填写模型 ID。');
  const timeout = AbortSignal.timeout(Math.min(context.connection.requestTimeoutMs, 15_000));
  const signal = AbortSignal.any([context.signal, timeout]);
  const models = new Map<string, ProviderModelOption>();
  const seenTokens = new Set<string>();
  let token = '';
  let truncated = false;
  try {
    for (let page = 1; page <= maxCatalogPages; page++) {
      const query = new URLSearchParams();
      if (source === 'gemini') {
        query.set('pageSize', '100');
        if (token) query.set('pageToken', token);
      } else if (source === 'dashscope') {
        query.set('capabilities', 'VG');
        query.set('page_no', String(page));
        query.set('page_size', String(dashscopePageSize));
      }
      const payload = record(await call({ ...context, signal }, `/models${query.size ? '?' + query : ''}`, undefined, { label: '模型目录', maxMiB: 4 }), '模型目录返回无效对象');
      const output = source === 'dashscope' ? record(payload.output, '模型目录缺少分页数据') : payload;
      const entries = source === 'gemini' || source === 'dashscope' ? output.models : output.data;
      if (payload.success === false || !Array.isArray(entries)) throw new Error('模型目录响应无效');
      for (const entry of entries) {
        const model = catalogOption(entry, context.connection, context.key);
        if (!model || models.has(model.id)) continue;
        if (models.size >= maxCatalogModels) { truncated = true; break; }
        models.set(model.id, model);
      }
      const nextToken = text(output.nextPageToken);
      const pageSize = typeof output.page_size === 'number' && output.page_size > 0 ? output.page_size : dashscopePageSize;
      const hasNext = source === 'gemini' ? Boolean(nextToken) : source === 'dashscope' && typeof output.total === 'number' && page * pageSize < output.total;
      if (truncated || !hasNext) {
        truncated ||= output.has_more === true;
        break;
      }
      const unsafeToken = source === 'gemini' && (nextToken.length > 2048 || seenTokens.has(nextToken) || Boolean(context.key && nextToken.includes(context.key)));
      if (page === maxCatalogPages || models.size >= maxCatalogModels || unsafeToken) {
        truncated = true;
        break;
      }
      if (source === 'gemini') { seenTokens.add(nextToken); token = nextToken; }
    }
  } catch (error) {
    if (timeout.aborted) throw new ModelDiscoveryError('MODEL_DISCOVERY_TIMEOUT', '模型目录请求超时，请重试。');
    const status = error && typeof error === 'object' && 'httpStatus' in error ? error.httpStatus : undefined;
    if (status === 401 || status === 403) throw new ModelDiscoveryError('MODEL_DISCOVERY_AUTH', `模型目录鉴权失败（HTTP ${status}），请检查 API Key 和权限。`);
    if (status === 404 || status === 405 || status === 501) throw new ModelDiscoveryError('MODEL_DISCOVERY_UNSUPPORTED', `此服务地址未提供可用的模型目录（HTTP ${status}），可手动填写模型 ID。`);
    const detail = typeof status === 'number' ? `（HTTP ${status}）` : '';
    throw new ModelDiscoveryError('MODEL_DISCOVERY_FAILED', `无法读取模型目录${detail}，请检查服务地址后重试，或手动填写模型 ID。`);
  }
  return { models: [...models.values()].sort((a,b) => a.id.localeCompare(b.id)), truncated };
}
function dataImage(dataUrl: string): { mime: string; base64: string } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match?.[1] || !match[2]) throw new Error('参考图片必须是 PNG、JPEG 或 WebP');
  return { mime: match[1], base64: match[2] };
}
function firstImage(input: AdapterInput): { mime: string; base64: string; dataUrl: string } | undefined {
  const image = input.inputs[0];
  if (!image) return undefined;
  const parsed = dataImage(image.dataUrl);
  return { ...parsed, dataUrl: image.dataUrl };
}
function artifact(connection: ProviderConnection, url: string, mimeType: string): MediaArtifact {
  let sameOrigin = false;
  try { sameOrigin = new URL(url).origin === new URL(connection.baseUrl).origin; } catch { sameOrigin = false; }
  return { url, mimeType, ...(sameOrigin ? { sameOriginAuth: true } : {}) };
}
function job(jobId: string, status: RemoteStatus, extra: Partial<RemoteJob> = {}): RemoteJob {
  if (!jobId) throw new Error('媒体接口没有返回任务 ID');
  return { jobId, status, ...extra };
}
const videoStatus = (value: string): RemoteStatus => {
  const status = value.toLowerCase();
  if (['queued', 'submitted', 'pending', 'preparing', 'queueing', 'starting'].includes(status)) return 'queued';
  if (['running', 'processing', 'in_progress'].includes(status)) return 'running';
  if (['succeeded', 'succeed', 'success', 'completed'].includes(status)) return 'succeeded';
  if (['cancelled', 'canceled', 'aborted'].includes(status)) return 'cancelled';
  if (['failed', 'fail', 'error'].includes(status)) return 'failed';
  throw new Error('媒体接口返回了无法识别的任务状态');
};
function numberParam(input: AdapterInput, key: string): number | undefined {
  const value = input.parameters[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function stringParam(input: AdapterInput, key: string): string | undefined {
  const value = input.parameters[key];
  return typeof value === 'string' && value ? value : undefined;
}

async function geminiImage(context: AdapterContext, input: AdapterInput): Promise<RemoteJob> {
  const images=input.inputs.map(image=>{
    const {mime,base64}=dataImage(image.dataUrl);
    return {inlineData:{mimeType:mime,data:base64}};
  });
  const data = record(await call(context, '/models/' + encodeURIComponent(input.model.model) + ':generateContent', {
    contents: [{ role: 'user', parts: [{ text: input.prompt },...images] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  }), 'Gemini 图像接口返回无效对象');
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const artifacts: MediaArtifact[] = [];
  for (const candidate of candidates) {
    const content = record(candidate, 'Gemini 候选结果无效').content;
    const parts = Array.isArray(record(content ?? {}, 'Gemini 候选结果无效').parts) ? record(content ?? {}, 'Gemini 候选结果无效').parts as unknown[] : [];
    for (const part of parts) {
      const inline = record(part, 'Gemini 分片无效').inlineData ?? record(part, 'Gemini 分片无效').inline_data;
      if (!inline || typeof inline !== 'object') continue;
      const body = inline as Json;
      if (typeof body.data === 'string' && typeof body.mimeType === 'string') artifacts.push({ base64: body.data, mimeType: body.mimeType });
    }
  }
  if (!artifacts.length) throw new Error('Gemini 没有返回图像');
  return job(input.clientRequestId, 'succeeded', { artifacts });
}

async function openaiVideoSubmit(context: AdapterContext, input: AdapterInput): Promise<RemoteJob> {
  const seconds = numberParam(input, 'durationSeconds');
  const width = numberParam(input, 'width'), height = numberParam(input, 'height');
  const ratio=stringParam(input,'aspectRatio');
  const size = width && height ? width + 'x' + height : ratio==='16:9'?'1280x720':ratio==='9:16'?'720x1280':undefined;
  const image = firstImage(input);
  let data: unknown;
  if (!image) {
    data = await call(context, '/videos', { model: input.model.model, prompt: input.prompt, ...(seconds ? { seconds: String(seconds) } : {}), ...(size ? { size } : {}) });
  } else {
    const form = new FormData();
    form.set('model', input.model.model);
    form.set('prompt', input.prompt);
    if (seconds) form.set('seconds', String(seconds));
    if (size) form.set('size', size);
    const bytes = Buffer.from(image.base64, 'base64');
    form.set('input_reference', new Blob([bytes], { type: image.mime }), 'reference.' + (image.mime === 'image/jpeg' ? 'jpg' : image.mime === 'image/webp' ? 'webp' : 'png'));
    const response = await (context.fetch ?? fetch)(endpoint(context.connection, '/videos'), {
      method: 'POST', redirect: 'error', headers: headers(context.connection, context.key), body: form,
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(context.connection.requestTimeoutMs)]),
    });
    data = await readJson(response, 'OpenAI Videos');
  }
  const body = record(data, 'OpenAI Videos 返回无效对象');
  const id = text(body.id);
  const status = videoStatus(text(body.status) || 'queued');
  const progress = typeof body.progress === 'number' ? Math.max(0, Math.min(1, body.progress > 1 ? body.progress / 100 : body.progress)) : undefined;
  return job(id, status, { ...(progress !== undefined ? { progress } : {}), ...(status === 'succeeded' ? { artifacts: [artifact(context.connection, endpoint(context.connection, '/videos/' + encodeURIComponent(id) + '/content'), 'video/mp4')] } : {}) });
}

async function openaiVideoPoll(context: AdapterContext, jobId: string): Promise<RemoteJob> {
  const body = record(await call(context, '/videos/' + encodeURIComponent(jobId)), 'OpenAI Videos 返回无效对象');
  const status = videoStatus(text(body.status) || 'running');
  const progress = typeof body.progress === 'number' ? Math.max(0, Math.min(1, body.progress > 1 ? body.progress / 100 : body.progress)) : undefined;
  const error = body.error && typeof body.error === 'object' ? text((body.error as Json).message) : text(body.error);
  return job(text(body.id) || jobId, status, { ...(progress !== undefined ? { progress } : {}), ...(error ? { error } : {}), ...(status === 'succeeded' ? { artifacts: [artifact(context.connection, endpoint(context.connection, '/videos/' + encodeURIComponent(jobId) + '/content'), 'video/mp4')] } : {}) });
}

async function klingSubmit(context: AdapterContext, input: AdapterInput): Promise<RemoteJob> {
  const image = firstImage(input);
  const path = image ? '/v1/videos/image2video' : '/v1/videos/text2video';
  const duration = numberParam(input, 'durationSeconds');
  const body = record(await call(context, path, {
    model_name: input.model.model,
    prompt: input.prompt,
    ...(stringParam(input, 'negativePrompt') ? { negative_prompt: stringParam(input, 'negativePrompt') } : {}),
    ...(stringParam(input, 'aspectRatio') ? { aspect_ratio: stringParam(input, 'aspectRatio') } : {}),
    ...(duration ? { duration: String(duration) } : {}),
    ...(image ? { image: image.base64 } : {}),
  }), '可灵接口返回无效对象');
  const data = record(body.data ?? body, '可灵接口没有返回任务');
  const id = text(data.task_id);
  if(!id)throw new Error('可灵接口没有返回任务 ID');
  return job((image ? 'image2video:' : 'text2video:') + id, videoStatus(text(data.task_status) || 'submitted'));
}
async function klingPoll(context: AdapterContext, jobId: string): Promise<RemoteJob> {
  const split = jobId.indexOf(':');
  const kind = split > 0 ? jobId.slice(0, split) : 'text2video';
  const id = split > 0 ? jobId.slice(split + 1) : jobId;
  const body = record(await call(context, '/v1/videos/' + kind + '/' + encodeURIComponent(id)), '可灵接口返回无效对象');
  const data = record(body.data ?? body, '可灵任务无效');
  const status = videoStatus(text(data.task_status) || 'processing');
  const result = data.task_result && typeof data.task_result === 'object' ? data.task_result as Json : {};
  const videos = Array.isArray(result.videos) ? result.videos : [];
  const artifacts = videos.flatMap(item => { const url = text(record(item, '可灵产物无效').url); return url ? [artifact(context.connection, url, 'video/mp4')] : []; });
  if (status === 'succeeded' && !artifacts.length) throw new Error('可灵成功状态缺少视频地址');
  return job(jobId, status, { ...(text(data.task_status_msg) ? { error: text(data.task_status_msg) } : {}), ...(artifacts.length ? { artifacts } : {}) });
}

async function minimaxSubmit(context: AdapterContext, input: AdapterInput): Promise<RemoteJob> {
  const image = firstImage(input);
  const duration = numberParam(input, 'durationSeconds');
  const body = record(await call(context, '/v1/video_generation', {
    model: input.model.model, prompt: input.prompt,
    ...(duration ? { duration } : {}),
    ...(image ? { first_frame_image: image.dataUrl } : {}),
  }), 'MiniMax 接口返回无效对象');
  const base = body.base_resp && typeof body.base_resp === 'object' ? body.base_resp as Json : {};
  if (typeof base.status_code === 'number' && base.status_code !== 0) throw new Error(text(base.status_msg) || 'MiniMax 拒绝了生成请求');
  return job(text(body.task_id), 'queued');
}
async function minimaxPoll(context: AdapterContext, jobId: string): Promise<RemoteJob> {
  const body = record(await call(context, '/v1/query/video_generation?task_id=' + encodeURIComponent(jobId)), 'MiniMax 查询返回无效对象');
  const status = videoStatus(text(body.status) || 'processing');
  if (status !== 'succeeded') return job(jobId, status);
  const fileId = text(body.file_id);
  if (!fileId) throw new Error('MiniMax 成功状态缺少文件 ID');
  const file = record(await call(context, '/v1/files/retrieve?file_id=' + encodeURIComponent(fileId)), 'MiniMax 文件接口无效');
  const download = text(record(file.file ?? file, 'MiniMax 文件接口无效').download_url);
  if (!download) throw new Error('MiniMax 没有返回视频地址');
  return job(jobId, 'succeeded', { artifacts: [artifact(context.connection, download, 'video/mp4')] });
}

async function volcSubmit(context: AdapterContext, input: AdapterInput): Promise<RemoteJob> {
  const image = firstImage(input);
  const content: Json[] = [{ type: 'text', text: input.prompt }];
  if (image) content.push({ type: 'image_url', image_url: { url: image.dataUrl },role:'first_frame' });
  if(input.operation==='first-last-frame-video')content.push({type:'image_url',image_url:{url:input.inputs[1]!.dataUrl},role:'last_frame'});
  const duration=numberParam(input,'durationSeconds'),ratio=stringParam(input,'aspectRatio'),seed=numberParam(input,'seed');
  const body = record(await call(context, '/contents/generations/tasks', { model: input.model.model, content,...(duration!==undefined?{duration}:{}),...(ratio!==undefined?{ratio}:{}),...(seed!==undefined?{seed}:{}) }), '火山方舟接口返回无效对象');
  return job(text(body.id), 'queued');
}
async function volcPoll(context: AdapterContext, jobId: string): Promise<RemoteJob> {
  const body = record(await call(context, '/contents/generations/tasks/' + encodeURIComponent(jobId)), '火山方舟查询返回无效对象');
  const status = videoStatus(text(body.status) || 'running');
  const content = body.content && typeof body.content === 'object' ? body.content as Json : {};
  const url = text(content.video_url);
  if (status === 'succeeded' && !url) throw new Error('火山方舟成功状态缺少视频地址');
  return job(text(body.id) || jobId, status, { ...(url ? { artifacts: [artifact(context.connection, url, 'video/mp4')] } : {}), ...(body.error && typeof body.error === 'object' ? { error: text((body.error as Json).message) || text((body.error as Json).code) } : {}) });
}

async function dashscopeSubmit(context: AdapterContext, input: AdapterInput): Promise<RemoteJob> {
  const image = firstImage(input);
  const duration = numberParam(input, 'durationSeconds');
  const body = record(await call(context, '/services/aigc/video-generation/video-synthesis', {
    model: input.model.model,
    input: { prompt: input.prompt, ...(image ? { img_url: image.dataUrl } : {}),...(stringParam(input,'negativePrompt')?{negative_prompt:stringParam(input,'negativePrompt')}:{}) },
    parameters: { ...(duration!==undefined ? { duration } : {}), ...(numberParam(input,'width')!==undefined?{size:numberParam(input,'width')+'*'+numberParam(input,'height')} : {}),...(numberParam(input,'seed')!==undefined?{seed:numberParam(input,'seed')}:{}) },
  }, { extraHeaders: { 'X-DashScope-Async': 'enable' } }), '百炼接口返回无效对象');
  const output = record(body.output, '百炼接口没有返回任务');
  return job(text(output.task_id), videoStatus(text(output.task_status) || 'pending'));
}
async function dashscopePoll(context: AdapterContext, jobId: string): Promise<RemoteJob> {
  const body = record(await call(context, '/tasks/' + encodeURIComponent(jobId)), '百炼查询返回无效对象');
  const output = record(body.output ?? body, '百炼任务无效');
  const status = videoStatus(text(output.task_status) || 'running');
  const url = text(output.video_url);
  if (status === 'succeeded' && !url) throw new Error('百炼成功状态缺少视频地址');
  return job(text(output.task_id) || jobId, status, { ...(url ? { artifacts: [artifact(context.connection, url, 'video/mp4')] } : {}), ...(text(output.message) ? { error: text(output.message) } : {}) });
}

async function geminiVideoSubmit(context: AdapterContext, input: AdapterInput): Promise<RemoteJob> {
  const image = firstImage(input);
  const duration = numberParam(input, 'durationSeconds');
  const body = record(await call(context, '/models/' + encodeURIComponent(input.model.model) + ':predictLongRunning', {
    instances: [{ prompt: input.prompt, ...(image ? { image: { bytesBase64Encoded: image.base64, mimeType: image.mime } } : {}) }],
    parameters: { ...(stringParam(input, 'aspectRatio') ? { aspectRatio: stringParam(input, 'aspectRatio') } : {}), ...(duration ? { durationSeconds: duration } : {}) },
  }), 'Gemini Veo 返回无效对象');
  const name = text(body.name);
  return job(name, 'queued');
}
async function geminiVideoPoll(context: AdapterContext, jobId: string): Promise<RemoteJob> {
  const body = record(await call(context, '/' + jobId.replace(/^\/+/, '')), 'Gemini Veo 查询返回无效对象');
  if (body.done !== true) return job(text(body.name) || jobId, 'running');
  if (body.error && typeof body.error === 'object') return job(jobId, 'failed', { error: text((body.error as Json).message) || 'Gemini Veo 生成失败' });
  const response = body.response && typeof body.response === 'object' ? body.response as Json : {};
  const generated = response.generateVideoResponse && typeof response.generateVideoResponse === 'object' ? response.generateVideoResponse as Json : response;
  const samples = Array.isArray(generated.generatedSamples) ? generated.generatedSamples : Array.isArray(generated.videos) ? generated.videos : [];
  const artifacts = samples.flatMap(item => {
    const video = record(item, 'Gemini 视频产物无效').video;
    const uri = video && typeof video === 'object' ? text((video as Json).uri) : text(record(item, 'Gemini 视频产物无效').uri);
    return uri ? [artifact(context.connection, uri, 'video/mp4')] : [];
  });
  if (!artifacts.length) throw new Error('Gemini Veo 成功状态缺少视频地址');
  return job(text(body.name) || jobId, 'succeeded', { artifacts });
}

function replicateJob(context:AdapterContext,value:unknown):RemoteJob{
  const data=record(value,'Replicate 返回无效任务'),status=videoStatus(text(data.status));
  const url=text(data.output);
  if(status==='succeeded'&&!url)throw new Error('Replicate 已完成任务缺少视频地址');
  return job(text(data.id),status,url?{artifacts:[artifact(context.connection,url,'video/mp4')]}:{});
}
async function replicateUpload(context:AdapterContext,dataUrl:string,filename:string){
  const separator=dataUrl.indexOf(',');
  const form=new FormData();
  form.set('content',new Blob([Buffer.from(dataUrl.slice(separator+1),'base64')],{type:dataUrl.slice(5,separator).split(';')[0]}),filename);
  const response=await (context.fetch??fetch)(endpoint(context.connection,'/files'),{method:'POST',redirect:'error',headers:headers(context.connection,context.key),body:form,
    signal:AbortSignal.any([context.signal,AbortSignal.timeout(context.connection.requestTimeoutMs)])});
  const data=record(await readJson(response,'Replicate 文件上传',1),'Replicate 文件接口返回无效对象');
  const url=new URL(text(record(data.urls,'Replicate 文件接口未返回地址').get));
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('Replicate 文件接口返回不安全的地址');
  return url.href;
}
async function replicateSubmit(context:AdapterContext,input:AdapterInput){
  let video:string,audio:string;
  try{
    video=await replicateUpload(context,input.inputs[0]!.dataUrl,'video.mp4');
    audio=await replicateUpload(context,input.inputs[1]!.dataUrl,'voice.wav');
    context.signal.throwIfAborted();
  }catch(error){throw Object.assign(error instanceof Error?error:new Error(String(error)),{submissionUncertain:false});}
  return replicateJob(context,await call(context,'/models/sync/lipsync-2/predictions',{input:{video,audio}}));
}

export async function submitGeneration(context: AdapterContext, input: AdapterInput): Promise<RemoteJob> {
  validateMediaRequest({connection:context.connection,model:input.model},input);
  switch (context.connection.protocol) {
    case 'images': return generateImage(context, input);
    case 'gemini-image': return geminiImage(context, input);
    case 'video-gateway': return submitVideo(context, input);
    case 'openai-videos': return openaiVideoSubmit(context, input);
    case 'kling-video': return klingSubmit(context, input);
    case 'minimax-video': return minimaxSubmit(context, input);
    case 'volc-video': return volcSubmit(context, input);
    case 'dashscope-video': return dashscopeSubmit(context, input);
    case 'gemini-video': return geminiVideoSubmit(context, input);
    case 'replicate-lipsync': return replicateSubmit(context,input);
    default: throw new Error('此协议不能发起素材生成');
  }
}
export async function pollGeneration(context: AdapterContext, protocol: ProviderConnection['protocol'], operation: MediaOperation, jobId: string | undefined, clientRequestId: string): Promise<RemoteJob | null> {
  if (protocol === 'video-gateway') return jobId ? getVideo(context, jobId) : lookupVideo(context, clientRequestId);
  if (!jobId) return null;
  switch (protocol) {
    case 'openai-videos': return openaiVideoPoll(context, jobId);
    case 'kling-video': return klingPoll(context, jobId);
    case 'minimax-video': return minimaxPoll(context, jobId);
    case 'volc-video': return volcPoll(context, jobId);
    case 'dashscope-video': return dashscopePoll(context, jobId);
    case 'gemini-video': return geminiVideoPoll(context, jobId);
    case 'replicate-lipsync': return replicateJob(context,await call(context,'/predictions/'+encodeURIComponent(jobId)));
    default: throw new Error(mediaOutput(operation)==='image' ? '图像协议不支持任务查询' : '此协议不支持任务查询');
  }
}
export async function cancelGeneration(context: AdapterContext, protocol: ProviderConnection['protocol'], jobId: string): Promise<RemoteJob> {
  if (protocol === 'video-gateway') return cancelVideo(context, jobId);
  if(protocol==='replicate-lipsync')return replicateJob(context,await call(context,'/predictions/'+encodeURIComponent(jobId)+'/cancel',{}));
  if (protocol === 'openai-videos') {
    const body = record(await call(context, '/videos/' + encodeURIComponent(jobId) + '/cancel', {}), 'OpenAI Videos 取消返回无效对象');
    return job(text(body.id) || jobId, videoStatus(text(body.status) || 'cancelled'));
  }
  throw new Error('此协议不能确认远端取消，本地已停止等待');
}
export function artifactAuth(connection: ProviderConnection, key?: string): { origin: string; header: string; value: string } | undefined {
  if (connection.auth !== 'bearer' || !key) return undefined;
  const token = bearer(connection, key);
  return { origin: new URL(connection.baseUrl).origin, header: connection.protocol.startsWith('gemini-') ? 'x-goog-api-key' : 'Authorization', value: connection.protocol.startsWith('gemini-') ? token : 'Bearer ' + token };
}
