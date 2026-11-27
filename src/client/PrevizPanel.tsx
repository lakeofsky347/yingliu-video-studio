import {useEffect,useState} from 'react';
import {previzAssetIds,type PrevizRecord,type PrevizSceneSpec,type PrevizStatus} from '../shared/previz.ts';
import type {Asset,EnvironmentInfo,Shot,VideoProject} from '../shared/types.ts';
import type {StudioController} from './controller.ts';
import {Field} from './EnvironmentPanel.tsx';
import {useConfirmAction} from './Feedback.tsx';
import {Button} from './icons.tsx';
import {systemMessage,t,useLocale} from './i18n.ts';

const exampleScene:PrevizSceneSpec={
  camera:{lensMm:35,startPos:[-4,-7,2.8],endPos:[-2,-6,2.4],startTarget:[0,0,1.1]},
  objects:[
    {id:'actor',kind:'character',position:[-1,0,0],endPos:[1,0,0],pose:'walk'},
    {id:'set',kind:'box',position:[1.5,2.5,0],scale:[3,1,2.5]},
  ],
  width:640,height:360,fps:12,durationSeconds:2,lighting:'three_point',emitDepth:true,
};
const initialScene=JSON.stringify(exampleScene,null,2);

export function PrevizPanel({controller,project,selectedShot,environment,busy,assetUrl,onDirector,onEnvironment}:{
  controller:StudioController;
  project:VideoProject;
  selectedShot?:Shot;
  environment:EnvironmentInfo;
  busy:boolean;
  assetUrl:(asset:Asset)=>string;
  onDirector:()=>void;
  onEnvironment:()=>void;
}){
  useLocale();
  const confirm=useConfirmAction();
  const [chosenShot,setChosenShot]=useState('');
  const [output,setOutput]=useState<'image'|'both'>('image');
  const [scene,setScene]=useState(initialScene);
  const [result,setResult]=useState<{key:string;status?:PrevizStatus;error?:string}>();
  const [working,setWorking]=useState<'render'|'approve'|null>(null);
  const [canceling,setCanceling]=useState(false);
  const [error,setError]=useState('');
  const shot=project.shots.find(item=>item.id===chosenShot)??selectedShot??project.shots[0];
  const shotId=shot?.id??'',key=JSON.stringify([project.id,project.revision,shotId]);
  const status=result?.key===key?result.status:undefined,scope=status?.scope,record=status?.record;
  const loading=!!shotId&&result?.key!==key;
  const rendering=working==='render'||(busy&&!!status?.rendering);
  const disabled=busy||!!working;
  useEffect(()=>{setError('');},[shotId]);
  useEffect(()=>{
    if(!shotId)return;
    let active=true;
    void controller.api.call<PrevizStatus>('previz.get',{projectId:project.id,shotId})
      .then(status=>{if(active)setResult({key,status});})
      .catch(cause=>{if(active)setResult({key,error:cause instanceof Error?cause.message:String(cause)});});
    return()=>{active=false;};
  },[controller,key,project.id,shotId,busy]);

  async function render(){
    if(!scope)return;
    setError('');
    let input:unknown;
    try{input=JSON.parse(scene);}catch{setError('请输入有效的白模场景 JSON。');return;}
    if(!input||typeof input!=='object'||Array.isArray(input)){setError('请输入有效的白模场景 JSON。');return;}
    setWorking('render');
    try{await controller.mediaCommand('previz.render',{...scope,spec:{...input,output}},true);}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setWorking(null);setCanceling(false);}
  }
  async function cancel(){
    setCanceling(true);
    try{await controller.api.call('previz.cancel',{projectId:project.id,shotId});}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));setCanceling(false);}
  }
  async function approve(visibleRecord:PrevizRecord){
    if(!await confirm({
      title:t('确认本次镜头预演？'),
      body:t('确认当前导演计划中的构图与运镜。白模关键帧、深度参考和预演视频均保留为参考素材。'),
      confirmLabel:t('确认预演'),
    }))return;
    if(controller.getSnapshot().snapshot?.project?.id!==project.id)return;
    setError('');setWorking('approve');
    const {shotId,documentHash,documentVersion,id:renderId}=visibleRecord;
    try{await controller.mediaCommand('previz.approve',{shotId,documentHash,documentVersion,renderId,assetIds:previzAssetIds(visibleRecord)},true);}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setWorking(null);}
  }
  const asset=(id:string|undefined)=>project.assets.find(item=>item.id===id);
  const image=asset(record?.imageAssetId),depth=asset(record?.depthAssetId),video=asset(record?.videoAssetId);
  const lookupError=result?.key===key?result.error:undefined;
  const videoAvailable=environment.ffmpegAvailable&&environment.ffprobeAvailable;
  const renderUnavailable=!scope||!environment.blenderAvailable||output==='both'&&!videoAvailable;

  return <section className="vs-record-panel vs-previz-panel" aria-label={t('Blender 白模预演')}>
    <header className="vs-record-heading"><div><h3>{t('Blender 白模预演')}</h3><p>{t('在本机审阅镜头构图、角色走位和运镜。输出素材仅供参考。')}</p></div>
      <button type="button" onClick={onEnvironment}>{t('运行环境')}</button>
    </header>
    <Field label={t('预演镜头')}>
      <select value={shotId} disabled={disabled||!project.shots.length} onChange={event=>setChosenShot(event.target.value)}>
        {!project.shots.length&&<option value="">{t('请先添加镜头')}</option>}
        {project.shots.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
    </Field>
    {loading&&<p role="status" className="vs-media-help">{t('正在读取预演记录…')}</p>}
    {!loading&&!lookupError&&shotId&&!scope&&<div className="vs-previz-lock">
      <p>{t('请先批准包含该镜头的导演计划')}</p><button type="button" onClick={onDirector}>{t('打开导演计划')}</button>
    </div>}
    {!environment.blenderAvailable&&<p className="vs-media-help">{t('未检测到 Blender，请在运行环境中配置可执行路径')}</p>}
    {scope&&<>
      <Field label={t('预演输出')}>
        <select value={output} disabled={disabled} onChange={event=>setOutput(event.target.value as 'image'|'both')}>
          <option value="image">{t('白模关键帧')}</option><option value="both" disabled={!videoAvailable}>{t('白模关键帧与预演视频')}</option>
        </select>
      </Field>
      <details className="vs-media-advanced">
        <summary>{t('编辑场景参数')}</summary>
        <Field label={t('白模场景 JSON')} hint={t('用 camera 设置机位、焦距和运镜，用 objects 设置角色、走位和几何布景。深度图按每个像素可见表面的远近着色。')}>
          <textarea rows={11} maxLength={100000} spellCheck={false} value={scene} disabled={disabled} onChange={event=>setScene(event.target.value)}/>
        </Field>
        <button type="button" disabled={disabled} onClick={()=>setScene(initialScene)}>{t('恢复示例场景')}</button>
      </details>
      <div className="vs-record-actions">
        <Button icon="camera" variant="primary" disabled={disabled||renderUnavailable} onClick={()=>void render()}>{rendering?t('正在渲染白模预演…'):t('渲染白模预演')}</Button>
        {rendering&&<button type="button" disabled={canceling} onClick={()=>void cancel()}>{t('取消预演')}</button>}
      </div>
    </>}
    {(error||lookupError)&&<p className="vs-inline-error" role="alert">{systemMessage(error||lookupError)}</p>}
    {record&&<div className="vs-previz-result">
      <div className="vs-previz-result-heading"><h4>{t('当前镜头预演')}</h4>
        <span className={`vs-status-pill ${record.approvedAt?'is-ok':'is-warn'}`}>{record.approvedAt?t('预演已确认'):t('等待确认')}</span>
      </div>
      <div className="vs-previz-grid">
        {[{file:image,label:t('白模关键帧')},{file:depth,label:t('深度参考')}].map(({file,label})=>file&&<figure key={file.id}><img loading="lazy" src={assetUrl(file)} alt={label}/><figcaption>{label}</figcaption></figure>)}
      </div>
      {video&&<video className="vs-previz-video" aria-label={t('白模预演视频')} controls src={assetUrl(video)} preload="metadata"/>}
      {!record.approvedAt&&<Button icon="check" disabled={disabled} onClick={()=>void approve(record)}>{t('确认预演')}</Button>}
    </div>}
  </section>;
}
