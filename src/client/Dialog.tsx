import { useEffect, useRef, useState, type ReactNode } from 'react';

const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Dialog({label,onClose,busy=false,leaving:externalLeaving=false,className='',children}:{label:string;onClose:()=>void;busy?:boolean;leaving?:boolean;className?:string;children:ReactNode}) {
  const [leaving,setLeaving]=useState(false);
  const panel=useRef<HTMLElement>(null),previous=useRef(typeof document==='undefined'?null:document.activeElement as HTMLElement|null),closing=useRef({busy,onClose,leaving:false});
  closing.current={busy,onClose,leaving:leaving||externalLeaving};
  const requestClose=()=>{
    if(closing.current.busy||closing.current.leaving)return;
    if(reducedMotion()){closing.current.onClose();return;}
    setLeaving(true);closing.current.leaving=true;
    setTimeout(()=>closing.current.onClose(),150);
  };
  useEffect(()=>{
    const dialog=panel.current;
    if(!dialog)return;
    const controls=()=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(item=>item.getClientRects().length>0);
    (dialog.querySelector<HTMLElement>('[data-dialog-autofocus],[autofocus]')||controls()[0]||dialog).focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!closing.current.busy){event.preventDefault();requestClose();}
      if(event.key!=='Tab')return;const items=controls(),first=items[0],last=items.at(-1);
      if(!first){event.preventDefault();dialog.focus();return;}
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    };
    dialog.addEventListener('keydown',key);
    return()=>{
      dialog.removeEventListener('keydown',key);
      if(previous.current?.isConnected&&(document.activeElement===document.body||dialog.contains(document.activeElement)))previous.current.focus();
    };
  },[]);
  const isLeaving=leaving||externalLeaving;
  return <div className={`vs-modal-backdrop ${isLeaving?'is-leaving':''}`.trim()} onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)requestClose();}}><section ref={panel} tabIndex={-1} className={`vs-modal ${className} ${isLeaving?'is-leaving':''}`.trim()} role="dialog" aria-modal="true" aria-label={label}>{children}</section></div>;
}
