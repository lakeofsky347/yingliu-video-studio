import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rmdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,request} from 'playwright-core';

// Run against scripts/preview.mjs or an isolated Desktop CDP connection with the offline Session fixture.
const env=process.env;
const native=env.DSH_NATIVE_CDP;
const hostLog=env.DSH_SURFACES_HOST_LOG&&await readFile(env.DSH_SURFACES_HOST_LOG,'utf8');
const hostUrl=env.DSH_SURFACES_HOST_URL??hostLog?.match(/dsh web: (http[^\s]+)/)?.[1];
assert.ok(native||hostUrl,'Set DSH_SURFACES_HOST_URL, DSH_SURFACES_HOST_LOG or DSH_NATIVE_CDP');
const url=hostUrl?new URL(hostUrl):null;
if(url)assert.ok(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password,'Use an isolated loopback DSH Web host');
assert.ok(env.DSH_PREVIEW_PROJECTS,'Set DSH_PREVIEW_PROJECTS to the isolated project directory');
const output=path.resolve(env.DSH_SURFACES_REPORT_DIR??'.local/dsh-surfaces');
const executablePath=env.DSH_TEST_BROWSER??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
await mkdir(output,{recursive:true});

const report={status:'FAIL',surface:native?'Official isolated DSH Desktop':'Official isolated DSH Web',provider:'offline Session fixture',checks:[],pageErrors:[]};
const redact=value=>value.replace(/https?:\/\/[^\s<>"']+/g,match=>{
  try{const parsed=new URL(match);return parsed.origin+parsed.pathname;}catch{return '[redacted URL]';}
});
const browser=native?await chromium.connectOverCDP(native):await chromium.launch({headless:true,executablePath});
const page=native?browser.contexts().flatMap(context=>context.pages()).find(candidate=>candidate.url().startsWith('dsh-app://')):await browser.newPage({locale:'zh-CN'});
assert.ok(page,'The isolated Desktop window is unavailable');
const api=native?null:await request.newContext();
page.setDefaultTimeout(20_000);
page.on('pageerror',error=>report.pageErrors.push(redact(error.message)));

async function rpc(method,payload){
  const data={type:'client-request',rpcId:randomUUID(),method,payload};
  const {status,ok,json}=native?await page.evaluate(async data=>{
    const response=await fetch('/api/'+data.method,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),
    });
    return {status:response.status,ok:response.ok,json:await response.json()};
  },data):await api.post(new URL('/api/'+method,url).href,{data}).then(async response=>{
    return {status:response.status(),ok:response.ok(),json:await response.json()};
  });
  assert.ok(ok,`${method} returned HTTP ${status}`);
  const {result}=json;
  assert.ok(result?.ok,`${method}: ${result?.error?.message??'unexpected response'}`);
  return result.value;
}

const remote=(method,request)=>rpc(method,{args:{request}});
const studio=(method,payload)=>rpc('video-studio/'+method,payload);
const rightPanel=page.locator('[data-sidebar-right-panel][data-sidebar-right-open]');
const rightStudio=rightPanel.locator('[data-video-studio-surface="right"] .vs-studio');
const rightTab=rightPanel.locator('[data-dockkit-tab]').filter({hasText:'映流 · 视频工作台'});
const globalStudio=page.locator('[data-video-studio-surface="main"] .vs-studio');
const conversation=page.locator('[data-conversation-content]');
const conversationStudio=conversation.locator('[data-video-studio-surface="conversation"] .vs-studio');
const conversationTabs=page.locator('[data-conversation-tabs]');
const openDock=page.getByRole('button',{name:'在右侧打开映流',exact:true});
const panelName='映流 · 视频工作台';
const chat=conversationTabs.getByRole('tab',{name:'对话',exact:true});
const composer=conversation.locator('[data-composer-input]');
let workspaceDir;

async function openProject(surface,project){
  const heading=surface.getByRole('heading',{name:project.title,exact:true});
  await heading.or(surface.locator('[data-video-home]')).waitFor();
  if(!await heading.isVisible()){
    await surface.locator(`[data-project-id="${project.id}"]`).getByRole('button',{name:`打开影片 ${project.title}`,exact:true}).click();
  }
  await heading.waitFor();
  await surface.getByRole('region',{name:'时间线',exact:true}).waitFor();
}

function firstShot(surface){
  return surface.getByRole('region',{name:'时间线',exact:true}).getByRole('button',{name:/^镜头 1：/});
}

function pass(name,details){
  report.checks.push({name,...details});
  console.log(name);
}

try{
  await page.setViewportSize({width:1680,height:1040});
  if(!native){
    assert.ok((await api.get(url.href)).ok(),'The isolated host is unreachable');
    await page.goto(url.href);
  }
  const welcome=page.getByRole('button',{name:'继续',exact:true});
  if(await welcome.waitFor({timeout:3000}).then(()=>true,()=>false))await welcome.click();
  const globalEntry=page.getByRole('navigation',{name:'全局面板'}).getByText(panelName,{exact:true});
  await globalEntry.waitFor({timeout:60_000});

  workspaceDir=await mkdtemp(path.join(output,'workspace-'));
  const workspace=(await remote('workspace/create',{path:workspaceDir})).workspace;
  const {sessionId}=await remote('session/create',{workspaceId:workspace.workspaceId});
  const initialPrompt='检查会话顶部入口与右侧并排工作台';
  await remote('session/rename',{sessionId,title:'映流界面验收'});
  await remote('session/prompt',{sessionId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:initialPrompt}]});
  const {project,root}=await studio('create',{
    sessionId,title:'并排工作台验收影片',topic:'从同一会话打开并编辑影片',
    productionMode:'code_animation',
    target:{width:320,height:180,fps:{num:12,den:1},audioMode:'none'},
  });
  const relative=path.relative(await realpath(env.DSH_PREVIEW_PROJECTS),await realpath(root));
  assert.ok(relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative),'Fixture must live within the isolated projects directory');
  const group=page.locator(`[data-row-key="workspace:${workspace.workspaceId}"]`);
  await group.waitFor();
  if(await group.getAttribute('aria-expanded')!=='true')await group.click();
  await page.locator(`[data-row-key="session:${sessionId}"]`).click();
  await conversation.getByText('映流会话验收',{exact:true}).waitFor();
  assert.equal(await conversation.getAttribute('data-conversation-session'),sessionId);

  const view=conversationTabs.getByRole('tab',{name:'映流',exact:true});
  await view.click();
  assert.equal(await view.getAttribute('aria-selected'),'true');
  await openProject(conversationStudio,project);
  await conversationStudio.getByRole('radio',{name:'分镜画布',exact:true}).click();
  await conversationStudio.locator('.vs-stage-canvas').waitFor();
  await conversationStudio.getByRole('radio',{name:'监视器',exact:true}).click();
  await conversationStudio.locator('.vs-stage-monitor').waitFor();
  await page.screenshot({path:path.join(output,'top-view.png')});
  await chat.click();
  await conversation.getByText(initialPrompt,{exact:true}).waitFor();
  pass('Conversation tab opens the same session’s monitor and storyboard canvas and returns to its transcript');

  await page.getByRole('button',{name:'打开右侧边栏',exact:true}).click();
  await rightPanel.getByRole('button',{name:panelName,exact:true}).click();
  await openProject(rightStudio,project);
  assert.equal(await rightPanel.getAttribute('data-sidebar-right-panel'),'push');
  assert.equal(await rightPanel.getAttribute('data-sidebar-right-session'),sessionId);
  assert.equal(await chat.getAttribute('aria-selected'),'true');
  await conversation.getByText(initialPrompt,{exact:true}).waitFor();
  const continuedPrompt='右侧工作台打开时仍可继续发送会话消息';
  await composer.fill(continuedPrompt);
  await composer.press('Enter');
  await conversation.getByText(continuedPrompt,{exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-conversation-content]')].some(content=>content.innerText.split('映流会话验收').length>=3));
  await rightStudio.getByRole('heading',{name:project.title,exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'chat-and-right.png')});
  pass('Right-sidebar guide opens the project while the same chat sends and receives a message');

  await rightPanel.getByRole('button',{name:'收起右侧边栏',exact:true}).click();
  await rightStudio.waitFor({state:'hidden'});
  await openDock.click();
  await openProject(rightStudio,project);
  assert.equal(await rightTab.count(),1);
  await rightTab.getByRole('button',{name:'关闭',exact:true}).click();
  await rightStudio.waitFor({state:'hidden'});
  await openDock.click();
  await openProject(rightStudio,project);
  assert.equal(await chat.getAttribute('aria-selected'),'true');
  pass('Toolbar action expands and reopens the same right tab after collapse and close');

  await page.setViewportSize({width:1080,height:960});
  await rightStudio.and(page.locator('[data-layout="narrow"]')).waitFor();
  await firstShot(rightStudio).click();
  const editedText='窄侧栏编辑保存验收';
  const textInput=rightStudio.getByLabel('屏幕主文字',{exact:true});
  await textInput.fill(editedText);
  for(let retry=0;retry<40;retry++){
    const current=await studio('current',{sessionId});
    if(current.project.shots[0].params.text===editedText)break;
    assert.ok(retry<39,'Right-sidebar edit did not persist');
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  const sizes=await rightStudio.locator('.vs-workbench').evaluate(element=>({
    width:element.clientWidth,
    scrollWidth:element.scrollWidth,
    height:element.clientHeight,
    scrollHeight:element.scrollHeight,
  }));
  assert.ok(sizes.width<700&&sizes.width>0,`Expected a narrow sidebar, got ${sizes.width}px`);
  assert.ok(sizes.scrollWidth<=sizes.width+1,'Right editor overflows horizontally');
  assert.ok(sizes.scrollHeight>sizes.height,'Right editor should scroll vertically');
  const [left,right]=await Promise.all([conversation.boundingBox(),rightStudio.boundingBox()]);
  assert.ok(left&&right&&left.x+left.width<=right.x+1,'Right editor covers the conversation region');
  await composer.waitFor();
  await page.screenshot({path:path.join(output,'narrow-right.png')});
  pass('Narrow right-side editor scrolls and saves real project changes beside the composer',sizes);

  await globalEntry.click();
  await openProject(globalStudio,project);
  await firstShot(globalStudio).click();
  assert.equal(await globalStudio.getByLabel('屏幕主文字',{exact:true}).inputValue(),editedText);
  pass('Original global left entry still opens the editor and reads the saved project');
  assert.deepEqual(report.pageErrors,[]);
  report.status='PASS';
}catch(error){
  report.failure=redact(error.stack??String(error));
  await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  console.error(report.failure);
  process.exitCode=1;
}finally{
  await writeFile(path.join(output,'surfaces.json'),JSON.stringify(report,null,2)+'\n');
  if(workspaceDir)await rmdir(workspaceDir).catch(()=>{});
  await api?.dispose();
  await browser.close();
}
