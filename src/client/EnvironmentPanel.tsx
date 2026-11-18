import { cloneElement, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { StudioSnapshot } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { t, useLocale } from './i18n.ts';
import { Button, Icon } from './icons.tsx';

/** Labelled form row. A bare input/textarea/select child also receives the label as its exact accessible name. */
export function Field({label,children,hint,className=''}:{label:string;children:ReactNode;hint?:string;className?:string}){
  const control=isValidElement(children)&&typeof children.type==='string'&&['input','textarea','select'].includes(children.type)
    ?cloneElement(children as ReactElement<{'aria-label'?:string}>,{'aria-label':label}):children;
  return <label className={`vs-field ${className}`.trim()}><span>{label}</span>{control}{hint&&<small>{hint}</small>}</label>;
}

export function EnvironmentPanel({controller,snapshot}:{controller:StudioController;snapshot:StudioSnapshot}){
  useLocale();
  const [settings,setSettings]=useState({...snapshot.environment});useEffect(()=>setSettings({...snapshot.environment}),[snapshot.environment]);
  const checks=[['browserPath',t("Chromium 浏览器"),'browserAvailable'],['ffmpegPath',t("FFmpeg 编码器"),'ffmpegAvailable'],['ffprobePath',t("ffprobe 媒体检查"),'ffprobeAvailable']] as const;
  const ready=checks.every(([, ,available])=>snapshot.environment[available]);
  const validLimit=settings.maxVideoBytes===undefined||Number.isInteger(settings.maxVideoBytes/(1024*1024))&&settings.maxVideoBytes>=1024*1024&&settings.maxVideoBytes<=512*1024*1024;
  return <div className="vs-environment">
    <div className="vs-environment-intro">
      <span className={`vs-status-pill ${ready?'is-ok':'is-warn'}`}><Icon name={ready?'check':'warning'}/>{ready?t("本地渲染工具已就绪"):t("检查本地渲染环境")}</span>
      <h3>{t("本地渲染环境")}</h3>
      <p>{t("预览在浏览器中运行；成片由本地 Chromium 逐帧捕获，再交给 FFmpeg 编码。路径留空时使用已检测到的环境。")}</p>
    </div>
    <div className="vs-environment-fields">
      {checks.map(([key,label,available])=><label className="vs-field" key={key}><span>{label}</span><div className="vs-env-row"><span className={snapshot.environment[available]?'is-ready':'is-missing'}><i/>{snapshot.environment[available]?t("已就绪"):t("待配置")}</span><input aria-label={label} value={settings[key]} placeholder={t("工具的绝对路径")} onChange={e=>setSettings({...settings,[key]:e.target.value})}/></div></label>)}
      <label className="vs-field"><span>{t("视频文件上限（MiB）")}</span><input aria-label={t("视频文件上限（MiB）")} type="number" min="1" max="512" step="1" value={(settings.maxVideoBytes??512*1024*1024)/(1024*1024)} onChange={event=>setSettings({...settings,maxVideoBytes:Number(event.target.value)*1024*1024})}/><small>{t("每个导入或生成视频的最大大小，默认 512 MiB。可降低上限以控制本地存储和处理开销。")}</small></label>
      <Button variant="primary" icon="check" disabled={!validLimit} onClick={()=>void controller.action('environment',{browserPath:settings.browserPath,ffmpegPath:settings.ffmpegPath,ffprobePath:settings.ffprobePath,maxVideoBytes:settings.maxVideoBytes??512*1024*1024},'环境配置已更新。')}>{t("保存并检查环境")}</Button>
    </div>
  </div>;
}
