import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** One 24-unit grid, 1.6px stroke icon set shared by every studio surface. */
const paths:Record<string,ReactNode>={
  plus:<path d="M12 5v14M5 12h14"/>,
  minus:<path d="M5 12h14"/>,
  upload:<path d="M12 15V4m-4.5 4.5L12 4l4.5 4.5M4 15v4.5h16V15"/>,
  download:<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M4 15v4.5h16V15"/>,
  spark:<><path d="M12 3.5l2.1 5.4 5.4 2.1-5.4 2.1L12 18.5l-2.1-5.4L4.5 11l5.4-2.1L12 3.5Z"/><path d="M19 2.8l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6Z"/></>,
  play:<path d="M8 5.5v13l10.5-6.5L8 5.5Z" fill="currentColor" stroke="none"/>,
  pause:<><rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/></>,
  stepBack:<><path d="M6 5.5v13"/><path d="M18 6v12l-8.5-6L18 6Z" fill="currentColor" stroke="none"/></>,
  stepForward:<><path d="M18 5.5v13"/><path d="M6 6v12l8.5-6L6 6Z" fill="currentColor" stroke="none"/></>,
  stop:<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>,
  grid:<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></>,
  graph:<><circle cx="5.5" cy="6" r="2.2"/><circle cx="18.5" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M7.6 6h8.8M6.7 7.9l4.1 8.2M17.3 7.9l-4.1 8.2"/></>,
  monitor:<><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></>,
  split:<><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M12 4.5v15"/></>,
  copy:<><rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/></>,
  delete:<><path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5l.8 13.5h9.4l.8-13.5M10 10.5v6M14 10.5v6"/></>,
  undo:<><path d="M8.5 5 4 9.5 8.5 14"/><path d="M4 9.5h10a6 6 0 0 1 0 12h-3"/></>,
  redo:<><path d="M15.5 5 20 9.5 15.5 14"/><path d="M20 9.5H10a6 6 0 0 0 0 12h3"/></>,
  expand:<><path d="M9 3.5H3.5V9M15 3.5h5.5V9M3.5 15v5.5H9M20.5 15v5.5H15"/></>,
  collapse:<><path d="M3.5 9H9V3.5M20.5 9H15V3.5M9 20.5V15H3.5M15 20.5V15h5.5"/></>,
  folder:<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V6.5Z"/>,
  group:<><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" strokeDasharray="3 2.4"/><rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/></>,
  check:<path d="m5 12.5 4.2 4.2L19 7"/>,
  refresh:<><path d="M19.5 5.5v5h-5"/><path d="M19 10.5A7.5 7.5 0 1 0 17 17"/></>,
  image:<><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="9.5" r="1.6"/><path d="m4 17.5 5-5 3.5 3.5 3-3 4.5 4.5"/></>,
  text:<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>,
  music:<><path d="M9 17.5V6l10.5-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17" cy="15.5" r="2.5"/></>,
  video:<><rect x="3" y="5.5" width="13" height="13" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/></>,
  arrow:<path d="M5 12h14m-5.5-5.5L19 12l-5.5 5.5"/>,
  external:<><path d="M13.5 4.5h6v6M19.5 4.5l-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></>,
  close:<path d="m6 6 12 12M18 6 6 18"/>,
  settings:<><path d="M5 4v16M12 4v16M19 4v16"/><circle cx="5" cy="9" r="2" fill="var(--vs-icon-fill,currentColor)"/><circle cx="12" cy="15" r="2" fill="var(--vs-icon-fill,currentColor)"/><circle cx="19" cy="8" r="2" fill="var(--vs-icon-fill,currentColor)"/></>,
  more:<><circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/></>,
  chevronDown:<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>,
  chevronUp:<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>,
  chevronRight:<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>,
  chevronLeft:<path d="m14.5 6.5L9 12l5.5 5.5"/>,
  search:<><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></>,
  keyboard:<><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/></>,
  film:<><rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M7.5 3.5v17M16.5 3.5v17M3.5 8h4M3.5 12h4M3.5 16h4M16.5 8h4M16.5 12h4M16.5 16h4"/></>,
  link:<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></>,
  unlink:<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/><path d="M4 4l16 16"/></>,
  sidebar:<><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 4.5v15"/></>,
  drawer:<><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 14.5h17"/></>,
  wand:<><path d="m4 20 11-11M14 4v3M12.5 5.5h3M19 9v3M17.5 10.5h3M18 3.5v1.5M17.25 4.25h1.5"/></>,
  volume:<><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></>,
  mute:<><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></>,
  camera:<><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z"/><circle cx="12" cy="12.8" r="3.3"/></>,
  focus:<><circle cx="12" cy="12" r="3"/><path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/></>,
  fit:<><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1.5"/></>,
  info:<><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/></>,
  warning:<><path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.5M12 17.2h.01"/></>,
  history:<><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4.5l3 2"/></>,
  tasks:<><path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="m3.5 6.5 1.5 1.5 2.5-3M3.5 12l1.5 1.5 2.5-3M4 17.5h2.5"/></>,
  code:<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15"/>,
  doc:<><path d="M6 3.5h8l4.5 4.5v12.5H6Z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h6"/></>,
  users:<><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9.5" r="2.5"/><path d="M15.5 14.3a4.5 4.5 0 0 1 5 4.2"/></>,
};
export type IconName=keyof typeof paths;
export function Icon({name,size}:{name:string;size?:number}){
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="vs-icon" style={size?{width:size,height:size}:undefined}>{paths[name]||paths.grid}</svg>;
}
type ButtonProps=ButtonHTMLAttributes<HTMLButtonElement>&{icon?:string;variant?:'primary'|'ghost'|'danger'|'subtle';size?:'sm'|'md'};
/** Text button with an optional leading icon; `variant` maps to the shared button hierarchy. */
export function Button({children,icon,variant,size,className='',type='button',...props}:ButtonProps){
  const classes=[className,variant?`vs-btn-${variant}`:'',variant==='primary'?'vs-primary':'',variant==='danger'?'vs-danger':'',size==='sm'?'vs-btn-sm':''].filter(Boolean).join(' ');
  return <button type={type} className={classes||undefined} {...props}>{icon&&<Icon name={icon}/>}{children!==undefined&&children!==null&&children!==false&&<span>{children}</span>}</button>;
}
/** Square icon-only button. `label` is required: it becomes the accessible name and the tooltip. */
export function IconButton({icon,label,className='',type='button',active,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{icon:string;label:string;active?:boolean}){
  return <button type={type} className={`vs-iconbutton ${active?'is-active':''} ${className}`.trim()} aria-label={label} title={props.title??label} {...props}><Icon name={icon}/></button>;
}
