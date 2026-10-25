import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import semver from 'semver';

// Execute the official host's loader policy, rather than reimplementing it here.
const root=path.resolve(import.meta.dirname,'..');
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const hostModules=process.argv[2]??process.env.DSH_HOST_NODE_MODULES;
const require=createRequire(import.meta.url);
// Linked peers point into the host; resolve app-boot from there when it is not
// installed directly in the plugin's development dependencies.
const boot=hostModules?path.join(path.resolve(hostModules),'@deepseek-ai/dsh-app-boot/lib/index.js'):
  createRequire(require.resolve('@deepseek-ai/dsh-client-connection')).resolve('@deepseek-ai/dsh-app-boot');
const {evaluatePluginCompatibility,getDshRuntimeVersion}=await import(pathToFileURL(boot).href);
assert.equal(typeof evaluatePluginCompatibility,'function','Host must export its compatibility evaluator');
assert.equal(manifest.engines?.dsh,'*','DSH release numbers must not gate the plugin');
const peers=Object.entries(manifest.peerDependencies).filter(([name])=>name.startsWith('@deepseek-ai/dsh-'));
assert.ok(peers.length>0,'Retain host peers for DSH service resolution');
for(const [name,range] of peers)assert.equal(range,'*',`${name} must not pin a DSH release`);
const versions=['0.2.0-rc.2','0.2.1-rc.2','0.2.1-rc.3','0.2.2-alpha.1','0.3.0-alpha.1','1.0.0','2.0.0-rc.1'];
for(const version of versions){
  assert.equal(evaluatePluginCompatibility(manifest,{},version),undefined,`Official loader rejected ${version}`);
  const legacy={...manifest};delete legacy.engines;
  assert.equal(evaluatePluginCompatibility(legacy,{},version),undefined,`Peer fallback rejected ${version}`);
  for(const [,range] of peers)assert.ok(semver.satisfies(version,range,{includePrerelease:true}));
}
const incompatible={...manifest,engines:{dsh:'0.2.1-rc.2'},peerDependencies:Object.fromEntries(peers.map(([name])=>[name,'0.2.1-rc.2']))};
assert.ok(evaluatePluginCompatibility(incompatible,{},'0.2.1-rc.3'),'Control must reproduce the old rc.3 rejection');
console.log(JSON.stringify({status:'PASS',actualRuntime:getDshRuntimeVersion(),officialEvaluator:boot,versions,peerCount:peers.length,legacyPeerFallback:true,oldRejectionReproduced:true,scope:'Loader metadata only; runtime APIs and native UI require separate checks'},null,2));
