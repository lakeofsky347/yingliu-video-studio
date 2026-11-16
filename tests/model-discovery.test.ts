import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProviderModels, ModelDiscoveryError } from '../src/models/adapters/official.ts';
import { ModelRegistry } from '../src/models/registry.ts';
import type { ModelProtocol, ProviderConnection } from '../src/models/contracts.ts';

const key = 'synthetic-model-discovery-key';
const context = (protocol: ModelProtocol, fetcher: typeof fetch) => ({
  connection: { id:'provider', name:'test', protocol, baseUrl:'https://models.invalid/v1', auth:'bearer', enabled:true, revision:1, credentialRef:'secret', requestTimeoutMs:5000, concurrency:1 } satisfies ProviderConnection,
  key, signal:new AbortController().signal, fetch:fetcher,
});
const catalogError = (code: string) => (error: unknown) => error instanceof ModelDiscoveryError && error.code === code && !error.message.includes(key);
function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise = new Promise<T>(complete=>{resolve=complete;});
  return {promise,resolve};
}

test('OpenAI compatible discovery uses read-only bearer auth and returns unique safe IDs', async () => {
  const result = await discoverProviderModels(context('images', async (url, init) => {
    assert.equal(String(url), 'https://models.invalid/v1/models');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${key}`);
    return Response.json({ data:[{id:'image-b'}, {id:'image-a',name:key}, {id:'image-a'}, {id:key}, {id:'   '}, null] });
  }));
  assert.deepEqual(result, { models:[{id:'image-a',name:'image-a'}, {id:'image-b',name:'image-b'}], truncated:false });
});

test('Gemini discovery follows opaque page tokens on the configured origin and filters by generation method', async () => {
  const requests: URL[] = [];
  const result = await discoverProviderModels(context('gemini-video', async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.origin, 'https://models.invalid');
    assert.equal(url.pathname, '/v1/models');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-goog-api-key'), key);
    assert.equal(headers.has('Authorization'), false);
    if (requests.length === 1) return Response.json({ models:[{name:'models/chat',supportedGenerationMethods:['generateContent']}], nextPageToken:'c/+?=' });
    assert.equal(url.searchParams.get('pageToken'), 'c/+?=');
    return Response.json({ models:[{name:'models/veo-preview',displayName:'Veo Preview',supportedGenerationMethods:['predictLongRunning']}], nextPageToken:'c/+?=' });
  }));
  assert.equal(requests.length, 2);
  assert.deepEqual(result, { models:[{id:'veo-preview',name:'Veo Preview'}], truncated:true });
});

test('Ark and DashScope discover video entries from documented directory fields', async () => {
  const ark = await discoverProviderModels(context('volc-video', async () => Response.json({data:[{id:'text',domain:'LLM'},{id:'seedance',domain:'VideoGeneration'}]})));
  assert.deepEqual(ark.models, [{id:'seedance',name:'seedance'}]);
  const pages: string[] = [];
  const dashscope = await discoverProviderModels(context('dashscope-video', async (input) => {
    const params = new URL(String(input)).searchParams;
    assert.equal(params.get('capabilities'), 'VG');
    const page = params.get('page_no')!;
    pages.push(page);
    return Response.json({success:true,output:{total:2,page_size:1,models:[{model:`wan-${page}`,name:`万相 ${page}`,capabilities:['VG']}]}});
  }));
  assert.deepEqual(pages, ['1','2']);
  assert.deepEqual(dashscope.models, [{id:'wan-1',name:'万相 1'}, {id:'wan-2',name:'万相 2'}]);
});

test('model directory failures do not disclose provider bodies and unsupported protocols make no request', async t => {
  await assert.rejects(discoverProviderModels(context('speech', async () => new Response(key,{status:401}))), catalogError('MODEL_DISCOVERY_AUTH'));
  await assert.rejects(discoverProviderModels(context('speech', async () => new Response(key,{status:404}))), catalogError('MODEL_DISCOVERY_UNSUPPORTED'));
  await assert.rejects(discoverProviderModels(context('images', async () => { throw new Error(key); })), catalogError('MODEL_DISCOVERY_FAILED'));
  const unsupported = t.mock.fn<typeof fetch>();
  await assert.rejects(discoverProviderModels(context('kling-video', unsupported)), catalogError('MODEL_DISCOVERY_UNSUPPORTED'));
  assert.equal(unsupported.mock.callCount(), 0);
});

test('discovery captures a matched key and URL, rejects stale revisions, and does not store suggestions', async t => {
  const directory = await mkdtemp(join(tmpdir(),'yingliu-model-discovery-'));
  try {
    const credentials = new Map<string,string>();
    const registry = new ModelRegistry(directory, {
      async get(ref) { return credentials.get(ref); },
      async set(ref, value) { credentials.set(ref, value); },
      async delete(ref) { credentials.delete(ref); },
    });
    const previous = await registry.saveConnection({protocol:'images',baseUrl:'https://first.invalid/v1',apiKey:key});
    const started = deferred<void>();
    const response = deferred<Response>();
    const fetcher = t.mock.method(globalThis,'fetch',async () => {
      started.resolve();
      return response.promise;
    });
    const inFlight = registry.discoverModels(previous.id,previous.revision);
    const rejected = assert.rejects(inFlight,catalogError('MODEL_CONNECTION_CHANGED'));
    await started.promise;
    await registry.saveConnection({id:previous.id,baseUrl:'https://second.invalid/v1',apiKey:'another-synthetic-key'});
    response.resolve(Response.json({data:[{id:'unsaved-suggestion'}]}));
    await rejected;
    await assert.rejects(registry.discoverModels(previous.id,previous.revision),catalogError('MODEL_CONNECTION_CHANGED'));
    assert.equal(fetcher.mock.callCount(),1);
    const [url, init] = fetcher.mock.calls[0]!.arguments as Parameters<typeof fetch>;
    assert.equal(String(url),'https://first.invalid/v1/models');
    assert.equal(new Headers(init?.headers).get('Authorization'),`Bearer ${key}`);
    assert.deepEqual((await registry.list()).models,[]);
    const stored = await readFile(join(directory,'model-registry.json'),'utf8');
    assert.ok(!stored.includes(key) && !stored.includes('another-synthetic-key') && !stored.includes('unsaved-suggestion'));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
