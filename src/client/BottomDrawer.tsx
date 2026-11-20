import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { t, useLocale } from './i18n.ts';
import { Icon } from './icons.tsx';

export interface DrawerTab<T extends string> { id:T; label:string; icon:string; badge?:ReactNode }
/**
 * Collapsible, resizable bottom drawer. Tabs stay visible when collapsed; choosing a tab opens it.
 * `flash` increments whenever another surface opens a panel, so the drawer can draw attention to itself.
 */
export function BottomDrawer<T extends string>({tabs,active,open,height,flash,onSelect,onToggle,onResize,children}:{
  tabs:DrawerTab<T>[];active:T|null;open:boolean;height:number;flash:number;
  onSelect:(id:T)=>void;onToggle:()=>void;onResize:(height:number)=>void;children:ReactNode;
}){
  useLocale();
  const root=useRef<HTMLElement>(null),tablist=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!flash)return;const element=root.current;if(!element)return;
    element.classList.remove('is-flash');void element.offsetWidth;element.classList.add('is-flash');
    element.scrollIntoView?.({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    tablist.current?.querySelector<HTMLElement>('[aria-selected=true]')?.focus({preventScroll:true});
  },[flash]);
  function startResize(event:ReactPointerEvent){
    event.preventDefault();const startY=event.clientY,startHeight=height,target=event.currentTarget as HTMLElement;target.setPointerCapture(event.pointerId);
    const body=root.current?.parentElement?.getBoundingClientRect().height||800;
    const move=(e:PointerEvent)=>onResize(Math.round(Math.max(160,Math.min(body*.72,startHeight+(startY-e.clientY)))));
    const up=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',up);target.removeEventListener('pointercancel',up);};
    target.addEventListener('pointermove',move);target.addEventListener('pointerup',up);target.addEventListener('pointercancel',up);
  }
  return <section ref={root} className={`vs-drawer ${open?'is-open':''}`} style={{'--vs-drawer-height':`${height}px`} as CSSProperties} aria-label={t("工作面板")}>
    {open&&<div className="vs-drawer-resize" role="separator" aria-orientation="horizontal" aria-label={t("调整面板高度")} tabIndex={0} onPointerDown={startResize}
      onKeyDown={event=>{if(event.key==='ArrowUp'){event.preventDefault();onResize(height+24);}if(event.key==='ArrowDown'){event.preventDefault();onResize(Math.max(160,height-24));}}}/>}
    <div className="vs-drawer-bar">
      <div ref={tablist} className="vs-tabs" role="tablist" aria-label={t("主要工作面板")}>
        {tabs.map(tab=><button type="button" key={tab.id} role="tab" aria-selected={open&&active===tab.id} className={open&&active===tab.id?'is-active':''}
          onClick={()=>{if(open&&active===tab.id)onToggle();else onSelect(tab.id);}}><Icon name={tab.icon}/><span>{tab.label}</span>{tab.badge}</button>)}
      </div>
      <button type="button" className="vs-iconbutton vs-drawer-toggle" aria-expanded={open} aria-label={open?t("收起面板"):t("展开面板")} title={open?t("收起面板"):t("展开面板")} onClick={onToggle}><Icon name={open?'chevronDown':'chevronUp'}/></button>
    </div>
    <div className="vs-drawer-body" role="tabpanel" hidden={!open}>{open&&children}</div>
  </section>;
}
