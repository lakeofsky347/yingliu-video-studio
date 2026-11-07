import {createHash} from 'node:crypto';
import {assertProductionComposition} from '../core/production-policy.ts';
import {validateDirectorPlan,requiresNativeAudio,type DirectorPlan,type QualityCheck,type QualityReport,type TrustedReview} from '../director/index.ts';
import type {WorkflowCandidate} from './contracts.ts';
export const candidateHash=(candidate:WorkflowCandidate)=>createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
/** Deterministic checks do not make claims about unseen motion or unheard audio. */
export function candidateQuality(candidate:WorkflowCandidate,plan:DirectorPlan|undefined,visual:'code'|'image'|'video'):QualityReport {
  const checks:QualityCheck[]=[];
  const structural=(id:string,work:()=>void)=>{try{work();checks.push({id,category:'structure',severity:'hard',status:'pass',message:'结构校验通过',confidence:1,evidence:[{kind:'structural'}]});}catch(error){checks.push({id,category:'structure',severity:'hard',status:'fail',message:error instanceof Error?error.message:String(error),confidence:1,evidence:[{kind:'structural'}]});}};
  const selected=plan?.shots.map(s=>s.shotId)??candidate.project.shotOrder;
  structural('production-composition',()=>assertProductionComposition({...candidate.project,shotOrder:selected},{forExport:true}));
  if(visual==='video')structural('video-no-code',()=>{if(Object.keys(candidate.sources).length)throw new Error('视频候选不得提交动画源码');});
  if(plan)for(const [i,issue] of validateDirectorPlan(plan).issues.entries())checks.push({id:`plan-issue:${i}`,category:'plan',severity:issue.severity==='error'?'hard':'advisory',status:issue.severity==='error'?'fail':'needs-review',message:issue.path+': '+issue.message,evidence:[{kind:'structural'}]});
  for(const shot of plan?.shots??[]){
    const actual=candidate.project.shots.find(s=>s.id===shot.shotId),fps=candidate.project.target.fps.num/candidate.project.target.fps.den;
    structural(`duration:${shot.shotId}`,()=>{if(!actual)throw new Error('导演镜头不存在');if(actual.durationFrames/fps+1e-6<shot.durationSeconds)throw new Error('成片时长不足以容纳已规划事件');});
    if(visual==='video'){
      const clip=candidate.project.videoClips?.find(c=>c.shotId===shot.shotId),asset=candidate.project.assets.find(a=>a.id===clip?.assetId);
      structural(`audio-strategy:${shot.shotId}`,()=>{
        if(!clip||!asset)throw new Error('缺少视频候选');
        if(shot.audioStrategy==='native'&&(clip.audio!=='keep'||candidate.project.target.audioMode==='none'))throw new Error('原生声轨被静音或替换');
        if(requiresNativeAudio(shot)&&asset.hasAudio!==true)throw new Error('要求原生表演声音，但候选没有音轨');
        if(shot.audioStrategy!=='native'&&clip.audio!=='mute')throw new Error('外配音或静音策略不能意外保留原声');
      });
    }
    if(visual==='video'||shot.performance.length||shot.dialogue.length||shot.events.length){
      checks.push({id:`temporal:${shot.shotId}`,shotId:shot.shotId,category:'timing',severity:'hard',status:'unchecked',message:'尚未检验实际视频的动作、节拍、口型与全时段连续性；关键静帧不能验证这些条件'});
      if(shot.audioStrategy!=='silent')checks.push({id:`audio:${shot.shotId}`,shotId:shot.shotId,category:'audio',severity:'hard',status:'unchecked',message:'尚未听检实际声轨与对白事件；计划内截断、重复、抢话必须按计划审看，不自动纠正'});
    }
    for(const condition of shot.acceptance)checks.push({id:`acceptance:${shot.shotId}:${condition.id}`,shotId:shot.shotId,category:condition.category,severity:condition.severity,status:'unchecked',message:condition.description});
  }
  return decide({version:1,candidateHash:candidateHash(candidate),decision:'pass',checks});
}
export function decide(report:QualityReport,trusted?:TrustedReview):QualityReport {
  const valid=trusted?.candidateHash===report.candidateHash?new Set(trusted.checkIds):new Set<string>();
  const checks=report.checks.map(check=>check.status==='fail'&&check.severity==='advisory'?{...check,status:'needs-review' as const}:check).map(check=>valid.has(check.id)&&(check.status==='unchecked'||check.status==='needs-review')?{...check,status:'pass' as const,message:check.message+'（用户已审看确认）',evidence:[...(check.evidence??[]),{kind:'human' as const,note:'可信宿主确认；绑定当前候选 hash'}]}:check);
  const fail=checks.some(c=>c.status==='fail'&&c.severity==='hard'),pending=checks.some(c=>c.status==='unchecked'||c.status==='needs-review'||c.status==='fail');
  return {...report,checks,decision:fail?'fail':pending?'needs-review':'pass'};
}
/** Only the fixed sampled-frame visual check may be satisfied by the frame model. */
export function frameQuality(raw:string,evidence:{frame:number;sha256:string}[]):QualityCheck {
  const base={id:'sampled-frames',category:'visual',severity:'hard' as const,evidence:evidence.map(e=>({kind:'frame' as const,...e}))};
  if(!evidence.length)return {...base,status:'unchecked',message:'没有实际关键帧证据，不能判定视觉检查通过；请审看当前候选。'};
  try{
    const value=JSON.parse(raw),check=value?.visual;
    if(!check||!['pass','fail','uncertain'].includes(check.verdict)||typeof check.confidence!=='number'||!Number.isFinite(check.confidence)||check.confidence<0||check.confidence>1||typeof check.message!=='string'||!check.message.trim())throw new Error('invalid');
    return {...base,status:check.confidence<.8||check.verdict==='uncertain'?'needs-review':check.verdict,message:check.message,confidence:check.confidence};
  }catch{return {...base,status:'unchecked',message:'视觉返回没有有效的结构化结论；请人工审看抽样帧。原始意见保留在步骤记录。'};}
}
