import type {EnvironmentInfo,TtsSettings} from './types.ts';

export function defaultTtsSettings(environment:Pick<EnvironmentInfo,'localSpeechAvailable'>):TtsSettings {
  return {endpoint:environment.localSpeechAvailable?'local:say':'',model:'',voice:'',speed:1,enabled:false};
}

/** Describe the configured speech capability without changing saved settings. */
export function ttsCapability(settings:Pick<TtsSettings,'endpoint'>|undefined,environment:Pick<EnvironmentInfo,'localSpeechAvailable'>):{available:boolean;message:string} {
  if(settings?.endpoint==='local:say'&&!environment.localSpeechAvailable)return {available:false,message:'当前系统没有可用的本机语音服务。可导入音频，或配置自己的语音接口。'};
  if(!settings?.endpoint.trim())return {available:false,message:'请填写自己的语音接口地址；导入音频无需配音服务。'};
  return {available:true,message:''};
}

export function validateTtsSettings(settings:TtsSettings,environment:Pick<EnvironmentInfo,'localSpeechAvailable'>):void {
  if(typeof settings.endpoint!=='string'||typeof settings.model!=='string'||typeof settings.voice!=='string'||typeof settings.enabled!=='boolean')throw new Error('配音服务配置无效');
  if(!Number.isFinite(settings.speed)||settings.speed<.25||settings.speed>4)throw new Error('配音速度须为 0.25–4');
  if(settings.requestTimeoutMs!==undefined&&(!Number.isSafeInteger(settings.requestTimeoutMs)||settings.requestTimeoutMs<1||settings.requestTimeoutMs>900000))throw new Error('配音超时须为 1–900000 毫秒');
  if(!settings.enabled)return;
  const capability=ttsCapability(settings,environment);if(!capability.available)throw new Error(capability.message);
  if(settings.endpoint==='local:say')return;
  let url:URL;try{url=new URL(settings.endpoint);}catch{throw new Error('语音端点须为有效的 HTTP 或 HTTPS 地址');}
  if(!['http:','https:'].includes(url.protocol))throw new Error('语音端点须为有效的 HTTP 或 HTTPS 地址');
  if(!settings.model.trim()||!settings.voice.trim())throw new Error('请填写配音模型和声音 ID');
}
