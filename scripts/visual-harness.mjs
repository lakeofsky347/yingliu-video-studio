// Development-only: render the real Studio against an in-memory API and capture screenshots.
// Usage: node scripts/visual-harness.mjs [label] [--only=studio-1440-light,...]
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {build} from 'tsdown';
import {chromium} from 'playwright-core';

const root=path.resolve(import.meta.dirname,'..');
const label=process.argv.slice(2).find(arg=>!arg.startsWith('--'))||'current';
const only=(process.argv.find(arg=>arg.startsWith('--only='))||'').slice(7).split(',').filter(Boolean);
const outDir=path.join(root,'.local/visual-redesign',label);
const buildDir=path.join(root,'.local/visual-redesign/.build');
await fs.mkdir(outDir,{recursive:true});await fs.mkdir(buildDir,{recursive:true});
await build({entry:{fixture:path.join(root,'tests/fixtures/studio-harness-entry.tsx')},outDir:buildDir,clean:false,format:'esm',platform:'browser',inputOptions:{platform:'browser'},deps:{alwaysBundle:[/.*/]},dts:false,sourcemap:false,logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});

const titles=['在清晨出发','街角的一杯咖啡','把落日带回家'];
const palettes=[['#0f3b3a','#1f6f63','#f2c46d'],['#3a2a1f','#8a5a3b','#f4dcb0'],['#2b1d3a','#c26a4a','#ffd08a']];
const framePage=`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:-apple-system,'PingFang SC',sans-serif}
#s{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 9%;color:#fff;transition:none}
#s small{letter-spacing:.3em;opacity:.75;font-size:2.2vw}#s h1{font-size:7vw;margin:.25em 0;font-weight:700}#s p{font-size:2.6vw;opacity:.9;margin:0}
#sun{position:absolute;right:16%;top:16%;width:11vw;height:11vw;border-radius:50%}#ground{position:absolute;left:0;right:0;bottom:0;height:22%;opacity:.55}</style>
<div id="s"><div id="sun"></div><div id="ground"></div><small id="k"></small><h1 id="t"></h1><p id="p"></p></div>
<script>const titles=${JSON.stringify(titles)},pal=${JSON.stringify(palettes)};
function draw(frame){const i=Math.min(2,Math.floor(frame/96)),l=(frame%96)/96,c=pal[i];
document.getElementById('s').style.background='linear-gradient(135deg,'+c[0]+','+c[1]+')';
const sun=document.getElementById('sun');sun.style.background=c[2];sun.style.transform='translateY('+(l*20)+'px)';
document.getElementById('ground').style.background='linear-gradient(transparent,'+c[0]+')';
document.getElementById('k').textContent='城市漫步 · 镜头 0'+(i+1);document.getElementById('t').textContent=titles[i];
document.getElementById('t').style.transform='translateX('+((1-Math.min(1,l*3))*-40)+'px)';document.getElementById('t').style.opacity=Math.min(1,l*3);
document.getElementById('p').textContent=['沿熟悉的街道，发现新的风景。','留一点时间，听城市的日常。','走到河畔，让今天慢慢收尾。'][i];return 'shot-'+i;}
draw(0);addEventListener('message',e=>{if(e.data&&e.data.type==='video-studio/render'){const id=draw(e.data.frame);parent.postMessage({type:'video-studio/frame',frame:e.data.frame,sceneId:id},'*');}});
parent.postMessage({type:'video-studio/ready'},'*');</script>`;
const thumb=frame=>{const i=Math.min(2,Math.floor(frame/96)),c=palettes[i];return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="250" cy="50" r="20" fill="${c[2]}"/><text x="28" y="100" font-size="26" font-family="PingFang SC,sans-serif" font-weight="700" fill="#fff">${titles[i]}</text></svg>`;};
const street=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6d6a8"/><stop offset="1" stop-color="#5b7c8a"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/><g fill="#2c3e48">${Array.from({length:14},(_,i)=>`<rect x="${i*118}" y="${380+((i*53)%220)}" width="96" height="900"/>`).join('')}</g></svg>`;

const server=createServer(async(req,res)=>{
  const url=new URL(req.url||'/','http://x');
  if(url.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(buildDir,'fixture.js')));return;}
  if(url.pathname==='/studio.css'){res.setHeader('Content-Type','text/css');res.end(await fs.readFile(path.join(root,'src/client/styles.css')));return;}
  if(url.pathname.startsWith('/frame')){res.setHeader('Content-Type','text/html');res.end(framePage);return;}
  if(url.pathname.startsWith('/thumb/')){res.setHeader('Content-Type','image/svg+xml');res.end(thumb(Number(url.pathname.slice(7).replace('.svg',''))||0));return;}
  if(url.pathname==='/assets/street.svg'){res.setHeader('Content-Type','image/svg+xml');res.end(street);return;}
  if(url.pathname.startsWith('/assets/')){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/studio.css"><style>html,body{margin:0;height:100%}body{background:#888}#root{height:100vh;display:flex;flex-direction:column}</style><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const executablePath=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser=await chromium.launch({executablePath,headless:true});
const matrix=[];
for(const scheme of ['light','dark']){
  matrix.push({name:`home-1440-${scheme}`,width:1440,height:900,query:`view=home&scheme=${scheme}`});
  matrix.push({name:`studio-1440-${scheme}`,width:1440,height:900,query:`scheme=${scheme}`});
  matrix.push({name:`studio-1024-${scheme}`,width:1024,height:768,query:`scheme=${scheme}&surface=conversation`});
  matrix.push({name:`studio-720-${scheme}`,width:720,height:900,query:`scheme=${scheme}&surface=right`});
  matrix.push({name:`studio-main-and-right-${scheme}`,width:1720,height:900,query:`scheme=${scheme}&surface=split-host`});
}
matrix.push({name:'studio-1440-light-running',width:1440,height:900,query:'scheme=light&task=running'});
matrix.push({name:'studio-1440-en',width:1440,height:900,query:'scheme=light&locale=en'});
matrix.push({name:'studio-main-and-right-en',width:1720,height:900,query:'scheme=dark&locale=en&surface=split-host'});
// Interaction states: each step runs in the page before the screenshot.
const click=selector=>async page=>{await page.locator(selector).first().click();await page.waitForTimeout(450);};
const role=(name)=>async page=>{await page.getByRole('button',{name,exact:true}).first().click();await page.waitForTimeout(450);};
matrix.push({name:'state-canvas-dark',width:1440,height:900,query:'scheme=dark',steps:[async page=>{await page.getByRole('radio',{name:'分镜画布'}).click();await page.waitForTimeout(700);}]});
matrix.push({name:'state-split-light',width:1440,height:900,query:'scheme=light',steps:[async page=>{await page.getByRole('radio',{name:'分栏'}).click();await page.waitForTimeout(700);},click('.vs-clip >> nth=1')]});
matrix.push({name:'state-drawer-light',width:1440,height:900,query:'scheme=light',steps:[click('.vs-clip >> nth=0'),async page=>{await page.getByRole('tab',{name:'修改历史'}).click();await page.waitForTimeout(600);}]});
matrix.push({name:'state-word-dark',width:1440,height:900,query:'scheme=dark',steps:[click('.vs-clip >> nth=0'),click('.vs-word-trigger')]});
matrix.push({name:'state-confirm-light',width:1440,height:900,query:'scheme=light',steps:[role('生成分镜')]});
matrix.push({name:'state-delete-toast-dark',width:1440,height:900,query:'scheme=dark',steps:[click('.vs-clip >> nth=2'),async page=>{await page.getByRole('button',{name:'删除',exact:true}).click();await page.waitForTimeout(700);}]});
matrix.push({name:'state-menu-light',width:1440,height:900,query:'scheme=light',steps:[async page=>{await page.getByRole('button',{name:'更多操作',exact:true}).click();await page.waitForTimeout(400);}]});
matrix.push({name:'state-create-light',width:1440,height:900,query:'view=home&scheme=light',steps:[async page=>{await page.locator('.vs-home-hero .vs-primary').click();await page.waitForTimeout(500);}]});
const tab=name=>async page=>{await page.getByRole('tab',{name,exact:true}).first().click();await page.waitForTimeout(450);};
matrix.push({name:'state-review-light',width:1440,height:900,query:'scheme=light',steps:[tab('历史成片'),role('生成五帧宫格')]});
matrix.push({name:'state-audio-dark',width:1440,height:900,query:'scheme=dark',steps:[tab('声音与配音')]});
matrix.push({name:'state-previz-light',width:1440,height:900,query:'scheme=light&previz=1',steps:[tab('白模预演')]});
matrix.push({name:'state-previz-right-en',width:440,height:900,query:'scheme=dark&surface=right&locale=en&previz=1',steps:[tab('Work panels'),tab('Whitebox previsualization'),async page=>{await page.locator('.vs-previz-result').scrollIntoViewIfNeeded();}]});
matrix.push({name:'state-media-dark',width:1440,height:900,query:'scheme=dark',steps:[tab('模型与素材生成'),async page=>{await page.getByLabel('媒体生成方式').selectOption('first-last-frame-video');}]});
matrix.push({name:'state-import-light',width:1440,height:900,query:'view=home&scheme=light',steps:[role('导入工程包')]});
const errors=[];
try{
  for(const item of matrix){
    if(only.length&&!only.includes(item.name))continue;
    const page=await browser.newPage({viewport:{width:item.width,height:item.height},deviceScaleFactor:2});
    page.on('pageerror',error=>errors.push(`${item.name}: ${error.message}`));
    page.on('console',message=>{if(message.type()==='error')errors.push(`${item.name}: ${message.text()}`);});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto(`http://127.0.0.1:${port}/?${item.query}`);
    await page.waitForSelector('.vs-studio');
    await page.waitForTimeout(1500);
    for(const step of item.steps||[])await step(page);
    await page.screenshot({path:path.join(outDir,`${item.name}.png`),fullPage:true});
    await page.close();
  }
}finally{await browser.close();server.close();}
console.log(`Screenshots: ${outDir}`);
if(errors.length){console.log('Page errors:\n'+errors.join('\n'));}
