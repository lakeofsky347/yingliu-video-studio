import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject} from '../src/core/index.ts';
import {DIRECTOR_RULESET_VERSION,compileDirectorShot,type DirectorPlan} from '../src/director/index.ts';
import {makeDirectorPlan} from '../src/workflows/director-plan.ts';
import type {WorkflowRequest} from '../src/workflows/contracts.ts';

test('selected-shot director plan keeps global identities without requiring unrelated image uploads',()=>{
  const project=createProject('局部导演参考','','code_animation'),shot=project.shots[0]!;
  project.assets=[{id:'ref-a',kind:'image',name:'A',description:''},{id:'ref-b',kind:'image',name:'B',description:''}];shot.referenceIds=['ref-a'];
  const plan:DirectorPlan={version:1,ruleSetVersion:DIRECTOR_RULESET_VERSION,filmKind:'general',characters:[{id:'A',name:'A',identity:'灰衣人物'},{id:'B',name:'B',identity:'蓝衣人物'}],worldLayouts:[],storyBeats:[],identityMap:[{characterId:'A',assetId:'ref-a'},{characterId:'B',assetId:'ref-b'}],shots:[{shotId:shot.id,title:shot.title,visualPrompt:'只有 A 出场',narration:'',characterIds:['A'],durationSeconds:shot.durationFrames*project.target.fps.den/project.target.fps.num,audioStrategy:'silent',performance:[],dialogue:[],events:[],references:[{assetId:'ref-a',purpose:'identity',usage:'reference_only'}],acceptance:[]}]};
  const request:WorkflowRequest={projectId:project.id,expectedRevision:project.revision,prompt:'只重做 A 的镜头',visual:'code',narration:false,review:false,allowImageUpload:true,imageAssetIds:['ref-a'],shotIds:[shot.id],directorPlan:plan},shots=[{shotId:shot.id,prompt:'只有 A 出场',narration:''}];
  const checked=makeDirectorPlan(plan,project,shots,request);assert.equal(checked.identityMap.length,2);assert.deepEqual(compileDirectorShot(checked,shot.id).referenceAssetIds,['ref-a']);
  assert.throws(()=>makeDirectorPlan(plan,project,shots,{...request,imageAssetIds:[]}),/未授权.*ref-a/);
  assert.throws(()=>makeDirectorPlan({...plan,shots:[{...plan.shots[0]!,references:[]}]},project,shots,request),/身份映射必须绑定/);
  const unrelatedMissing=structuredClone(project);unrelatedMissing.assets=unrelatedMissing.assets.filter(asset=>asset.id!=='ref-b');assert.throws(()=>makeDirectorPlan(plan,unrelatedMissing,shots,request),/不存在.*ref-b/);
});
