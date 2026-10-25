import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {assertClientContract,assertHostContract,DshHostContractError} from '../src/shared/host-contract.ts';
import {apply as applyHost} from '../src/host/index.ts';
import type {HostContext} from '../src/host/platform.ts';

// Installed DSH applications may ship Cordis runtime code without declarations.
const cordisModule='@deepseek-ai/cordis';
const cordis=await import(cordisModule) as {
  Context:new()=>{provide(name:string,value:unknown):()=>void};
  Service:{new(context:unknown,name:string):object;invoke:symbol};
};

const unused=()=>{throw new Error('Capability checks must not invoke host APIs');};
function hostFixture(){return {
  effect:unused,connection:{fetch:{register:unused}},
  llm:{listProviders:unused,listModels:unused,stream:unused},tools:{register:unused},
};}
function clientFixture(){return {
  effect:unused,on:unused,connection:{rpc:{call:unused}},slots:{inject:unused,register:unused},locale:{register:unused,bind:unused},
  layout:{selectPanel:unused,panelInfo:{getSnapshot:unused,subscribe:unused}},uiWorkspace:{openSession:unused},
  sessions:{list:{getSnapshot:unused,subscribe:unused},refresh:unused,refreshProjections:unused,subagentAddress:unused},
  workspaces:{list:{getSnapshot:unused,subscribe:unused}},
};}
function failure(action:()=>void):DshHostContractError {
  try{action();assert.fail('Expected an unavailable-API error');}
  catch(error){assert.ok(error instanceof DshHostContractError);return error;}
}

test('the same consumed API contract accepts unrelated host release labels without calling APIs',()=>{
  for(const version of ['0.2.1-rc.2','0.2.1-rc.3','0.3.0-beta.1','2.0.0','development']){
    assert.doesNotThrow(()=>assertHostContract({...hostFixture(),version}));
    assert.doesNotThrow(()=>assertClientContract({...clientFixture(),version}));
  }
  const context=Object.defineProperty(hostFixture(),'version',{get(){throw new Error('Release metadata must not be read');}});
  assert.doesNotThrow(()=>assertHostContract(context));
});

test('missing required APIs report all concrete paths in Chinese instead of a version requirement',()=>{
  const error=failure(()=>assertHostContract({...hostFixture(),connection:{fetch:{}},tools:{register:'removed'}}));
  assert.equal(error.code,'DSH_HOST_API_UNAVAILABLE');
  assert.equal(error.side,'服务端');
  assert.deepEqual(error.missingMethods,['connection.fetch.register','tools.register']);
  assert.match(error.message,/缺少所需插件 API/);
  assert.match(error.message,/ctx\.connection\.fetch\.register/);
  assert.doesNotMatch(error.message,/rc\.|0\.2\.|版本/);
  const clientError=failure(()=>assertClientContract({...clientFixture(),sessions:{list:{getSnapshot:unused}}}));
  assert.equal(clientError.side,'客户端');
  assert.deepEqual(clientError.missingMethods,['sessions.list.subscribe','sessions.refresh','sessions.refreshProjections','sessions.subagentAddress']);
});

test('already optional services and extension APIs remain optional, while supplied services must be usable',()=>{
  assert.doesNotThrow(()=>assertHostContract(hostFixture()));
  assert.doesNotThrow(()=>assertClientContract(clientFixture()));
  assert.doesNotThrow(()=>assertHostContract({...hostFixture(),jobs:{start:unused},attachments:{readImage:unused,fileHostPath:unused},sessionController:{list:unused},get:unused,llm:{...hostFixture().llm,resolveModelInfo:unused}}));
  assert.doesNotThrow(()=>assertClientContract({...clientFixture(),theme:{getTheme:unused}}));
  assert.deepEqual(failure(()=>assertHostContract({...hostFixture(),jobs:{},attachments:{readImage:unused},sessionController:{list:unused,projections:0}})).missingMethods,['jobs.start','attachments.fileHostPath','sessionController.projections']);
  assert.deepEqual(failure(()=>assertHostContract({...hostFixture(),llm:{...hostFixture().llm,resolveModelInfo:0}})).missingMethods,['llm.resolveModelInfo']);
  assert.deepEqual(failure(()=>assertClientContract({...clientFixture(),theme:{}})).missingMethods,['theme.getTheme']);
});

test('callable proxies and inherited methods work without own-property enumeration',()=>{
  class ModelApi {listProviders=unused;listModels=unused;stream=unused;}
  const implementation=Object.create(new ModelApi()) as ModelApi;
  const rpc=new Proxy(()=>{}, {get:(_target,key)=>key==='call'?unused:undefined,ownKeys(){throw new Error('Do not enumerate a service');}});
  const host=hostFixture();host.llm=implementation;
  assert.doesNotThrow(()=>assertHostContract(host));
  assert.doesNotThrow(()=>assertClientContract({...clientFixture(),connection:{rpc}}));
  const throwing={...hostFixture(),connection:Object.defineProperty({},'fetch',{get(){throw new Error('Cordis inactive service');}})};
  assert.deepEqual(failure(()=>assertHostContract(throwing)).missingMethods,['connection.fetch.register']);
});

test('real Cordis context and traceable callable services satisfy the contract',()=>{
  const {Context,Service}=cordis;
  const context=new Context();
  const fixture=hostFixture();
  class Models extends Service {
    constructor(){super(context,'llm');}
    [Service.invoke](){throw new Error('Do not invoke callable service');}
    listProviders=unused;listModels=unused;stream=unused;
  }
  new Models();
  const disposers=Object.entries(fixture).filter(([key])=>key!=='effect'&&key!=='llm').map(([key,value])=>context.provide(key,value));
  try{assert.doesNotThrow(()=>assertHostContract(context));}
  finally{for(const dispose of disposers)dispose();}
});

test('host entrypoint rejects a missing API before registering plugin resources',()=>{
  const mutations:string[]=[];
  const broken={...hostFixture(),connection:{fetch:{register:()=>{mutations.push('route');}}},effect:()=>{mutations.push('effect');},tools:{register:()=>{mutations.push('tool');}},llm:{listProviders:unused,listModels:unused}};
  assert.deepEqual(failure(()=>applyHost(broken as unknown as HostContext)).missingMethods,['llm.stream']);
  assert.deepEqual(mutations,[]);
});

test('client entrypoint rejects missing APIs before constructing resources or touching the browser',()=>{
  // Load the real entrypoint with only its imports stubbed. A guard failure must
  // precede controller construction, effects, DOM access, and slot registration.
  const source=readFileSync(new URL('../src/client/index.tsx',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{} as {apply(context:unknown):void}};
  const mutations:string[]=[];
  runInNewContext(compiled,{
    exports:module.exports,module,
    require:(name:string)=>name==='../shared/host-contract.ts'?{assertClientContract}:name==='./controller.ts'?{
      StudioController:class {constructor(){mutations.push('controller');}},RpcStudioApi:class {constructor(){mutations.push('rpc');}},
    }:{},
    AbortController:class {constructor(){mutations.push('abort');}},
  });
  const broken={...clientFixture(),connection:{rpc:{}},effect:()=>{mutations.push('effect');}};
  assert.deepEqual(failure(()=>module.exports.apply(broken)).missingMethods,['connection.rpc.call']);
  assert.deepEqual(mutations,[]);
});
