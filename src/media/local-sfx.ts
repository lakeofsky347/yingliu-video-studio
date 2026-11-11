/** Deterministic local synthesis. No model, network or paid fallback is involved. */
export interface LocalSfxSpec {kind:'tone'|'sweep'|'chime'|'noise'|'whoosh'|'click';durationSeconds:number;frequency?:number;endFrequency?:number;volume?:number;seed?:number}
const RATE=44100;
function number(value:unknown,fallback:number,min:number,max:number,label:string):number {
  if(value===undefined)return fallback;
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`${label}须在 ${min}–${max} 之间`);
  return value;
}
export function synthesizeLocalSfx(spec:LocalSfxSpec):Uint8Array {
  if(!spec||!['tone','sweep','chime','noise','whoosh','click'].includes(spec.kind))throw new Error('请选择支持的本地音效类型');
  const duration=number(spec.durationSeconds,.5,.05,10,'音效时长'),f0=number(spec.frequency,440,20,12000,'起始频率'),f1=number(spec.endFrequency,Math.min(12000,f0*2),20,12000,'结束频率'),volume=number(spec.volume,.6,0,1,'音效音量');
  let seed=number(spec.seed,1,0,0xffffffff,'音效种子');if(!Number.isInteger(seed))throw new Error('音效种子须为整数');seed=seed>>>0||1;
  const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return ((seed>>>0)/4294967296)*2-1;};
  const count=Math.floor(duration*RATE),buffer=new Uint8Array(44+count*2),view=new DataView(buffer.buffer);
  const ascii=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)buffer[offset+i]=value.charCodeAt(i);};
  ascii(0,'RIFF');view.setUint32(4,36+count*2,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,RATE,true);view.setUint32(28,RATE*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,count*2,true);
  let phase=0,low=0;
  for(let i=0;i<count;i++){
    const t=i/RATE,p=i/count;let envelope=Math.min(1,t/.01)*Math.min(1,(duration-t)/.05),sample=0;
    switch(spec.kind){
      case 'tone':sample=Math.sin(2*Math.PI*f0*t);break;
      case 'sweep':phase+=2*Math.PI*(f0+(f1-f0)*p)/RATE;sample=Math.sin(phase);break;
      case 'chime':envelope*=Math.exp(-4*t/duration);sample=.6*Math.sin(2*Math.PI*f0*t)+.3*Math.sin(2*Math.PI*f0*2.76*t)+.1*Math.sin(2*Math.PI*f0*5.4*t);break;
      case 'noise':envelope*=Math.exp(-6*t/duration);sample=random();break;
      case 'whoosh':low+=(random()-low)*(.02+.2*Math.sin(Math.PI*p));sample=low*3;envelope*=Math.sin(Math.PI*p);break;
      case 'click':envelope=Math.exp(-t*400);sample=Math.sin(2*Math.PI*2000*t);break;
    }
    view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,sample*envelope*volume))*32767),true);
  }
  return buffer;
}
