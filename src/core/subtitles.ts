import type { SpecShot, SubtitleCue, VideoProject, VideoTarget } from '../shared/types.ts';

export function validateSubtitles(value:unknown,shotIds:ReadonlySet<string>):string[]{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>5000)return ['字幕轨须为至多 5000 条的数组'];
  const ids=new Set<string>(),errors:string[]=[];
  for(const [index,cue] of value.entries()){
    if(!cue||typeof cue!=='object'||typeof cue.id!=='string'||!cue.id||ids.has(cue.id)||
      !Number.isFinite(cue.startSeconds)||!Number.isFinite(cue.endSeconds)||cue.startSeconds<0||
      cue.endSeconds<=cue.startSeconds||cue.endSeconds>1_000_000||
      typeof cue.text!=='string'||!cue.text.trim()||cue.text.length>4000||
      (cue.speaker!==undefined&&(typeof cue.speaker!=='string'||cue.speaker.length>120))||
      (cue.shotId!==undefined&&!shotIds.has(cue.shotId))){
      errors.push(`字幕第 ${index+1} 条的内容、时间、镜头引用或 ID 无效`);
    }
    if(typeof cue?.id==='string')ids.add(cue.id);
  }
  return errors;
}

/** Existing narration yields initial cues until the project has an explicit track. */
export function projectSubtitles(project:VideoProject):SubtitleCue[]{
  const secondsPerFrame=project.target.fps.den/project.target.fps.num;
  const byId=new Map(project.shots.map(shot=>[shot.id,shot]));
  let frame=0;
  const suggested:SubtitleCue[]=[];
  for(const id of project.shotOrder){
    const shot=byId.get(id);
    if(!shot)continue;
    const startSeconds=frame*secondsPerFrame;
    frame+=shot.durationFrames;
    const text=(shot.narration||shot.params.subtitle).trim();
    if(text&&!text.startsWith('编辑文字、绑定图片')){
      suggested.push({id:`subtitle-${id}`,shotId:id,startSeconds,endSeconds:frame*secondsPerFrame,text});
    }
  }
  const duration=frame*secondsPerFrame;
  return (project.subtitles??suggested).filter(cue=>cue.startSeconds<duration)
    .map(cue=>({...cue,endSeconds:Math.min(cue.endSeconds,duration)}))
    .sort((a,b)=>a.startSeconds-b.startSeconds);
}

export function sliceSubtitles(cues:SubtitleCue[]|undefined,shots:SpecShot[],target:VideoTarget):SubtitleCue[]|undefined{
  const secondsPerFrame=target.fps.den/target.fps.num;
  let offset=0;
  return cues&&shots.flatMap(shot=>{
    const start=shot.startFrame*secondsPerFrame,end=shot.endFrame*secondsPerFrame;
    const outputStart=offset;
    offset+=end-start;
    return cues.flatMap(cue=>{
      const first=Math.max(start,cue.startSeconds),last=Math.min(end,cue.endSeconds);
      return last>first?[{...cue,id:cue.id+'-'+shot.id,shotId:shot.id,startSeconds:first-start+outputStart,endSeconds:last-start+outputStart}]:[];
    });
  });
}

function timestamp(ticks:number,resolution:100|1000):string{
  const whole=Math.floor(ticks/resolution);
  const hours=String(Math.floor(whole/3600)).padStart(2,'0');
  const minutes=String(Math.floor(whole/60)%60).padStart(2,'0');
  const seconds=String(whole%60).padStart(2,'0');
  const fraction=String(ticks%resolution).padStart(resolution===1000?3:2,'0');
  return `${hours}:${minutes}:${seconds}${resolution===1000?',':'.'}${fraction}`;
}

function timeRange(cue:SubtitleCue,resolution:100|1000):[string,string]{
  const start=Math.round(cue.startSeconds*resolution),end=Math.max(start+1,Math.round(cue.endSeconds*resolution));
  return [timestamp(start,resolution),timestamp(end,resolution)];
}

function cueText(cue:SubtitleCue):string{
  return [cue.speaker,cue.text].filter(Boolean).join('：').replace(/\r\n?/g,'\n');
}

export function formatSrt(cues:SubtitleCue[]):string{
  return cues.map((cue,index)=>{
    const [start,end]=timeRange(cue,1000);
    const text=cueText(cue).replace(/\n[ \t]*\n+/g,'\n').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));
    return `${index+1}\n${start} --> ${end}\n${text}\n`;
  }).join('\n');
}

export function formatAss(cues:SubtitleCue[],target:VideoTarget):string{
  return [
    '[Script Info]','ScriptType: v4.00+',`PlayResX: ${target.width}`,`PlayResY: ${target.height}`,'WrapStyle: 0','',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,sans-serif,${Math.max(16,Math.round(Math.min(target.width,target.height)*.045))},&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,24,1`,'',
    '[Events]','Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map(cue=>{
      const [start,end]=timeRange(cue,100);
      const text=cueText(cue).replace(/[\\{}]/g,c=>({'\\':'＼','{':'｛','}':'｝'}[c]!)).replace(/\n/g,'\\N');
      return `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`;
    }),'',
  ].join('\n');
}
