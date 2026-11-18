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

const environment=detectEnvironment();
const savedSource={html:'<main>用户原稿：山河</main>',css:'main { color: white; }',js:"const caption = '原始字幕';"};
const draftHtml='<main>用户草稿：河流</main>\n<p>字幕也保留</p>';
const draftJs="const title = '中文标题';\nwindow.render = () => {};";

async function browserFixture(run:(page:Page)=>Promise<void>){
  const directory=path.resolve('artifacts/localization-ui-'+randomUUID());
  await fs.mkdir(directory,{recursive:true});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const server=createServer(async(req,res)=>{
    if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(directory,'fixture.js')));return;}
    if(req.url==='/studio.css'){res.setHeader('Content-Type','text/css');res.end(await fs.readFile(path.resolve('src/client/styles.css')));return;}
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/studio.css">
      <style>body{margin:0}#root{padding:16px}.fixture-panels{display:flex;align-items:flex-start;gap:24px}.fixture-output{width:280px;flex-shrink:0}.fixture-source{flex:1;min-width:0}.fixture-canvas{width:980px;height:410px;max-width:100%;margin-top:24px}canvas{display:block}</style>
      <div id="root" class="vs-studio"></div><script type="module" src="/fixture.js"></script>`);
  });
  try{
    const project=createCodeProject('用户片名：山河之间','保留用户中文主题');
    project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);
    const shot=project.shots[0]!;shot.title='用户镜头：清晨';shot.intent='用户写下的画面说明';shot.params.subtitle='用户字幕不要翻译';
    project.assets=[{id:'user-text',kind:'text',name:'用户素材：旁白',description:'用户素材说明',text:'用户文字内容'}];
    shot.assetIds=['user-text'];
    project.graph.positions={'user-text':[15,55],[shot.id]:[300,100],'film-output':[600,100]};
    const entry=path.join(directory,'fixture.tsx');
    await fs.writeFile(entry,`import React,{useEffect,useRef} from 'react';import {createRoot} from 'react-dom/client';
      import {LiteGraph} from '@comfyorg/litegraph';
      import {SourceEditor} from ${JSON.stringify(path.resolve('src/client/SourceEditor.tsx'))};
      import {OutputSettings} from ${JSON.stringify(path.resolve('src/client/output-settings.tsx'))};
      import {LiteGraphEditor} from ${JSON.stringify(path.resolve('src/client/graph-adapter.ts'))};
      import {setLocale} from ${JSON.stringify(path.resolve('src/client/i18n.ts'))};
      const project=${JSON.stringify(project)},savedSource=${JSON.stringify(savedSource)},drafts=new Map(),listeners=new Set();
      let state={snapshot:{project}},readCount=0,outputChanges=0,graphChanges=0,selectionChanges=0,editor;
      const drawn=new Set();
      const controller={subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},getSnapshot:()=>state,confirmedRevision:0,
        getSourceDraft:id=>drafts.get(id),sourceDrafts:()=>[...drafts].map(([shotId,draft])=>({shotId,...draft})),
        readSource:async()=>{readCount++;return savedSource;},
        setSourceDraft:(id,source,baseRevision)=>{drafts.set(id,{source,baseRevision});state={...state};for(const listener of listeners)listener();}};
      function switchLanguage(locale){LiteGraph.closeAllContextMenus(window);drawn.clear();setLocale(locale);}
      function Fixture(){const canvas=useRef(null);useEffect(()=>{
          const context=canvas.current.getContext('2d'),fillText=context.fillText.bind(context);
          context.fillText=(text,...args)=>{drawn.add(text);return fillText(text,...args);};
          editor=new LiteGraphEditor(canvas.current,()=>graphChanges++,()=>selectionChanges++);
          editor.setProject(project,()=> '');editor.view.ds.scale=.9;editor.view.ds.offset=[20,40];
          editor.view.selectNode(editor.nodes.get(project.shots[0].id));editor.view.setDirty(true,true);
          window.fixture={switchLanguage,read:()=>({project:JSON.stringify(project),draft:drafts.get(project.shots[0].id),readCount,outputChanges,graphChanges,selectionChanges,drawn:[...drawn],
            nodes:[...editor.nodes].map(([id,node])=>({id,title:node.title,position:[...node.pos],inputs:node.inputs.map(port=>port.name),outputs:node.outputs.map(port=>port.name)})),
            selected:editor.selectedIds(),viewport:{scale:editor.view.ds.scale,offset:[...editor.view.ds.offset]},
            nodeMenu:editor.view.getNodeMenuOptions(editor.nodes.get(project.shots[0].id)).map(item=>item.content),canvasMenu:editor.view.getCanvasMenuOptions().map(item=>item.content)})};
          return()=>editor.dispose();},[]);
        return <><nav><button data-testid="locale-en" onClick={()=>switchLanguage('en')}>English</button><button data-testid="locale-zh" onClick={()=>switchLanguage('zh')}>中文</button></nav>
          <h1>{project.title}</h1><div className="fixture-panels"><section className="fixture-output"><OutputSettings project={project} onChange={()=>outputChanges++}/></section>
          <section className="fixture-source"><SourceEditor controller={controller} selectedShot={project.shots[0]} busy={false} version="fixed"/></section></div>
          <div className="fixture-canvas"><canvas ref={canvas}/></div></>;}
      setLocale('zh');createRoot(document.getElementById('root')).render(<Fixture/>);`);
    await build({entry:{fixture:entry},outDir:directory,clean:false,format:'esm',platform:'browser',inputOptions:{platform:'browser'},deps:{alwaysBundle:[/.*/]},dts:false,sourcemap:false,logLevel:'silent'});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:environment.browserPath,headless:true});
    const page=await browser.newPage({viewport:{width:1200,height:900}}),errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.clock.install();
    await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);
    await page.waitForFunction(()=>Boolean((window as any).fixture)&&document.querySelector('textarea')?.value==='<main>用户原稿：山河</main>');
    await run(page);
    assert.deepEqual(errors,[],'The actual React and LiteGraph components must not throw browser errors');
  }finally{
    await browser?.close();server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await fs.rm(directory,{recursive:true,force:true});
  }
}

test('language changes preserve real editor drafts, form input and canvas interaction state',{skip:!environment.browserAvailable,timeout:90_000},async context=>{
  await browserFixture(async page=>{
    const initial=await page.evaluate(()=>(window as any).fixture.read());
    await context.test('Chinese → English → Chinese updates controls without rewriting unsaved input or user content',async()=>{
      await page.getByLabel('HTML 源码',{exact:true}).fill(draftHtml);
      await page.getByRole('button',{name:'JS',exact:true}).click();
      await page.getByLabel('JS 源码',{exact:true}).fill(draftJs);
      await page.getByRole('button',{name:'HTML',exact:true}).click();
      await page.getByText('自定义画面尺寸',{exact:true}).click();
      await page.getByLabel('宽度（像素）',{exact:true}).fill('1460');
      await page.getByLabel('高度（像素）',{exact:true}).fill('822');
      await page.getByTestId('locale-en').click();
      await page.getByRole('button',{name:'Save source',exact:true}).waitFor();
      assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),draftHtml);
      assert.equal(await page.getByLabel('Width (pixels)',{exact:true}).inputValue(),'1460');
      assert.equal(await page.getByLabel('Height (pixels)',{exact:true}).inputValue(),'822');
      assert.equal(await page.getByLabel('Aspect ratio',{exact:true}).locator('option[value="16:9"]').textContent(),'16:9 Landscape');
      assert.equal(await page.getByText('Draft retained · Not submitted',{exact:true}).count(),1);
      assert.equal(await page.getByRole('heading',{name:'用户片名：山河之间',exact:true}).count(),1);
      assert.equal(await page.locator('.vs-source-toolbar').getByText('用户镜头：清晨',{exact:true}).count(),1);
      assert.equal(await page.getByRole('button',{name:'Save source',exact:true}).isEnabled(),true);
      const widthBounds=await page.getByLabel('Width (pixels)',{exact:true}).boundingBox(),panelBounds=await page.locator('.fixture-output').boundingBox();
      assert.ok(widthBounds&&panelBounds&&widthBounds.x>=panelBounds.x&&widthBounds.x+widthBounds.width<=panelBounds.x+panelBounds.width+1,'English custom-size input remains inside the narrow properties panel');
      await page.getByTestId('locale-zh').click();
      await page.getByRole('button',{name:'保存源码',exact:true}).waitFor();
      assert.equal(await page.getByLabel('HTML 源码',{exact:true}).inputValue(),draftHtml);
      assert.equal(await page.getByLabel('宽度（像素）',{exact:true}).inputValue(),'1460');
      assert.equal(await page.getByLabel('高度（像素）',{exact:true}).inputValue(),'822');
      assert.equal(await page.getByLabel('画幅比例',{exact:true}).locator('option[value="16:9"]').textContent(),'16:9 横屏');
      await page.getByRole('button',{name:'JS',exact:true}).click();
      assert.equal(await page.getByLabel('JS 源码',{exact:true}).inputValue(),draftJs);
      const current=await page.evaluate(()=>(window as any).fixture.read());
      assert.deepEqual(current.draft,{source:{...savedSource,html:draftHtml,js:draftJs},baseRevision:0});
      assert.equal(current.project,initial.project,'Language changes cannot rewrite existing user projects');
      assert.equal(current.readCount,1,'Language changes must not reload the source or invalidate the current draft identity');
      assert.equal(current.outputChanges,0,'Unapplied form values remain local while changing language');
    });
    await context.test('the live canvas repaints labels and menus without moving, reselecting or saving nodes',async()=>{
      await page.clock.runFor(100);
      const before=await page.evaluate(()=>(window as any).fixture.read());
      assert.equal(before.graphChanges,0);
      assert.equal(before.selected.length,1);
      assert.deepEqual(before.nodes.find((node:any)=>node.id===before.selected[0]).inputs,['上一镜头','使用 1','使用 2','参考 1']);
      assert.equal(before.nodes.find((node:any)=>node.id==='film-output').title,'影片输出');
      assert.ok(before.drawn.includes('影片输出'),'The initial Chinese label is drawn by the real canvas renderer');
      for(const locale of ['en','zh'] as const){
        await page.getByTestId('locale-'+locale).click();
        await page.clock.runFor(100);
        const current=await page.evaluate(()=>(window as any).fixture.read()),english=locale==='en';
        const film=current.nodes.find((node:any)=>node.id==='film-output'),shot=current.nodes.find((node:any)=>node.id===before.selected[0]),asset=current.nodes.find((node:any)=>node.id==='user-text');
        assert.equal(film.title,english?'Film output':'影片输出');
        assert.deepEqual(film.inputs,[english?'Final shot':'最后镜头']);
        assert.deepEqual(shot.inputs,english?['Previous shot','Use 1','Use 2','Reference 1']:['上一镜头','使用 1','使用 2','参考 1']);
        assert.deepEqual(shot.outputs,[english?'Next shot':'下一镜头']);
        assert.deepEqual(asset.outputs,english?['Use asset','Reference only']:['使用素材','仅供参考']);
        assert.equal(shot.title,'用户镜头：清晨');assert.equal(asset.title,'用户素材：旁白');
        assert.deepEqual(current.nodeMenu,english?['Edit properties','Duplicate shot','Delete node']:['编辑属性','复制镜头','删除节点']);
        assert.deepEqual(current.canvasMenu,english?['Arrange canvas','Group selected nodes']:['整理画布','选中节点分组']);
        assert.ok(current.drawn.includes(film.title),'A locale change must repaint the visible canvas, not only update node metadata');
        assert.ok(current.drawn.includes(english?'End of the shot sequence':'主镜头链的终点'),'Program text inside the output node also follows the locale');
        assert.deepEqual(current.nodes.map((node:any)=>[node.id,node.position]),before.nodes.map((node:any)=>[node.id,node.position]));
        assert.deepEqual(current.viewport,before.viewport);assert.deepEqual(current.selected,before.selected);
        assert.equal(current.selectionChanges,before.selectionChanges,'A locale update must not reconstruct or reselect graph nodes');
        assert.equal(current.graphChanges,0,'A locale update must never write a new project revision');
        assert.equal(current.project,initial.project);
        assert.equal(await page.locator('canvas').getAttribute('aria-label'),english?'Asset and shot connection canvas':'资产与镜头连线画布');
        await page.locator('canvas').click({button:'right',position:{x:400,y:112}});
        await page.getByText(english?'Edit properties':'编辑属性',{exact:true}).waitFor();
      }
    });
  });
});
