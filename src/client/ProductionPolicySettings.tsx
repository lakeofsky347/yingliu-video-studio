import {useEffect,useState} from 'react';
import type {ProductionMode,VideoProject} from '../shared/types.ts';
import type {StudioController} from './controller.ts';

/** Uses the existing requirements panel. No new page, dock, or workspace layout. */
export function ProductionPolicySettings({project,controller}:{project:VideoProject;controller:StudioController}){
  const policy=project.productionPolicy;
  const [mode,setMode]=useState<ProductionMode>(policy?.mode??'unresolved');
  const [baseMode,setBaseMode]=useState<'code_animation'|'model_video'>('code_animation');
  const [images,setImages]=useState(false),[imports,setImports]=useState(false),[shots,setShots]=useState<string[]>([]),[saving,setSaving]=useState(false);
  useEffect(()=>{setMode(policy?.mode??'unresolved');setBaseMode(policy?.baseMode??(policy?.mode==='model_video'?'model_video':'code_animation'));setImages(policy?.allowGeneratedImages??false);setImports(policy?.allowImportedVideo??false);setShots([...new Set(policy?.hybridGrants?.flatMap(grant=>grant.shotIds)??[])]);},[project.id,JSON.stringify(policy)]);
  async function save(){setSaving(true);try{await controller.action('production.set',{mode,baseMode,allowGeneratedImages:images,allowImportedVideo:imports,shotIds:shots,operations:['code','video']},'制作策略已保存；后续任务与导出均按此约束执行。');}finally{setSaving(false);}}
  return <fieldset disabled={saving} className="vs-media-images"><legend>制作模式与允许范围</legend>
    <label className="vs-field"><span>本工程制作模式</span><select aria-label="本工程制作模式" value={mode} onChange={event=>setMode(event.target.value as ProductionMode)}><option value="unresolved">尚未确认</option><option value="code_animation">代码动画 · 禁止调用视频生成模型</option><option value="model_video">模型视频 · 不执行动画源码</option><option value="hybrid">明确混合 · 仅允许指定镜头</option></select></label>
    {mode==='hybrid'&&<><label className="vs-field"><span>未授权混合的镜头继续使用</span><select aria-label="混合基线模式" value={baseMode} onChange={event=>setBaseMode(event.target.value as typeof baseMode)}><option value="code_animation">代码动画</option><option value="model_video">模型视频</option></select></label><p>仅以下勾选镜头允许使用代码和视频画面；新镜头不会自动继承混合许可。</p>{project.shots.map(shot=><label key={shot.id}><input type="checkbox" checked={shots.includes(shot.id)} onChange={event=>setShots(ids=>event.target.checked?[...ids,shot.id]:ids.filter(id=>id!==shot.id))}/>{shot.title}</label>)}</>}
    <label><input type="checkbox" checked={images} onChange={event=>setImages(event.target.checked)}/>允许生成静态图片素材（上传参考图仍需本次选择）</label>
    <label><input type="checkbox" checked={imports} onChange={event=>setImports(event.target.checked)}/>允许采用自有或未知来源的视频素材（代码模式仍禁止绑定动态视频）</label>
    <p className="vs-media-help">切换会停用不兼容画面并保留历史；不会自动重生成或跨模式补片。模型配置和“继续生成”不改变此范围。</p>
    <button className="vs-primary" disabled={saving||(mode==='hybrid'&&!shots.length)} onClick={()=>void save()}>确认并保存制作策略</button>
  </fieldset>;
}
