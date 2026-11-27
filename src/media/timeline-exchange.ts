import type {AudioClip,VideoTarget} from '../shared/types.ts';

export interface ExchangeVideoClip {shotId:string;title:string;media:string;startFrame:number;durationFrames:number}
export interface ExchangeAudioClip {clipId:string;title:string;media:string;role:AudioClip['role'];startSample:number;durationSamples:number}
export interface ExchangeTimeline {
  title:string;
  target:VideoTarget;
  durationFrames:number;
  video:ExchangeVideoClip[];
  audio:ExchangeAudioClip[];
}

const sampleRate=48_000;
const roles={voice:'Dialogue',music:'Music',sfx:'Effects'};

/** Clips in one editorial track are sequential. Allocate another track when sounds overlap. */
function audioTracks(clips:ExchangeAudioClip[]):{name:string;clips:ExchangeAudioClip[]}[] {
  return (Object.keys(roles) as AudioClip['role'][]).flatMap(role=>{
    const lanes:{end:number;clips:ExchangeAudioClip[]}[]=[];
    const ordered=clips.filter(clip=>clip.role===role).sort((a,b)=>a.startSample-b.startSample);
    for(const clip of ordered){
      let lane=lanes.find(item=>item.end<=clip.startSample);
      if(!lane){lane={end:0,clips:[]};lanes.push(lane);}
      lane.clips.push(clip);lane.end=clip.startSample+clip.durationSamples;
    }
    return lanes.map((lane,index)=>({name:`${roles[role]} ${index+1}`,clips:lane.clips}));
  });
}

function relativeUrl(path:string):string {return './'+path.split('/').map(encodeURIComponent).join('/');}
function xml(value:string):string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[character]!);
}

export function formatExchangeOtio(timeline:ExchangeTimeline):string {
  const time=(value:number,rate:number)=>({OTIO_SCHEMA:'RationalTime.1',value,rate});
  const range=(duration:number,rate:number)=>({OTIO_SCHEMA:'TimeRange.1',start_time:time(0,rate),duration:time(duration,rate)});
  const item={metadata:{},effects:[],markers:[],enabled:true};
  const clip=(name:string,media:string,duration:number,rate:number)=>({OTIO_SCHEMA:'Clip.1',...item,name,source_range:range(duration,rate),
    media_reference:{OTIO_SCHEMA:'ExternalReference.1',metadata:{},name,target_url:relativeUrl(media),available_range:range(duration,rate)}});
  const track=(name:string,kind:'Video'|'Audio',children:unknown[])=>({OTIO_SCHEMA:'Track.1',...item,name,kind,source_range:null,children});
  const rate=timeline.target.fps.num/timeline.target.fps.den;
  const children=[track('Picture','Video',timeline.video.map(shot=>clip(shot.title,shot.media,shot.durationFrames,rate))),
    ...audioTracks(timeline.audio).map(lane=>{
      const clips:unknown[]=[];let cursor=0;
      for(const sound of lane.clips){
        if(sound.startSample>cursor)clips.push({OTIO_SCHEMA:'Gap.1',...item,name:'',source_range:range(sound.startSample-cursor,sampleRate)});
        clips.push(clip(sound.title,sound.media,sound.durationSamples,sampleRate));cursor=sound.startSample+sound.durationSamples;
      }
      return track(lane.name,'Audio',clips);
    })];
  return JSON.stringify({OTIO_SCHEMA:'Timeline.1',metadata:{},name:timeline.title,global_start_time:time(0,rate),
    tracks:{OTIO_SCHEMA:'Stack.1',...item,name:'Tracks',source_range:null,children}},null,2)+'\n';
}

function gcd(a:bigint,b:bigint):bigint {return b?gcd(b,a%b):a;}
function seconds(numerator:bigint,denominator:bigint):string {
  if(!numerator)return '0s';
  const divisor=gcd(numerator<0n?-numerator:numerator,denominator),whole=numerator/divisor,part=denominator/divisor;
  return part===1n?`${whole}s`:`${whole}/${part}s`;
}

export function formatExchangeFcpxml(timeline:ExchangeTimeline):string {
  const {target}=timeline,{num,den}=target.fps;
  const frameNum=BigInt(den),frameDen=BigInt(num),samplesPerSecond=BigInt(sampleRate);
  const frameTime=(frames:number)=>seconds(BigInt(frames)*frameNum,frameDen);
  const sampleTime=(samples:number)=>seconds(BigInt(samples),samplesPerSecond);
  const mediaRep=(media:string)=>`<media-rep kind="original-media" src="${xml(relativeUrl(media))}"/>`;
  const videoId=(index:number)=>`r${index+2}`;
  const audioIds=new Map(timeline.audio.map((sound,index)=>[sound.media,`r${timeline.video.length+index+2}`]));
  const resources=[`    <format id="r1" frameDuration="${frameTime(1)}" width="${target.width}" height="${target.height}"/>`,
    ...timeline.video.map((shot,index)=>`    <asset id="${videoId(index)}" name="${xml(shot.title)}" start="0s" duration="${frameTime(shot.durationFrames)}" format="r1" hasVideo="1" videoSources="1">${mediaRep(shot.media)}</asset>`),
    ...timeline.audio.map(sound=>`    <asset id="${audioIds.get(sound.media)}" name="${xml(sound.title)}" start="0s" duration="${sampleTime(sound.durationSamples)}" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000">${mediaRep(sound.media)}</asset>`)];
  const connected=timeline.video.map(()=>[] as string[]);
  for(const [laneIndex,lane] of audioTracks(timeline.audio).entries())for(const sound of lane.clips){
    const sampleInSharedUnits=BigInt(sound.startSample)*frameDen,framesToSharedUnits=frameNum*samplesPerSecond;
    const anchor=timeline.video.findIndex(shot=>sampleInSharedUnits<BigInt(shot.startFrame+shot.durationFrames)*framesToSharedUnits);
    if(anchor<0)throw new Error('音频片段缺少连接镜头');
    const shot=timeline.video[anchor]!;
    const offset=seconds(sampleInSharedUnits-BigInt(shot.startFrame)*framesToSharedUnits,samplesPerSecond*frameDen);
    const audioRole={voice:'dialogue',music:'music',sfx:'effects'}[sound.role];
    connected[anchor]!.push(`            <asset-clip name="${xml(sound.title)}" lane="-${laneIndex+1}" offset="${offset}" ref="${audioIds.get(sound.media)}" start="0s" duration="${sampleTime(sound.durationSamples)}" audioRole="${audioRole}"/>`);
  }
  const clips=timeline.video.flatMap((shot,index)=>{
    const opening=`          <asset-clip name="${xml(shot.title)}" ref="${videoId(index)}" offset="${frameTime(shot.startFrame)}" start="0s" duration="${frameTime(shot.durationFrames)}" format="r1"`;
    return connected[index]!.length?[opening+'>',...connected[index]!,'          </asset-clip>']:[opening+'/>'];
  });
  return ['<?xml version="1.0" encoding="UTF-8"?>','<!DOCTYPE fcpxml>','<fcpxml version="1.10">','  <resources>',...resources,'  </resources>',
    `  <library><event name="Yingliu"><project name="${xml(timeline.title)}">`,
    `    <sequence format="r1" duration="${frameTime(timeline.durationFrames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    '        <spine>',...clips,'        </spine>','    </sequence>','  </project></event></library>','</fcpxml>',''].join('\n');
}

function cmxNominalRate(timeline:ExchangeTimeline):number|undefined {
  const {num,den}=timeline.target.fps,rate=num/den;
  return [24,25,30].find(nominal=>Math.abs(rate-nominal)<.000001||nominal!==25&&Math.abs(rate-nominal*1000/1001)<.000001);
}

export function exchangeEdlLimitation(timeline:ExchangeTimeline):string|undefined {
  const rate=cmxNominalRate(timeline);
  if(!rate)return 'CMX3600 EDL 仅输出 23.976、24、25、29.97 或 30 FPS 时间轴';
  if(timeline.video.length>999)return 'CMX3600 EDL 最多支持 999 个镜头';
  if(timeline.durationFrames>=24*60*60*rate)return 'CMX3600 EDL 时间码不能跨越 24 小时';
  return undefined;
}

/** CMX3600 only represents the video cut list; alternate audio tracks stay in OTIO and FCPXML. */
export function formatExchangeEdl(timeline:ExchangeTimeline):string {
  const limitation=exchangeEdlLimitation(timeline);if(limitation)throw new Error(limitation);
  const nominal=cmxNominalRate(timeline)!;
  const time=(frame:number)=>[Math.floor(frame/nominal/3600),Math.floor(frame/nominal/60)%60,Math.floor(frame/nominal)%60,frame%nominal]
    .map(part=>String(part).padStart(2,'0')).join(':');
  const safe=(value:string)=>value.replace(/[\u0000-\u001f]/g,' ');
  return [`TITLE: ${safe(timeline.title)}`,'FCM: NON-DROP FRAME','',...timeline.video.flatMap((shot,index)=>{
    const event=String(index+1).padStart(3,'0'),reel='YL'+String(index+1).padStart(6,'0');
    const file=shot.media.split('/').at(-1);
    return [`${event}  ${reel} V     C        ${time(0)} ${time(shot.durationFrames)} ${time(shot.startFrame)} ${time(shot.startFrame+shot.durationFrames)}`,
      `* FROM CLIP NAME: ${file}`,`* FROM FILE: ${shot.media}`,`* COMMENT: ${safe(shot.title)}`,''];
  })].join('\n');
}
