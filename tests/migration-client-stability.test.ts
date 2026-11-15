import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {build} from 'tsdown';
import {chromium,type Page} from 'playwright-core';
import {detectEnvironment} from '../src/host/renderer.ts';
import {createCodeProject} from './fixtures/production.ts';
import {DIRECTOR_RULESET_VERSION} from '../src/director/index.ts';

const env=detectEnvironment();
async function fixture(mode:'director'|'director-constraints'|'workflow'|'workflow-preview'|'corrupt',run:(page:Page)=>Promise<void>){
  const directory=path.resolve('artifacts/stabilization-20261115/client-fixture-'+randomUUID());await fs.mkdir(directory,{recursive:true});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const server=createServer(async(req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?await fs.readFile(path.join(directory,'fixture.js')):'<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/fixture.js"></script>');});
  try{
    const project=createCodeProject('工程 A');project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);
    const other=createCodeProject('工程 B');
    const plan={version:1,ruleSetVersion:DIRECTOR_RULESET_VERSION,filmKind:'general',characters:[],worldLayouts:[],identityMap:[],storyBeats:[],shots:project.shots.map(shot=>({shotId:shot.id,title:shot.title,visualPrompt:'保护本地编辑',narration:'',durationSeconds:shot.durationFrames/30,audioStrategy:'silent',performance:[],dialogue:[],events:[],references:[],acceptance:[]}))};
    const entry=path.join(directory,'fixture.tsx');
    await fs.writeFile(entry,`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {DirectorDocumentPanel} from ${JSON.stringify(path.resolve('src/client/DirectorDocumentPanel.tsx'))};
      import {WorkflowPanel} from ${JSON.stringify(path.resolve('src/client/WorkflowPanel.tsx'))};
      const initial=${JSON.stringify(project)},other=${JSON.stringify(other)},plan=${JSON.stringify(plan)};
      const record={id:'old-workflow',projectId:initial.id,request:{prompt:'OLD_PROJECT_RECORD'},status:'complete',createdAt:new Date().toISOString(),message:'OLD_PROJECT_RECORD',steps:[],usage:{cost:null,generatedTasks:0}};
      ${mode==='director-constraints'?`plan.characters=[{id:'speaker',name:'对白角色',identity:'保留对白'},{id:'identity',name:'身份角色',identity:'保留身份图'}];plan.identityMap=[{characterId:'identity',assetId:'portrait'}];plan.shots[0].dialogue=[{id:'line',characterId:'speaker',start:0,end:1,text:'精确台词'}];`:''}
      ${mode==='workflow-preview'?`record.status='awaiting-apply';record.qualityReport={version:1,candidateHash:'a'.repeat(64),decision:'needs-review',checks:[{id:'dialogue',category:'dialogue',severity:'hard',status:'unchecked',message:'对白时序需审看'}]};`:''}
      const state={snapshot:{project:initial},pending:false,route:{provider:'fixture',model:'fixture'}};window.calls=[];window.errors=[];window.holdA=false;
      addEventListener('error',event=>window.errors.push(event.message));
      const controller={subscribe:()=>()=>{},getSnapshot:()=>state,busy:false,refreshMediaProject:async()=>true,
        mediaCommand:async(endpoint,payload)=>{window.calls.push({endpoint,payload});throw new Error('fixture saved');},
        api:{call:async(endpoint,payload)=>{window.calls.push({endpoint,payload});if(endpoint==='workflows.preview')return new Promise(resolve=>window.resolvePreview=()=>resolve({candidateHash:'a'.repeat(64),playback:{candidateHash:'a'.repeat(64),url:'/old-candidate.mp4',mime:'video/mp4',duration:1,frameCount:30,shotIds:[initial.shots[0].id]}}));if(endpoint==='workflows.list'&&payload.projectId===initial.id&&window.holdA)return new Promise(resolve=>window.resolveA=()=>{window.holdA=false;resolve({workflows:[record]});});return {workflows:payload.projectId===initial.id&&(window.resolvedA||${mode==='workflow-preview'})?[record]:[]};}}};
      ${mode==='corrupt'?`localStorage.setItem('yingliu-video-studio.director-draft.v1.'+initial.id,JSON.stringify({projectId:initial.id,baseVersion:0,updatedAt:new Date().toISOString(),plan:{version:1,shots:[]}}));`:''}
      function Fixture(){const [project,setProject]=useState(initial);window.switchProject=()=>{state.snapshot={project:other};setProject(other);};window.switchProjectA=()=>{state.snapshot={project:initial};setProject(initial);};return ${mode.startsWith('workflow')?'<WorkflowPanel controller={controller} project={project} plugin/>':'<DirectorDocumentPanel key={project.id} controller={controller} project={project} latestPlan={plan} disabled={false} onDirtyChange={()=>{}}/>'};}
      createRoot(document.getElementById('root')).render(<Fixture/>);`);
    await build({entry:{fixture:entry},outDir:directory,clean:false,format:'esm',platform:'browser',inputOptions:{platform:'browser'},deps:{alwaysBundle:[/.*/]},dts:false,sourcemap:false,logLevel:'silent'});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({executablePath:env.browserPath,headless:true});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);await run(page);
  }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
}

test('director panel protects a referenced role instead of stranding invalid local edits',{skip:!env.browserAvailable,timeout:60_000},async()=>{
  await fixture('director',async page=>{
    await page.locator('[data-director-document] > summary').click();await page.getByRole('button',{name:'从当前镜头建立计划'}).click();await page.getByRole('button',{name:'添加角色'}).click();
    const shot=page.locator('[data-director-document] details').first();await shot.locator('summary').click();await shot.getByRole('checkbox',{name:'新角色'}).check();
    await page.getByLabel('导演画面要求 1',{exact:true}).fill('仍需保留的其他编辑');
    assert.equal(await page.getByRole('button',{name:'移除角色'}).isDisabled(),true,'a role referenced by the shot must not be destructively removed');
    assert.equal(await page.getByLabel('角色名字 1',{exact:true}).inputValue(),'新角色');assert.equal(await page.getByLabel('导演画面要求 1',{exact:true}).inputValue(),'仍需保留的其他编辑');
    await shot.getByRole('checkbox',{name:'新角色'}).uncheck();assert.equal(await page.getByRole('button',{name:'移除角色'}).isDisabled(),false);
  });
});

test('director role deletion preserves dialogue and identity-map references outside the visible cast toggles',{skip:!env.browserAvailable,timeout:60_000},async()=>{
  await fixture('director-constraints',async page=>{
    await page.locator('[data-director-document] > summary').click();await page.getByRole('button',{name:'使用最近的导演计划'}).click();
    const buttons=page.getByRole('button',{name:'移除角色'});assert.equal(await buttons.count(),2);assert.equal(await buttons.nth(0).isDisabled(),true);assert.equal(await buttons.nth(1).isDisabled(),true);
    assert.equal(await page.getByText('此角色仍被镜头出场、表演、对白、空间关系或身份映射引用。请先解除相应引用；已有复杂约束会保留。',{exact:true}).count(),2);
  });
});

test('late workflow refresh from an old project never repopulates the new project panel',{skip:!env.browserAvailable,timeout:60_000},async()=>{
  await fixture('workflow',async page=>{
    await page.getByRole('button',{name:'刷新',exact:true}).waitFor();await page.evaluate(()=>{(window as any).holdA=true;});await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>typeof(window as any).resolveA==='function');
    await page.evaluate(()=>(window as any).switchProject());await page.waitForFunction(()=>(window as any).calls.some((call:any)=>call.endpoint==='workflows.list'&&call.payload.projectId!==(window as any).calls[0].payload.projectId));
    await page.evaluate(()=>{(window as any).resolvedA=true;(window as any).resolveA();});await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    assert.equal(await page.getByText('OLD_PROJECT_RECORD',{exact:true}).count(),0,'old project task data must be ignored after the project changes');
    assert.equal(await page.getByText('流程状态已刷新。',{exact:true}).count(),0,'old project success messages must not leak into the current project');
  });
});

test('a late candidate preview cannot survive a project switch and authorize human review on return',{skip:!env.browserAvailable,timeout:60_000},async()=>{
  await fixture('workflow-preview',async page=>{
    await page.getByRole('button',{name:'审看当前候选',exact:true}).click();await page.waitForFunction(()=>typeof(window as any).resolvePreview==='function');await page.evaluate(()=>(window as any).switchProject());
    await page.getByText('此工程还没有协作流程。',{exact:true}).waitFor();await page.evaluate(()=>(window as any).resolvePreview());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    assert.equal(await page.locator('video').count(),0);await page.evaluate(()=>(window as any).switchProjectA());await page.getByRole('button',{name:'采用候选结果',exact:true}).waitFor();assert.equal(await page.locator('video').count(),0);
    await page.getByRole('button',{name:'采用候选结果',exact:true}).click();await page.getByRole('alert').filter({hasText:'请先打开当前候选'}).waitFor();assert.equal(await page.evaluate(()=>(window as any).calls.filter((call:any)=>call.endpoint==='workflows.apply').length),0);
  });
});

test('malformed persisted director drafts cannot crash the workbench',{skip:!env.browserAvailable,timeout:60_000},async()=>{
  await fixture('corrupt',async page=>{await page.waitForFunction(()=>document.querySelector('[data-director-document]')||(window as any).errors.length);assert.equal(await page.locator('[data-director-document]').count(),1);assert.deepEqual(await page.evaluate(()=>(window as any).errors),[]);assert.equal(await page.evaluate(()=>localStorage.length),1,'invalid raw draft remains available for recovery');await page.locator('[data-director-document] > summary').click();await page.getByRole('status').filter({hasText:'本地导演草稿结构损坏'}).waitFor();});
});
