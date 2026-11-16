import {useSyncExternalStore} from 'react';
import {dateLocale,formatMessage,normalizeLocale,translateSystemMessage,type MessageValues,type StudioLocale} from '../shared/localization.ts';

// One browser window shares the host's language. No server or project state is changed.
let locale:StudioLocale='zh';
const listeners=new Set<()=>void>();
export function getLocale():StudioLocale{return locale;}
export function setLocale(value:unknown):void{
  const next=normalizeLocale(value);if(next===locale)return;locale=next;
  for(const listener of [...listeners])listener();
}
export function subscribeLocale(listener:()=>void):()=>void{listeners.add(listener);return()=>listeners.delete(listener);}
export function useLocale():StudioLocale{return useSyncExternalStore(subscribeLocale,getLocale,getLocale);}
export function t(message:string,values:MessageValues={}):string{return formatMessage(locale,message,values);}
export function systemMessage(message:string|null|undefined):string{return translateSystemMessage(locale,message);}
export function formatDate(value:string,options?:Intl.DateTimeFormatOptions):string{
  const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString(dateLocale(locale),options);
}
