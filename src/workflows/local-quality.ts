import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {assertProductionComposition} from '../core/production-policy.ts';
import type {QualityCheck,QualityReport} from '../director/contracts.ts';
import {readDirectorDocument} from '../director/document.ts';
import type {AudioAcousticReport} from '../media/deconstruct.ts';
import type {SceneSource,VideoProject} from '../shared/types.ts';

export interface LocalQualityFrame {shotId:string;frame:number;bytes?:Uint8Array;error?:string}
export type LocalQualityAudioEvidence={status:'measured';report:AudioAcousticReport}|{status:'empty'}|{status:'unchecked';reason:string};
export interface LocalQualityReport extends QualityReport {
  projectId:string;revision:number;checkedAt:string;
  scope:{kind:'local-export';requestedFrames:{shotId:string;frame:number}[];checkedFrames:{shotId:string;frame:number;sha256:string}[];sampledShots:string[];unsampledShots:string[];unchecked:string[];audio?:LocalQualityAudioEvidence};
}
export function localQualityHash(project:VideoProject,sources:Record<string,SceneSource>):string{return createHash('sha256').update(JSON.stringify({project,sources})).digest('hex');}
/** Absolute timeline frames; a bounded, spread-out sample is never described as a full scan. */
export function localQualityFrames(project:VideoProject,max=12):{shotId:string;frame:number}[] {
  if(!Number.isSafeInteger(max)||max<1||max>36)throw new Error('质检抽样数量须为 1–36');
  const points:{shotId:string;frame:number}[]=[];let start=0;
  for(const id of project.shotOrder){const shot=project.shots.find(item=>item.id===id);if(!shot||!Number.isSafeInteger(shot.durationFrames)||shot.durationFrames<1)continue;
    for(const local of new Set([0,Math.floor((shot.durationFrames-1)/2),shot.durationFrames-1]))points.push({shotId:id,frame:start+local});start+=shot.durationFrames;}
  if(points.length<=max)return points;
  return Array.from({length:max},(_,i)=>points[Math.floor(i*(points.length-1)/Math.max(1,max-1))]!);
}
/** Bounded PNG decoder for non-interlaced 8-bit grayscale/RGB/RGBA capture output. Unsupported data stays unchecked. */
export function pngLuma(bytes:Uint8Array):{mean:number;std:number}|null {
  try{
    const b=Buffer.from(bytes);if(b.length<45||b.length>32*1024*1024||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return null;
    let p=8,width=0,height=0,channels=0,ended=false;const compressed:Buffer[]=[];
    while(p+12<=b.length){const length=b.readUInt32BE(p);if(length>b.length-p-12)return null;const type=b.toString('ascii',p+4,p+8),body=b.subarray(p+8,p+8+length);
      if(type==='IHDR'){if(p!==8||length!==13)return null;width=body.readUInt32BE(0);height=body.readUInt32BE(4);channels=({0:1,2:3,4:2,6:4} as Record<number,number>)[body[9]!]??0;if(!width||!height||width*height>16_000_000||body[8]!==8||body[10]!==0||body[11]!==0||body[12]!==0||!channels)return null;}
      else if(type==='IDAT'){if(!width)return null;compressed.push(body);}
      else if(type==='IEND'){ended=true;break;}
      p+=12+length;
    }
    if(!ended||!compressed.length||!width)return null;
    const stride=width*channels,expected=(stride+1)*height,raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected});if(raw.length!==expected)return null;
    let previous:Buffer=Buffer.alloc(stride),sum=0,squared=0,count=0;const step=Math.max(1,Math.floor(Math.max(width,height)/300));
    for(let y=0;y<height;y++){
      const filter=raw[y*(stride+1)]!;if(filter>4)return null;const line=Buffer.from(raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)));
      for(let x=0;x<stride;x++){const a=x>=channels?line[x-channels]!:0,up=previous[x]!,c=x>=channels?previous[x-channels]!:0;let prediction=0;
        if(filter===1)prediction=a;else if(filter===2)prediction=up;else if(filter===3)prediction=(a+up)>>1;else if(filter===4){const q=a+up-c,pa=Math.abs(q-a),pb=Math.abs(q-up),pc=Math.abs(q-c);prediction=pa<=pb&&pa<=pc?a:pb<=pc?up:c;}
        line[x]=(line[x]!+prediction)&255;}
      if(y%step===0)for(let x=0;x<width;x+=step){const o=x*channels,l=channels>=3?.2126*line[o]!+.7152*line[o+1]!+.0722*line[o+2]!:line[o]!;sum+=l;squared+=l*l;count++;}
      previous=line;
    }
    const mean=sum/count;return {mean,std:Math.sqrt(Math.max(0,squared/count-mean*mean))};
  }catch{return null;}
}
/** Local checks cover structure, captured pixels and, when supplied, measured audio. */
export function localExportQuality(project:VideoProject,sources:Record<string,SceneSource>,samples:LocalQualityFrame[],options:{now?:string;maxFrames?:number;audio?:LocalQualityAudioEvidence}={}):LocalQualityReport {
  const checks:QualityCheck[]=[],requested=localQualityFrames(project,options.maxFrames??12),checkedFrames:LocalQualityReport['scope']['checkedFrames']=[];
  const add=(id:string,category:string,severity:'hard'|'advisory',status:QualityCheck['status'],message:string,shotId?:string)=>checks.push({id,category,severity,status,message,...(shotId?{shotId}:{}),evidence:[{kind:'structural'}]});
  try{assertProductionComposition(project,{forExport:true});if(!project.shotOrder.length)throw new Error('没有可导出的主链镜头');add('local-composition','structure','hard','pass','主链画面来源和素材长度结构校验通过');}catch(error){add('local-composition','structure','hard','fail',error instanceof Error?error.message:String(error));}
  const fps=project.target.fps.num/project.target.fps.den,clips=project.audioClips??[];
  for(const clip of clips){
    const asset=project.assets.find(item=>item.id===clip.assetId);
    if(!asset||asset.kind!=='audio')add('audio-asset:'+clip.id,'audio','hard','fail','音轨引用的音频资产不存在',clip.shotId);
    if(clip.shotId&&!project.shots.some(shot=>shot.id===clip.shotId))add('audio-shot:'+clip.id,'audio','hard','fail','音轨引用的镜头不存在',clip.shotId);
    if(clip.volume===0)add('audio-volume:'+clip.id,'audio','advisory','needs-review','此音频片段音量为零，请确认是否为有意静音',clip.shotId);
  }
  if(project.target.audioMode==='mixed'&&!clips.length&&!project.videoClips?.some(clip=>clip.audio!=='mute'&&project.assets.find(asset=>asset.id===clip.assetId)?.hasAudio===true))add('audio-presence','audio','advisory','needs-review','混音模式下没有已知可播放的声轨；仅检查元数据，未听检实际声音');
  const audio=options.audio;
  if(audio?.status==='unchecked')add('audio-acoustics','audio','advisory','unchecked','未能实测总混音，请查看声学检查详情');
  if(audio?.status==='measured'){
    const {clippingRisk,tooQuiet,totalSilenceSeconds}=audio.report;
    const addAudio=(id:string,message:string,status:QualityCheck['status']='needs-review')=>checks.push({id,category:'audio',severity:'advisory',status,message,evidence:[{kind:'audio'}]});
    addAudio('audio-acoustics','已实测总混音响度、真峰值与静音区间','pass');
    if(clippingRisk)addAudio('audio-peak','总混音真峰值接近削波，请复听并检查电平');
    if(tooQuiet)addAudio('audio-loudness','总混音响度较低，请确认是否符合预期');
    if(totalSilenceSeconds>0)addAudio('audio-silence','总混音含连续静音区间，请确认是否为有意留白');
  }
  for(const id of project.shotOrder){
    const shot=project.shots.find(item=>item.id===id);if(!shot)continue;
    if(!Number.isSafeInteger(shot.durationFrames)||shot.durationFrames<1)add('duration-valid:'+id,'duration','hard','fail','镜头时长必须为正整数帧',id);
    const seconds=shot.durationFrames/fps,subtitle=typeof shot.params.subtitle==='string'?shot.params.subtitle:'';
    const perLine=Math.max(8,Math.floor(project.target.width/Math.max(24,project.target.height*.05)*.9));
    const lines=subtitle.split('\n').reduce((sum,line)=>sum+Math.max(1,Math.ceil([...line].length/perLine)),0);
    if(subtitle&&lines>2)add('subtitle-estimate:'+id,'subtitle','advisory','needs-review',`字幕文字量约 ${lines} 行；这是字数估算，须在实际画面检查排版`,id);
    for(const clip of clips.filter(clip=>clip.shotId===id&&clip.role==='voice')){const asset=project.assets.find(item=>item.id===clip.assetId);if(asset?.duration&&clip.startSeconds+Math.min(clip.trimEnd??asset.duration,asset.duration)-clip.trimStart>seconds+.05)add('voice-duration:'+clip.id,'audio','advisory','needs-review','配音片段超出镜头时长，请检查裁剪与对白安排',id);}
  }
  const duration=project.shotOrder.reduce((total,id)=>total+(project.shots.find(shot=>shot.id===id)?.durationFrames??0),0)/fps;
  if(project.targetDuration>0&&Math.abs(duration-project.targetDuration)/project.targetDuration>.2)add('target-duration','duration','advisory','needs-review',`实际主链 ${duration.toFixed(2)} 秒，与目标 ${project.targetDuration} 秒相差超过 20%`);
  try{const document=readDirectorDocument(project);if(document?.status==='approved')for(const shot of document.plan.shots)if(!project.shots.some(item=>item.id===shot.shotId))add('plan-shot:'+shot.shotId,'plan','hard','fail','已批准导演计划引用已不存在的镜头',shot.shotId);}catch(error){add('director-document','plan','hard','fail',error instanceof Error?error.message:String(error));}
  for(const requestedFrame of requested){
    const sample=samples.find(item=>item.frame===requestedFrame.frame&&item.shotId===requestedFrame.shotId),luma=sample?.bytes?pngLuma(sample.bytes):null;
    if(!luma){add('sample:'+requestedFrame.frame,'visual','advisory','unchecked',sample?.error?`抽样帧 ${requestedFrame.frame} 未检查：${sample.error.slice(0,300)}`:`抽样帧 ${requestedFrame.frame} 没有可分析的 PNG`,requestedFrame.shotId);continue;}
    const sha256=createHash('sha256').update(sample!.bytes!).digest('hex');checkedFrames.push({...requestedFrame,sha256});
    const dark=luma.mean<8&&luma.std<4,flat=luma.std<2;
    checks.push({id:'sample:'+requestedFrame.frame,shotId:requestedFrame.shotId,category:'visual',severity:'advisory',status:dark||flat?'needs-review':'pass',message:dark?'此抽样帧接近全黑，请确认是否为有意黑场':flat?'此抽样帧接近纯色，请检查画面是否正确渲染':'此抽样帧未发现近黑或纯色现象',evidence:[{kind:'frame',frame:requestedFrame.frame,sha256}]});
  }
  const sampledShots=[...new Set(checkedFrames.map(frame=>frame.shotId))],unsampledShots=project.shotOrder.filter(id=>!sampledShots.includes(id));
  const audioScope=audio?.status==='measured'?'声轨是否自然、对白是否清晰及听感平衡仍需人工审听':audio?.status==='empty'?'当前工程没有可供测量的声轨':'实际声轨的静音、失真、音量与听感未自动检查';
  return {version:1,projectId:project.id,revision:project.revision,checkedAt:options.now??new Date().toISOString(),candidateHash:localQualityHash(project,sources),decision:checks.some(check=>check.severity==='hard'&&check.status==='fail')?'fail':checks.some(check=>check.status!=='pass')?'needs-review':'pass',checks,
    scope:{kind:'local-export',requestedFrames:requested,checkedFrames,sampledShots,unsampledShots,unchecked:['完整视频的动作、连续性、口型与对白时序未自动检查',audioScope,'字幕仅按文字量估算，未测量实际渲染边界'],...(audio?{audio}:{})}};
}
