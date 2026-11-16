import {t, useLocale, systemMessage} from './i18n.ts';
import {useEffect,useRef,useState} from 'react';
import type {LocalSfxSpec} from '../media/local-sfx.ts';
import type {StudioController} from './controller.ts';
export function LocalSfxPanel({controller,busy}:{controller:StudioController;busy:boolean}){
  useLocale();
  const [spec,setSpec]=useState<LocalSfxSpec>({kind:'chime',durationSeconds:.5,frequency:880,endFrequency:1760,volume:.6,seed:1}),[name,setName]=useState(t("提示音")),[working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const request=useRef<string|undefined>(undefined),active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const change=(patch:Partial<LocalSfxSpec>)=>{setSpec(value=>({...value,...patch}));request.current=undefined;setNotice('');};
  async function generate(){setWorking(true);setError('');request.current??=crypto.randomUUID();try{await controller.mediaCommand('audio.sfx',{name,spec,requestId:request.current},true);if(active.current){setNotice("本地音效已导入并加入全片音效轨。可在下方试听，调整片段起点、音量与裁剪。");request.current=undefined;}}catch(cause){if(active.current)setError(cause instanceof Error?cause.message:String(cause));}finally{if(active.current)setWorking(false);}}
  const disabled=busy||working;
  return <details className="vs-media-advanced" data-local-sfx><summary>{t("本地合成音效")}</summary><p className="vs-media-help">{t("提示音、扫频和噪声音效在本机合成，不调用模型。相同参数和种子生成相同声音。")}</p>
    {error&&<p className="vs-inline-error" role="alert">{systemMessage(error)}</p>}{notice&&<p className="vs-media-success" role="status">{systemMessage(notice)}</p>}
    <div className="vs-field-pair"><label className="vs-field"><span>{t("音效名称")}</span><input aria-label={t("本地音效名称")} disabled={disabled} value={name} maxLength={60} onChange={event=>{setName(event.target.value);request.current=undefined;}}/></label><label className="vs-field"><span>{t("音效类型")}</span><select aria-label={t("本地音效类型")} disabled={disabled} value={spec.kind} onChange={event=>change({kind:event.target.value as LocalSfxSpec['kind']})}>{[['chime',t("钟声")],['tone',t("单音")],['sweep',t("扫频")],['noise',t("噪声冲击")],['whoosh',t("风声")],['click',t("点击")]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
    <div className="vs-field-pair"><label className="vs-field"><span>{t("时长（秒）")}</span><input aria-label={t("本地音效时长")} type="number" min="0.05" max="10" step="0.05" disabled={disabled} value={spec.durationSeconds} onChange={event=>change({durationSeconds:Number(event.target.value)})}/></label><label className="vs-field"><span>{t("音量")}</span><input aria-label={t("本地音效音量")} type="number" min="0" max="1" step="0.05" disabled={disabled} value={spec.volume} onChange={event=>change({volume:Number(event.target.value)})}/></label></div>
    <div className="vs-field-pair"><label className="vs-field"><span>{t("起始频率（Hz）")}</span><input aria-label={t("本地音效起始频率")} type="number" min="20" max="12000" disabled={disabled} value={spec.frequency} onChange={event=>change({frequency:Number(event.target.value)})}/></label><label className="vs-field"><span>{t("结束频率（Hz，扫频使用）")}</span><input aria-label={t("本地音效结束频率")} type="number" min="20" max="12000" disabled={disabled||spec.kind!=='sweep'} value={spec.endFrequency} onChange={event=>change({endFrequency:Number(event.target.value)})}/></label></div>
    <label className="vs-field"><span>{t("声音种子（整数）")}</span><input aria-label={t("本地音效种子")} type="number" min="0" max="4294967295" step="1" disabled={disabled} value={spec.seed} onChange={event=>change({seed:Number(event.target.value)})}/></label><button disabled={disabled||!name.trim()} onClick={()=>void generate()}>{working?t("正在合成…"):t("合成并加入音轨")}</button>
  </details>;
}
