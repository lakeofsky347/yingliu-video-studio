import type {HostContext} from './platform.ts';
import {ProjectHub} from './project-hub.ts';
import {registerSessionTools} from './session-tools.ts';
import {clientRequestSchema} from '@deepseek-ai/dsh-client-connection';
import {assertHostContract} from '../shared/host-contract.ts';
export const name='video-studio';
export const inject=['connection','llm','tools','jobs','attachments','sessionController'];
export function apply(ctx:HostContext,config:{baseDirectory?:string}={}):void{
  assertHostContract(ctx);
  const service=new ProjectHub(ctx,config);
  ctx.effect(()=>()=>service.dispose(),'video-studio lifetime');
  registerSessionTools(ctx,service);
  for(const endpoint of ['catalog','current','create','open','save','import','source','saveSource','restoreSource','preview','generate','export','cancel','environment','reveal','apply','inspect','list','bind','bindSession','unbindSession','focus','audio','tts','rename','duplicate','archive','restore','history','undo','redo','tasks','jobs','retry','job.retry','styles.list','styles.save','styles.delete',
    'models.list','models.connection.save','models.connection.remove','models.model.save','models.model.remove','models.role.bind','models.check',
    'media.generate','media.list','media.get','media.cancel','media.pause','media.retry','media.apply','video.clip.save','video.clip.remove','video.clip.extract',
    'workflows.run','workflows.list','workflows.get','workflows.pause','workflows.retry','workflows.apply']){
    const method=`video-studio/${endpoint}`;
    ctx.effect(()=>ctx.connection.fetch.register({path:`/api/${method}`,methods:['POST'],requestBody:'buffered',async fetch(request){
      let raw:unknown;try{raw=await request.json();}catch{return new Response('Invalid JSON',{status:400});}
      const parsed=clientRequestSchema.safeParse(raw);
      if(!parsed.success||parsed.data.method!==method)return new Response('Invalid RPC envelope',{status:400});
      return Response.json({type:'server-response',rpcId:parsed.data.rpcId,result:await service.route(endpoint,parsed.data.payload)});
    }}),`video-studio ${endpoint}`);
  }
}
