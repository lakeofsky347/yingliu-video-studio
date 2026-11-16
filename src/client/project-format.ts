import {formatDate} from './i18n.ts';
export function localTime(value:string):string{return formatDate(value,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
