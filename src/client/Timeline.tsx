import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { Shot } from '../shared/types.ts';
import { t, useLocale } from './i18n.ts';
import { Icon } from './icons.tsx';
import type { Playhead } from './playhead-store.ts';

interface ClipDrag {
  id:string;
  pointerId:number;
  startX:number;
  startY:number;
  x:number;
  y:number;
  moved:boolean;
}
/**
 * Proportional shot timeline. Clip widths follow duration, the playhead tracks the monitor without
 * re-rendering React, and clips reorder by drag (with an insertion marker) or Alt+←/→.
 */
export function Timeline({shots,fps,selectedId,locked,playhead,onSelect,onReorder,onAdd,onDelete}:{
  shots:Shot[];fps:number;selectedId:string|null;locked:boolean;playhead:Playhead;
  onSelect:(id:string)=>void;onReorder:(ids:string[])=>void;onAdd:()=>void;onDelete:(id:string)=>void;
}){
  useLocale();
  const scroll=useRef<HTMLDivElement>(null),track=useRef<HTMLDivElement>(null),ruler=useRef<HTMLDivElement>(null),head=useRef<HTMLDivElement>(null),clips=useRef<(HTMLElement|null)[]>([]);
  const drag=useRef<ClipDrag|null>(null),scrollAnimation=useRef(0),suppressClick=useRef(false);
  const [dragging,setDragging]=useState<string|null>(null),[dropIndex,setDropIndex]=useState<number|null>(null);
  const total=shots.reduce((sum,shot)=>sum+shot.durationFrames,0);
  const starts:number[]=[];shots.reduce((at,shot)=>{starts.push(at);return at+shot.durationFrames;},0);
  const totalSeconds=total/Math.max(1,fps);
  const rulerSteps=totalSeconds>0?Math.min(8,Math.max(3,Math.round(totalSeconds/2))):4;
  const rulerFrames=Array.from({length:rulerSteps+1},(_,index)=>Math.round(total*index/rulerSteps));
  const rulerMarks=Array.from({length:rulerSteps+1},(_,index)=>{
    const sec=(totalSeconds*index)/rulerSteps;
    const mins=Math.floor(sec/60),rem=Math.floor(sec%60);
    return `${String(mins).padStart(2,'0')}:${String(rem).padStart(2,'0')}`;
  });
  useEffect(()=>()=>cancelAnimationFrame(scrollAnimation.current),[]);
  // Use the same clip geometry for the playhead and ruler, including minimum clip widths.
  useEffect(()=>{
    const position=(frame:number)=>{
      let index=starts.findIndex((start,i)=>frame>=start&&frame<start+shots[i]!.durationFrames);if(index<0)index=frame>=total?shots.length-1:0;
      const clip=clips.current[index];if(!clip||!shots[index])return;
      const local=Math.min(1,Math.max(0,(frame-starts[index]!)/Math.max(1,shots[index]!.durationFrames)));
      return clip.offsetLeft+clip.offsetWidth*local;
    };
    const place=()=>{
      const element=head.current,offset=position(playhead.frame());if(!element)return;
      element.style.opacity=offset===undefined?'0':'1';
      if(offset!==undefined)element.style.transform=`translateX(${offset}px)`;
      element.classList.toggle('is-playing',playhead.playing());
    };
    const measure=()=>{
      place();
      ruler.current?.querySelectorAll('span').forEach((mark,index)=>{
        mark.style.left=`${position(rulerFrames[index]!)??0}px`;
      });
    };
    measure();const stop=playhead.subscribe(place);
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(measure):null;if(track.current)observer?.observe(track.current);
    return()=>{stop();observer?.disconnect();};
  });
  function seekAt(clientX:number):void{
    if(total<=0)return;
    for(let index=0;index<shots.length;index++){
      const box=clips.current[index]?.getBoundingClientRect();if(!box||box.width<=0)continue;
      if(clientX<=box.left){playhead.seek(starts[index]!);return;}
      if(clientX<=box.right){
        const offset=Math.floor((clientX-box.left)/box.width*shots[index]!.durationFrames);
        playhead.seek(Math.min(total-1,starts[index]!+offset));return;
      }
    }
    playhead.seek(total-1);
  }
  function insertionIndex(clientX:number):number{
    for(let i=0;i<shots.length;i++){const clip=clips.current[i];if(!clip)continue;const box=clip.getBoundingClientRect();if(clientX<box.left+box.width/2)return i;}
    return shots.length;
  }
  function markerLeft(index:number):number{
    const clip=clips.current[Math.min(index,shots.length-1)];if(!clip)return 0;
    return index>=shots.length?clip.offsetLeft+clip.offsetWidth+4:clip.offsetLeft-4;
  }
  function dropBounds(x:number,y:number):DOMRect|null{
    const box=scroll.current?.getBoundingClientRect();
    return box&&x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom?box:null;
  }
  function scrollOnDrag():void{
    const gesture=drag.current,scroller=scroll.current;
    if(!gesture?.moved||!scroller)return;
    const box=dropBounds(gesture.x,gesture.y);
    if(box){
      const edge=28;
      if(gesture.x<box.left+edge)scroller.scrollLeft-=10;
      else if(gesture.x>box.right-edge)scroller.scrollLeft+=10;
    }
    setDropIndex(box?insertionIndex(gesture.x):null);
    scrollAnimation.current=requestAnimationFrame(scrollOnDrag);
  }
  function beginDrag(event:PointerEvent<HTMLButtonElement>,id:string):void{
    if(event.button!==0||!event.isPrimary)return;
    suppressClick.current=false;
    if(locked||event.pointerType==='touch')return;
    const {pointerId,clientX:x,clientY:y}=event;
    drag.current={id,pointerId,startX:x,startY:y,x,y,moved:false};
    event.currentTarget.setPointerCapture(pointerId);
  }
  function moveDrag(event:PointerEvent<HTMLButtonElement>):void{
    const gesture=drag.current;
    if(!gesture||gesture.pointerId!==event.pointerId)return;
    gesture.x=event.clientX;
    gesture.y=event.clientY;
    if(locked||gesture.moved||Math.hypot(gesture.x-gesture.startX,gesture.y-gesture.startY)<5)return;
    gesture.moved=true;
    setDragging(gesture.id);
    scrollOnDrag();
  }
  function finishDrag(event:PointerEvent<HTMLButtonElement>,commit:boolean):void{
    const gesture=drag.current;
    if(!gesture||gesture.pointerId!==event.pointerId)return;
    drag.current=null;
    if(!gesture.moved)return;
    suppressClick.current=true;
    cancelAnimationFrame(scrollAnimation.current);
    setDragging(null);
    setDropIndex(null);
    if(!commit||locked||!dropBounds(event.clientX,event.clientY))return;
    const ids=shots.map(shot=>shot.id),from=ids.indexOf(gesture.id);
    const index=insertionIndex(event.clientX),target=index>from?index-1:index;
    if(from<0||from===target)return;
    ids.splice(from,1);
    ids.splice(target,0,gesture.id);
    onReorder(ids);
  }
  function keys(event:KeyboardEvent,index:number){
    const id=shots[index]!.id;
    if(event.altKey&&(event.key==='ArrowLeft'||event.key==='ArrowRight')&&!locked){
      event.preventDefault();const target=index+(event.key==='ArrowLeft'?-1:1);if(target<0||target>=shots.length)return;
      const ids=shots.map(shot=>shot.id);ids.splice(index,1);ids.splice(target,0,id);onReorder(ids);
      requestAnimationFrame(()=>clips.current[target]?.focus());return;
    }
    if(!event.altKey&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){event.preventDefault();clips.current[Math.max(0,Math.min(shots.length-1,index+(event.key==='ArrowLeft'?-1:1)))]?.focus();return;}
    if((event.key==='Delete'||event.key==='Backspace')&&!locked){event.preventDefault();onDelete(id);}
  }
  return <section className="vs-timeline" aria-label={t("时间线")}>
    <div className="vs-timeline-label"><strong>{t("时间线")}</strong><small>{t("{value0} 个镜头 · {value1} 秒", {value0:shots.length, value1:(total/fps).toFixed(1)})}</small></div>
    <div ref={scroll} className="vs-timeline-scroll">
      <div ref={ruler} className="vs-timeline-ruler" aria-hidden="true" onPointerDown={event=>{if(event.button===0)seekAt(event.clientX);}}>
        {shots.length>0&&rulerMarks.map((mark,index)=><span key={index}>{mark}</span>)}
      </div>
      <div ref={track} className={`vs-timeline-track ${dragging?'is-dragging':''}`} data-keyboard-owner="timeline"
        onPointerDown={event=>{
          if(event.button===0&&!(event.target as Element).closest('.vs-clip,.vs-clip-add'))seekAt(event.clientX);
        }}>
        {shots.map((shot,index)=><button type="button" key={shot.id} ref={element=>{clips.current[index]=element;}}
          className={`vs-clip ${shot.id===selectedId?'is-active':''} ${dragging===shot.id?'is-dragging':''} ${shot.transition==='fade'?'has-fade':''}`}
          style={{'--vs-clip-grow':String(Math.max(1,shot.durationFrames))} as CSSProperties}
          aria-pressed={shot.id===selectedId} aria-label={t("镜头 {value0}：{value1}，{value2} 秒", {value0:index+1, value1:shot.title, value2:(shot.durationFrames/fps).toFixed(1)})}
          title={t("拖动排序 · Alt ←/→ 移动 · Delete 删除")}
          onPointerDown={event=>beginDrag(event,shot.id)}
          onPointerMove={moveDrag}
          onPointerUp={event=>finishDrag(event,true)}
          onPointerCancel={event=>finishDrag(event,false)}
          onLostPointerCapture={event=>finishDrag(event,false)}
          onKeyDown={event=>keys(event,index)}
          onClick={event=>{
            if(event.detail&&suppressClick.current){suppressClick.current=false;return;}
            if(shot.id===selectedId)playhead.seek(starts[index]!);else onSelect(shot.id);
          }}>
          <span className="vs-clip-swatch" aria-hidden="true" style={{'--vs-swatch-bg':shot.params.background,'--vs-swatch-fg':shot.params.foreground,'--vs-swatch-accent':shot.params.accent} as CSSProperties}><i/></span>
          <b>{String(index+1).padStart(2,'0')}</b>
          <span className="vs-clip-body"><strong>{shot.title}</strong><small>{t("{value0} 秒", {value0:(shot.durationFrames/fps).toFixed(1)})}{shot.transition==='fade'?` · ${t("淡入淡出")}`:''}</small></span>
        </button>)}
        <button type="button" className="vs-clip-add" onClick={onAdd} disabled={locked} aria-label={t("添加镜头")} title={selectedId?t("在选中镜头后添加"):t("添加镜头")}><Icon name="plus"/></button>
        {dropIndex!==null&&<i className="vs-drop-marker" style={{transform:`translateX(${markerLeft(dropIndex)}px)`}} aria-hidden="true"/>}
        {shots.length>0&&<div ref={head} className="vs-playhead" aria-hidden="true"><i/></div>}
      </div>
    </div>
  </section>;
}
