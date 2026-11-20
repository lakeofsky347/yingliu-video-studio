/** Transient feedback owned by a single mounted workbench. */
export type ToastTone='success'|'info'|'warning'|'error';
export interface ToastAction { label:string; run:()=>void; available?:()=>boolean }
export interface ToastItem { id:number; tone:ToastTone; message:string; detail?:string; action?:ToastAction; duration:number; leaving?:boolean }

export function createToastStore(){
  let items:ToastItem[]=[];
  let serial=0;
  const listeners=new Set<()=>void>();
  const timers=new Map<number,ReturnType<typeof setTimeout>>();
  function emit():void{for(const listener of [...listeners])listener();}
  function clearTimer(id:number):void{clearTimeout(timers.get(id));timers.delete(id);}
  function schedule(id:number,ms:number):void{clearTimer(id);if(ms>0&&Number.isFinite(ms))timers.set(id,setTimeout(()=>dismiss(id),ms));}
  function dismiss(id:number):void{
    const item=items.find(value=>value.id===id);if(!item||item.leaving)return;
    clearTimer(id);
    items=items.map(value=>value.id===id?{...value,leaving:true}:value);emit();
    timers.set(id,setTimeout(()=>{timers.delete(id);items=items.filter(value=>value.id!==id);emit();},220));
  }
  return {
    getSnapshot:()=>items,
    subscribe(listener:()=>void):()=>void{listeners.add(listener);return()=>listeners.delete(listener);},
    toast(input:{message:string;tone?:ToastTone;detail?:string;action?:ToastAction;duration?:number}):number{
      const tone=input.tone||'info';
      const duration=input.duration??(tone==='error'?9000:input.action?6500:3800);
      const existing=items.find(item=>!item.leaving&&!item.action&&!input.action&&item.message===input.message&&item.tone===tone);
      if(existing){schedule(existing.id,duration);return existing.id;}
      const item:ToastItem={id:++serial,tone,message:input.message,detail:input.detail,action:input.action,duration};
      const retained=items.filter(value=>!value.leaving).slice(-2);
      for(const old of items)if(!retained.includes(old))clearTimer(old.id);
      items=[...retained,item];schedule(item.id,duration);emit();return item.id;
    },
    dismiss,
    hold(id:number,hold:boolean):void{
      const item=items.find(value=>value.id===id);if(!item||item.leaving)return;
      if(hold)clearTimer(id);else schedule(id,Math.min(item.duration,2500));
    },
    dropUnavailableActions():void{
      const expired=items.filter(item=>item.action?.available?.()===false);
      if(!expired.length)return;
      items=items.map(item=>expired.includes(item)?{...item,action:undefined}:item);emit();
    },
    clear():void{for(const id of timers.keys())clearTimer(id);if(items.length){items=[];emit();}},
  };
}
