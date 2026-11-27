import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProtocol, ResolvedModel } from '../src/models/contracts.ts';
import { getMediaCapabilities, MediaCapabilityError, validateMediaRequest } from '../src/models/capabilities.ts';
import { submitGeneration, pollGeneration } from '../src/models/adapters/official.ts';
import { generateImage, submitVideo } from '../src/models/adapters/media.ts';
import type { AdapterContext, AdapterInput } from '../src/models/adapters/media.ts';

const image={type:'image' as const,dataUrl:'data:image/png;base64,YWJj'};
const native:ModelProtocol[]=['openai-videos','kling-video','minimax-video','volc-video','dashscope-video','gemini-video'];
function resolved(protocol:ModelProtocol,model='test-model'):ResolvedModel {
  return {connection:{id:'connection',name:'fixture',protocol,baseUrl:'https://fixture.invalid/v1',auth:'none',credentialRef:'none',enabled:true,revision:1,requestTimeoutMs:5000,concurrency:1},model:{id:'model',connectionId:'connection',model,name:model,enabled:true,inputModalities:['text','image'],outputModalities:[protocol==='images'||protocol==='gemini-image'?'image':'video'],parameters:{}}};
}
function request(value:ResolvedModel,patch:Partial<AdapterInput>={}):AdapterInput {
  return {model:value.model,clientRequestId:'fixture-request',operation:'text-to-video',prompt:'纸船',inputs:[],parameters:{},...patch};
}
function harness(value:ResolvedModel,response:unknown={id:'task',status:'queued'}) {
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const context:AdapterContext={connection:value.connection,signal:new AbortController().signal,fetch:async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify(response),{status:200});}};
  return {context,calls,body:()=>JSON.parse(String(calls[0]?.init?.body))};
}
const safelyRejected=(error:unknown)=>error instanceof MediaCapabilityError&&error.code==='UNSUPPORTED_MEDIA_CAPABILITY'&&error.submissionUncertain===false;

test('Seedance encodes ordered first and last frames and gateway v1 rejects the new operation',async()=>{
  const value=resolved('volc-video','doubao-seedance-2-5-260628'),h=harness(value);
  const input=request(value,{operation:'first-last-frame-video',inputs:[image,{...image,dataUrl:'data:image/png;base64,ZGVm'}],referenceRoles:['first_frame','last_frame']});
  await assert.rejects(submitGeneration(h.context,{...input,referenceRoles:['last_frame','first_frame']}),safelyRejected);
  await submitGeneration(h.context,input);
  assert.deepEqual(h.body().content.slice(1).map((part:{role:string})=>part.role),['first_frame','last_frame']);
  const gateway=resolved('video-gateway'),legacy=harness(gateway);
  await assert.rejects(submitGeneration(legacy.context,{...input,model:gateway.model}),safelyRejected);
  assert.equal(legacy.calls.length,0);
});

test('Gemini image composition sends all images as ordered inline parts',async()=>{
  const value=resolved('gemini-image','gemini-3.1-flash-image'),h=harness(value,{candidates:[{content:{parts:[{inlineData:{data:'YWJj',mimeType:'image/png'}}]}}]});
  const output=await submitGeneration(h.context,request(value,{operation:'image-compose',inputs:[image,{...image,dataUrl:'data:image/png;base64,ZGVm'}]}));
  assert.equal(output.status,'succeeded');
  assert.deepEqual(h.body().contents[0].parts.slice(1).map((part:{inlineData:{data:string}})=>part.inlineData.data),['YWJj','ZGVm']);
});

test('Replicate lip sync accepts one MP4 and one WAV and creates a pollable prediction',async()=>{
  const value=resolved('replicate-lipsync','sync/lipsync-2');
  value.model.inputModalities=['video','audio'];
  const uploads:string[]=[];
  const context:AdapterContext={connection:value.connection,signal:new AbortController().signal,
    fetch:async(raw,init)=>{
      const url=new URL(String(raw));
      if(url.pathname.endsWith('/files')){
        const file=(init?.body as FormData).get('content') as File;
        uploads.push(file.type);
        return Response.json({urls:{get:'https://files.fixture.invalid/'+file.name}});
      }
      if(url.pathname.endsWith('/models/sync/lipsync-2/predictions')){
        assert.deepEqual(JSON.parse(String(init?.body)),{input:{video:'https://files.fixture.invalid/video.mp4',audio:'https://files.fixture.invalid/voice.wav'}});
        return Response.json({id:'clip',status:'starting'});
      }
      assert.equal(url.pathname,'/v1/predictions/clip');
      return Response.json({id:'clip',status:'succeeded',output:'https://files.fixture.invalid/final.mp4'});
    }};
  const inputs=[{type:'video',dataUrl:'data:video/mp4;base64,YWJj'},{type:'audio',dataUrl:'data:audio/wav;base64,YWJj'}] as AdapterInput['inputs'];
  await assert.rejects(submitGeneration(context,request(value,{operation:'lip-sync-video',inputs:[inputs[0]!]})),safelyRejected);
  assert.equal(uploads.length,0);
  const queued=await submitGeneration(context,request(value,{operation:'lip-sync-video',inputs}));
  assert.equal(queued.status,'queued');
  assert.deepEqual(uploads,['video/mp4','audio/wav']);
  assert.equal((await pollGeneration(context,value.connection.protocol,'lip-sync-video',queued.jobId,'request'))?.artifacts?.[0]?.mimeType,'video/mp4');
});

for(const protocol of native)test(protocol+' rejects multiple references before HTTP rather than taking the first',async()=>{
  const value=resolved(protocol),h=harness(value);
  await assert.rejects(submitGeneration(h.context,request(value,{operation:'image-to-video',inputs:[image,image]})),safelyRejected);
  assert.equal(h.calls.length,0);
});

test('explicit reference roles, unsupported modalities, missing images and audio requirements fail closed',async()=>{
  const value=resolved('volc-video'),h=harness(value);
  for(const patch of [
    {inputs:[image],referenceRoles:['last_frame']},
    {inputs:[image],referenceRoles:['character']},
    {inputs:[image],referenceRoles:['style']},
    {inputs:[image],referenceRoles:['layout']},
    {inputs:[image],referenceRoles:['unrecognized-role']},
    {inputs:[image],referenceRoles:[]},
    {inputs:[{...image,role:'first_frame'}],referenceRoles:['last_frame']},
    {inputs:[{...image,type:'audio' as const}]},
    {inputs:[{...image,type:'video' as const}]},
    {inputs:[{...image,dataUrl:'https://unapproved.invalid/image.png'}]},
    {inputs:[]},
  ])await assert.rejects(submitGeneration(h.context,request(value,{operation:'image-to-video',...patch})),safelyRejected);
  await assert.rejects(submitGeneration(h.context,request(value,{requiresAudio:true})),safelyRejected);
  assert.equal(h.calls.length,0);
});

test('effective capabilities identify exact model evidence without claiming live-provider validation',()=>{
  const sora=getMediaCapabilities(resolved('openai-videos','sora-2'));
  const pro=getMediaCapabilities(resolved('openai-videos','sora-2-pro'));
  const unknown=getMediaCapabilities(resolved('openai-videos','custom-sora-alias'));
  assert.equal(sora.verification.modelRecognized,true);assert.equal(sora.verification.realProviderTested,false);
  assert.equal(sora.verification.level,'documentation-checked');assert.equal(unknown.verification.level,'adapter-contract');
  assert.ok(!sora.sizes!.includes('1792x1024'));assert.ok(pro.sizes!.includes('1792x1024'));
  assert.equal(pro.recovery.automaticResubmit,false);
  assert.equal(getMediaCapabilities(resolved('video-gateway')).recovery.lookupByClientRequestId,true);
  const changed=getMediaCapabilities(resolved('openai-videos','sora-2'));changed.parameters.push('fps');
  assert.equal(getMediaCapabilities(resolved('openai-videos','sora-2')).parameters.includes('fps'),false);
  const textOnly=resolved('openai-videos','sora-2');textOnly.model.inputModalities=['text'];
  assert.deepEqual(getMediaCapabilities(textOnly).operations,['text-to-video']);assert.equal(getMediaCapabilities(textOnly).references.max,0);
});

test('unsupported parameters and fractional native durations are rejected with zero HTTP',async()=>{
  for(const [protocol,parameters] of [
    ['openai-videos',{fps:24}],['kling-video',{width:1280,height:720}],
    ['minimax-video',{aspectRatio:'16:9'}],['volc-video',{fps:24}],
    ['dashscope-video',{aspectRatio:'16:9'}],['gemini-video',{negativePrompt:'blur'}],
    ['gemini-image',{size:'1024x1024'}],['images',{unknown:'value'}],
  ] as [ModelProtocol,Record<string,string|number|boolean>][]){
    const value=resolved(protocol),h=harness(value);
    await assert.rejects(submitGeneration(h.context,request(value,{operation:protocol==='images'||protocol==='gemini-image'?'text-to-image':'text-to-video',parameters})),safelyRejected);
    assert.equal(h.calls.length,0,protocol);
  }
  for(const protocol of native)assert.throws(()=>validateMediaRequest(resolved(protocol),{operation:'text-to-video',parameters:{durationSeconds:4.4}}),safelyRejected);
});

test('Sora maps aspect ratio to a supported size and preserves duration without rounding',async()=>{
  const value=resolved('openai-videos','sora-2'),h=harness(value);
  await submitGeneration(h.context,request(value,{parameters:{durationSeconds:8,aspectRatio:'16:9'}}));
  assert.equal(h.body().size,'1280x720');assert.equal(h.body().seconds,'8');
  for(const parameters of [{durationSeconds:5},{width:1920,height:1080},{width:720},{aspectRatio:'1:1'},{width:720,height:1280,aspectRatio:'16:9'}] as Record<string,string|number|boolean>[])assert.throws(()=>validateMediaRequest(value,{operation:'text-to-video',parameters}),safelyRejected);
  validateMediaRequest(value,{operation:'text-to-video',parameters:{width:1280,height:720,aspectRatio:'16:9'}});
});

test('Sora image-to-video sends exactly one validated first frame as multipart',async()=>{
  const value=resolved('openai-videos','sora-2'),h=harness(value);
  await submitGeneration(h.context,request(value,{operation:'image-to-video',inputs:[image],referenceRoles:['first_frame'],parameters:{durationSeconds:4,aspectRatio:'9:16'}}));
  const form=h.calls[0]!.init!.body as FormData;
  assert.ok(form instanceof FormData);assert.equal(form.get('size'),'720x1280');assert.equal(form.get('seconds'),'4');assert.ok(form.get('input_reference') instanceof Blob);
});

test('Seedance maps duration, ratio, seed and first-frame role and applies exact model constraints',async()=>{
  const value=resolved('volc-video','doubao-seedance-2-5-260628'),h=harness(value);
  await submitGeneration(h.context,request(value,{operation:'image-to-video',inputs:[image],referenceRoles:['first_frame'],parameters:{durationSeconds:10,aspectRatio:'adaptive',seed:0}}));
  assert.equal(h.body().duration,10);assert.equal(h.body().ratio,'adaptive');assert.equal(h.body().seed,0);
  assert.equal(h.body().content[1].role,'first_frame');assert.equal(h.body().content[1].image_url.url,image.dataUrl);
  assert.throws(()=>validateMediaRequest(value,{operation:'image-to-video',imageAssetIds:['one'],parameters:{aspectRatio:'16:9'}}),safelyRejected);
  assert.throws(()=>validateMediaRequest(value,{operation:'text-to-video',parameters:{durationSeconds:31}}),safelyRejected);
  assert.throws(()=>validateMediaRequest(resolved('volc-video','doubao-seedance-2-0-260128'),{operation:'text-to-video',parameters:{durationSeconds:20}}),safelyRejected);
});

test('documented Wan t2v models encode exact dimensions instead of an invalid ratio field',async()=>{
  const value=resolved('dashscope-video','wan2.6-t2v'),h=harness(value,{output:{task_id:'wan-task',task_status:'PENDING'}});
  await submitGeneration(h.context,request(value,{parameters:{durationSeconds:8,width:1280,height:720,seed:0,negativePrompt:'blur'}}));
  assert.deepEqual(h.body().parameters,{duration:8,size:'1280*720',seed:0});assert.equal(h.body().input.negative_prompt,'blur');
  assert.equal(h.body().parameters.ratio,undefined);
  assert.throws(()=>validateMediaRequest(value,{operation:'image-to-video',imageAssetIds:['one']}),safelyRejected);
  assert.throws(()=>validateMediaRequest(resolved('dashscope-video','wan2.2-t2v-plus'),{operation:'text-to-video',parameters:{durationSeconds:10}}),safelyRejected);
});

test('gateway retains all three untyped v1 references and every legacy parameter unchanged',async()=>{
  const value=resolved('video-gateway'),h=harness(value,{jobId:'gateway-task',status:'queued'});
  const parameters={durationSeconds:0.5,width:777,height:555,fps:29.97,aspectRatio:'custom',seed:-1,negativePrompt:'blur'};
  const input=request(value,{operation:'image-to-video',inputs:[image,image,image],referenceRoles:['reference','reference','reference'],parameters});
  await submitGeneration(h.context,input);
  assert.deepEqual(h.body(),{clientRequestId:input.clientRequestId,model:value.model.model,operation:input.operation,prompt:input.prompt,inputs:[image,image,image],parameters});
  assert.equal(h.body().referenceRoles,undefined);assert.equal(h.body().requiresAudio,undefined);
});

test('public adapter entry points cannot bypass operation, protocol, input or parameter checks',async()=>{
  const images=resolved('images'),ih=harness(images),video=resolved('video-gateway'),vh=harness(video);
  await assert.rejects(generateImage(ih.context,request(images,{operation:'text-to-image',inputs:[image]})),safelyRejected);
  await assert.rejects(generateImage(ih.context,request(images,{operation:'text-to-image',parameters:{model:'override'}})),safelyRejected);
  await assert.rejects(submitVideo(ih.context,request(images,{operation:'text-to-image'})),safelyRejected);
  await assert.rejects(generateImage(vh.context,request(video,{operation:'text-to-image'})),safelyRejected);
  await assert.rejects(submitVideo(vh.context,request(video,{operation:'image-to-video',inputs:[image],referenceRoles:['last_frame']})),safelyRejected);
  assert.equal(ih.calls.length+vh.calls.length,0);
});

test('native unknown submissions never POST again and submission transport failures are not labelled safely unsubmitted',async()=>{
  for(const protocol of native){
    const value=resolved(protocol),h=harness(value);
    assert.equal(await pollGeneration(h.context,protocol,'text-to-video',undefined,'same-request'),null);
    assert.equal(h.calls.length,0);
  }
  const value=resolved('openai-videos','sora-2');let posts=0;
  const context:AdapterContext={connection:value.connection,signal:new AbortController().signal,fetch:async()=>{posts++;throw new TypeError('response lost');}};
  await assert.rejects(submitGeneration(context,request(value)),e=>e instanceof TypeError&&(e as TypeError&{submissionUncertain?:boolean}).submissionUncertain!==false);
  assert.equal(posts,1);
});

test('malformed native response cannot manufacture a pollable Kling task ID',async()=>{
  const value=resolved('kling-video'),h=harness(value,{data:{task_status:'submitted'}});
  await assert.rejects(submitGeneration(h.context,request(value)),/任务 ID/);assert.equal(h.calls.length,1);
});

test('audio output requirements use concrete model evidence rather than arbitrary output modality claims',()=>{
  const unknown=resolved('gemini-video');unknown.model.outputModalities.push('audio');
  assert.throws(()=>validateMediaRequest(unknown,{operation:'text-to-video',requiresAudio:true}),safelyRejected);
  const known=resolved('gemini-video','veo-3.1-generate-preview');
  assert.equal(validateMediaRequest(known,{operation:'text-to-video',requiresAudio:true}).audio.output,'native');
  assert.ok(getMediaCapabilities(known).verification.notes.some(n=>n.includes('停用')));
});
