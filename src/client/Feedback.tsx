import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { t, useLocale } from './i18n.ts';
import { Icon } from './icons.tsx';
import { Dialog } from './Dialog.tsx';
import { createToastStore } from './toast-store.ts';

const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Toasts({store}:{store:ReturnType<typeof createToastStore>}){
  useLocale();
  const items=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  return <div className="vs-toasts" role="region" aria-label={t("通知")}>
    {items.map(item=><div key={item.id} className={`vs-toast is-${item.tone} ${item.leaving?'is-leaving':''}`} role={item.tone==='error'?'alert':'status'}
      onMouseEnter={()=>store.hold(item.id,true)} onMouseLeave={()=>store.hold(item.id,false)}>
      <span className="vs-toast-icon"><Icon name={item.tone==='success'?'check':item.tone==='error'?'warning':item.tone==='warning'?'warning':'info'}/></span>
      <div className="vs-toast-body"><span>{item.message}</span>{item.detail&&<small>{item.detail}</small>}</div>
      {item.action&&<button type="button" className="vs-toast-action" disabled={item.leaving} onClick={()=>{if(item.action?.available?.()!==false)item.action?.run();store.dismiss(item.id);}}>{item.action.label}</button>}
      <button type="button" className="vs-toast-close" aria-label={t("关闭提示")} onClick={()=>store.dismiss(item.id)}><Icon name="close"/></button>
      {!item.leaving&&Number.isFinite(item.duration)&&<i className="vs-toast-timer" style={{animationDuration:`${item.duration}ms`}}/>}
    </div>)}
  </div>;
}

interface ConfirmOptions { title:string; body?:string; confirmLabel?:string; cancelLabel?:string; tone?:'danger'|'default' }
interface ConfirmRequest extends ConfirmOptions { id:number; leaving?:boolean; resolve:(value:boolean)=>void }
function createConfirmStore(){
  let pending:ConfirmRequest|null=null;
  let serial=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const listeners=new Set<()=>void>();
  function emit():void{for(const listener of [...listeners])listener();}
  function finish(requestId:number,value:boolean):void{
    if(!pending||pending.id!==requestId)return;
    const {resolve}=pending;
    clearTimeout(timer);timer=undefined;pending=null;emit();resolve(value);
  }
  function cancel():void{if(pending)finish(pending.id,false);}
  return {
    getSnapshot:()=>pending,
    subscribe(listener:()=>void):()=>void{listeners.add(listener);return()=>listeners.delete(listener);},
    ask(input:ConfirmOptions):Promise<boolean>{
      cancel();
      return new Promise(resolve=>{pending={...input,id:++serial,resolve};emit();});
    },
    settle(requestId:number,value:boolean):void{
      if(!pending||pending.id!==requestId||pending.leaving)return;
      if(reducedMotion()){finish(requestId,value);return;}
      pending={...pending,leaving:true};emit();
      timer=setTimeout(()=>finish(requestId,value),150);
    },
    cancel,
    finish,
  };
}
const ConfirmationContext=createContext<ReturnType<typeof createConfirmStore>|null>(null);
export function ConfirmationScope({children}:{children:ReactNode}){
  const [store]=useState(createConfirmStore);
  useEffect(()=>store.cancel,[store]);
  return <ConfirmationContext.Provider value={store}>{children}</ConfirmationContext.Provider>;
}
const nativeConfirm=async(input:ConfirmOptions):Promise<boolean>=>typeof window!=='undefined'&&typeof window.confirm==='function'&&window.confirm(input.body?`${input.title}\n\n${input.body}`:input.title);
export function useConfirmAction(){return useContext(ConfirmationContext)?.ask??nativeConfirm;}
export function useCancelConfirmation(){return useContext(ConfirmationContext)?.cancel;}
export function ConfirmHost(){
  useLocale();
  const store=useContext(ConfirmationContext);
  return store&&<ConfirmPanel store={store}/>;
}
function ConfirmPanel({store}:{store:ReturnType<typeof createConfirmStore>}){
  const request=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  if(!request)return null;
  return <Dialog key={request.id} label={request.title} leaving={!!request.leaving} onClose={()=>store.finish(request.id,false)} className={`vs-confirm ${request.tone==='danger'?'is-danger':''}`}>
    <div className="vs-confirm-icon"><Icon name={request.tone==='danger'?'warning':'info'}/></div>
    <h2>{request.title}</h2>
    {request.body&&<p>{request.body}</p>}
    <div className="vs-modal-actions">
      <button type="button" disabled={request.leaving} onClick={()=>store.settle(request.id,false)}>{request.cancelLabel||t("取消")}</button>
      <button type="button" data-dialog-autofocus disabled={request.leaving} className={request.tone==='danger'?'vs-btn-danger-solid':'vs-primary'} onClick={()=>store.settle(request.id,true)}>{request.confirmLabel||t("确认")}</button>
    </div>
  </Dialog>;
}

/** Small popover anchored to its trigger; closes on outside click, Escape, or choosing an item. */
export function Popover({trigger,children,align='end',className='',label}:{trigger:(props:{open:boolean;toggle:()=>void;ref:RefObject<HTMLButtonElement>})=>ReactNode;children:(close:()=>void)=>ReactNode;align?:'start'|'end';className?:string;label:string}){
  const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!open)return;
    const away=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);button.current?.focus();}};
    document.addEventListener('pointerdown',away,true);root.current?.addEventListener('keydown',key);
    const first=root.current?.querySelector<HTMLElement>('.vs-popover-panel button:not(:disabled),.vs-popover-panel select,.vs-popover-panel input,.vs-popover-panel textarea');first?.focus();
    const owner=root.current;
    return()=>{document.removeEventListener('pointerdown',away,true);owner?.removeEventListener('keydown',key);};
  },[open]);
  return <div ref={root} className={`vs-popover ${open?'is-open':''} ${className}`}>
    {trigger({open,toggle:()=>setOpen(value=>!value),ref:button})}
    {open&&<div className={`vs-popover-panel is-${align}`} role="dialog" aria-label={label}>{children(()=>setOpen(false))}</div>}
  </div>;
}
