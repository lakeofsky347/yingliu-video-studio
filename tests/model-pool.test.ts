import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_PROTOCOLS } from '../src/models/contracts.ts';
import { ModelRegistry } from '../src/models/registry.ts';
import type { ModelSecrets } from '../src/models/contracts.ts';
import { catalogCoversProtocols } from '../src/models/protocols.ts';
import { submitGeneration } from '../src/models/adapters/official.ts';
import type { AdapterContext, AdapterInput } from '../src/models/adapters/media.ts';

class Secrets implements ModelSecrets {
  values = new Map<string, string>();
  async get(ref: string) { return this.values.get(ref); }
  async set(ref: string, value: string) { this.values.set(ref, value); }
  async delete(ref: string) { this.values.delete(ref); }
}

test('protocol catalog matches the stored protocol list', () => {
  assert.equal(catalogCoversProtocols(), true);
  assert.equal(new Set(MODEL_PROTOCOLS).size, MODEL_PROTOCOLS.length);
});

test('one video role can default while other official video models stay in the pool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-model-pool-'));
  try {
    const registry = new ModelRegistry(directory, new Secrets());
    await registry.initialize();
    const kling = await registry.saveConnection({ id: 'kling', name: '可灵', protocol: 'kling-video', baseUrl: 'https://api.klingai.com', apiKey: 'token' });
    const volc = await registry.saveConnection({ id: 'volc', name: '方舟', protocol: 'volc-video', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'token' });
    const first = await registry.saveModel({ connectionId: kling.id, model: 'kling-v1' });
    const second = await registry.saveModel({ connectionId: volc.id, model: 'doubao-seedance' });
    await registry.bindRole('video', first.id);
    assert.equal((await registry.resolve('video')).model.id, first.id);
    assert.equal((await registry.resolve({ role: 'video', modelId: second.id })).connection.protocol, 'volc-video');
    await assert.rejects(registry.bindRole('image', second.id), /协议/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('openai videos submit uses the official /videos endpoint', async () => {
  let seen = '';
  let payload = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    seen = String(input);
    payload = String(init?.body ?? '');
    return new Response(JSON.stringify({ id: 'video_1', status: 'queued', progress: 10 }), { status: 200 });
  };
  const context: AdapterContext = {
    connection: { id: 'openai', name: 'OpenAI', protocol: 'openai-videos', baseUrl: 'https://api.openai.com/v1', auth: 'bearer', credentialRef: 'key', enabled: true, revision: 1, requestTimeoutMs: 90000, concurrency: 2 },
    key: 'secret', signal: AbortSignal.timeout(1000), fetch: fetchImpl,
  };
  const input: AdapterInput = { clientRequestId: 'req-1', model: { id: 'model', connectionId: 'openai', model: 'sora-2', name: 'Sora', enabled: true, inputModalities: ['text'], outputModalities: ['video'], parameters: {} }, operation: 'text-to-video', prompt: '一只纸船', inputs: [], parameters: { durationSeconds: 4 } };
  const job = await submitGeneration(context, input);
  assert.equal(seen, 'https://api.openai.com/v1/videos');
  assert.equal(JSON.parse(payload).model, 'sora-2');
  assert.equal(job.jobId, 'video_1');
  assert.equal(job.status, 'queued');
  assert.equal(job.progress, 0.1);
});
