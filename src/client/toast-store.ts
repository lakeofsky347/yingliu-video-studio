import { useSyncExternalStore } from 'react';

/** Transient, non-blocking feedback. Decisions that need the user stay in banners or dialogs. */
export type ToastTone='success'|'info'|'warning'|'error';
export interface ToastAction { label:string; run:()=>void }
export interface ToastItem { id:number; tone:ToastTone; message:string; detail?:string; action?:ToastAction; duration:number; leaving?:boolean }

let items:ToastItem[]=[];let serial=0;
const listeners=new Set<()=>void>();
const timers=new Map<number,ReturnType<typeof setTimeout>>();
function emit():void{for(const listener of [...listeners])listener();}
function schedule(id:number,ms:number):void{clearTimeout(timers.get(id));if(ms>0&&Number.isFinite(ms))timers.set(id,setTimeout(()=>dismissToast(id),ms));}

export function toast(input:{message:string;tone?:ToastTone;detail?:string;action?:ToastAction;duration?:number;key?:string}):number{
  const tone=input.tone||'info';
  const duration=input.duration??(tone==='error'?9000:input.action?6500:3800);
  // Collapse an identical visible message instead of stacking duplicates.
  const existing=items.find(item=>!item.leaving&&item.message===input.message&&item.tone===tone);
  if(existing){schedule(existing.id,duration);return existing.id;}
  const item:ToastItem={id:++serial,tone,message:input.message,detail:input.detail,action:input.action,duration};
  items=[...items.filter(value=>!value.leaving).slice(-2),item];
  schedule(item.id,duration);emit();return item.id;
}
export function dismissToast(id:number):void{
  const item=items.find(value=>value.id===id);if(!item||item.leaving)return;
  clearTimeout(timers.get(id));timers.delete(id);
  items=items.map(value=>value.id===id?{...value,leaving:true}:value);emit();
  setTimeout(()=>{items=items.filter(value=>value.id!==id);emit();},220);
}
/** Hover keeps a toast readable; leaving restarts a shorter timer. */
export function holdToast(id:number,hold:boolean):void{const item=items.find(value=>value.id===id);if(!item||item.leaving)return;if(hold)clearTimeout(timers.get(id));else schedule(id,Math.min(item.duration,2500));}
/** Toasts with an undo action become invalid once the user continues editing. */
export function expireActionToasts():void{for(const item of items)if(item.action&&!item.leaving)dismissToast(item.id);}
export function clearToasts():void{for(const id of timers.keys())clearTimeout(timers.get(id));timers.clear();items=[];emit();}
function subscribe(listener:()=>void):()=>void{listeners.add(listener);return()=>listeners.delete(listener);}
export function useToasts():ToastItem[]{return useSyncExternalStore(subscribe,()=>items,()=>items);}
