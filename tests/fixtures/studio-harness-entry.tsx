import { createRoot } from 'react-dom/client';
import { Studio } from '../../src/client/Studio.tsx';
import { StudioController } from '../../src/client/controller.ts';
import { addShot, createProject } from '../../src/core/index.ts';
import { setLocale } from '../../src/client/i18n.ts';
import type { StudioApi, StudioSnapshot, VideoProject } from '../../src/shared/types.ts';

const params=new URLSearchParams(location.search);
const scheme=(params.get('scheme')==='dark'?'dark':'light') as 'light'|'dark';
const view=params.get('view')||'studio';
const surface=params.get('surface')||'main';
const lagPreview=params.get('lagPreview')==='1';
const hasPreviz=params.get('previz')==='1';
setLocale(params.get('locale')||'zh');

function demoProject():VideoProject{
  let project=createProject('城市漫步 · 影片示例','12 秒城市漫步短片。清晨街道、街角咖啡、河畔落日，三个镜头各 4 秒。中文文案，平缓节奏，青绿与暖金配色。','code_animation');
  project.id='demo-city-walk';
  project.target={width:1280,height:720,fps:{num:24,den:1},audioMode:'mixed',quality:'standard'};
  project.targetDuration=12;
  const copy=[
    ['在清晨出发','沿熟悉的街道，发现新的风景。','左侧标题与说明，右侧城市剪影','标题从左侧滑入'],
    ['街角的一杯咖啡','留一点时间，听城市的日常。','咖啡杯特写，蒸汽缓慢上升','镜头缓慢推近'],
    ['把落日带回家','走到河畔，让今天慢慢收尾。','河面反光与远处桥梁','色调由暖转冷'],
  ];
  project.shots.forEach((shot,i)=>{const [title,subtitle,composition,action]=copy[i]!;shot.title=title;shot.params={...shot.params,text:title,subtitle};shot.intent=subtitle;shot.composition=composition;shot.action=action;shot.durationFrames=96;});
  if(params.get('shots')==='5'){
    project=addShot(addShot(project));
    project.shots.forEach(shot=>{shot.durationFrames=96;});
    project.targetDuration=20;
  }
  project.assets=[
    {id:'brief',kind:'text',name:'城市漫步 · 创作简报',description:'影片简报',text:project.topic},
    {id:'tone',kind:'audio',name:'示例提示音（本地合成）',description:'文档演示用提示音',duration:2,path:'assets/tone.wav'},
    {id:'street',kind:'image',name:'清晨街景.jpg',description:'街道参考',width:1600,height:900,path:'assets/street.svg'},
  ];
  project.shots.forEach(shot=>{shot.assetIds=['brief'];});
  project.shots[0]!.referenceIds=['street'];
  project.revision=4;
  project.outputs=[];
  return project;
}

const origin=location.origin;
let project=demoProject();
let previewRevision:number|null=project.revision;
let previzApprovedAt:string|undefined;
function samplePreviz(shotId:string){
  const scope={shotId,documentHash:'a'.repeat(64),documentVersion:2};
  const record={...scope,id:'fixture-previz',projectId:project.id,imageAssetId:'street',mediaHashes:[],
    width:640,height:360,fps:12,frameCount:1,renderedAt:'2026-11-27T04:00:00Z',approvedAt:previzApprovedAt};
  return {scope,record,rendering:false};
}
const history={canUndo:true,canRedo:false,cursor:3,entries:[
  {id:'h1',label:'创建工程',createdAt:new Date(Date.now()-3600e3).toISOString(),revision:1},
  {id:'h2',label:'生成分镜',createdAt:new Date(Date.now()-1800e3).toISOString(),revision:2},
  {id:'h3',label:'生成画面',createdAt:new Date(Date.now()-900e3).toISOString(),revision:3},
  {id:'h4',label:'编辑工程',createdAt:new Date(Date.now()-60e3).toISOString(),revision:4},
]};
const calls:{endpoint:string;payload:unknown}[]=[];
(window as any).harnessCalls=calls;
function snapshot():StudioSnapshot{
  return structuredClone({
    project,root:'/Users/demo/影片/城市漫步',
    task:params.get('task')==='running'?{id:'t2',kind:'scenes',status:'running',progress:.46,message:'正在生成镜头 2 / 3 的画面',startedAt:new Date().toISOString()}:{id:'t1',kind:'scenes',status:'complete',progress:1,message:'已完成',startedAt:new Date(Date.now()-60e3).toISOString(),finishedAt:new Date().toISOString()},
    previewUrl:origin+'/frame/',previewRevision,assetBaseUrl:origin+'/',audioUrl:null,
    providers:[{id:'deepseek',name:'DeepSeek',models:[{id:'deepseek-v4-flash',name:'DeepSeek-V4.1-Flash'},{id:'deepseek-v4',name:'DeepSeek-V4.1'}]}],
    environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:true,ffmpegAvailable:true,ffprobeAvailable:true,blenderAvailable:hasPreviz},
    recent:[],history,
  } as StudioSnapshot);
}
const projects=[
  {id:'demo-city-walk',path:'/Users/demo/影片/城市漫步',title:'城市漫步 · 影片示例',updatedAt:new Date(Date.now()-60e3).toISOString()},
  {id:'demo-product',path:'/Users/demo/影片/新品发布',title:'新品发布 30 秒',updatedAt:new Date(Date.now()-86400e3).toISOString()},
  {id:'demo-travel',path:'/Users/demo/影片/海岛旅行',title:'海岛旅行 Vlog 片头',updatedAt:new Date(Date.now()-5*86400e3).toISOString()},
];
const api:StudioApi={async call<T>(endpoint:string,payload:any={}):Promise<T>{
  calls.push({endpoint,payload});
  await new Promise(resolve=>setTimeout(resolve,(window as any).harnessDelay?.[endpoint]??(endpoint==='save'?60:20)));
  switch(endpoint){
    case 'catalog':case 'current':case 'focus':case 'open':return snapshot() as T;
    case 'history':return structuredClone(history) as T;
    case 'list':return {projects,bindings:{}} as T;
    case 'styles.list':return {styles:[]} as T;
    case 'quality.last':return null as T;
    case 'media.list':return {tasks:[]} as T;
    case 'models.list':return {version:1,connections:[],models:[],roles:[]} as T;
    case 'previz.get':return (hasPreviz?samplePreviz(payload.shotId):{scope:null,record:null,rendering:false}) as T;
    case 'previz.approve':{
      previzApprovedAt='2026-11-27T04:00:01Z';
      project={...project,revision:project.revision+1};previewRevision=project.revision;
      return samplePreviz(payload.shotId).record as T;
    }
    case 'review.frames':return {revision:project.revision,frames:[0,24,48,72,95].map(frame=>({frame,shotId:project.shotOrder[0],url:`${origin}/thumb/${frame}.svg`}))} as T;
    case 'save':project={...payload.project,revision:project.revision+1};if(!lagPreview&&!(window as any).harnessLagPreview)previewRevision=project.revision;return snapshot() as T;
    case 'preview':previewRevision=project.revision;return snapshot() as T;
    case 'undo':case 'redo':case 'export':case 'generate':return snapshot() as T;
    case 'thumbnails':{
      const frames=payload.frames as number[];
      if(payload.expectedRevision!==project.revision||frames.length<1||frames.length>3)throw new Error('Thumbnail request does not match the host contract');
      return {frames:frames.map(frame=>({frame,url:`${origin}/thumb/${frame}.svg`}))} as T;
    }
    default:return {} as T;
  }
}};
const controller=new StudioController(api);
controller.setScheme(scheme);
(window as any).harnessController=controller;
await controller.load();
if(view==='studio')controller.showStudio();
document.documentElement.dataset.scheme=scheme;
const root=document.getElementById('root')!;
root.className='vs-embedded-surface';
root.dataset.videoStudioSurface=surface;
const stageMode=params.get('stageMode');
if(stageMode==='canvas'||stageMode==='split')localStorage.setItem('vs-stage-mode',JSON.stringify(stageMode));
const sideBySide=surface==='split-host';
if(sideBySide)root.style.flexDirection='row';
createRoot(root).render(surface==='both'||sideBySide?<>
  {['main','right'].map(target=><div key={target} className="vs-embedded-surface" data-video-studio-surface={target} style={sideBySide?{flex:target==='right'?'0 0 min(44%, 440px)':'1 1 0',height:'100%'}:{height:'50%',flex:'0 0 50%'}}>
    <Studio controller={controller} sessions={[]}/>
  </div>)}
</>:<Studio controller={controller} sessions={[]}/>);
