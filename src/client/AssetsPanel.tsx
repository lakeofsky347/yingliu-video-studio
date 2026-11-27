import { useRef, useState } from 'react';
import type { Asset, VideoProject } from '../shared/types.ts';
import { t, useLocale } from './i18n.ts';
import { Icon, IconButton } from './icons.tsx';

const ACCEPT='image/png,image/jpeg,image/webp,.txt,.md,text/plain,text/markdown,audio/*,video/*,.mp4,.mov,.m4v,.webm,.mkv,.wav,.mp3,.m4a,.aac,.flac,.ogg';
type Kind='all'|Asset['kind'];
const KIND_ICON:Record<Asset['kind'],string>={image:'image',text:'text',audio:'music',video:'video'};

export function AssetsPanel({project,selectedId,assetUrl,pending,locked,onSelect,onImport,onAddText,onDelete,onClose}:{
  project:VideoProject;selectedId:string|null;assetUrl:(asset:Asset)=>string;pending:boolean;locked:boolean;
  onSelect:(id:string)=>void;onImport:(files:FileList)=>void;onAddText:()=>void;onDelete:(asset:Asset)=>void;onClose?:()=>void;
}){
  useLocale();
  const file=useRef<HTMLInputElement>(null),[query,setQuery]=useState(''),[kind,setKind]=useState<Kind>('all'),[dropping,setDropping]=useState(0);
  const needle=query.trim().toLocaleLowerCase();
  const counts=project.assets.reduce<Record<string,number>>((all,asset)=>({...all,[asset.kind]:(all[asset.kind]||0)+1}),{});
  const kinds=(['image','text','audio','video'] as const).filter(value=>counts[value]);
  const activeKind=kind==='all'||counts[kind]?kind:'all';
  const visible=project.assets.filter(asset=>(activeKind==='all'||asset.kind===activeKind)&&(!needle||`${asset.name} ${asset.description} ${asset.text||''}`.toLocaleLowerCase().includes(needle)));
  const uses=(asset:Asset)=>project.shots.filter(shot=>shot.assetIds.includes(asset.id)||shot.referenceIds.includes(asset.id)).length;
  const label:Record<Kind,string>={all:t("全部"),image:t("图片"),text:t("文字"),audio:t("音频"),video:t("视频")};
  return <aside className={`vs-assets-panel ${dropping?'is-dropping':''}`} aria-label={t("资产库")}
    onDragEnter={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();setDropping(value=>value+1);}}}
    onDragLeave={event=>{if(event.dataTransfer.types.includes('Files'))setDropping(value=>Math.max(0,value-1));}}
    onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}}
    onDrop={event=>{setDropping(0);if(event.dataTransfer.files.length){event.preventDefault();onImport(event.dataTransfer.files);}}}>
    <div className="vs-panel-header">
      <h2>{t("资产库 ")}<small>{project.assets.length}</small></h2>
      <div className="vs-panel-header-actions">
        <IconButton icon="text" label={t("添加文字")} onClick={onAddText} disabled={locked}/>
        <IconButton icon="upload" label={t("导入图片、文字或音频")} onClick={()=>file.current?.click()} disabled={pending||locked}/>
        {onClose&&<IconButton icon="close" className="vs-assets-close" label={t("收起资产库")} onClick={onClose}/>}
      </div>
    </div>
    <div className="vs-search-box"><Icon name="search"/><input className="vs-search" type="search" aria-label={t("搜索资产")} placeholder={t("搜索图片、文字、音频…")} value={query} onChange={e=>setQuery(e.target.value)}/></div>
    {kinds.length>1&&<div className="vs-chip-row" role="group" aria-label={t("按类型筛选")}>{(['all',...kinds] as Kind[]).map(value=><button type="button" key={value} aria-pressed={activeKind===value} className={`vs-chip ${activeKind===value?'is-active':''}`} onClick={()=>setKind(value)}>{label[value]}<small>{value==='all'?project.assets.length:counts[value]}</small></button>)}</div>}
    <input ref={file} hidden multiple type="file" accept={ACCEPT} onChange={e=>{if(e.target.files)onImport(e.target.files);e.target.value='';}}/>
    <div className="vs-assets">
      {visible.map(asset=>{const count=uses(asset),url=asset.kind==='image'?assetUrl(asset):'';return <div key={asset.id} className={`vs-asset ${selectedId===asset.id?'is-selected':''}`}>
        <button type="button" className="vs-asset-main" draggable onDragStart={e=>{e.dataTransfer.setData('application/x-dsh-video-asset',asset.id);e.dataTransfer.effectAllowed='move';}} onClick={()=>onSelect(asset.id)} aria-pressed={selectedId===asset.id}>
          <span className={`vs-asset-thumb is-${asset.kind}`}>{url?<img src={url} alt="" loading="lazy"/>:asset.kind==='audio'?<span className="vs-mini-wave" aria-hidden="true"><i/><i/><i/><i/><i/></span>:<Icon name={KIND_ICON[asset.kind]}/>}</span>
          <span className="vs-asset-text"><strong>{asset.name}</strong><small>{asset.kind==='image'?asset.width&&asset.height?`${asset.width} × ${asset.height}`:t("图片素材"):asset.kind==='audio'?t("{value0} 秒 · 音频", {value0: (asset.duration||0).toFixed(1)}):asset.kind==='video'?t("{value0} 秒 · 视频", {value0: (asset.duration||0).toFixed(1)}):truncate(asset.text||asset.description,38)}</small></span>
          {count>0&&<span className="vs-asset-uses" title={t("已用于 {value0} 个镜头", {value0:count})}>{count}</span>}
        </button>
        <IconButton icon="delete" className="vs-asset-delete" label={t("删除资产「{value0}」", {value0:asset.name})} onClick={()=>onDelete(asset)} disabled={locked}/>
      </div>;})}
      {!project.assets.length&&<button type="button" className="vs-assets-empty" onClick={()=>file.current?.click()} disabled={pending||locked}><span><Icon name="upload"/></span><strong>{t("把图片拖到这里")}</strong><small>{t("或添加一段文字，")}{t("连接到镜头的「使用」或「参考」端口。")}</small></button>}
      {project.assets.length>0&&!visible.length&&<p className="vs-assets-none">{t("没有匹配的资产")}</p>}
    </div>
    <div className="vs-drop-veil" aria-hidden="true"><Icon name="upload"/><span>{t("松开即可导入")}</span></div>
  </aside>;
}
function truncate(value:string,length:number):string{const units=[...value];return units.length>length?units.slice(0,length-1).join('')+'…':value;}
