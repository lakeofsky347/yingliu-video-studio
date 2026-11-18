import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { t, useLocale } from './i18n.ts';
import { Icon } from './icons.tsx';
import { Dialog } from './Dialog.tsx';
import { dismissToast, holdToast, useToasts } from './toast-store.ts';

const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Toasts(){
  useLocale();
  const items=useToasts();
  return <div className="vs-toasts" role="region" aria-label={t("通知")}>
    {items.map(item=><div key={item.id} className={`vs-toast is-${item.tone} ${item.leaving?'is-leaving':''}`} role={item.tone==='error'?'alert':'status'}
      onMouseEnter={()=>holdToast(item.id,true)} onMouseLeave={()=>holdToast(item.id,false)}>
      <span className="vs-toast-icon"><Icon name={item.tone==='success'?'check':item.tone==='error'?'warning':item.tone==='warning'?'warning':'info'}/></span>
      <div className="vs-toast-body"><span>{item.message}</span>{item.detail&&<small>{item.detail}</small>}</div>
      {item.action&&<button type="button" className="vs-toast-action" onClick={()=>{item.action!.run();dismissToast(item.id);}}>{item.action.label}</button>}
      <button type="button" className="vs-toast-close" aria-label={t("关闭提示")} onClick={()=>dismissToast(item.id)}><Icon name="close"/></button>
      {!item.leaving&&Number.isFinite(item.duration)&&<i className="vs-toast-timer" style={{animationDuration:`${item.duration}ms`}}/>}
    </div>)}
  </div>;
}

interface ConfirmRequest { id:number; title:string; body?:string; confirmLabel?:string; cancelLabel?:string; tone?:'danger'|'default'; leaving?:boolean; resolve:(value:boolean)=>void }
let pending:ConfirmRequest|null=null;let requestSerial=0;
const confirmListeners=new Set<()=>void>();
function emitConfirm():void{for(const listener of [...confirmListeners])listener();}
/**
 * Promise-based replacement for window.confirm, styled and focus-trapped like every other dialog.
 * Falls back to window.confirm when a panel is mounted outside <Studio> in standalone tests.
 */
export function confirmAction(input:Omit<ConfirmRequest,'id'|'resolve'|'leaving'>):Promise<boolean>{
  if(!confirmListeners.size&&typeof window!=='undefined'&&typeof window.confirm==='function'){
    return Promise.resolve(window.confirm(input.body?`${input.title}\n\n${input.body}`:input.title));
  }
  pending?.resolve(false);
  return new Promise(resolve=>{pending={...input,id:++requestSerial,resolve};emitConfirm();});
}
function settle(value:boolean):void{
  const current=pending;if(!current||current.leaving)return;
  if(reducedMotion()){pending=null;emitConfirm();current.resolve(value);return;}
  pending={...current,leaving:true};emitConfirm();
  setTimeout(()=>{if(pending?.id===current.id){pending=null;emitConfirm();}current.resolve(value);},150);
}
export function ConfirmHost(){
  useLocale();
  const request=useSyncExternalStore(listener=>{confirmListeners.add(listener);return()=>confirmListeners.delete(listener);},()=>pending,()=>pending);
  if(!request)return null;
  return <Dialog key={request.id} label={request.title} leaving={!!request.leaving} onClose={()=>settle(false)} className={`vs-confirm ${request.tone==='danger'?'is-danger':''}`}>
    <div className="vs-confirm-icon"><Icon name={request.tone==='danger'?'warning':'info'}/></div>
    <h2>{request.title}</h2>
    {request.body&&<p>{request.body}</p>}
    <div className="vs-modal-actions">
      <button type="button" onClick={()=>settle(false)}>{request.cancelLabel||t("取消")}</button>
      <button type="button" data-dialog-autofocus className={request.tone==='danger'?'vs-btn-danger-solid':'vs-primary'} onClick={()=>settle(true)}>{request.confirmLabel||t("确认")}</button>
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
