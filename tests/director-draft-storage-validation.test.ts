import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DirectorDraftStore} from '../src/client/director-drafts.ts';
import {DIRECTOR_RULESET_VERSION} from '../src/director/index.ts';

function draft(){return {projectId:randomUUID(),baseVersion:0,updatedAt:new Date().toISOString(),plan:{version:1,ruleSetVersion:DIRECTOR_RULESET_VERSION,filmKind:'general',characters:[{id:'person',name:'',identity:'',features:['']}],storyBeats:[],worldLayouts:[],identityMap:[],shots:[{shotId:'shot',title:'',visualPrompt:'',narration:'',durationSeconds:1,audioStrategy:'silent',characterIds:['person'],performance:[],dialogue:[],events:[],references:[],acceptance:[]}]}};}
function fixture(value:ReturnType<typeof draft>){const key='yingliu-video-studio.director-draft.v1.'+value.projectId,raw=JSON.stringify(value),values=new Map([[key,raw]]),storage={getItem:(id:string)=>values.get(id)??null,setItem:(id:string,text:string)=>{values.set(id,text);},removeItem:(id:string)=>{values.delete(id);}};return {store:new DirectorDraftStore(storage),values,key,raw};}

test('persisted unfinished director fields remain recoverable without applying saved-plan business validation',()=>{
  const value=draft(),f=fixture(value);assert.deepEqual(f.store.get(value.projectId),value);assert.equal(f.store.warning,'');assert.equal(f.values.get(f.key),f.raw);
});

test('malformed director draft render structures fail closed without deleting or rewriting recovery data',()=>{
  for(const corrupt of [(value:any)=>delete value.plan.characters,(value:any)=>{value.plan.characters[0].features={bad:true};},(value:any)=>{value.plan.shots[0].durationSeconds='not a number';},(value:any)=>{value.plan.shots[0].events=[{screenPositions:null}];}]){
    const value=draft();corrupt(value);const f=fixture(value);assert.equal(f.store.get(value.projectId),undefined);assert.match(f.store.warning,/结构损坏/);assert.equal(f.values.get(f.key),f.raw);
  }
});
