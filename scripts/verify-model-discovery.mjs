import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright-core';

// Start scripts/preview.mjs with a fresh profile and DSH_SESSION_FIXTURE=1 first.
const env=process.env;
const hostLog=env.DSH_MODELS_HOST_LOG&&await readFile(env.DSH_MODELS_HOST_LOG,'utf8');
const hostUrl=env.DSH_MODELS_HOST_URL??hostLog?.match(/dsh web: (http[^\s]+)/)?.[1];
assert.ok(hostUrl,'Set DSH_MODELS_HOST_URL or DSH_MODELS_HOST_LOG');
const url=new URL(hostUrl);
assert.ok(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password,'Use an isolated loopback DSH Web host');
const output=path.resolve(env.DSH_MODELS_REPORT_DIR??'.local/model-discovery');
const executablePath=env.DSH_TEST_BROWSER??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
await mkdir(output,{recursive:true});

const key=`catalog-fixture-${randomUUID()}`;
const report={status:'FAIL',surface:'Official isolated DSH Web',provider:'loopback OpenAI-compatible fixture',checks:[],requests:[],pageErrors:[]};
const redact=value=>String(value).replaceAll(key,'[redacted key]').replace(/https?:\/\/[^\s<>"']+/g,match=>{
  try{const parsed=new URL(match);return parsed.origin+parsed.pathname;}catch{return '[redacted URL]';}
});
let outcome='initial';
const provider=createServer((request,response)=>{
  const authenticated=request.headers.authorization===`Bearer ${key}`;
  report.requests.push({method:request.method,path:new URL(request.url,'http://127.0.0.1').pathname,authenticated});
  response.setHeader('content-type','application/json');
  if(request.method!=='GET'||request.url!=='/v1/models'||!authenticated||outcome==='denied'){
    response.writeHead(401).end(JSON.stringify({error:{message:'Rejected test key '+key}}));
    return;
  }
  const models=outcome==='initial'?['gpt-image-1','dall-e-3']:['gpt-image-1','gpt-image-1-mini'];
  response.end(JSON.stringify({object:'list',data:[...models.map(id=>({id,object:'model'})),{id:`invalid-${key}`}]}));
});
await new Promise((resolve,reject)=>{
  provider.once('error',reject);
  provider.listen(0,'127.0.0.1',resolve);
});
const baseUrl=`http://127.0.0.1:${provider.address().port}/v1`;
let browser,page;

function pass(name){report.checks.push(name);console.log(name);}

async function registry(){
  const json=await page.evaluate(async rpcId=>{
    const method='video-studio/models.list';
    const response=await fetch('/api/'+method,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId,method,payload:{}}),
    });
    return response.json();
  },randomUUID());
  assert.ok(json.result?.ok,'The registry RPC must succeed');
  assert.ok(!JSON.stringify(json).includes(key),'The registry must not return the credential');
  return json.result.value;
}

try{
  browser=await chromium.launch({headless:true,executablePath});
  page=await browser.newPage({locale:'zh-CN',viewport:{width:1570,height:1020}});
  page.setDefaultTimeout(15_000);
  page.on('pageerror',error=>report.pageErrors.push(redact(error.message)));
  await page.goto(url.href);
  const welcome=page.getByRole('button',{name:'继续',exact:true});
  if(await welcome.waitFor({timeout:3000}).then(()=>true,()=>false))await welcome.click();
  await page.getByRole('navigation',{name:'全局面板'}).getByText('映流 · 视频工作台',{exact:true}).click({timeout:60_000});
  await page.getByRole('button',{name:'媒体模型',exact:true}).click();
  const center=page.locator('.vs-model-center');
  await center.waitFor();

  const keyField=center.getByLabel('模型连接 API Key',{exact:true});
  const addressField=center.getByLabel('模型连接地址',{exact:true});
  const saveConnection=center.getByRole('button',{name:'保存连接',exact:true});
  const modelField=center.getByLabel('服务端模型 ID',{exact:true});
  const saveModel=center.getByRole('button',{name:'保存模型',exact:true});
  const suggestions=center.getByLabel('从服务商列表选择模型',{exact:true});
  const refresh=center.getByRole('button',{name:'拉取模型列表',exact:true});
  const pool=center.getByRole('region',{name:'模型池',exact:true});

  async function fillConnection(name){
    await center.getByLabel('连接名称',{exact:true}).fill(name);
    await addressField.fill(baseUrl);
    await keyField.fill(key);
  }
  async function assertKeyCleared(){
    assert.ok((await keyField.inputValue())==='','The key entry must clear after saving');
    assert.ok(!(await page.content()).includes(key),'The DOM must not expose the credential after saving');
  }

  const name='目录验收 · 图片服务';
  await fillConnection(name);
  assert.equal(report.requests.length,0,'Filling the field must wait for the explicit save');
  await saveConnection.click();
  await suggestions.locator('option[value="gpt-image-1"]').waitFor({state:'attached'});
  assert.deepEqual(report.requests,[{method:'GET',path:'/v1/models',authenticated:true}]);
  await assertKeyCleared();
  const connection=(await registry()).connections.find(connection=>connection.name===name);
  assert.ok(connection?.hasKey,'The provider connection and its credential must be saved');
  await suggestions.selectOption('gpt-image-1');
  assert.equal(await modelField.inputValue(),'gpt-image-1');
  await saveModel.click();
  await pool.getByText('gpt-image-1',{exact:true}).waitFor();
  assert.ok((await registry()).models.some(model=>model.connectionId===connection.id&&model.model==='gpt-image-1'));
  await page.screenshot({path:path.join(output,'catalog-selected.png')});
  pass('Saving a key triggers exactly one API catalog GET; selecting a returned ID saves it in the model pool.');

  outcome='updated';
  await refresh.click();
  await suggestions.locator('option[value="gpt-image-1-mini"]').waitFor({state:'attached'});
  assert.equal(await suggestions.locator('option[value="dall-e-3"]').count(),0);
  assert.equal(report.requests.length,2);
  assert.equal(report.requests[1].authenticated,true);
  await assertKeyCleared();
  pass('Refreshing the list uses the saved credentials and replaces outdated suggestions.');

  await addressField.fill(baseUrl+'/unsaved');
  assert.ok(!await refresh.isEnabled(),'An unsaved endpoint must not reuse saved credentials for discovery');
  assert.equal(report.requests.length,2);
  pass('An unsaved endpoint edit disables catalog fetching with the stored key.');

  outcome='denied';
  const manualName='目录验收 · 手动添加';
  await center.getByRole('button',{name:'新增连接',exact:true}).click();
  await fillConnection(manualName);
  await saveConnection.click();
  await center.getByRole('alert').filter({hasText:'拉取模型列表失败'}).waitFor();
  assert.equal(report.requests.length,3);
  await assertKeyCleared();
  const manual=(await registry()).connections.find(connection=>connection.name===manualName);
  assert.ok(manual?.hasKey,'A catalog failure must preserve the saved connection');
  await page.screenshot({path:path.join(output,'catalog-error.png')});
  await modelField.fill('manual-image-model');
  await saveModel.click();
  await pool.getByText('manual-image-model',{exact:true}).waitFor();
  assert.ok((await registry()).models.some(model=>model.connectionId===manual.id&&model.model==='manual-image-model'));
  assert.ok(report.requests.every(({method,path,authenticated})=>method==='GET'&&path==='/v1/models'&&authenticated));
  assert.equal(report.requests.length,3,'Saving a model must not make a generation request');
  assert.deepEqual(report.pageErrors,[]);
  pass('A 401 preserves the saved connection, masks the provider response, and permits adding a manual model.');
  report.status='PASS';
}catch(error){
  report.failure=redact(error.stack??error);
  if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  console.error(report.failure);
  process.exitCode=1;
}finally{
  await browser?.close();
  await new Promise(resolve=>provider.close(resolve));
  await writeFile(path.join(output,'model-discovery.json'),JSON.stringify(report,null,2)+'\n');
}
