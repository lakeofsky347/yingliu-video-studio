// Offline agent-loop fixture. It emits actual tool calls through the official DSH runtime.
// This file is excluded from the production package and makes no network requests.
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {randomUUID} from 'node:crypto';
import {appendFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
const sessions=new Map();
export const inject=['llm'];
function objects(value,found=[]){
  if(value===null||typeof value!=='object')return found;
  if(value.kind==='video-studio'&&typeof value.projectId==='string')found.push(value);
  if(typeof value.text==='string'){
    for(const text of [value.text,...value.text.split('\n')])try{objects(JSON.parse(text),found);}catch{}
  }
  for(const item of Array.isArray(value)?value:Object.values(value))if(item&&typeof item==='object')objects(item,found);
  return found;
}
function command(messages){for(const message of [...messages].reverse())for(const block of message.content??[]){const match=block.type==='text'&&block.text?.match(/\[VS_SESSION:([A-Z_]+)\]/);if(match)return {key:match[1],message};}return null;}
function source(){return {html:'<div class="session-title"></div><div class="session-picture"></div>',css:'.session-title{position:absolute;left:8%;top:12%;font-family:system-ui,sans-serif;max-width:84%;line-height:1.25}.session-picture{position:absolute;left:60%;top:32%;width:30%;height:58%;background-size:contain;background-position:center;background-repeat:no-repeat}',js:'export function render(ctx){const title=ctx.root.querySelector(".session-title");title.textContent=ctx.params.text;title.style.color=ctx.params.foreground;title.style.fontSize=(ctx.width*0.055)+"px";title.style.transform="translateY("+((1-Math.min(1,ctx.progress*5))*25)+"px)";title.style.opacity=String(Math.min(1,ctx.progress*5));ctx.root.style.background=ctx.params.background;const image=ctx.assets.find(a=>a.kind==="image");ctx.root.querySelector(".session-picture").style.backgroundImage=image?"url(\\""+image.url+"\\")":"none";}'};}
async function log(value){const file=process.env.DSH_VIDEO_SESSION_LOG;if(!file)return;await mkdir(dirname(file),{recursive:true});await appendFile(file,JSON.stringify({...value,realProvider:false})+'\n');}
class SessionVideoAdapter extends LlmAdapter {
  providerInfo(id){return {id,name:'会话闭环验收 · 离线工具模型'};}
  async listModels(provider){return [{provider,id:'offline-session-video',name:'离线 Session 工具验收（模拟）',inputModalities:['text','image']}];}
  async *stream(options){
    const request=command(options.messages),receipts=objects(options.messages),latest=receipts.at(-1);
    if(!request){yield {type:'text-delta',index:0,text:'映流会话验收'};yield {type:'finish',reason:{kind:'stop'}};return;}
    let state=sessions.get(options.sessionId);if(!state||state.command!==request.key){state={command:request.key,step:0};sessions.set(options.sessionId,state);}
    const step=state.step++,key=request.key;let name,args;
    const full=[...receipts].reverse().find(value=>Array.isArray(value.shots));
    const running=[...receipts].reverse().find(value=>typeof value.jobId==='string');
    if(key==='CREATE_A'||key==='CREATE_B'){
      if(step===0){name='video_project';args={action:'create',title:key==='CREATE_A'?'会话影片 A':'会话影片 B',topic:'在已有对话中制作并检查图文影片',targetDuration:2,target:{width:640,height:360,fps:{num:12,den:1},quality:'small'}};}
      if(step===1){name='video_update';args={projectId:latest.projectId,expectedRevision:latest.revision,imports:(request.message.content??[]).filter(b=>b.type==='image').map(b=>({attachment:b.attachment})),update:{storyboard:{shots:[{title:'第一镜',intent:'进入主题',composition:'图文分栏',action:'文字上移入场',durationSeconds:1,assetIds:[],params:{text:key+' · 镜头一'}},{title:'第二镜',intent:'展示可编辑结果',composition:'大字居中',action:'按帧淡入',durationSeconds:1,assetIds:[],params:{text:'会话生成 · 镜头二'}}]}}};}
      if(step===2){name='video_update';args={projectId:full.projectId,expectedRevision:full.revision,update:{shotPatches:full.shots.map((shot,index)=>({id:shot.id,patch:{assetIds:index===0&&full.assets[0]?[full.assets[0].id]:[]}})),sources:full.shots.map(shot=>({shotId:shot.id,source:source()}))}};}
      if(step===3){name='video_inspect';args={projectId:full.projectId,shotId:full.shots[0].id,frame:3,includeSource:true};}
      if(step===4){name='video_render';args={projectId:full.projectId,action:'export'};}
      if(step===5){name='job_output';args={job_id:running.jobId,wait:true,timeout_ms:60000};}
    }else if(key==='READ_MANUAL'){
      if(step===0){name='video_project';args={action:'get'};}
      if(step===1){name='video_update';args={projectId:full.projectId,expectedRevision:full.revision,update:{shotPatches:[{id:full.shots[1].id,patch:{params:{...full.shots[1].params,subtitle:'模型读取到：'+full.shots[1].params.text}}}]}};}
    }else if(key==='AUDIO'){
      if(step===0){name='video_project';args={action:'get'};}
      if(step===1){name='video_audio';args={projectId:full.projectId,expectedRevision:full.revision,action:'import',path:process.env.DSH_VIDEO_SESSION_AUDIO,name:'会话音效.wav',request:{role:'sfx',volume:0.25,startSeconds:0}};}
      if(step===2){name='video_render';args={projectId:full.projectId,action:'export'};}
      if(step===3){name='job_output';args={job_id:running.jobId,wait:true,timeout_ms:60000};}
    }else if(key==='CANCEL'){
      if(step===0){name='video_project';args={action:'get'};}
      if(step===1){name='video_update';args={projectId:full.projectId,expectedRevision:full.revision,update:{target:{width:1920,height:1080,fps:{num:30,den:1}},targetDuration:10,shotPatches:full.shots.map(s=>({id:s.id,patch:{durationFrames:150}}))}};}
      if(step===2){name='video_render';args={projectId:full.projectId,action:'export'};}
      if(step===3){name='job_kill';args={job_id:running.jobId};}
      if(step===4){name='job_output';args={job_id:running.jobId,wait:true,timeout_ms:60000};}
    }
    await log({sessionId:options.sessionId,command:key,step,tool:name??null,names:(options.tools??[]).map(tool=>tool.name),videoSdkVisible:options.system?.includes('video_project')??false,projectId:full?.projectId,readText:key==='READ_MANUAL'?full?.shots?.[1]?.params?.text:undefined});
    if(name){
      const native=(options.tools??[]).some(tool=>tool.name===name),toolName=native?name:'run_code';
      const toolArgs=native?args:{code:`const value = await tools.${name}(${JSON.stringify(args)}); text(value);`,description:`离线验收：${name}`};
      yield {type:'tool-call-delta',index:0,id:'vs-test-'+randomUUID(),name:toolName,argumentsDelta:JSON.stringify(toolArgs)};
      yield {type:'finish',reason:{kind:'tool-calls'}};
    }else{yield {type:'text-delta',index:0,text:`[VS_DONE:${key}] 离线模型已完成实际工具调用。`};yield {type:'finish',reason:{kind:'stop'}};}
  }
}
export function apply(ctx){ctx.llm.registerAdapter(['video-studio-session-offline'],new SessionVideoAdapter());}
