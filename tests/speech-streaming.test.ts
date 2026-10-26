import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SpeechSynthesizer} from '../src/host/audio.ts';
import type {ProjectStore} from '../src/host/store.ts';
import type {TtsSettings} from '../src/shared/types.ts';

const settings:TtsSettings={endpoint:'https://speech.invalid/v1',model:'fixture',voice:'fixture',speed:1,enabled:true};

test('speech streams bounded data to a temporary file; oversized responses never reach media import',async()=>{
  const root=await mkdtemp(join(tmpdir(),'speech-stream-')),originalFetch=globalThis.fetch;let mode='normal',imports=0,cancelled=0;
  const store={async importAudio(_root:string,input:{path?:string;dataBase64?:string}){
    imports++;assert.equal(input.dataBase64,undefined);assert.ok(input.path);assert.equal((await readFile(input.path!)).toString(),'streamed-audio');
    return {id:'audio',kind:'audio',name:'fixture',description:'',path:'assets/audio.wav'};
  }} as ProjectStore;
  const speech=new SpeechSynthesizer(store);
  globalThis.fetch=async()=>{
    if(mode==='declared')return new Response('unused',{headers:{'content-length':String(64*1024*1024+1)}});
    return new Response(new ReadableStream<Uint8Array>({pull(controller){
      if(mode==='normal'){controller.enqueue(Buffer.from('streamed-'));controller.enqueue(Buffer.from('audio'));controller.close();}
      else controller.enqueue(new Uint8Array(1024*1024));
    },cancel(){cancelled++;}}),{headers:{'content-type':'audio/wav'}});
  };
  try{
    await speech.synthesize(root,{text:'stream'},settings);assert.equal(imports,1);assert.deepEqual(await readdir(join(root,'runtime')),[]);
    mode='declared';await assert.rejects(speech.synthesize(root,{text:'too large'},settings),/64 MiB/);assert.equal(imports,1);assert.deepEqual(await readdir(join(root,'runtime')),[]);
    mode='streamed';await assert.rejects(speech.synthesize(root,{text:'too many chunks'},settings),/64 MiB/);assert.equal(imports,1);assert.ok(cancelled>0);assert.deepEqual(await readdir(join(root,'runtime')),[]);
  }finally{globalThis.fetch=originalFetch;await speech.close();await rm(root,{recursive:true,force:true});}
});

test('speech abort and configured timeout cancel stalled bodies and remove partial files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'speech-abort-')),originalFetch=globalThis.fetch;let started!:()=>void,cancelled=0,imports=0;
  const speech=new SpeechSynthesizer({async importAudio(){imports++;throw new Error('stalled body must not import');}} as unknown as ProjectStore);
  globalThis.fetch=async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(Buffer.from('partial'));started();},cancel(){cancelled++;}}),{headers:{'content-type':'audio/wav'}});
  try{
    let ready=new Promise<void>(resolve=>{started=resolve;}),controller=new AbortController();
    const pending=speech.synthesize(root,{text:'abort'},settings,{},controller.signal);await ready;controller.abort(new Error('stop test'));await assert.rejects(pending);assert.equal(imports,0);assert.deepEqual(await readdir(join(root,'runtime')),[]);
    ready=new Promise<void>(resolve=>{started=resolve;});const timeout=speech.synthesize(root,{text:'timeout'},{...settings,requestTimeoutMs:30});await ready;await assert.rejects(timeout);assert.equal(imports,0);assert.ok(cancelled>=2);assert.deepEqual(await readdir(join(root,'runtime')),[]);
    const originalNoop=started;started=()=>{};
    await assert.rejects(speech.synthesize(root,{text:'invalid'},{...settings,requestTimeoutMs:0}),/超时/);started=originalNoop;
  }finally{globalThis.fetch=originalFetch;await speech.close();await rm(root,{recursive:true,force:true});}
});
