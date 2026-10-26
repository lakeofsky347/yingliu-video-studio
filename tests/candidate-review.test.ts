import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createProject } from '../src/core/index.js';
import { ProjectStore } from '../src/host/store.js';
import { VideoRenderer, detectEnvironment } from '../src/host/renderer.js';
import type { SceneSource } from '../src/shared/types.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const scene = (color: string): SceneSource => ({
  html: '', css: '',
  js: `export function render(ctx) { ctx.ctx2d.fillStyle = '${color}'; ctx.ctx2d.fillRect(0, 0, ctx.width, ctx.height); }`,
});

async function fileHashes(root: string, relative = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      files[name + '/'] = 'directory';
      Object.assign(files, await fileHashes(root, name));
    } else files[name] = hash(await fs.readFile(path.join(root, name)));
  }
  return files;
}

const environment = detectEnvironment();
test('real Chromium candidate capture changes pixels without mutating live head, sources or runtime', {
  skip: environment.browserAvailable ? false : 'Executable Chromium unavailable; candidate rendering isolation was not verified.',
  timeout: 60_000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-candidate-review-'));
  const store = new ProjectStore({ baseDirectory: directory }), renderer = new VideoRenderer(store);
  const candidateDirectories: string[] = [];
  // Record real snapshot directories so cleanup assertions cannot race other test processes.
  const makeTemp = fs.mkdtemp;
  t.mock.method(fs, 'mkdtemp', async (...args: Parameters<typeof fs.mkdtemp>) => {
    const result = await makeTemp(...args);
    if (String(args[0]).endsWith('video-studio-candidate-')) candidateDirectories.push(String(result));
    return result;
  });
  try {
    const initial = createProject('候选画面隔离');
    initial.shots = initial.shots.slice(0, 1); initial.shotOrder = initial.shots.map(shot => shot.id);
    initial.shots[0]!.durationFrames = 12;
    initial.target = { width: 160, height: 90, fps: { num: 12, den: 1 }, audioMode: 'none' }; initial.targetDuration = 1;
    const shot = initial.shots[0]!, blue = scene('#0000ff');
    const { root, project } = await store.create({ project: initial, sources: [{ shotId: shot.id, source: blue }] });
    const baseline = await renderer.capture(root, project, environment, 6);
    const baselineBytes = await fs.readFile(baseline.path), liveFiles = await fileHashes(root);
    for (const file of ['project.json', '.studio/state.json', shot.sourcePath + '/source.json', 'runtime/spec.json', 'runtime/scenes/' + shot.id + '.mjs']) {
      assert.ok(liveFiles[file], 'Baseline must include ' + file);
    }
    const originalProject = structuredClone(project);
    const candidate = await renderer.captureCandidate(root, project, { [shot.id]: scene('#ff0000') }, environment, 6);

    assert.equal(candidate.mime, 'image/png');
    assert.equal(candidate.sha256, hash(candidate.bytes));
    assert.equal(baseline.sha256, hash(baselineBytes));
    assert.notEqual(candidate.sha256, baseline.sha256, 'The candidate must render its red source instead of the committed blue source');
    assert.notDeepEqual(Buffer.from(candidate.bytes), baselineBytes);
    assert.deepEqual(await fileHashes(root), liveFiles, 'Candidate review must preserve all live files, including runtime and history');
    assert.deepEqual(project, originalProject);
    assert.deepEqual(await store.readSource(root, shot), blue);
    assert.equal(candidateDirectories.length, 1);
    await assert.rejects(fs.stat(candidateDirectories[0]!), { code: 'ENOENT' });
  } finally {
    await renderer.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
