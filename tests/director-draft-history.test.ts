import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject} from '../src/core/index.ts';
import {DIRECTOR_RULESET_VERSION,type DirectorPlan} from '../src/director/index.ts';
import {approveDirectorDocument,saveDirectorDocument} from '../src/director/document.ts';
import {DirectorDraftStore,directorDraftMatchesDocument} from '../src/client/director-drafts.ts';

test('director draft content baseline detects divergent documents after undo reuses a version number',()=>{
  const project=createProject('导演草稿历史','','code_animation');
  const plan:DirectorPlan={version:1,ruleSetVersion:DIRECTOR_RULESET_VERSION,filmKind:'general',characters:[],worldLayouts:[],identityMap:[],storyBeats:[],shots:project.shots.map(shot=>({shotId:shot.id,title:shot.title,visualPrompt:'最初计划',narration:'',durationSeconds:shot.durationFrames*project.target.fps.den/project.target.fps.num,audioStrategy:'silent',performance:[],dialogue:[],events:[],references:[],acceptance:[]}))};
  const first=saveDirectorDocument(project,plan,{expectedVersion:0});project.extensions.directorDocument=first;const approved=approveDirectorDocument(project,{expectedVersion:first.version,expectedHash:first.hash});project.extensions.directorDocument=approved;
  const branchA=structuredClone(plan);branchA.shots[0]!.visualPrompt='旧分支 A';const documentA=saveDirectorDocument(project,branchA,{expectedVersion:approved.version});
  const localDraft={projectId:project.id,baseVersion:documentA.version,baseHash:documentA.hash,plan:branchA,updatedAt:new Date().toISOString()};const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};
  const store=new DirectorDraftStore(storage);store.set(localDraft);assert.equal(directorDraftMatchesDocument(store.get(project.id)!,documentA),true);
  // Undo restores the approved v2, then another save creates a different v3.
  project.extensions.directorDocument=approved;const branchB=structuredClone(plan);branchB.shots[0]!.visualPrompt='新分支 B';const documentB=saveDirectorDocument(project,branchB,{expectedVersion:approved.version});assert.equal(documentA.version,documentB.version);assert.notEqual(documentA.hash,documentB.hash);
  assert.equal(directorDraftMatchesDocument(new DirectorDraftStore(storage).get(project.id)!,documentB),false);assert.equal(store.get(project.id)!.plan.shots[0]!.visualPrompt,'旧分支 A','detecting a stale draft must preserve its content');
  assert.equal(directorDraftMatchesDocument({baseVersion:documentB.version},documentB),false,'legacy drafts without a hash cannot overwrite an existing document');
  assert.equal(directorDraftMatchesDocument({baseVersion:0}),true,'new drafts with no saved document have a valid empty baseline');
  assert.equal(directorDraftMatchesDocument({baseVersion:0},first),false);store.delete(project.id);
});
