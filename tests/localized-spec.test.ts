import test from 'node:test';
import assert from 'node:assert/strict';
import {compileSpec,createProject,specMarkdown} from '../src/core/index.ts';

function fixture(){
  const project=createProject('未命名视频','已完成','code_animation');
  const shot=project.shots[0]!;
  shot.id='user-shot';shot.title='预览';shot.intent='待细化';shot.composition='无';shot.action='淡入';shot.transition='fade';
  shot.params.text='用户文字 {0} $&';shot.params.subtitle='用户字幕：{"name":"山河"}';shot.params.custom='自定义参数：{name}';
  shot.narration='旁白原文：山河之间';shot.sourcePath='shots/user-source';
  shot.assetIds=['user-asset'];shot.referenceIds=['reference-one','reference-two'];
  project.shots=[shot];project.shotOrder=[shot.id];project.graph.positions={[shot.id]:[0,0]};
  project.target.audioMode='mixed';
  project.assets=[
    {id:'user-asset',kind:'text',name:'镜头',description:'已完成',text:'素材原文'},
    {id:'reference-one',kind:'text',name:'参考一',description:'',text:'参考内容一'},
    {id:'reference-two',kind:'text',name:'参考二',description:'',text:'参考内容二'},
  ];
  const spec=compileSpec(project);
  spec.shots[0]!.videoClip={id:'clip',shotId:shot.id,assetId:'用户视频：{0}',trimStart:1.25,speed:1.5,fit:'contain',audio:'keep'};
  return {project,spec};
}

test('production requirements keep Chinese as the default and preserve the established structure',()=>{
  const {spec}=fixture(),markdown=specMarkdown(spec);
  assert.equal(markdown,specMarkdown(spec,'zh'));
  assert.ok(markdown.startsWith('# 未命名视频：视频制作要求\n\n主题：已完成\n'));
  for(const line of [
    '画面：1920 × 1080；FPS：30/1；含音频 MP4；质量：high。',
    '总时长：10 秒（300 帧）；共 1 个镜头。',
    '镜头 ID：user-shot；帧区间：[0, 300)；时长：10 秒。',
    '进入转场：淡入',
    '画面来源：code；视频片段：用户视频：{0}；源区间 1.25–结尾 秒；1.5 倍速；contain；原声 keep。只有明确许可的混合镜头才能执行代码叠加。',
    '生产资产：镜头 (user-asset，text，已完成)',
    '参考资产 ID：reference-one、reference-two',
    '## 实现与验收',
    '- 画面文字可见、无截断，图片符合构图，切镜和淡入符合说明；自动媒体检查与人工观看分别记录。',
  ])assert.ok(markdown.split('\n').includes(line),line);
  assert.doesNotMatch(markdown,/中文文字可见/);
});

test('English production requirements translate headings, field templates and empty values',()=>{
  const {spec}=fixture(),markdown=specMarkdown(spec,'en');
  for(const line of [
    '# 未命名视频: Video production requirements',
    'Topic: 已完成',
    'Frame: 1920 × 1080; FPS: 30/1; MP4 (With audio); quality: high.',
    'Total duration: 10 seconds (300 frames); shots: 1.',
    'Shot ID: user-shot; frame range: [0, 300); duration: 10 seconds.',
    'Entrance transition: Fade in',
    'Visual source: code; video clip: 用户视频：{0}; source range 1.25–End seconds; 1.5× speed; contain; original audio: keep. Code overlays are allowed only in hybrid shots with explicit permission.',
    'Production assets: 镜头 (user-asset, text, 已完成)',
    'Reference asset IDs: reference-one, reference-two',
    'Source directory: shots/user-source',
    'Visual parameters:',
    '## Implementation and acceptance',
  ])assert.ok(markdown.split('\n').includes(line),line);
  assert.match(markdown,/- On-screen text must be visible and uncut/);
  assert.doesNotMatch(markdown,/Chinese text must/);

  spec.title='A film';spec.topic='';
  const shot=spec.shots[0]!;
  shot.title='Opening';shot.intent='';shot.composition='';shot.action='';shot.narration='';shot.transition='cut';
  shot.params.text='';shot.params.subtitle='';delete shot.params.custom;
  shot.assets=[];shot.referenceIds=[];delete shot.videoClip;spec.target.audioMode='none';
  const empty=specMarkdown(spec,'en');
  for(const line of ['Topic: Not filled in yet','What the viewer should understand: To be refined','Composition: To be refined','Motion: To be refined','Entrance transition: Cut','On-screen text: None','Subtitles / additional text: None','Narration: None','Production assets: None assigned yet','Reference asset IDs: None'])assert.ok(empty.split('\n').includes(line),line);
  assert.match(empty,/MP4 \(Silent\)/);
  assert.doesNotMatch(empty,/[\u3400-\u9fff]/);
});

test('rendering either language preserves user text, parameter JSON and project data',()=>{
  const {project,spec}=fixture(),beforeProject=structuredClone(project),beforeSpec=structuredClone(spec);
  const chinese=specMarkdown(spec,'zh'),english=specMarkdown(spec,'en');
  for(const markdown of [chinese,english]){
    for(const value of [spec.title,spec.topic,spec.shots[0]!.title,spec.shots[0]!.intent,spec.shots[0]!.composition,spec.shots[0]!.action,spec.shots[0]!.params.text,spec.shots[0]!.params.subtitle,spec.shots[0]!.narration!])assert.ok(markdown.includes(value),value);
    const json=markdown.match(/```json\n([\s\S]*?)\n```/)?.[1];
    assert.equal(json,JSON.stringify(spec.shots[0]!.params,null,2));
    assert.deepEqual(JSON.parse(json!),spec.shots[0]!.params);
  }
  assert.match(english,/What the viewer should understand: 待细化/);
  assert.match(english,/Composition: 无/);
  assert.match(english,/Motion: 淡入/);
  assert.equal(specMarkdown(spec,'zh'),chinese);
  assert.deepEqual(project,beforeProject);
  assert.deepEqual(spec,beforeSpec);
});
