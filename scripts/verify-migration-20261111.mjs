import {chromium} from 'playwright-core';
import {mkdir,readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {findBrowserExecutable,isExecutableFile} from '../src/host/tool-environment.ts';

/** The caller starts an isolated host with scripts/preview.mjs and names its project directory. */
export async function migrationVerificationOptions(env=process.env){
 let url=env.MIGRATION_HOST_URL;
 if(!url&&env.MIGRATION_HOST_LOG){const log=await readFile(path.resolve(env.MIGRATION_HOST_LOG),'utf8');url=[...log.matchAll(/dsh web: (http[^\s]+)/g)].at(-1)?.[1];}
 assert.ok(url,'Set MIGRATION_HOST_URL or MIGRATION_HOST_LOG for a running isolated DSH Web host');
 const parsed=new URL(url);assert.ok(parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)&&!parsed.username&&!parsed.password,'Migration verification requires a loopback HTTP host URL');
 assert.ok(env.MIGRATION_PROJECTS_DIR,'Set MIGRATION_PROJECTS_DIR to the isolated host DSH_PREVIEW_PROJECTS directory');
 const browserPath=env.MIGRATION_BROWSER_PATH??findBrowserExecutable({env});assert.ok(isExecutableFile(browserPath),'Chrome/Chromium unavailable; set MIGRATION_BROWSER_PATH to an executable');
 const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
 return {url:parsed.href,browserPath,projects:path.resolve(env.MIGRATION_PROJECTS_DIR),out:path.resolve(env.MIGRATION_REPORT_DIR??path.join('artifacts','migration-smoke',runId)),restoreProjectId:env.MIGRATION_RESTORE_PROJECT_ID};
}
export function assertMigrationProjectRoot(root,projects){
 const relative=path.relative(realpathSync(projects),realpathSync(root));assert.ok(relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),'Host project is outside MIGRATION_PROJECTS_DIR');
}
export function assertRestoredMigrationFixture(snapshot,projectId){
 if(!projectId)return false;
 assert.equal(snapshot.project?.id,projectId,'The selected project must match MIGRATION_RESTORE_PROJECT_ID');
 assert.equal(snapshot.project.extensions.directorDocument?.status,'approved');assert.equal(snapshot.project.audioClips.length,1);assert.ok(snapshot.project.outputs.length>0);return true;
}
// Authentication can appear in the host URL's query/fragment or in Playwright call logs.
export function redactMigrationMessage(message){return String(message).replace(/https?:\/\/[^\s<>"']+/g,value=>{try{const url=new URL(value);url.username='';url.password='';url.search='';url.hash='';return url.href;}catch{return '[redacted URL]';}});}

export async function verifyMigration(options){
options??=await migrationVerificationOptions();
const {out,url,browserPath,projects,restoreProjectId}=options;await mkdir(out,{recursive:true});
const base=new URL(url).origin,report={surface:'official isolated DSH Web',platform:process.platform,hostOrigin:base,realProvider:false,checks:[],errors:[],startedAt:new Date().toISOString()};
let browser,context,page;
async function rpc(endpoint,payload={}){const response=await context.request.post(base+'/api/video-studio/'+endpoint,{data:{type:'client-request',rpcId:randomUUID(),method:'video-studio/'+endpoint,payload}});assert.ok(response.ok());const json=await response.json();assert.equal(json.result.ok,true,JSON.stringify(json.result));return json.result.value;}
const pass=(name,evidence={})=>{report.checks.push({name,evidence});console.log(name);};
async function poll(check,timeout=90000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,150));}throw new Error('postcondition timeout');}
async function tab(name){await page.getByRole('tab',{name,exact:true}).click();}
let projectId;
try{
 browser=await chromium.launch({headless:true,executablePath:browserPath});context=await browser.newContext({viewport:{width:1600,height:1100}});page=await context.newPage();report.browser=browser.version();
 page.on('pageerror',error=>report.errors.push(redactMigrationMessage(error.message)));assert.ok((await context.request.get(url)).ok(),'isolated host is reachable');
 const restored=await rpc('current');if(restored.root)assertMigrationProjectRoot(restored.root,projects);
 if(assertRestoredMigrationFixture(restored,restoreProjectId))pass('previous fixture retains approved plan, audio and historical MP4',{projectId:restored.project.id,revision:restored.project.revision,outputs:restored.project.outputs.length});
 let snapshot=await rpc('create',{title:'选择性迁移 · 本地验收',topic:'工程计划、声音和导出检查',productionMode:'code_animation',target:{width:320,height:180,fps:{num:12,den:1},audioMode:'none'}});projectId=snapshot.project.id;assertMigrationProjectRoot(snapshot.root,projects);
 const shots=snapshot.project.shots.slice(0,2).map((shot,index)=>({...shot,durationFrames:12,params:{...shot.params,text:index?'本地音效与导出检查':'角色与工程计划',subtitle:'实际 DSH 宿主 · 无外部模型调用'}}));
 snapshot=await rpc('apply',{projectId,expectedRevision:snapshot.project.revision,shots,shotOrder:shots.map(shot=>shot.id),targetDuration:2});
 await page.goto(url);const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.waitFor({state:'visible',timeout:2500}).then(()=>true).catch(()=>false))await welcome.click();await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.locator(`[data-project-id="${projectId}"]`).getByRole('button',{name:'打开工作台',exact:true}).first().click();await page.getByRole('heading',{name:'选择性迁移 · 本地验收',exact:true}).waitFor();
 await tab('协作制作');await page.locator('[data-director-document] > summary').click();await page.getByRole('button',{name:'从当前镜头建立计划',exact:true}).click();await page.getByRole('button',{name:'添加角色',exact:true}).click();await page.getByLabel('角色名字 1',{exact:true}).fill('导览员');await page.getByLabel('角色身份 1',{exact:true}).fill('短发，蓝色工作服，担任本片导览');await page.getByLabel('角色特征 1',{exact:true}).fill('蓝色衣服\n圆形胸针');await page.getByLabel('角色音色 1',{exact:true}).fill('清晰、自然的中性声音');await page.locator('[data-director-document] details > summary').first().click();await page.locator('[data-director-document] details').first().getByRole('checkbox',{name:'导览员'}).check();
 await page.getByRole('button',{name:'保存计划草稿',exact:true}).click();await poll(async()=>((await rpc('director.document.get',{projectId})).document?.status==='draft'));await page.getByRole('button',{name:'批准此计划',exact:true}).click();const approved=await poll(async()=>{const doc=(await rpc('director.document.get',{projectId})).document;return doc?.status==='approved'?doc:false;});assert.equal(approved.plan.characters[0].name,'导览员');assert.equal(approved.plan.shots[0].characterIds[0],approved.plan.characters[0].id);await page.screenshot({path:out+'/director-plan.png'});pass('edit character, assign shot, save draft, explicitly approve persisted plan',{version:approved.version,hash:approved.hash});
 await tab('声音与配音');await page.locator('[data-local-sfx] > summary').click();await page.getByLabel('本地音效名称',{exact:true}).fill('验收钟声');await page.getByLabel('本地音效时长',{exact:true}).fill('0.5');await page.getByRole('button',{name:/合成并(加入音轨|导入素材)/}).click();snapshot=await poll(async()=>{const s=await rpc('current',{projectId});return s.project.audioClips?.length===1?s:false;});assert.equal(snapshot.project.assets.filter(asset=>asset.kind==='audio').length,1);const audio=page.locator('.vs-audio-clip audio').first();if(await audio.count())await poll(()=>audio.evaluate(element=>element.readyState>=2));await page.screenshot({path:out+'/local-sfx.png'});pass('synthesize local chime through original audio panel and register one playable clip',{assetId:snapshot.project.audioClips[0].assetId});
 await tab('历史成片');await page.locator('[data-local-quality] > summary').click();await page.getByRole('button',{name:'检查当前版本',exact:true}).click();const quality=await poll(()=>rpc('quality.last',{projectId}));assert.equal(quality.scope.checkedFrames.length,6);assert.equal(quality.decision==='fail',false);await page.locator('[data-local-quality]').getByText(/实际分析 6 \/ 6 帧/).waitFor();await page.locator('[data-local-quality] details > summary').click();await page.screenshot({path:out+'/local-quality.png'});pass('local QC captures six actual first/middle/last frames and displays untested scope',{revision:quality.revision,candidateHash:quality.candidateHash,frames:quality.scope.checkedFrames});
 await page.getByRole('button',{name:'导出视频',exact:true}).click();snapshot=await poll(async()=>{const s=await rpc('current',{projectId});if(s.task?.status==='failed')throw new Error(JSON.stringify(s.task));return s.task?.status==='complete'&&s.project.outputs.length?s:false;},120000);const output=snapshot.project.outputs.at(-1);assert.equal(output.qa.status,'PASS');assert.equal(output.localQuality.revision,output.revision);assert.equal(output.localQuality.scope.checkedFrames.length,6);const run=promisify(execFile);await run(snapshot.environment.ffmpegPath,['-v','error','-i',output.path,'-f','null','-']);const probe=JSON.parse((await run(snapshot.environment.ffprobePath,['-v','error','-show_streams','-show_format','-of','json',output.path])).stdout);assert.equal(probe.streams.filter(stream=>stream.codec_type==='audio').length,1);await tab('历史成片');await page.getByRole('button',{name:'播放成片',exact:true}).first().click();await poll(()=>page.locator('.vs-export-player video').evaluate(video=>video.readyState>=2));await page.locator('[data-export-quality] > summary').first().click();await page.screenshot({path:out+'/export-playback.png'});pass('shared export QC gate produces playable AAC MP4 and full FFmpeg decode',{path:output.path,sha256:createHash('sha256').update(await readFile(output.path)).digest('hex'),qa:output.qa.status,streams:probe.streams.map(stream=>({codec:stream.codec_name,type:stream.codec_type}))});
 await page.reload();await page.getByText('映流 · 视频工作台',{exact:true}).click();await page.locator(`[data-project-id="${projectId}"]`).getByRole('button',{name:'打开工作台',exact:true}).first().click();await tab('协作制作');await page.locator('[data-director-document] > summary').click();await page.getByLabel('角色名字 1',{exact:true}).waitFor();assert.equal(await page.getByLabel('角色名字 1',{exact:true}).inputValue(),'导览员');pass('client reload retains approved director document and audio/output project state');
 await page.setViewportSize({width:1100,height:900});await page.screenshot({path:out+'/compact.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);pass('compact desktop preserves original layout without document overflow');
 assert.deepEqual(report.errors,[]);report.status='PASS';report.projectId=projectId;
}catch(error){report.status='FAIL';report.failure=redactMigrationMessage(error.stack??error);await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});throw new Error(report.failure);}
finally{report.completedAt=new Date().toISOString();try{await writeFile(out+'/verification.json',JSON.stringify(report,null,2)+'\n');}finally{await browser?.close();}}
return report;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await verifyMigration();
