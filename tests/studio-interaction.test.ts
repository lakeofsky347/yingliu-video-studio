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

const env=detectEnvironment();
const framePage=`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#123"><script>
addEventListener('message',e=>{if(e.data&&e.data.type==='video-studio/render')parent.postMessage({type:'video-studio/frame',frame:e.data.frame,sceneId:'s'},'*');});
parent.postMessage({type:'video-studio/ready'},'*');</script>`;

/** Mounts the real Studio (tests/fixtures/studio-harness-entry.tsx) against its in-memory API. */
async function studio(query:string,run:(page:Page)=>Promise<void>){
  const directory=path.resolve('artifacts/studio-interaction-'+randomUUID());await fs.mkdir(directory,{recursive:true});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url||'/','http://x');
    if(url.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(directory,'fixture.js')));return;}
    if(url.pathname==='/studio.css'){res.setHeader('Content-Type','text/css');res.end(await fs.readFile(path.resolve('src/client/styles.css')));return;}
    if(url.pathname.startsWith('/frame')){res.setHeader('Content-Type','text/html');res.end(framePage);return;}
    if(url.pathname.startsWith('/thumb/')){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18"><rect width="32" height="18" fill="#123"/></svg>');return;}
    if(url.pathname.startsWith('/assets/')){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/studio.css"><style>html,body{margin:0;height:100%}#root{height:100vh;display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="/fixture.js"></script>');
  });
  try{
    await build({entry:{fixture:path.resolve('tests/fixtures/studio-harness-entry.tsx')},outDir:directory,clean:false,format:'esm',platform:'browser',inputOptions:{platform:'browser'},deps:{alwaysBundle:[/.*/]},dts:false,sourcemap:false,logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:env.browserPath,headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}/?${query}`);
    await page.locator('.vs-stage').first().waitFor();
    await run(page);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
}
const calls=(page:Page)=>page.evaluate(()=>((window as any).harnessCalls as {endpoint:string;payload:any}[]).map(call=>call.endpoint));
const lastSave=(page:Page)=>page.evaluate(()=>((window as any).harnessCalls as {endpoint:string;payload:any}[]).filter(call=>call.endpoint==='save').at(-1)?.payload?.project);

test('regenerating an existing storyboard asks first and cancelling sends nothing',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    await page.getByRole('button',{name:'生成分镜',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'重新生成分镜？'});await dialog.waitFor();
    await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'detached'});
    assert.equal((await calls(page)).includes('generate'),false);
    await page.getByRole('button',{name:'生成分镜',exact:true}).click();
    await page.getByRole('dialog',{name:'重新生成分镜？'}).getByRole('button',{name:'重新生成',exact:true}).click();
    await page.waitForFunction(()=>(window as any).harnessCalls.some((call:any)=>call.endpoint==='generate'&&call.payload.kind==='storyboard'));
  });
});

test('deleting a shot offers undo, and the undo action reaches the project history',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=dark',async page=>{
    await page.locator('.vs-clip').nth(2).click();
    await page.locator('.vs-properties').getByRole('button',{name:'删除',exact:true}).click();
    const toast=page.locator('.vs-toast',{hasText:'已删除镜头「把落日带回家」'});await toast.waitFor();
    assert.equal(await page.locator('.vs-clip').count(),2);
    await toast.getByRole('button',{name:'撤销',exact:true}).click();
    await page.waitForFunction(()=>(window as any).harnessCalls.some((call:any)=>call.endpoint==='undo'));
    const endpoints=await calls(page);assert.ok(endpoints.lastIndexOf('save')<endpoints.lastIndexOf('undo'),'The deletion is saved before undo runs');
  });
});

test('deleting an asset requires confirmation and keeps it when cancelled',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    const row=page.locator('.vs-asset',{hasText:'清晨街景.jpg'});await row.hover();
    await row.getByRole('button',{name:'删除资产「清晨街景.jpg」'}).click();
    const dialog=page.getByRole('dialog',{name:'删除资产「清晨街景.jpg」？'});await dialog.waitFor();
    assert.match(await dialog.innerText(),/1 个镜头/);
    await dialog.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal(await page.locator('.vs-asset').count(),3);
  });
});

test('asset confirmation is confined to its workbench and closes on navigation',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light&surface=both',async page=>{
    const main=page.locator('[data-video-studio-surface="main"]');
    const right=page.locator('[data-video-studio-surface="right"]');
    const row=main.locator('.vs-asset',{hasText:'清晨街景.jpg'});
    await row.hover();
    await row.getByRole('button',{name:'删除资产「清晨街景.jpg」'}).click();
    const dialog=main.getByRole('dialog',{name:'删除资产「清晨街景.jpg」？'});
    await dialog.waitFor();
    assert.equal(await right.getByRole('dialog').count(),0);
    await page.evaluate(()=>void (window as any).harnessController.showProjects());
    await dialog.waitFor({state:'detached'});
    await page.evaluate(()=>void (window as any).harnessController.showStudio());
    await row.waitFor();
    assert.equal((await calls(page)).includes('save'),false);
  });
});

test('menu entries open the drawer panel and move focus to its tab',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    assert.equal(await page.locator('.vs-drawer-body').isVisible(),false);
    await page.getByRole('button',{name:'更多操作',exact:true}).click();
    await page.locator('.vs-menu').getByRole('button',{name:'运行环境'}).click();
    const tab=page.getByRole('tab',{name:'运行环境'});
    await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='tab');
    assert.equal(await tab.getAttribute('aria-selected'),'true');
    await page.locator('.vs-drawer-body').waitFor({state:'visible'});
    await page.getByText('本地渲染环境',{exact:true}).waitFor();
  });
});

test('space plays from a pointer-focused control and the timeline follows the monitor',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=dark',async page=>{
    await page.locator('.vs-clip').first().click();
    await page.waitForFunction(()=>!(document.querySelector('button[aria-label="播放"]') as HTMLButtonElement)?.disabled);
    await page.keyboard.press('Space');
    await page.getByRole('button',{name:'暂停',exact:true}).waitFor();
    await page.waitForFunction(()=>Number(document.querySelector('[data-testid="current-frame"]')?.textContent)>=3);
    await page.keyboard.press('Space');
    await page.getByRole('button',{name:'播放',exact:true}).waitFor();
    const transform=await page.locator('.vs-playhead').evaluate(element=>(element as HTMLElement).style.transform);
    assert.match(transform,/translateX\(\d/);
  });
});

test('two surfaces sharing a project controller keep their playback independent',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light&surface=both',async page=>{
    const main=page.locator('[data-video-studio-surface="main"]');
    const right=page.locator('[data-video-studio-surface="right"]');
    await page.waitForFunction(()=>[...document.querySelectorAll<HTMLButtonElement>('button[aria-label="播放"]')].filter(button=>!button.disabled).length===2);
    await main.getByRole('radio',{name:'分栏'}).click();
    const ruler=await main.locator('.vs-timeline-ruler').boundingBox();
    const clip=await main.locator('.vs-clip').first().boundingBox();
    assert.ok(ruler&&clip);
    await page.mouse.click(clip.x+clip.width/2,ruler.y+ruler.height/2);
    const mainFrame=await main.getByTestId('current-frame').textContent();
    assert.ok(Math.abs(Number(mainFrame)-48)<=1);
    assert.equal(await right.getByTestId('current-frame').textContent(),'0');

    await main.locator('.vs-graph-shell > canvas').focus();
    await page.keyboard.press('Space');
    await main.getByRole('button',{name:'暂停',exact:true}).waitFor();
    await right.getByRole('button',{name:'播放',exact:true}).waitFor();
    assert.equal(await right.getByTestId('current-frame').textContent(),'0');
  });
});

test('the minimap initializes and pans when the canvas view was already selected',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light&stageMode=canvas',async page=>{
    const minimap=page.locator('.vs-graph-minimap canvas');
    await minimap.waitFor();
    await page.waitForFunction(()=>{
      const canvas=document.querySelector<HTMLCanvasElement>('.vs-graph-minimap canvas');
      return !!canvas&&canvas.clientWidth>0&&canvas.width===Math.round(canvas.clientWidth*devicePixelRatio);
    });
    const original=await minimap.evaluate((element:HTMLCanvasElement)=>element.toDataURL());
    await minimap.click({position:{x:15,y:12}});
    assert.notEqual(await minimap.evaluate((element:HTMLCanvasElement)=>element.toDataURL()),original);
  });
});

test('the English header leaves the steps unobstructed and labels narrow controls',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light&locale=en',async page=>{
    const header=page.locator('.vs-header');
    assert.ok(await header.evaluate(element=>{
      const identity=element.querySelector('.vs-header-identity')!.getBoundingClientRect();
      const actions=element.querySelector('.vs-header-actions')!.getBoundingClientRect();
      return [...element.querySelectorAll('.vs-stepper button')].every(button=>{
        const step=button.getBoundingClientRect();
        return step.left>=identity.right&&step.right<=actions.left;
      });
    }));
    await page.setViewportSize({width:720,height:900});
    await page.locator('.vs-studio[data-layout=narrow]').waitFor();
    for(const name of ['Generate storyboard','Generate visuals','Export video','Storyboard','DeepSeek-V4.1-Flash']){
      await header.getByRole('button',{name,exact:true}).waitFor();
    }
  });
});

test('the timeline ruler and gaps seek using the actual clip positions',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    await page.waitForFunction(()=>!(document.querySelector('button[aria-label="播放"]') as HTMLButtonElement)?.disabled);
    const ruler=await page.locator('.vs-timeline-ruler').boundingBox();
    const first=await page.locator('.vs-clip').first().boundingBox();
    const second=await page.locator('.vs-clip').nth(1).boundingBox();
    assert.ok(ruler&&first&&second);
    await page.mouse.click(second.x+second.width/2,ruler.y+ruler.height/2);
    await page.waitForFunction(()=>Math.abs(Number(document.querySelector('[data-testid="current-frame"]')?.textContent)-144)<=1);
    await page.mouse.click((first.x+first.width+second.x)/2,second.y+second.height/2);
    await page.waitForFunction(()=>document.querySelector('[data-testid="current-frame"]')?.textContent==='96');

    await page.setViewportSize({width:390,height:900});
    await page.locator('.vs-studio[data-layout=narrow]').waitFor();
    const scroll=page.locator('.vs-timeline-scroll');
    await scroll.scrollIntoViewIfNeeded();
    assert.ok(await scroll.evaluate(element=>{element.scrollLeft=element.scrollWidth;return element.scrollLeft>0;}));
    const scrolledRuler=await scroll.locator('.vs-timeline-ruler').boundingBox();
    const third=await scroll.locator('.vs-clip').nth(2).boundingBox();
    assert.ok(scrolledRuler&&third);
    await page.mouse.click(third.x+third.width/2,scrolledRuler.y+scrolledRuler.height/2);
    await page.waitForFunction(()=>Math.abs(Number(document.querySelector('[data-testid="current-frame"]')?.textContent)-240)<=1);
  });
});

test('pointer reorder scrolls the timeline edge and releasing outside cancels',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light&shots=5',async page=>{
    await page.setViewportSize({width:440,height:900});
    const scroll=page.locator('.vs-timeline-scroll'),clips=scroll.locator('.vs-clip');
    await scroll.scrollIntoViewIfNeeded();
    const titles=await clips.locator('strong').allTextContents();
    const scroller=await scroll.boundingBox(),first=await clips.first().boundingBox();
    assert.ok(scroller&&first);
    const y=first.y+first.height/2;
    const start=async()=>{
      await scroll.evaluate(element=>{element.scrollLeft=0;});
      await page.mouse.move(first.x+first.width/2,y);
      await page.mouse.down();
      await page.mouse.move(scroller.x+scroller.width-6,y,{steps:8});
      await page.waitForFunction(()=>{
        const element=document.querySelector('.vs-timeline-scroll');
        return !!element&&element.scrollWidth>element.clientWidth&&element.scrollLeft>=element.scrollWidth-element.clientWidth-1;
      });
    };
    await start();
    await page.mouse.move(scroller.x+scroller.width-6,scroller.y-16);
    await page.mouse.up();
    await scroll.locator('.vs-drop-marker').waitFor({state:'detached'});
    assert.deepEqual(await clips.locator('strong').allTextContents(),titles);
    assert.equal((await calls(page)).filter(endpoint=>endpoint==='save').length,0);
    await start();
    await page.mouse.up();
    await page.waitForFunction(()=>((window as any).harnessCalls as {endpoint:string}[]).some(call=>call.endpoint==='save'));
    assert.deepEqual(await clips.locator('strong').allTextContents(),[...titles.slice(1),titles[0]]);
  });
});

test('asset kind filter falls back to all when the active category becomes empty',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    const filters=page.getByRole('group',{name:'按类型筛选'});
    await filters.getByRole('button',{name:/音频/}).click();
    assert.equal(await page.locator('.vs-asset').count(),1);
    const row=page.locator('.vs-asset',{hasText:'示例提示音'});
    await row.hover();
    await row.getByRole('button',{name:'删除资产「示例提示音（本地合成）」'}).click();
    await page.getByRole('dialog').getByRole('button',{name:'删除资产',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.vs-asset').length===2);
    assert.equal(await filters.getByRole('button',{name:/全部/}).getAttribute('aria-pressed'),'true');
  });
});

test('a narrow host right pane shows keyframes alongside the wide workbench',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=dark&locale=en&surface=split-host',async page=>{
    await page.setViewportSize({width:1720,height:900});
    const main=page.locator('[data-video-studio-surface="main"]'),right=page.locator('[data-video-studio-surface="right"]');
    await main.locator('.vs-studio[data-layout=wide]').waitFor();
    await right.locator('.vs-studio[data-layout=narrow]').waitFor();
    await right.locator('.vs-keyframe').first().waitFor();
    const widths=await right.evaluate(element=>{
      const workbench=element.querySelector('.vs-workbench')!;
      const keyframes=element.querySelector('.vs-keyframes')!;
      return {right:element.clientWidth,workbench:workbench.scrollWidth,keyframes:keyframes.clientWidth};
    });
    assert.equal(widths.right,440);
    assert.ok(widths.workbench<=widths.right&&widths.keyframes<=widths.right);
  });
});

test('the storyboard requests every shot thumbnail within the host batch limit at the saved preview revision',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light&shots=5&lagPreview=1',async page=>{
    const canvas=page.getByRole('radio',{name:'分镜画布'});
    const lastThumb=page.waitForResponse(response=>response.url().endsWith('/thumb/431.svg')&&response.ok());
    await canvas.click();
    const hasStoryboardBatches=(revision:number)=>page.waitForFunction(expected=>{
      const calls=(window as any).harnessCalls.filter((call:any)=>call.endpoint==='thumbnails'&&call.payload.expectedRevision===expected);
      return calls.some((call:any)=>call.payload.frames.join(',')==='47,143,239')&&calls.some((call:any)=>call.payload.frames.join(',')==='335,431');
    },revision);
    await hasStoryboardBatches(4);
    await lastThumb;

    await page.locator('.vs-clip').first().click();
    await page.getByLabel('镜头标题',{exact:true}).fill('修改后重新生成缩略图');
    await hasStoryboardBatches(5);
    const relevant=await page.evaluate(()=>((window as any).harnessCalls as {endpoint:string;payload:{expectedRevision:number;frames?:number[]}}[])
      .filter(call=>call.endpoint==='preview'||call.endpoint==='thumbnails'));
    const previewIndex=relevant.findIndex(call=>call.endpoint==='preview'&&call.payload.expectedRevision===5);
    const storyboardCalls=relevant.filter(call=>call.endpoint==='thumbnails'&&[47,335].includes(call.payload.frames![0]!));
    assert.ok(previewIndex>=0);
    assert.ok(storyboardCalls.every(call=>call.payload.frames!.length<=3));
    assert.ok(storyboardCalls.filter(call=>call.payload.expectedRevision===5).every(call=>relevant.indexOf(call)>previewIndex));
    assert.equal(relevant.slice(relevant.findIndex(call=>call.payload.expectedRevision===5)).some(call=>
      call.endpoint==='thumbnails'&&call.payload.expectedRevision===4&&[47,335].includes(call.payload.frames![0]!)),false);
  });
});

test('duration drafts can be cleared, cancelled on Escape, and committed on Enter',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    await page.locator('.vs-clip').first().click();
    const input=page.getByLabel('时长（秒）',{exact:true});
    await input.fill('');assert.equal(await input.inputValue(),'');
    await input.blur();assert.equal(await input.inputValue(),'4');
    await input.fill('3');await input.press('Escape');assert.equal(await input.inputValue(),'4');
    assert.equal(await page.evaluate(()=>Boolean((window as any).harnessController.getSnapshot().dirty)),false);
    await input.fill('0.');assert.notEqual(await input.inputValue(),'4','An in-progress draft never snaps back while typing');
    await input.fill('2.5');await input.press('Enter');
    await page.waitForFunction(()=>(window as any).harnessCalls.some((call:any)=>call.endpoint==='save'&&call.payload.project.shots.some((shot:any)=>shot.durationFrames===60)));
    assert.ok((await lastSave(page)).shots.some((shot:{durationFrames:number})=>shot.durationFrames===60));
  });
});

test('a mutating action locks the property form visibly instead of dropping keystrokes',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    await page.locator('.vs-clip').first().click();
    await page.evaluate(()=>{(window as any).harnessDelay={undo:1500};void (window as any).harnessController.action('undo');});
    await page.locator('.vs-lock-veil.is-on').waitFor();
    assert.equal(await page.getByLabel('镜头标题',{exact:true}).isDisabled(),true);
    await page.locator('.vs-lock-veil.is-on').waitFor({state:'detached',timeout:5000}).catch(()=>{});
    await page.waitForFunction(()=>!(document.querySelector('.vs-property-scroll') as HTMLFieldSetElement)?.disabled);
  });
});

test('edits rebuild an outdated preview after ~1.2s without setting global pending or dropping concurrent typing',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light&lagPreview=1',async page=>{
    await page.locator('.vs-clip').first().click();
    await page.evaluate(()=>{
      (window as any).harnessDelay={preview:500};
      (window as any).sawPending=false;
      (window as any).harnessController.subscribe(()=>{if((window as any).harnessController.getSnapshot().pending)(window as any).sawPending=true;});
    });
    const title=page.getByLabel('镜头标题',{exact:true});
    await title.fill('清晨第一缕光');
    await page.waitForFunction(()=>(window as any).harnessCalls.some((call:any)=>call.endpoint==='save'));
    assert.equal((await calls(page)).includes('preview'),false,'Auto-preview waits for the 1.2s debounce after save');
    await page.waitForFunction(()=>(window as any).harnessController.getSnapshot().previewing===true,{timeout:5000});
    assert.equal(await title.isDisabled(),false,'Preview preparation never locks property inputs');
    await title.fill('清晨街巷');
    await page.waitForFunction(()=>(window as any).harnessCalls.some((call:any)=>call.endpoint==='save'&&call.payload.project.shots[0].title==='清晨街巷'));
    assert.equal(await page.evaluate(()=>Boolean((window as any).sawPending)),false,'Preview refresh never sets global pending');
    await page.waitForFunction(()=>(window as any).harnessController.getSnapshot().snapshot?.previewRevision===(window as any).harnessController.getSnapshot().snapshot?.project?.revision,{timeout:5000});
  });
});

test('stepper reflects project data and asset search ignores letter case',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    assert.equal(await page.locator('.vs-stepper li.is-done').count(),3);
    assert.equal(await page.locator('.vs-stepper li').nth(3).getAttribute('class'),'is-current');
    await page.getByLabel('搜索资产',{exact:true}).fill('JPG');
    assert.equal(await page.locator('.vs-asset').count(),1);
    assert.match(await page.locator('.vs-asset').innerText(),/清晨街景\.jpg/);
    await page.getByRole('radio',{name:'分镜画布'}).click();
    assert.equal(await page.locator('.vs-stage-canvas').isVisible(),true);
    assert.equal(await page.locator('.vs-stage-monitor').isVisible(),false);
  });
});

/** Mounts only the graph editor, like tests/localization-ui.test.ts, to drive keyboard deletion on the canvas. */
test('Delete on an asset node detaches it from shots without deleting the asset',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  const directory=path.resolve('artifacts/graph-delete-'+randomUUID());await fs.mkdir(directory,{recursive:true});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const server=createServer(async(req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(directory,'fixture.js')));return;}res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><div class="vs-studio" data-scheme="light"><div style="width:900px;height:500px"><canvas></canvas></div></div><script type="module" src="/fixture.js"></script>');});
  try{
    const project=createCodeProject('画布删除');project.assets=[{id:'note',kind:'text',name:'旁白',description:'',text:'文字'},{id:'image',kind:'image',name:'图片',description:'',path:'assets/image.png'}];
    for(const shot of project.shots)shot.assetIds=['note'];
    const entry=path.join(directory,'fixture.ts');
    await fs.writeFile(entry,`import {LiteGraphEditor} from ${JSON.stringify(path.resolve('src/client/graph-adapter.ts'))};
      const project=${JSON.stringify(project)};window.changes=[];window.removals=[];
      const editor=new LiteGraphEditor(document.querySelector('canvas'),next=>window.changes.push(next),()=>{},()=>{},removal=>window.removals.push(removal));
      editor.setProject(project,()=>'');
      editor.view.selectNode(editor.nodes.get('note'));
      const shotId=project.shots[0].id;
      editor.view.selectNode(editor.nodes.get(shotId),true);
      editor.setSelected(shotId);
      window.selectedAfterEcho=editor.selectedIds();
      const next=structuredClone(project);
      next.shots[0].title='Updated';
      editor.setProject(next,()=>'');
      window.selectedAfterRebuild=editor.selectedIds();
      editor.view.selectNode(editor.nodes.get('note'));
      editor.setInteractive(false);
      window.unlock=()=>editor.setInteractive(true);
      window.select=(id)=>editor.view.selectNode(editor.nodes.get(id));
      document.querySelector('canvas').focus();window.ready=true;`);
    await build({entry:{fixture:entry},outDir:directory,clean:false,format:'esm',platform:'browser',inputOptions:{platform:'browser'},deps:{alwaysBundle:[/.*/]},dts:false,sourcemap:false,logLevel:'silent'});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:env.browserPath,headless:true});const page=await browser.newPage();
    await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);await page.waitForFunction(()=>(window as any).ready);
    const selections=await page.evaluate(()=>({
      afterEcho:(window as any).selectedAfterEcho,
      afterRebuild:(window as any).selectedAfterRebuild,
    }));
    const selected=['note',project.shots[0]!.id].sort();
    assert.deepEqual(selections.afterEcho.sort(),selected);
    assert.deepEqual(selections.afterRebuild.sort(),selected);
    await page.keyboard.press('Delete');
    assert.equal(await page.evaluate(()=>(window as any).changes.length),0,'Locked canvas ignores Delete');
    await page.evaluate(()=>(window as any).unlock());
    await page.keyboard.press('Delete');
    await page.waitForFunction(()=>(window as any).changes.length>0);
    const result=await page.evaluate(()=>({next:(window as any).changes.at(-1),removals:(window as any).removals}));
    assert.equal(result.next.assets.length,2,'The asset itself stays in the library');
    assert.ok(result.next.shots.every((shot:{assetIds:string[]})=>!shot.assetIds.includes('note')));
    assert.deepEqual(result.removals,[{shots:[],assets:[{name:'旁白',links:3}]}]);
    await page.evaluate(()=>{(window as any).changes.length=0;(window as any).select('image');});
    await page.keyboard.press('Control+c');await page.keyboard.press('Control+v');
    assert.equal(await page.evaluate(()=>(window as any).changes.length),0,'Binary assets cannot be copied into an ordinary project save');
    await page.evaluate(()=>(window as any).select('note'));
    await page.keyboard.press('Control+c');await page.keyboard.press('Control+v');
    await page.waitForFunction(()=>(window as any).changes.length===1);
    assert.equal(await page.evaluate(()=>(window as any).changes[0].assets.at(-1).text),'文字');
  }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
});
