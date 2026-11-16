import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {englishMessages,formatMessage,normalizeLocale,translateSystemMessage} from '../src/shared/localization.ts';
import {getLocale,setLocale,subscribeLocale,t,formatDate} from '../src/client/i18n.ts';
import {createProject,addShot,duplicateShot,compileSpec} from '../src/core/index.ts';
import {RpcStudioApi,StudioRequestError} from '../src/client/controller.ts';
import {DshSceneGenerator} from '../src/host/generator.ts';
import {ModelRegistry} from '../src/models/registry.ts';
import {synthesizeLocalSfx,type LocalSfxSpec} from '../src/media/local-sfx.ts';

const placeholders=(value:string)=>[...new Set([...value.matchAll(/\{(\w+)\}/g)].map(match=>match[1]))].sort();

test('English messages preserve every source placeholder and contain no empty translation',()=>{
  assert.ok(Object.keys(englishMessages).length>1500,'The complete UI and system catalogs must be loaded');
  for(const [source,english] of Object.entries(englishMessages)){
    assert.ok(english.trim(),source);
    assert.deepEqual(placeholders(english),placeholders(source),source);
  }
});

test('locale selection accepts Chinese regional tags and falls back to English',()=>{
  for(const value of ['zh','zh-CN','zh-TW','ZH-hans'])assert.equal(normalizeLocale(value),'zh');
  for(const value of ['en','en-GB','fr','ja',undefined])assert.equal(normalizeLocale(value),'en');
});

test('message formatting preserves user data and does not interpret replacement syntax',()=>{
  const name='预览 ${price} $& <b>我自己的影片</b>';
  assert.equal(formatMessage('en','{name} 副本',{name}),name+' copy');
  assert.equal(formatMessage('zh','{name} 副本',{name}),name+' 副本');
  assert.equal(formatMessage('en','External provider: {unknown}'), 'External provider: {unknown}');
  assert.equal(formatMessage('en','{name} 副本'),'{name} copy');
  for(const key of ['constructor','toString','__proto__'])assert.equal(formatMessage('en',key),key);
});

test('source system messages translate without rewriting interpolated user names or provider details',()=>{
  assert.equal(translateSystemMessage('en','不存在于词典的供应商原始报错'), '不存在于词典的供应商原始报错');
  const name='预览 $& $1 {0} <b>自己的名字</b>';
  assert.equal(translateSystemMessage('en',`${name} 不是有效 ZIP 文件`),`${name} is not a valid ZIP file`);
  assert.equal(translateSystemMessage('zh',`${name} 不是有效 ZIP 文件`),`${name} 不是有效 ZIP 文件`);
  assert.equal(translateSystemMessage('zh',`${name} is not a valid ZIP file`),`${name} is not a valid ZIP file`);
  assert.equal(translateSystemMessage('en','已完成\n不存在于词典的供应商原始报错'),formatMessage('en','已完成')+'\n不存在于词典的供应商原始报错');
  const details='已完成\nThe provider rejected your custom model\n预览';
  assert.equal(translateSystemMessage('en',`工程已保存，预览准备失败：${details}`),`The project was saved, but preview preparation failed: ${details}`,'Opaque provider details are not split into diagnostic lines');
});

test('system-message matching never guesses English translations, generated names or UI label patterns',()=>{
  for(const value of [
    'The provider rejected your custom model','The provider rejected 预览 custom model',
    'Preview','用户片名：预览','预览 副本','预览（副本）','镜头 用户标题','主题：预览','使用 预览',
    '预览无效','预览的自定义帧 1 与 2','External provider:\nPreview\ncustom model',
  ]){
    assert.equal(translateSystemMessage('en',value),value,value);
    assert.equal(translateSystemMessage('zh',value),value,value);
  }
  assert.equal(translateSystemMessage('zh','Completed'),'Completed','Even exact known English labels stay in their original language');
});

test('registered backend diagnostics and UI notices retain all dynamic parameters',()=>{
  const cases:[string,Record<string,string|number>][]=[
    ['工程版本冲突：期望 v{0}，当前 v{1}；请读取最新工程后合并修改',{0:4,1:9}],
    ['正在生成 · 已收到 {0} 字符',{0:123}],
    ['生成镜头 {0}/{1}',{0:2,1:3}],
    ['捕获帧 {0} / {1}',{0:90,1:120}],
    ['镜头 {0} 参数 {1} 无效',{0:'用户镜头：预览',1:'我的 opacity'}],
    ['{0} 路径 {1} 与 {2} 路径 {3} 冲突：{4}',{0:'用户输入',1:'影片/预览.mp4',2:'用户输出',3:'结果/视频.mp4',4:'用户保留的说明'}],
    ['模型目录鉴权失败（HTTP {0}），请检查 API Key 和权限。',{0:401}],
    ['当前适配器最多支持 {0} 张参考图片；不会只取首图',{0:4}],
    ['结果已保存为工程 v{0}',{0:7}],
    ['已检查 {0} 张实际候选关键帧',{0:3}],
    ['{0} 不是有效 JSON：{1}',{0:'预览.json',1:'Unexpected token 预览 $& {0}'}],
    ['已导入 {value0} 个视频制作风格。',{value0:2}],
    ['已删除「{value0}」。',{value0:'预览风格 $&'}],
    ['第 {value0} 帧 PNG 已保存到项目中。',{value0:42}],
  ];
  for(const [source,values] of cases){
    const message=formatMessage('zh',source,values);
    assert.equal(translateSystemMessage('en',message),formatMessage('en',source,values),source);
    assert.equal(translateSystemMessage('zh',message),message,source);
  }
});

test('real model and sound-effect validators render complete English field errors',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'studio-localized-validation-'));
  const registry=new ModelRegistry(directory,{get:async()=>undefined,set:async()=>{},delete:async()=>{}});
  const userName='预览 $& {0} 自定义连接';
  const base={name:userName,baseUrl:'https://example.invalid/v1',auth:'none' as const};
  const expectMessage=(expected:string)=>(error:unknown)=>{
    assert.ok(error instanceof Error);
    assert.equal(translateSystemMessage('en',error.message),expected);
    assert.equal(translateSystemMessage('zh',error.message),error.message);
    return true;
  };
  try{
    await assert.rejects(registry.saveConnection({...base,name:''}),expectMessage('Connection name is invalid.'));
    await assert.rejects(registry.saveConnection({...base,baseUrl:''}),expectMessage('API URL is invalid.'));
    await assert.rejects(registry.saveConnection({...base,requestTimeoutMs:1}),expectMessage('Request timeout must be an integer between 5000 and 900000.'));
    await assert.rejects(registry.saveConnection({...base,concurrency:17}),expectMessage('Concurrency must be an integer between 1 and 16.'));
    const connection=await registry.saveConnection(base);
    await assert.rejects(registry.saveModel({connectionId:connection.id,model:''}),expectMessage('Model ID is invalid.'));
    await assert.rejects(registry.saveModel({connectionId:connection.id,model:'model',inputModalities:[]}),expectMessage('Input modalities are invalid.'));
    await assert.rejects(registry.saveModel({connectionId:connection.id,model:'model',outputModalities:[]}),expectMessage('Output modalities are invalid.'));
    assert.equal((await registry.list()).connections[0]?.name,userName);
    const soundCases:[Partial<LocalSfxSpec>,string][]=[
      [{durationSeconds:11},'Sound effect duration must be between 0.05 and 10.'],
      [{frequency:0},'Start frequency must be between 20 and 12000.'],
      [{endFrequency:0},'End frequency must be between 20 and 12000.'],
      [{volume:2},'Sound effect volume must be between 0 and 1.'],
      [{seed:-1},'Sound effect seed must be between 0 and 4294967295.'],
    ];
    for(const [patch,expected] of soundCases)assert.throws(()=>synthesizeLocalSfx({kind:'chime',durationSeconds:.5,...patch}),expectMessage(expected));
    assert.equal(translateSystemMessage('en','旁白超出镜头时长 2.00 秒，请延长画面或调整旁白裁剪'),'Narration exceeds the shot duration by 2.00 seconds. Extend the visuals or adjust the narration trimming.');
    assert.equal(translateSystemMessage('en','旁白超出成片时长 3.00 秒，请延长画面或调整旁白裁剪'),'Narration exceeds the film duration by 3.00 seconds. Extend the visuals or adjust the narration trimming.');
    assert.equal(translateSystemMessage('en','我自己命名的字段无效'),'我自己命名的字段无效');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('compiler and explicit nested diagnostics translate their messages while preserving user names and unknown details',()=>{
  const project=createProject('用户片名：预览','','code_animation'),name='预览 $& {0} 用户镜头';
  const first=project.shots[0]!,originalId=first.id;
  first.id=name;first.title='';first.durationFrames=0;
  project.shotOrder=project.shotOrder.map(id=>id===originalId?name:id);
  project.graph.positions[name]=project.graph.positions[originalId]!;delete project.graph.positions[originalId];
  const before=structuredClone(project);let compilerError='';
  assert.throws(()=>compileSpec(project),(error:unknown)=>{assert.ok(error instanceof Error);compilerError=error.message;return true;});
  const translated=translateSystemMessage('en',compilerError);
  assert.ok(translated.startsWith('Cannot compile video requirements:\n'));
  assert.ok(translated.includes(`Shot ${name} is missing a title.`));
  assert.ok(translated.includes(`Shot ${name} must have a positive integer duration in frames.`));
  assert.equal(/[\u3400-\u9fff]/.test(translated.split(name).join('')),false);
  assert.deepEqual(project,before,'Rendering diagnostics cannot rewrite the project or its user-authored identifiers');
  assert.equal(translateSystemMessage('en','工程已保存，预览准备失败：'+compilerError),'The project was saved, but preview preparation failed: '+translated);
  const vendor='Provider rejected 用户原文 $& {0} custom model';
  const messages=[`镜头 ${name} 缺少标题`,vendor,'音轨引用的音频资产不存在'];
  for(const prefix of ['本地质检发现硬失败：','候选质量硬性条件失败：']){
    const result=translateSystemMessage('en',prefix+messages.join('；'));
    assert.ok(result.includes(`Shot ${name} is missing a title.`));
    assert.ok(result.includes(vendor));
    assert.ok(result.endsWith(formatMessage('en',messages[2]!)));
  }
  assert.equal(translateSystemMessage('en','主链草稿：末镜头必须连接到视频输出节点'),'Main sequence draft: '+formatMessage('en','末镜头必须连接到视频输出节点'));
  const multilineVendor='供应商原始内容\n已完成\n预览';
  assert.equal(translateSystemMessage('en','工程已保存，预览准备失败：'+multilineVendor),'The project was saved, but preview preparation failed: '+multilineVendor);
  for(const [prefix,separator] of [['无法编译视频要求：\n','\n'],['本地质检发现硬失败：','；']] as const){
    const identifier=`用户${separator}主链不能自连接${separator}名字`;
    const result=translateSystemMessage('en',prefix+`镜头 ${identifier} 缺少标题`);
    assert.ok(result.includes(`Shot ${identifier} is missing a title.`),'Diagnostic delimiters inside user identifiers must remain verbatim');
  }
});

test('explicit nested diagnostics have depth and length limits',()=>{
  const prefix='工程已保存，预览准备失败：',english='The project was saved, but preview preparation failed: ';
  assert.equal(translateSystemMessage('en',prefix.repeat(20)+'未知供应商内容'),english.repeat(8)+prefix.repeat(12)+'未知供应商内容');
  const oversized=prefix+'供应商日志'.repeat(4000);
  assert.equal(translateSystemMessage('en',oversized),oversized);
});

test('long and repetitive provider errors return promptly without regex backtracking',{timeout:15_000},async()=>{
  // A subprocess timeout also guards a regression that blocks the event loop itself.
  const script=`import assert from 'node:assert/strict';
    import {translateSystemMessage} from ${JSON.stringify(new URL('../src/shared/localization.ts',import.meta.url).href)};
    const messages=[
      '预览 路径 '.repeat(20_000)+' 与 '+'预览 路径 '.repeat(20_000),
      '镜头 '+' 帧 '.repeat(4_000)+'供应商返回未知错误',
      'The provider rejected your custom model '.repeat(20_000),
    ];
    const start=performance.now();
    for(const value of messages)for(const locale of ['en','zh'])assert.equal(translateSystemMessage(locale,value),value);
    assert.ok(performance.now()-start<1000,'System-message recognition must have bounded render cost');
  `;
  await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',script],{timeout:10_000,maxBuffer:32_768});
});

test('changing UI language updates subscribers and dates without changing stored project text',()=>{
  setLocale('zh');
  const project=createProject('预览','Keep my Chinese title and film content','code_animation');
  const before=structuredClone(project);let notifications=0;
  const unsubscribe=subscribeLocale(()=>notifications++);
  try{
    setLocale('en-US');assert.equal(getLocale(),'en');assert.equal(t('打开工作台'),'Open studio');
    assert.match(formatDate('2026-11-16T08:00:00Z',{month:'long',day:'numeric',timeZone:'UTC'}),/November/);
    setLocale('en');assert.equal(notifications,1);
    setLocale('zh-CN');assert.equal(t('打开工作台'),'打开工作台');assert.equal(notifications,2);
    assert.deepEqual(project,before);assert.equal(formatDate('not a date'),'');
  }finally{unsubscribe();setLocale('zh');}
});

test('new default content uses an explicit creation language and existing content stays unchanged',()=>{
  const chinese=createProject('','','code_animation');
  assert.equal(chinese.title,'未命名视频');assert.equal(chinese.shots[0].title,'镜头 1');
  const english=createProject('','','code_animation','en');
  assert.equal(english.title,formatMessage('en','未命名视频'));assert.equal(english.shots[0].title,'Shot 1');
  const before=structuredClone(chinese);
  const added=addShot(chinese,undefined,undefined,'en');assert.equal(added.shots.at(-1)?.title,'Shot 4');
  const duplicated=duplicateShot(chinese,chinese.shots[0].id,'en');
  assert.equal(duplicated.shots.find(shot=>shot.title==='镜头 1 (copy)')?.params.text,'镜头 1');
  assert.deepEqual(chinese,before);
});

test('RPC sends UI locale only for new defaults, preserves caller payload and error codes',async()=>{
  const calls:{endpoint:string;payload:any}[]=[];
  const api=new RpcStudioApi({call:async(_channel,endpoint,payload)=>{calls.push({endpoint,payload});return endpoint.endsWith('/fail')?{ok:false,error:{code:'REVISION_CONFLICT',message:'工程已切换，请重新发起操作'}}:{ok:true,value:{}};}});
  const payload={title:'用户片名',topic:'使用中文旁白'};
  setLocale('en');
  try{
    await api.call('create',payload);assert.deepEqual(calls[0].payload,{...payload,uiLocale:'en'});assert.deepEqual(payload,{title:'用户片名',topic:'使用中文旁白'});
    await api.call('save',{projectId:'film'});assert.deepEqual(calls[1].payload,{projectId:'film'});
    await assert.rejects(()=>api.call('fail'),error=>error instanceof StudioRequestError&&error.code==='REVISION_CONFLICT'&&error.message==='工程已切换，请重新发起操作');
  }finally{setLocale('zh');}
});

test('generation instructions respect the film language instead of forcing Chinese',async()=>{
  let sent:any;
  const context={llm:{listModels:async()=>[{id:'fixture'}],stream:async function*(request:any){sent=request;yield {type:'text-delta',text:JSON.stringify({shots:[{title:'A walk',intent:'English film',params:{text:'A walk',subtitle:'Keep the requested language'},durationSeconds:30}]})};yield {type:'finish',reason:{kind:'stop'}};}}};
  const project=createProject('我的英文片','Make this film in English','code_animation','en');
  const generator=new DshSceneGenerator(context as any,()=>'/unused');
  const shots=await generator.storyboard(project,{provider:'fixture',model:'fixture'},new AbortController().signal);
  assert.match(sent.system,/用户明确指定的语言/);assert.doesNotMatch(sent.system,/制作中文可读/);
  assert.equal(JSON.parse(sent.messages[0].content[0].text).topic,project.topic);
  assert.equal(shots[0].params.text,'A walk');assert.equal(project.title,'我的英文片');
});
