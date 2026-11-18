/**
 * Lightweight transport channel between the monitor and other surfaces (timeline, canvas, shortcuts).
 * Frame updates are published at playback rate; subscribers update the DOM directly instead of
 * re-rendering the whole studio.
 */
type Listener=()=>void;
let frame=0,total=0,playing=false;
const frameListeners=new Set<Listener>();
const seekHandlers=new Set<(frame:number)=>void>();
const toggleHandlers=new Set<()=>boolean>();
export const playhead={
  frame:():number=>frame,
  total:():number=>total,
  playing:():boolean=>playing,
  publish(next:number,length:number,isPlaying:boolean):void{if(next===frame&&length===total&&isPlaying===playing)return;frame=next;total=length;playing=isPlaying;for(const listener of [...frameListeners])listener();},
  subscribe(listener:Listener):()=>void{frameListeners.add(listener);return()=>frameListeners.delete(listener);},
  /** Request a seek on the mounted monitor. Returns false when no monitor is listening. */
  seek(target:number):boolean{if(!seekHandlers.size)return false;for(const handler of [...seekHandlers])handler(target);return true;},
  onSeek(handler:(frame:number)=>void):()=>void{seekHandlers.add(handler);return()=>seekHandlers.delete(handler);},
  /** Toggle play on the mounted monitor. Returns true when a monitor handled it. */
  toggle():boolean{let handled=false;for(const handler of [...toggleHandlers])handled=handler()||handled;return handled;},
  onToggle(handler:()=>boolean):()=>void{toggleHandlers.add(handler);return()=>toggleHandlers.delete(handler);},
};
/** mm:ss:ff timecode, the frame field padded to the frame-rate width. */
export function timecode(value:number,fps:number):string{
  const rate=Math.max(1,Math.round(fps)),safe=Math.max(0,Math.floor(value));
  const seconds=Math.floor(safe/rate),frames=safe%rate,minutes=Math.floor(seconds/60);
  const pad=(n:number,w=2)=>String(n).padStart(w,'0');
  return `${pad(minutes)}:${pad(seconds%60)}:${pad(frames,String(rate-1).length<2?2:String(rate-1).length)}`;
}
