import { LiteGraph, LGraph, LGraphNode, LGraphCanvas, LGraphGroup } from '@comfyorg/litegraph';
import type { LLink } from '@comfyorg/litegraph';
import { deleteShot, duplicateShot, unbindAsset } from '../core/index.ts';
import type { Asset, GraphEditorAdapter, Shot, VideoProject } from '../shared/types.ts';
import { t, subscribeLocale, getLocale } from './i18n.ts';
import { createPlayhead, type Playhead } from './playhead-store.ts';

/** Canvas colours come from the studio's CSS custom properties so the graph follows light and dark schemes. */
interface GraphTheme {
  isLight:boolean;
  bg:string;dot:string;dotMajor:string;spotlight:string;
  card:string;cardFilm:string;well:string;border:string;highlight:string;
  shadow:string;shadowSoft:string;
  text:string;strong:string;meta:string;meta2:string;
  accent:string;accentSoft:string;accentRing:string;onAccent:string;
  rule:string;film:string;filmSoft:string;
  blue:string;blueSoft:string;violet:string;violetSoft:string;
  amber:string;amberSoft:string;rose:string;roseSoft:string;
  hudBg:string;hudText:string;
  links:{asset:string;reference:string;shot:string};
}

const DARK_THEME:GraphTheme={
  isLight:false,
  bg:'#131519',dot:'rgba(255,255,255,0.075)',dotMajor:'rgba(255,255,255,0.16)',spotlight:'rgba(255,255,255,0.032)',
  card:'#1c1f26',cardFilm:'#211f1a',well:'#14161b',border:'rgba(255,255,255,0.085)',highlight:'rgba(255,255,255,0.065)',
  shadow:'rgba(0,0,0,0.48)',shadowSoft:'rgba(0,0,0,0.28)',
  text:'#d5dae2',strong:'#eef0f4',meta:'#969da8',meta2:'#6c7380',
  accent:'#22b58e',accentSoft:'rgba(34,181,142,0.16)',accentRing:'rgba(34,181,142,0.34)',onAccent:'#f4fbf8',
  rule:'rgba(255,255,255,0.07)',film:'#deb962',filmSoft:'rgba(222,185,98,0.14)',
  blue:'#6ea5e0',blueSoft:'rgba(110,165,224,0.16)',violet:'#a88fe6',violetSoft:'rgba(168,143,230,0.16)',
  amber:'#dfa94f',amberSoft:'rgba(223,169,79,0.16)',rose:'#e583a8',roseSoft:'rgba(229,131,168,0.16)',
  hudBg:'rgba(14,16,20,0.68)',hudText:'#f4f6f8',
  links:{asset:'#6ea5e0',reference:'#a88fe6',shot:'#22b58e'},
};

const LIGHT_THEME:GraphTheme={
  isLight:true,
  bg:'#f3f2ee',dot:'rgba(17,24,39,0.085)',dotMajor:'rgba(17,24,39,0.17)',spotlight:'rgba(255,255,255,0.78)',
  card:'#ffffff',cardFilm:'#fffdf7',well:'#f2f1ed',border:'rgba(20,24,30,0.08)',highlight:'rgba(255,255,255,0.95)',
  shadow:'rgba(17,24,39,0.11)',shadowSoft:'rgba(17,24,39,0.055)',
  text:'#2f363f',strong:'#171b20',meta:'#636b75',meta2:'#8b929c',
  accent:'#0f8264',accentSoft:'rgba(15,130,100,0.12)',accentRing:'rgba(15,130,100,0.28)',onAccent:'#ffffff',
  rule:'rgba(20,24,30,0.07)',film:'#a67512',filmSoft:'rgba(166,117,18,0.12)',
  blue:'#2f6fd6',blueSoft:'rgba(47,111,214,0.12)',violet:'#7c56d9',violetSoft:'rgba(124,86,217,0.12)',
  amber:'#c28312',amberSoft:'rgba(194,131,18,0.13)',rose:'#c44478',roseSoft:'rgba(196,68,120,0.12)',
  hudBg:'rgba(17,20,25,0.62)',hudText:'#ffffff',
  links:{asset:'#2f6fd6',reference:'#8468cc',shot:'#0f8264'},
};

let theme:GraphTheme=DARK_THEME;
function graphInk():GraphTheme{return theme;}

function readTheme(element:Element):GraphTheme{
  const studio=element.closest('.vs-studio');
  const isLight=studio?.getAttribute('data-scheme')==='light';
  const base=isLight?LIGHT_THEME:DARK_THEME;
  const style=getComputedStyle(element),v=(name:string,fallback:string)=>style.getPropertyValue(name).trim()||fallback;
  return {
    ...base,
    isLight,
    bg:v('--vs-g-bg',base.bg),
    card:v('--vs-g-node',base.card),
    cardFilm:v('--vs-g-node-film',base.cardFilm),
    well:v('--vs-g-well',base.well),
    text:v('--vs-g-text',base.text),
    strong:v('--vs-g-strong',base.strong),
    meta:v('--vs-g-text-2',base.meta),
    meta2:v('--vs-g-text-3',base.meta2),
    accent:v('--vs-g-accent',base.accent),
    film:v('--vs-g-film',base.film),
    links:{
      asset:v('--vs-g-link-asset',base.links.asset),
      reference:v('--vs-g-link-reference',base.links.reference),
      shot:v('--vs-g-link-shot',base.links.shot),
    },
  };
}

const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
const TITLE_H=LiteGraph.NODE_TITLE_HEIGHT;
const CARD_R=14;
const ASSET_R=13;
const SPINE_Y=34; // Horizontal alignment for all shot->shot->film connectors (vertical center of shot cover)
const WAVE_BARS=[0.28,0.48,0.72,0.52,0.92,0.68,0.42,0.85,1.0,0.64,0.78,0.44,0.88,0.62,0.38,0.70,0.50,0.30];

export interface GraphRemoval { shots:string[]; assets:{name:string;links:number}[] }
export interface GraphEdge { from:string; to:string }
type NodeKind='image'|'text'|'audio'|'video'|'shot'|'film';
interface NodeData {
  id:string;kind:NodeKind;asset?:Asset;shot?:Shot;
  image?:HTMLImageElement;thumb?:HTMLImageElement;
  order:number;fps?:number;playing?:boolean;
  filmMeta?:{duration:number;width:number;height:number;fps:number;connected:boolean};
}

function roundedPath(ctx:CanvasRenderingContext2D,x:number,y:number,w:number,h:number,r:number|[number,number,number,number]):void{
  ctx.beginPath();
  if(typeof ctx.roundRect==='function'){ctx.roundRect(x,y,w,h,r);}
  else {ctx.rect(x,y,w,h);}
}

function drawPill(ctx:CanvasRenderingContext2D,text:string,x:number,y:number,bg:string,fg:string,font='500 10.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif',px=7,h=20,border?:string):number{
  ctx.save();ctx.font=font;ctx.textBaseline='middle';ctx.textAlign='left';
  const w=Math.ceil(ctx.measureText(text).width)+px*2;
  roundedPath(ctx,x,y,w,h,h/2);ctx.fillStyle=bg;ctx.fill();
  if(border){ctx.strokeStyle=border;ctx.lineWidth=1;ctx.stroke();}
  ctx.fillStyle=fg;ctx.fillText(text,x+px,y+h/2+0.5);
  ctx.restore();
  return w;
}

function drawCoverImage(ctx:CanvasRenderingContext2D,image:HTMLImageElement,x:number,y:number,w:number,h:number):void{
  const iw=image.naturalWidth,ih=image.naturalHeight;if(!iw||!ih)return;
  const scale=Math.max(w/iw,h/ih);const dw=iw*scale,dh=ih*scale;
  ctx.drawImage(image,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
}

class StudioNode extends LGraphNode {
  static title='Video node';
  static title_text_color='#eef5f7';
  data:NodeData={id:'',kind:'film',order:0};
  private canvasHost?:LGraphCanvas;

  constructor(){
    super(t('视频节点'));
    this.size=[256,204];
    this.resizable=false;
  }

  override get collapsible():boolean{return false;}
  override collapse():void{/* Storyboard cards stay expanded for readable cinema previews. */}

  bindHost(host:LGraphCanvas):void{this.canvasHost=host;}

  /** Assign compact card sizes and edge-mounted socket coordinates without wasting vertical body space. */
  layoutPorts():void{
    const kind=this.data.kind;
    if(kind==='shot'){
      this.size=[256,204];
      const w=this.size[0];
      const assets=this.inputs.filter(i=>i.type==='asset');
      const refs=this.inputs.filter(i=>i.type==='reference');
      for(const input of this.inputs){
        if(input.type==='shot'){input.pos=[0,SPINE_Y];}
      }
      const placeGroup=(group:typeof this.inputs,startY:number,endY:number)=>{
        const step=group.length>1?Math.min(16,(endY-startY)/(group.length-1)):0;
        group.forEach((slot,index)=>{slot.pos=[0,Math.round(startY+index*step)];});
      };
      placeGroup(assets,112,148);
      placeGroup(refs,164,192);
      for(const output of this.outputs){
        if(output.type==='shot')output.pos=[w,SPINE_Y];
      }
    }else if(kind==='image'){
      this.size=[212,142];
      if(this.outputs[0])this.outputs[0].pos=[212,96];
      if(this.outputs[1])this.outputs[1].pos=[212,120];
    }else if(kind==='text'){
      this.size=[212,118];
      if(this.outputs[0])this.outputs[0].pos=[212,28];
      if(this.outputs[1])this.outputs[1].pos=[212,56];
    }else if(kind==='audio'){
      this.size=[212,96];
    }else if(kind==='video'){
      this.size=[212,104];
    }else {
      this.size=[220,152];
      if(this.inputs[0])this.inputs[0].pos=[0,SPINE_Y];
    }
    this.setDirtyCanvas(true,true);
  }

  resizeForPorts():void{this.layoutPorts();}

  /** Render crisp edge-mounted precision sockets; reveal labels cleanly on hover or compatible drag. */
  override drawSlots(ctx:CanvasRenderingContext2D,options?:{fromSlot?:unknown;editorAlpha?:number;lowQuality?:boolean}):void{
    const p=graphInk();
    const fromSlot=options?.fromSlot as {type?:string|number;isOutput?:boolean}|undefined;
    const isDragging=Boolean(fromSlot);
    const mouse=this.canvasHost?.graph_mouse;
    const mx=mouse?mouse[0]-this.pos[0]:-9999;
    const my=mouse?mouse[1]-this.pos[1]:-9999;

    const slotColor=(type:string|number):string=>type==='shot'?p.links.shot:type==='asset'?p.links.asset:type==='reference'?p.links.reference:p.meta;

    // Limit idle unconnected dynamic slots on shots to 1 per type so the card perimeter stays clean.
    const shownFree=new Set<string>();
    const drawEdgeSocket=(slot:{name:string;type:string|number;link?:number|null;links?:number[]|null;pos?:ArrayLike<number>},isInput:boolean)=>{
      const pos=slot.pos;if(!pos)return;
      const connected=isInput?slot.link!=null:Boolean(slot.links&&slot.links.length);
      const compatible=isDragging&&fromSlot?.type===slot.type;
      const dist=Math.hypot(mx-pos[0]!,my-pos[1]!);
      const hovered=dist<=13;
      const isDynamicShotSlot=this.data.kind==='shot'&&isInput&&(slot.type==='asset'||slot.type==='reference');
      if(isDynamicShotSlot&&!connected){
        const key=String(slot.type);
        if(shownFree.has(key)&&!hovered&&!compatible)return;
        shownFree.add(key);
      }

      const color=slotColor(slot.type);
      const r=hovered?6:compatible&&!connected?5.5:4.5;
      ctx.save();
      ctx.globalAlpha=isDragging&&!compatible&&!connected?0.28:1;

      if(hovered||compatible){
        ctx.beginPath();ctx.arc(pos[0]!,pos[1]!,r+4.5,0,Math.PI*2);
        ctx.fillStyle=slot.type==='shot'?p.accentSoft:slot.type==='asset'?p.blueSoft:p.violetSoft;
        ctx.fill();
      }

      // Outer card-colored ring cutout for physical depth
      ctx.beginPath();ctx.arc(pos[0]!,pos[1]!,r+2,0,Math.PI*2);
      ctx.fillStyle=this.data.kind==='film'?p.cardFilm:p.card;
      ctx.fill();

      ctx.beginPath();ctx.arc(pos[0]!,pos[1]!,r,0,Math.PI*2);
      if(connected||hovered||compatible){
        ctx.fillStyle=color;ctx.fill();
        if(!connected&&compatible){
          ctx.beginPath();ctx.arc(pos[0]!,pos[1]!,2,0,Math.PI*2);ctx.fillStyle=p.card;ctx.fill();
        }
      }else {
        ctx.fillStyle=p.card;ctx.fill();
        ctx.strokeStyle=color;ctx.lineWidth=1.8;ctx.stroke();
      }

      // Crisp floating micro-label only when hovered or actively targeted during wire drag
      if((hovered||(compatible&&!connected&&dist<90))&&!options?.lowQuality){
        const label=slot.name;
        ctx.font='500 10.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif';
        const tw=Math.ceil(ctx.measureText(label).width)+12;
        const lx=isInput?pos[0]!-tw-10:pos[0]!+10;
        const ly=pos[1]!-10;
        roundedPath(ctx,lx,ly,tw,20,6);
        ctx.fillStyle=p.hudBg;ctx.fill();
        ctx.fillStyle=p.hudText;ctx.textBaseline='middle';ctx.textAlign='left';
        ctx.fillText(label,lx+6,pos[1]!+0.5);
      }
      ctx.restore();
    };

    for(const input of this.inputs)drawEdgeSocket(input,true);
    for(const output of this.outputs)drawEdgeSocket(output,false);
  }

  onDrawForeground(ctx:CanvasRenderingContext2D):void{
    const d=this.data,p=graphInk();
    const w=this.size[0],h=this.size[1];
    const y0=-TITLE_H;
    const sans='-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif';
    const mono='"SF Mono", ui-monospace, Menlo, Consolas, monospace';
    ctx.save();
    ctx.textBaseline='top';ctx.textAlign='left';

    if(d.kind==='shot'){
      const coverH=128;
      // Top 16:9 clipped cinema preview cover
      ctx.save();
      roundedPath(ctx,0,y0,w,coverH,[CARD_R,CARD_R,0,0]);
      ctx.clip();
      const thumb=d.thumb;
      if(thumb?.complete&&thumb.naturalWidth){
        drawCoverImage(ctx,thumb,0,y0,w,coverH);
      }else {
        const bg=d.shot?.params.background||'#153835';
        const acc=d.shot?.params.accent||'#e8be6b';
        const grad=ctx.createLinearGradient(0,y0,w,y0+coverH);
        grad.addColorStop(0,bg);
        grad.addColorStop(1,blendHex(bg,acc,0.22));
        ctx.fillStyle=grad;ctx.fillRect(0,y0,w,coverH);
        // Subtle atmospheric orb
        const orb=ctx.createRadialGradient(w-46,y0+38,4,w-46,y0+38,46);
        orb.addColorStop(0,acc);orb.addColorStop(0.32,acc+'99');orb.addColorStop(1,'transparent');
        ctx.fillStyle=orb;ctx.fillRect(0,y0,w,coverH);
        // Subtle linked image backdrop if shot uses an image asset
        if(d.image?.complete&&d.image.naturalWidth){
          ctx.globalAlpha=0.32;drawCoverImage(ctx,d.image,0,y0,w,coverH);ctx.globalAlpha=1;
        }
      }
      // Subtle top scrim so corner pills stay crisp without dimming the frame
      const scrim=ctx.createLinearGradient(0,y0,0,y0+coverH);
      scrim.addColorStop(0,'rgba(8,10,14,0.34)');
      scrim.addColorStop(0.45,'rgba(8,10,14,0.02)');
      scrim.addColorStop(1,'rgba(8,10,14,0.16)');
      ctx.fillStyle=scrim;ctx.fillRect(0,y0,w,coverH);

      // Overlaid pills: top-left index & duration, top-right transition
      const sec=((d.shot?.durationFrames||0)/(d.fps||30)).toFixed(1);
      const badgeText=`${String(d.order+1).padStart(2,'0')} · ${sec}s`;
      const active=Boolean(this.selected||d.playing);
      drawPill(ctx,badgeText,10,y0+10,active?p.accent:p.hudBg,active?p.onAccent:p.hudText,`600 10.5px ${mono}`,8,20);

      const transText=t(d.shot?.transition==='fade'?'淡入淡出':'直接切换');
      ctx.font=`500 10px ${sans}`;
      const transW=Math.ceil(ctx.measureText(transText).width)+14;
      drawPill(ctx,transText,w-transW-10,y0+10,'rgba(12,15,20,0.46)','rgba(255,255,255,0.92)',`500 10px ${sans}`,7,20);
      ctx.restore();

      // Subtle hairline separating cover from editorial card body
      ctx.strokeStyle=p.rule;ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(0,y0+coverH);ctx.lineTo(w,y0+coverH);ctx.stroke();

      // Clean editorial card body (zero duplicate title collision with rendered frames)
      const bodyTop=y0+coverH+11; // 109
      ctx.font=`600 13.5px ${sans}`;ctx.fillStyle=p.strong;
      ctx.fillText(ellipsize(ctx,this.title||d.shot?.title||'',w-28),14,bodyTop);

      ctx.font=`400 11.5px ${sans}`;ctx.fillStyle=p.meta;
      wrap(ctx,d.shot?.intent||t('描述这个镜头想表达什么'),14,bodyTop+22,w-28,16.5,2);

      // Subtle footer divider
      const footRule=h-35;
      ctx.strokeStyle=p.rule;ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(14,footRule);ctx.lineTo(w-14,footRule);ctx.stroke();

      // Compact asset/reference count chips
      const usedCount=d.shot?.assetIds.length||0;
      const refCount=d.shot?.referenceIds.length||0;
      let cx=14;const cy=footRule+8;
      if(usedCount>0){
        cx+=drawPill(ctx,`● ${usedCount} ${t('使用')}`,cx,cy,p.blueSoft,p.blue,`500 10px ${sans}`,6,18)+5;
      }
      if(refCount>0){
        cx+=drawPill(ctx,`● ${refCount} ${t('参考')}`,cx,cy,p.violetSoft,p.violet,`500 10px ${sans}`,6,18)+5;
      }
      if(usedCount===0&&refCount===0){
        ctx.font=`400 10.5px ${sans}`;ctx.fillStyle=p.meta2;
        ctx.fillText(t('{count} 项素材关联',{count:0}),cx,cy+3);
      }

      // 3 overlapping shot color palette dots on bottom-right
      const swatches=[d.shot?.params.background||'#1a3a37',d.shot?.params.foreground||'#ffffff',d.shot?.params.accent||'#e8be6b'];
      swatches.forEach((color,idx)=>{
        const sx=w-18-(2-idx)*9;const sy=cy+9;
        ctx.beginPath();ctx.arc(sx,sy,5.5,0,Math.PI*2);ctx.fillStyle=p.card;ctx.fill();
        ctx.beginPath();ctx.arc(sx,sy,4.2,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
      });
    }else if(d.kind==='image'){
      const previewH=110;
      ctx.save();
      roundedPath(ctx,0,y0,w,previewH,[ASSET_R,ASSET_R,0,0]);
      ctx.clip();
      ctx.fillStyle=p.well;ctx.fillRect(0,y0,w,previewH);
      if(d.image?.complete&&d.image.naturalWidth){
        drawCoverImage(ctx,d.image,0,y0,w,previewH);
      }else {
        ctx.font=`500 12px ${sans}`;ctx.fillStyle=p.meta2;
        ctx.fillText(t('图片资产'),16,y0+previewH/2-6);
      }
      const resLabel=d.asset?.width&&d.asset?.height?`${d.asset.width}×${d.asset.height}`:'IMG';
      ctx.font=`500 10px ${mono}`;const rw=Math.ceil(ctx.measureText(resLabel).width)+12;
      drawPill(ctx,resLabel,w-rw-8,y0+8,p.hudBg,p.hudText,`500 10px ${mono}`,6,18);
      ctx.restore();

      // Subtle hairline below image
      ctx.strokeStyle=p.rule;ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(0,y0+previewH);ctx.lineTo(w,y0+previewH);ctx.stroke();

      ctx.font=`600 12.5px ${sans}`;ctx.fillStyle=p.strong;
      ctx.fillText(ellipsize(ctx,this.title||d.asset?.name||'',w-34),12,y0+previewH+12);
      ctx.font=`400 11px ${sans}`;ctx.fillStyle=p.meta;
      ctx.fillText(ellipsize(ctx,d.asset?.description||t('图片素材'),w-34),12,y0+previewH+34);
    }else if(d.kind==='text'){
      // Left lavender accent stripe
      roundedPath(ctx,1,y0+14,3.5,h+TITLE_H-28,2);ctx.fillStyle=p.violet;ctx.fill();

      drawPill(ctx,'TXT',w-44,y0+11,p.violetSoft,p.violet,`600 9.5px ${mono}`,6,18);
      ctx.font=`600 12.5px ${sans}`;ctx.fillStyle=p.strong;
      ctx.fillText(ellipsize(ctx,this.title||d.asset?.name||'',w-64),14,y0+13);

      ctx.strokeStyle=p.rule;ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(14,y0+38);ctx.lineTo(w-14,y0+38);ctx.stroke();

      ctx.font=`400 12px ${sans}`;ctx.fillStyle=p.meta;
      wrap(ctx,d.asset?.text||d.asset?.description||t('文字内容'),14,y0+48,w-28,18,5);
    }else if(d.kind==='audio'){
      // Left amber accent stripe
      roundedPath(ctx,1,y0+14,3.5,h+TITLE_H-28,2);ctx.fillStyle=p.amber;ctx.fill();

      const sec=`${(d.asset?.duration||0).toFixed(1)}s`;
      ctx.font=`600 10px ${mono}`;const sw=Math.ceil(ctx.measureText(sec).width)+12;
      drawPill(ctx,sec,w-sw-10,y0+11,p.amberSoft,p.amber,`600 10px ${mono}`,6,18);

      ctx.font=`600 12.5px ${sans}`;ctx.fillStyle=p.strong;
      ctx.fillText(ellipsize(ctx,this.title||d.asset?.name||'',w-sw-28),14,y0+13);

      // Crisp 18-bar vector audio waveform
      const waveX=16,waveY=y0+46,waveW=w-32,waveH=34;
      const barW=4,gap=(waveW-WAVE_BARS.length*barW)/(WAVE_BARS.length-1);
      WAVE_BARS.forEach((amp,i)=>{
        const bh=Math.max(6,Math.round(amp*waveH));
        const bx=waveX+i*(barW+gap);
        const by=waveY+(waveH-bh)/2;
        roundedPath(ctx,bx,by,barW,bh,2);
        ctx.fillStyle=p.amber;ctx.globalAlpha=0.4+amp*0.6;ctx.fill();
      });
      ctx.globalAlpha=1;

      ctx.font=`400 11px ${sans}`;ctx.fillStyle=p.meta2;
      ctx.fillText(ellipsize(ctx,t('{seconds} 秒 · 声音面板安排',{seconds:(d.asset?.duration||0).toFixed(1)}),w-28),14,h-24);
    }else if(d.kind==='video'){
      roundedPath(ctx,1,y0+14,3.5,h+TITLE_H-28,2);ctx.fillStyle=p.rose;ctx.fill();

      const sec=`${(d.asset?.duration||0).toFixed(1)}s`;
      ctx.font=`600 10px ${mono}`;const sw=Math.ceil(ctx.measureText(sec).width)+12;
      drawPill(ctx,sec,w-sw-10,y0+11,p.roseSoft,p.rose,`600 10px ${mono}`,6,18);

      ctx.font=`600 12.5px ${sans}`;ctx.fillStyle=p.strong;
      ctx.fillText(ellipsize(ctx,this.title||d.asset?.name||'',w-sw-28),14,y0+13);

      ctx.font=`400 12px ${sans}`;ctx.fillStyle=p.meta;
      wrap(ctx,d.asset?.description||d.asset?.name||t('视频素材'),14,y0+44,w-28,18,2);

      ctx.font=`400 11px ${sans}`;ctx.fillStyle=p.meta2;
      ctx.fillText(ellipsize(ctx,t('{seconds} 秒 · 镜头属性绑定',{seconds:(d.asset?.duration||0).toFixed(1)}),w-28),14,h-24);
    }else {
      // Film Output terminal card: warm champagne-gold wash + live spec badges
      ctx.save();
      roundedPath(ctx,0,y0,w,58,[CARD_R,CARD_R,0,0]);
      ctx.clip();
      const wash=ctx.createLinearGradient(0,y0,0,y0+58);
      wash.addColorStop(0,p.filmSoft);wash.addColorStop(1,'rgba(222,185,98,0)');
      ctx.fillStyle=wash;ctx.fillRect(0,y0,w,58);
      ctx.restore();

      // Gold film icon badge
      roundedPath(ctx,14,y0+14,24,24,7);ctx.fillStyle=p.filmSoft;ctx.fill();
      ctx.fillStyle=p.film;ctx.beginPath();ctx.moveTo(23,y0+21);ctx.lineTo(31,y0+26);ctx.lineTo(23,y0+31);ctx.closePath();ctx.fill();

      ctx.font=`600 13.5px ${sans}`;ctx.fillStyle=p.strong;
      ctx.fillText(this.title,46,y0+19);

      // Connection status pulse dot
      const ok=Boolean(d.filmMeta?.connected);
      ctx.beginPath();ctx.arc(w-18,y0+26,4,0,Math.PI*2);
      ctx.fillStyle=ok?p.accent:p.amber;ctx.fill();

      ctx.strokeStyle=p.rule;ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(14,y0+48);ctx.lineTo(w-14,y0+48);ctx.stroke();

      ctx.font=`600 12px ${sans}`;ctx.fillStyle=p.film;
      ctx.fillText(t('主镜头链的终点'),14,y0+59);

      ctx.font=`400 11.5px ${sans}`;ctx.fillStyle=p.meta;
      wrap(ctx,t('最后一个镜头连接到这里，然后生成画面、预览并导出。'),14,y0+81,w-28,17,3);

      // Live project output spec chips
      if(d.filmMeta){
        const cy=h-30;
        let cx=14;
        cx+=drawPill(ctx,`${d.filmMeta.duration.toFixed(1)}s`,cx,cy,p.well,p.strong,`600 10px ${mono}`,7,19,p.border)+5;
        cx+=drawPill(ctx,`${d.filmMeta.width}×${d.filmMeta.height}`,cx,cy,p.well,p.meta,`500 10px ${mono}`,6,19,p.border)+5;
        drawPill(ctx,`${Math.round(d.filmMeta.fps)} FPS`,cx,cy,p.well,p.meta,`500 10px ${mono}`,6,19,p.border);
      }
    }
    ctx.restore();
  }
}

const SHOT_X=332,SHOT_Y=108,SHOT_STEP=308,ASSET_GAP=286,ASSET_Y=56;
let registered=false;
function register():void{
  if(registered)return;
  for(const kind of ['image','text','audio','video','shot','film'] as NodeKind[])LiteGraph.registerNodeType(`video-studio/${kind}`,StudioNode);
  registered=true;
}

/** LiteGraph is a drawing/interaction dependency, never the saved project contract. */
export class LiteGraphEditor implements GraphEditorAdapter {
  private graph:LGraph; private view:LGraphCanvas; private project:VideoProject|null=null;
  private nodes=new Map<string,StudioNode>(); private setting=false;private serialized='';
  private logicalWidth=100; private logicalHeight=100; private pixelRatio=1;
  private static viewports=new Map<string,{scale:number;offset:[number,number]}>();
  private observer:ResizeObserver; private timer:ReturnType<typeof setTimeout>|undefined;
  private clipboardIds:string[]=[];
  private disposed=false; private cleanup:(()=>void)[]=[];
  private animation=0;
  private pendingInitialView=false;
  private shotThumbUrls:Record<string,string>={};
  private minimapCanvas:HTMLCanvasElement|null=null;
  private minimapCleanup:(()=>void)[]=[];
  private minimapTransform:{scale:number;minX:number;minY:number;padX:number;padY:number}|null=null;

  constructor(private canvas:HTMLCanvasElement,private onChange:(project:VideoProject,offerUndo?:boolean)=>boolean|void,private onSelect:(id:string|null)=>void,private onViewport:(scale:number)=>void=()=>{},private onRemoved:(removal:GraphRemoval)=>void=()=>{},private playhead:Playhead=createPlayhead()){
    register();this.graph=new LGraph();this.view=new LGraphCanvas(canvas,this.graph);
    this.view.show_info=false;this.view.background_image='';this.view.clear_background_color=theme.bg;this.view.render_canvas_border=false;
    this.view.render_shadows=false;this.view.render_connections_border=false;this.view.render_connection_arrows=false;
    this.view.linkMarkerShape=0;this.view.connections_width=2.2;
    this.view.allow_searchbox=false;this.view.allow_dragcanvas=true;
    this.view.low_quality_zoom_threshold=.22;
    this.view.ds.min_scale=.12;this.view.ds.max_scale=2.6;

    // Custom 3D elevated Cinema Card shell replacing LiteGraph's dated solid-header chrome.
    this.view.drawNodeShape=(node:LGraphNode,ctx:CanvasRenderingContext2D,size, _fg, _bg, selected)=>{
      const sn=node as StudioNode;
      const p=graphInk();
      const w=size[0],h=size[1]+TITLE_H,y0=-TITLE_H;
      const radius=sn.data?.kind==='shot'||sn.data?.kind==='film'?CARD_R:ASSET_R;
      const active=Boolean(selected||sn.data?.playing);
      const isFilm=sn.data?.kind==='film';

      ctx.save();
      // Layered ambient drop shadow
      if(!this.view.low_quality){
        ctx.shadowColor=active?p.accentRing:p.shadow;
        ctx.shadowBlur=active?24:p.isLight?22:26;
        ctx.shadowOffsetX=0;
        ctx.shadowOffsetY=active?8:p.isLight?8:10;
      }
      roundedPath(ctx,0,y0,w,h,radius);
      ctx.fillStyle=isFilm?p.cardFilm:p.card;
      ctx.fill();

      // Clear shadow before crisp border strokes
      ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetY=0;

      // Subtle inner top-edge specular highlight in dark mode
      if(!p.isLight&&!this.view.low_quality){
        ctx.save();
        roundedPath(ctx,0.5,y0+0.5,w-1,h-1,radius-0.5);
        ctx.strokeStyle=p.highlight;ctx.lineWidth=1;ctx.stroke();
        ctx.restore();
      }

      // Outer border (Emerald active ring / Champagne-gold film border / Subtle neutral rim)
      roundedPath(ctx,0,y0,w,h,radius);
      if(active){
        ctx.strokeStyle=p.accent;ctx.lineWidth=2;ctx.stroke();
      }else if(isFilm){
        ctx.strokeStyle=p.isLight?'rgba(166,117,18,0.34)':'rgba(222,185,98,0.34)';ctx.lineWidth=1.25;ctx.stroke();
      }else {
        ctx.strokeStyle=p.border;ctx.lineWidth=1;ctx.stroke();
      }
      ctx.restore();
    };

    // Custom clean cubic Bezier spline renderer (no muddy grey outlines; dashed violet for references; subtle emerald glow on playback spine).
    const baseRenderLink=this.view.renderLink.bind(this.view);
    this.view.renderLink=(ctx,a,b,link,skipBorder,flow,color,startDir,endDir,opts={})=>{
      const p=graphInk();
      const type=link?.type??(opts.reroute as unknown as {type?:string}|undefined)?.type;
      const highlighted=Boolean(link&&this.view.highlighted_links[link.id]);
      const isShot=type==='shot';
      const isRef=type==='reference';
      const stroke=isShot?p.links.shot:isRef?p.links.reference:type==='asset'?p.links.asset:(color||p.links.shot);

      const dx=b[0]-a[0];
      const tension=Math.max(46,Math.min(165,Math.abs(dx)*0.46+(dx<0?Math.min(110,Math.abs(b[1]-a[1])*0.4):0)));
      const c1x=a[0]+tension,c1y=a[1];
      const c2x=b[0]-tension,c2y=b[1];

      const path=new Path2D();
      path.moveTo(a[0],a[1]);
      path.bezierCurveTo(c1x,c1y,c2x,c2y,b[0],b[1]);

      const segment=(opts.reroute??link) as (LLink&{path?:Path2D;_pos?:Float32Array})|null;
      const midX=0.125*a[0]+0.375*c1x+0.375*c2x+0.125*b[0];
      const midY=0.125*a[1]+0.375*c1y+0.375*c2y+0.125*b[1];
      if(segment){
        segment.path=path;
        if(segment._pos){segment._pos[0]=midX;segment._pos[1]=midY;}
        else segment._pos=new Float32Array([midX,midY]);
      }

      ctx.save();
      ctx.lineCap='round';ctx.lineJoin='round';

      if(isShot){
        // Subtle luminous halo for the main playback spine
        ctx.strokeStyle=stroke;ctx.lineWidth=highlighted?7.5:6;ctx.globalAlpha=highlighted?(p.isLight?0.2:0.26):(p.isLight?0.13:0.18);
        ctx.stroke(path);
        ctx.globalAlpha=1;ctx.lineWidth=highlighted?2.9:2.4;
        ctx.stroke(path);

        // Crisp subtle midpoint directional chevron
        if(!this.view.low_quality&&segment?._pos){
          const mx=segment._pos[0]!,my=segment._pos[1]!;
          const tx=0.75*(c2x-c1x)+0.25*(b[0]-a[0]);
          const ty=0.75*(c2y-c1y)+0.25*(b[1]-a[1]);
          const angle=Math.atan2(ty,tx);
          ctx.save();ctx.translate(mx,my);ctx.rotate(angle);
          ctx.beginPath();ctx.moveTo(4,0);ctx.lineTo(-3,-3.5);ctx.lineTo(-1.5,0);ctx.lineTo(-3,3.5);ctx.closePath();
          ctx.fillStyle=stroke;ctx.fill();
          ctx.restore();
        }
      }else if(isRef){
        ctx.strokeStyle=stroke;ctx.lineWidth=highlighted?2.2:1.65;ctx.globalAlpha=highlighted?1:0.78;
        ctx.setLineDash([5,5]);
        ctx.stroke(path);
      }else {
        ctx.strokeStyle=stroke;ctx.lineWidth=highlighted?2.6:1.95;ctx.globalAlpha=highlighted?1:0.88;
        ctx.stroke(path);
      }
      ctx.restore();
      void baseRenderLink;void skipBorder;void flow;void startDir;void endDir;
    };

    // LiteGraph 0.17.2 scales its background for DPR, but leaves its foreground and
    // resize backing store to the host. Keep graph and pointer coordinates in CSS pixels.
    const front=this.view.drawFrontCanvas.bind(this.view);
    this.view.drawFrontCanvas=()=>{
      this.view.ctx?.setTransform(this.pixelRatio,0,0,this.pixelRatio,0,0);
      front();
      this.drawMinimap();
    };
    const visible=this.view.ds.computeVisibleArea.bind(this.view.ds);
    this.view.ds.computeVisibleArea=(viewport)=>visible(viewport||[0,0,this.logicalWidth,this.logicalHeight]);
    this.view.ds.onChanged=()=>this.rememberViewport();
    const resized=()=>this.resize();window.addEventListener('resize',resized);window.visualViewport?.addEventListener('resize',resized);
    this.cleanup.push(()=>{window.removeEventListener('resize',resized);window.visualViewport?.removeEventListener('resize',resized);});
    let resolution:MediaQueryList;
    const watchDpr=()=>{resolution?.removeEventListener('change',changedDpr);resolution=window.matchMedia(`(resolution: ${window.devicePixelRatio||1}dppx)`);resolution.addEventListener('change',changedDpr);};
    const changedDpr=()=>{this.resize();watchDpr();};watchDpr();this.cleanup.push(()=>resolution.removeEventListener('change',changedDpr));

    // Architectural dual-scale dot matrix + subtle neutral studio spotlight.
    this.view.onDrawBackground=(ctx:CanvasRenderingContext2D,area:number[])=>{
      const p=graphInk();
      // Opaque full-viewport base fill + subtle screen-space radial studio lift
      ctx.save();
      ctx.setTransform(this.pixelRatio,0,0,this.pixelRatio,0,0);
      ctx.globalAlpha=1;
      ctx.fillStyle=p.bg;ctx.fillRect(0,0,this.logicalWidth,this.logicalHeight);
      const cx=this.logicalWidth*0.5,cy=this.logicalHeight*0.44,rad=Math.max(this.logicalWidth,this.logicalHeight)*0.65;
      const spot=ctx.createRadialGradient(cx,cy,0,cx,cy,rad);
      spot.addColorStop(0,p.spotlight);spot.addColorStop(1,'rgba(255,255,255,0)');
      ctx.fillStyle=spot;ctx.fillRect(0,0,this.logicalWidth,this.logicalHeight);
      ctx.restore();

      const scale=this.view.ds.scale;
      if(scale<.28)return;
      const gap=24,majorGap=96;
      const x0=Math.floor(area[0]!/gap)*gap,y0=Math.floor(area[1]!/gap)*gap;
      const x1=area[0]!+area[2]!,y1=area[1]!+area[3]!;
      ctx.save();
      // Minor dots
      if(scale>=.42){
        const r=Math.max(0.85,1.05/scale);
        ctx.fillStyle=p.dot;
        for(let x=x0;x<x1;x+=gap){
          for(let y=y0;y<y1;y+=gap){
            if(x%majorGap===0&&y%majorGap===0)continue;
            ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
          }
        }
      }
      // Major architectural crosshairs at 96px intervals
      const mx0=Math.floor(area[0]!/majorGap)*majorGap,my0=Math.floor(area[1]!/majorGap)*majorGap;
      const arm=Math.max(2.5,3.2/scale);
      ctx.strokeStyle=p.dotMajor;ctx.lineWidth=Math.max(0.9,1/scale);
      ctx.beginPath();
      for(let x=mx0;x<x1;x+=majorGap){
        for(let y=my0;y<y1;y+=majorGap){
          ctx.moveTo(x-arm,y);ctx.lineTo(x+arm,y);
          ctx.moveTo(x,y-arm);ctx.lineTo(x,y+arm);
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    this.applyTheme();
    const studio=canvas.closest('.vs-studio');
    if(studio&&typeof MutationObserver!=='undefined'){
      const themeObserver=new MutationObserver(()=>this.applyTheme());
      themeObserver.observe(studio,{attributes:true,attributeFilter:['data-scheme']});
      this.cleanup.push(()=>themeObserver.disconnect());
    }

    // Highlight currently playing shot in sync with the monitor playhead.
    const stopPlayhead=this.playhead.subscribe(()=>this.syncPlayheadShot());
    this.cleanup.push(stopPlayhead);

    // Repaint gently on pointer move when hovering sockets so socket tooltips respond crisply.
    const onPointerMove=()=>this.view.setDirty(true,false);
    canvas.addEventListener('pointermove',onPointerMove);
    this.cleanup.push(()=>canvas.removeEventListener('pointermove',onPointerMove));

    // Never expose LiteGraph's generic HTML property dialogs; React owns all text inputs.
    this.view.showEditPropertyValue=()=>undefined;
    this.view.showShowNodePanel=(node:LGraphNode)=>this.onSelect((node as StudioNode).data.id);
    this.view.showSearchBox=()=>undefined as never;
    this.view.prompt=()=>undefined as never;
    this.view.getNodeMenuOptions=(node:LGraphNode)=>[
      {content:t('编辑属性'),callback:()=>this.onSelect((node as StudioNode).data.id)},
      ...((node as StudioNode).data.kind==='shot'?[{content:t('复制镜头'),callback:()=>this.duplicate((node as StudioNode).data.id)}]:[]),
      ...((node as StudioNode).data.kind==='shot'?[{content:t('删除节点'),callback:()=>this.remove([(node as StudioNode).data.id])}]:[]),
      ...(['image','text','audio','video'].includes((node as StudioNode).data.kind)?[{content:t('解除全部关联'),callback:()=>this.remove([(node as StudioNode).data.id])}]:[])
    ];
    this.view.getCanvasMenuOptions=()=>[{content:t('整理画布'),callback:()=>this.arrange()},{content:t('选中节点分组'),callback:()=>this.groupSelection()}];
    this.view.getGroupMenuOptions=()=>[];
    this.graph.onAfterChange=()=>this.queueChange();
    this.graph.onNodeRemoved=()=>this.queueChange();
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas.parentElement!);
    canvas.tabIndex=0;canvas.setAttribute('aria-label',t('资产与镜头连线画布'));
    this.cleanup.push(subscribeLocale(()=>this.refreshLocale()));

    const key=(event:KeyboardEvent)=>{
      if(event.target!==canvas)return;
      if(event.key===' '&&!event.repeat&&!(this.view as unknown as {pointer?:{isDown?:boolean}}).pointer?.isDown){event.preventDefault();event.stopPropagation();this.playhead.toggle();return;}
      if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();event.stopImmediatePropagation();this.remove(this.selectedIds());}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'){event.preventDefault();event.stopImmediatePropagation();this.duplicateSelection();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'){event.preventDefault();event.stopImmediatePropagation();this.clipboardIds=this.selectedIds();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='v'){event.preventDefault();event.stopImmediatePropagation();this.paste();}
    };
    const keyboardOwner=canvas.parentElement!;
    keyboardOwner.addEventListener('keydown',key,true);this.cleanup.push(()=>keyboardOwner.removeEventListener('keydown',key,true));
    const drag=(e:DragEvent)=>{if(this.view.allow_interaction&&e.dataTransfer?.types.includes('application/x-dsh-video-asset')){e.preventDefault();e.dataTransfer.dropEffect='move';}};
    const drop=(e:DragEvent)=>{const id=e.dataTransfer?.getData('application/x-dsh-video-asset');if(!id||!this.project||!this.view.allow_interaction)return;e.preventDefault();const rect=canvas.getBoundingClientRect();const ds=this.view.ds;const node=this.nodes.get(id);if(!node)return;node.pos=[(e.clientX-rect.left)/ds.scale-ds.offset[0],(e.clientY-rect.top)/ds.scale-ds.offset[1]];this.onSelect(id);this.queueChange();};
    canvas.addEventListener('dragover',drag);canvas.addEventListener('drop',drop);this.cleanup.push(()=>{canvas.removeEventListener('dragover',drag);canvas.removeEventListener('drop',drop);});
    this.resize();
  }

  private syncPlayheadShot():void{
    if(this.disposed||!this.project)return;
    const isPlaying=this.playhead.playing();
    const frame=this.playhead.frame();
    let activeId='';
    if(isPlaying){
      let cursor=0;
      for(const id of this.project.shotOrder){
        const shot=this.project.shots.find(s=>s.id===id);if(!shot)continue;
        if(frame>=cursor&&frame<cursor+shot.durationFrames){activeId=id;break;}
        cursor+=shot.durationFrames;
      }
    }
    let changed=false;
    for(const node of this.nodes.values()){
      if(node.data.kind!=='shot')continue;
      const next=node.data.id===activeId;
      if(Boolean(node.data.playing)!==next){node.data.playing=next;changed=true;}
    }
    if(changed)this.view.setDirty(true,true);
  }

  /** Supply rendered preview thumbnails for shots so Shot cards display real 16:9 frames. */
  setShotThumbs(urls:Record<string,string>):void{
    this.shotThumbUrls={...this.shotThumbUrls,...urls};
    for(const [shotId,url] of Object.entries(urls)){
      const node=this.nodes.get(shotId);
      if(!node||node.data.kind!=='shot'||!url)continue;
      if(node.data.thumb?.src===url)continue;
      const img=new Image();
      img.onload=()=>{if(!this.disposed)node.setDirtyCanvas(true,true);};
      img.src=url;
      node.data.thumb=img;
    }
  }

  clearShotThumbs():void{
    if(!Object.keys(this.shotThumbUrls).length)return;
    this.shotThumbUrls={};
    for(const node of this.nodes.values())if(node.data.kind==='shot')node.data.thumb=undefined;
    this.view.setDirty(true,true);
  }

  /** Attach an interactive translucent minimap canvas synced with the graph viewport. */
  attachMinimap(element:HTMLCanvasElement|null):void{
    for(const stop of this.minimapCleanup)stop();
    this.minimapCleanup=[];
    this.minimapCanvas=element;
    if(!element)return;

    let dragging=false;
    const panTo=(e:PointerEvent)=>{
      if(!this.minimapTransform)return;
      const rect=element.getBoundingClientRect();
      const {scale,minX,minY,padX,padY}=this.minimapTransform;
      const gx=(e.clientX-rect.left-padX)/scale+minX;
      const gy=(e.clientY-rect.top-padY)/scale+minY;
      this.stopAnimation();
      this.view.ds.offset=[this.logicalWidth/(2*this.view.ds.scale)-gx,this.logicalHeight/(2*this.view.ds.scale)-gy];
      this.viewportChanged();
    };
    const down=(e:PointerEvent)=>{dragging=true;element.setPointerCapture(e.pointerId);panTo(e);};
    const move=(e:PointerEvent)=>{if(dragging)panTo(e);};
    const up=()=>{dragging=false;};
    element.addEventListener('pointerdown',down);element.addEventListener('pointermove',move);element.addEventListener('pointerup',up);element.addEventListener('pointercancel',up);
    this.minimapCleanup.push(()=>{element.removeEventListener('pointerdown',down);element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',up);element.removeEventListener('pointercancel',up);});
    this.drawMinimap();
  }

  private drawMinimap():void{
    const canvas=this.minimapCanvas;if(!canvas||this.disposed)return;
    const nodes=[...this.nodes.values()];if(!nodes.length)return;
    const dpr=Math.max(1,window.devicePixelRatio||1);
    const w=canvas.clientWidth||136,h=canvas.clientHeight||74;
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){
      canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
    }
    const ctx=canvas.getContext('2d');if(!ctx)return;
    const p=graphInk();
    ctx.save();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);

    const minX=Math.min(...nodes.map(n=>n.pos[0]))-40;
    const minY=Math.min(...nodes.map(n=>n.pos[1]-TITLE_H))-40;
    const maxX=Math.max(...nodes.map(n=>n.pos[0]+n.size[0]))+40;
    const maxY=Math.max(...nodes.map(n=>n.pos[1]+n.size[1]))+40;
    const bw=Math.max(1,maxX-minX),bh=Math.max(1,maxY-minY);
    const pad=8;
    const scale=Math.min((w-pad*2)/bw,(h-pad*2)/bh);
    const padX=(w-bw*scale)/2,padY=(h-bh*scale)/2;
    this.minimapTransform={scale,minX,minY,padX,padY};

    const tx=(x:number)=>padX+(x-minX)*scale;
    const ty=(y:number)=>padY+(y-minY)*scale;

    // Miniature links
    ctx.lineWidth=1;
    for(const link of this.graph.links.values()){
      const from=this.graph.getNodeById(link.origin_id) as StudioNode|null;
      const to=this.graph.getNodeById(link.target_id) as StudioNode|null;
      if(!from||!to)continue;
      ctx.strokeStyle=link.type==='shot'?p.links.shot:link.type==='asset'?p.links.asset:p.links.reference;
      ctx.globalAlpha=0.55;
      ctx.beginPath();
      ctx.moveTo(tx(from.pos[0]+from.size[0]),ty(from.pos[1]+SPINE_Y));
      ctx.lineTo(tx(to.pos[0]),ty(to.pos[1]+SPINE_Y));
      ctx.stroke();
    }
    ctx.globalAlpha=1;

    // Miniature node blocks
    for(const node of nodes){
      const nx=tx(node.pos[0]),ny=ty(node.pos[1]-TITLE_H),nw=Math.max(5,node.size[0]*scale),nh=Math.max(4,(node.size[1]+TITLE_H)*scale);
      roundedPath(ctx,nx,ny,nw,nh,2.5);
      ctx.fillStyle=node.selected||node.data.playing?p.accent:node.data.kind==='film'?p.film:node.data.kind==='shot'?p.meta:p.meta2;
      ctx.globalAlpha=node.selected||node.data.playing?0.95:node.data.kind==='shot'?0.55:0.42;
      ctx.fill();
    }
    ctx.globalAlpha=1;

    // Current viewport rectangle
    const ds=this.view.ds;
    const vx=tx(-ds.offset[0]),vy=ty(-ds.offset[1]);
    const vw=(this.logicalWidth/ds.scale)*scale,vh=(this.logicalHeight/ds.scale)*scale;
    roundedPath(ctx,Math.max(1,vx),Math.max(1,vy),Math.min(w-2,vw),Math.min(h-2,vh),3);
    ctx.fillStyle=p.accentSoft;ctx.fill();
    ctx.strokeStyle=p.accent;ctx.lineWidth=1.2;ctx.stroke();
    ctx.restore();
  }

  /** Re-read colours from CSS after a scheme change and repaint every node. */
  applyTheme():void{
    if(this.disposed||typeof getComputedStyle!=='function')return;
    theme=readTheme(this.canvas);
    this.view.clear_background_color=theme.bg;
    this.view.default_connection_color_byType={...this.view.default_connection_color_byType,...theme.links};
    const lite=LiteGraph as unknown as Record<string,unknown>;
    lite.NODE_TEXT_COLOR=theme.meta;lite.NODE_SELECTED_TITLE_COLOR=theme.strong;lite.NODE_BOX_OUTLINE_COLOR=theme.accent;
    this.view.render_shadows=false;
    StudioNode.title_text_color=theme.strong;
    this.view.setDirty(true,true);
    this.drawMinimap();
  }

  private refreshLocale():void{
    if(this.disposed)return;
    this.canvas.setAttribute('aria-label',t('资产与镜头连线画布'));
    for(const node of this.nodes.values()){
      if(node.data.kind==='film')node.title=t('影片输出');
      let asset=0,reference=0;
      for(const port of node.inputs){
        if(port.type==='shot')port.name=t(node.data.kind==='film'?'最后镜头':'上一镜头');
        else if(port.type==='asset')port.name=t('使用 {number}',{number:++asset});
        else if(port.type==='reference')port.name=t('参考 {number}',{number:++reference});
      }
      for(const port of node.outputs)port.name=t(port.type==='shot'?'下一镜头':port.type==='asset'?'使用素材':'仅供参考');
    }
    this.view.setDirty(true,true);
  }

  setProject(project:VideoProject,assetUrl:(asset:Asset)=>string):void {
    const signature=projection(project);
    const sameProject=this.project?.id===project.id;
    this.project=project;
    const fps=project.target.fps.num/Math.max(1,project.target.fps.den);
    const totalDuration=project.shots.reduce((sum,s)=>sum+s.durationFrames,0)/fps;
    const edges=graphEdges(project);
    const filmConnected=edges.some(e=>e.to==='film-output');

    if(sameProject&&signature===this.serialized){
      for(const shot of project.shots){
        const node=this.nodes.get(shot.id);
        if(node){
          node.data.shot=shot;
          const order=project.shotOrder.indexOf(shot.id);
          node.data.order=order<0?project.shots.indexOf(shot):order;
          node.data.fps=fps;
        }
      }
      for(const asset of project.assets){
        const node=this.nodes.get(asset.id);const url=assetUrl(asset);
        if(node&&asset.kind==='image'&&url&&node.data.image?.src!==url){
          const image=new Image();image.onload=()=>node.setDirtyCanvas(true,true);image.src=url;node.data.image=image;
        }
      }
      const film=this.nodes.get('film-output');
      if(film)film.data.filmMeta={duration:totalDuration,width:project.target.width,height:project.target.height,fps,connected:filmConnected};
      this.view.setDirty(true,true);return;
    }

    this.setting=true;clearTimeout(this.timer);
    try{
      const initial=this.nodes.size===0||!sameProject;
      const selected=sameProject?this.selectedIds():[];
      const scale=this.view.ds.scale,offset=[...this.view.ds.offset] as [number,number];
      this.view.deselectAll();
      this.graph.clear();this.nodes.clear();
      const assetX=Math.min(SHOT_X,...project.shots.map(s=>project.graph.positions[s.id]?.[0]??SHOT_X))-ASSET_GAP;
      const imageCache=new Map<string,HTMLImageElement>();

      let autoAssetY=ASSET_Y;
      project.assets.forEach((asset)=>{
        const fallbackPos:[number,number]=[assetX,autoAssetY];
        const node=this.add(asset.id,asset.kind,asset.name,project.graph.positions[asset.id]||fallbackPos);
        node.data.asset=asset;
        if(asset.kind!=='audio'&&asset.kind!=='video'){node.addOutput(t('使用素材'),'asset');node.addOutput(t('仅供参考'),'reference');}
        if(asset.kind==='image'){
          const url=assetUrl(asset);
          if(url){
            const image=new Image();image.onload=()=>this.view.setDirty(true,true);image.src=url;
            node.data.image=image;imageCache.set(asset.id,image);
          }
        }
        node.layoutPorts();
        autoAssetY+=node.size[1]+TITLE_H+24;
      });

      project.shots.forEach((shot,index)=>{
        const order=project.shotOrder.indexOf(shot.id),slot=order<0?index:order;
        const node=this.add(shot.id,'shot',shot.title,project.graph.positions[shot.id]||[SHOT_X+slot*SHOT_STEP,SHOT_Y]);
        node.data.shot=shot;node.data.order=order<0?index:order;node.data.fps=fps;
        const linkedImageId=shot.assetIds.find(id=>imageCache.has(id))||shot.referenceIds.find(id=>imageCache.has(id));
        if(linkedImageId)node.data.image=imageCache.get(linkedImageId);
        const thumbUrl=this.shotThumbUrls[shot.id];
        if(thumbUrl){
          const thumb=new Image();thumb.onload=()=>node.setDirtyCanvas(true,true);thumb.src=thumbUrl;node.data.thumb=thumb;
        }
        node.addInput(t('上一镜头'),'shot');node.addOutput(t('下一镜头'),'shot');
        for(let i=0;i<Math.max(1,shot.assetIds.length+1);i++)node.addInput(t('使用 {number}',{number:i+1}),'asset');
        for(let i=0;i<Math.max(1,shot.referenceIds.length+1);i++)node.addInput(t('参考 {number}',{number:i+1}),'reference');
        node.layoutPorts();
        node.onConnectionsChange=()=>{
          if(this.setting)return;
          for(const type of ['asset','reference'])if(!node.inputs.some(input=>input.type===type&&input.link==null))node.addInput(t(type==='asset'?'使用 +':'参考 +'),type);
          node.layoutPorts();
          this.queueChange();
        };
      });

      const film=this.add('film-output','film',t('影片输出'),project.graph.positions['film-output']||[SHOT_X+project.shots.length*SHOT_STEP,SHOT_Y]);
      film.data.filmMeta={duration:totalDuration,width:project.target.width,height:project.target.height,fps,connected:filmConnected};
      film.addInput(t('最后镜头'),'shot');
      film.layoutPorts();

      for(const shot of project.shots){
        const target=this.nodes.get(shot.id)!;
        shot.assetIds.forEach((id,i)=>this.nodes.get(id)?.connect(0,target,1+i));
        const offsetIdx=1+Math.max(1,shot.assetIds.length+1);
        shot.referenceIds.forEach((id,i)=>this.nodes.get(id)?.connect(1,target,offsetIdx+i));
      }
      for(const edge of edges){
        const from=this.nodes.get(edge.from),to=this.nodes.get(edge.to);
        if(from&&to)from.connect(0,to,0);
      }
      for(const saved of project.graph.groups){
        const group=new LGraphGroup(saved.title);group.pos=[saved.bounds[0],saved.bounds[1]];group.size=[saved.bounds[2],saved.bounds[3]];
        this.graph.add(group);
      }
      for(const id of selected){
        const node=this.nodes.get(id);
        if(node)this.view.selectNode(node,true);
      }

      this.view.ds.scale=scale;this.view.ds.offset=offset;this.view.setDirty(true,true);this.serialized=signature;
      if(initial){
        const saved=LiteGraphEditor.viewports.get(project.id);
        if(saved){this.view.ds.scale=saved.scale;this.view.ds.offset=[...saved.offset];}
        else {this.fit(false);this.pendingInitialView=this.logicalWidth<=100||this.logicalHeight<=100;}
      }
      this.onViewport(this.view.ds.scale);
      this.drawMinimap();
    }finally{this.setting=false;}
  }

  private add(id:string,kind:NodeKind,title:string,position:[number,number]):StudioNode{
    const node=LiteGraph.createNode(`video-studio/${kind}`) as StudioNode;
    node.bindHost(this.view);
    node.title=title;node.pos=[...position];node.data={id,kind,order:0};
    node.onSelected=()=>{if(!this.setting)this.onSelect(node.data.id);};node.onDblClick=()=>this.onSelect(node.data.id);
    this.graph.add(node);this.nodes.set(id,node);return node;
  }

  private queueChange():void{if(this.setting||this.disposed)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.commit(),50);}

  private commit():void {
    if(!this.project||this.setting||this.disposed)return;
    let project={...this.project,shots:this.project.shots.filter(s=>this.nodes.get(s.id)?.graph===this.graph),assets:this.project.assets.filter(a=>this.nodes.get(a.id)?.graph===this.graph)};
    const edges:GraphEdge[]=[];const positions:Record<string,[number,number]>={};
    for(const [id,node] of this.nodes)if(node.graph===this.graph)positions[id]=[Math.round(node.pos[0]),Math.round(node.pos[1])];
    project.shots=project.shots.map(shot=>{const node=this.nodes.get(shot.id)!;const assetIds:string[]=[],referenceIds:string[]=[];
      for(const input of node.inputs){if(input.link==null)continue;const link=this.graph.links.get(input.link);if(!link)continue;const origin=this.graph.getNodeById(link.origin_id) as StudioNode|null;if(!origin)continue;
        if(input.type==='asset')assetIds.push(origin.data.id);if(input.type==='reference')referenceIds.push(origin.data.id);}
      for(const linkId of node.outputs[0]?.links||[]){const link=this.graph.links.get(linkId);if(!link)continue;const target=this.graph.getNodeById(link.target_id) as StudioNode|null;if(target)edges.push({from:shot.id,to:target.data.id});}
      return {...shot,assetIds:[...new Set(assetIds)],referenceIds:[...new Set(referenceIds)]};});
    const groups=this.graph._groups.map((group:LGraphGroup,index:number)=>({id:`group-${index}`,title:group.title,bounds:[Math.round(group.pos[0]),Math.round(group.pos[1]),Math.round(group.size[0]),Math.round(group.size[1])] as [number,number,number,number]}));
    const shotOrder=deriveOrder(project.shots,edges);
    project={...project,shotOrder,graph:{positions,groups},extensions:{...project.extensions,graphEdges:edges},revision:project.revision+1,updatedAt:new Date().toISOString()};
    const next=projection(project);if(next===this.serialized)return;this.serialized=next;this.project=project;this.onChange(project);
  }

  selectedIds():string[]{return Object.values(this.view.selected_nodes||{}).map(node=>(node as StudioNode).data.id);}

  /** Sync external selection (from Timeline / Assets panel) to the canvas highlight without firing loops. */
  setSelected(id:string|null):void{
    if(this.disposed)return;
    const current=this.selectedIds();
    if((id&&current.includes(id))||(!id&&!current.length))return;
    const prevSetting=this.setting;
    this.setting=true;
    try{
      this.view.deselectAll();
      if(id){
        const node=this.nodes.get(id);
        if(node)this.view.selectNode(node,false);
      }
      this.view.setDirty(true,true);
      this.drawMinimap();
    }finally{this.setting=prevSetting;}
  }

  remove(ids=this.selectedIds()):void{
    if(!this.project||!this.view.allow_interaction)return;let next=this.project;const removal:GraphRemoval={shots:[],assets:[]};
    for(const id of ids){
      const shot=next.shots.find(s=>s.id===id);if(shot){next=deleteShot(next,id);removal.shots.push(shot.title);continue;}
      const asset=next.assets.find(a=>a.id===id);if(!asset)continue;let links=0;
      for(const target of next.shots){
        if(target.assetIds.includes(id)){next=unbindAsset(next,target.id,id,'asset');links++;}
        if(target.referenceIds.includes(id)){next=unbindAsset(next,target.id,id,'reference');links++;}
      }
      removal.assets.push({name:asset.name,links});
    }
    if(next!==this.project&&this.onChange(next,true)===false)return;
    if(removal.shots.length||removal.assets.length)this.onRemoved(removal);
  }

  duplicate(id:string):void{if(this.project&&this.view.allow_interaction)this.onChange(duplicateShot(this.project,id,getLocale()));}
  private duplicateSelection():void{if(!this.project||!this.view.allow_interaction)return;let next=this.project;for(const id of this.selectedIds())if(next.shots.some(shot=>shot.id===id))next=duplicateShot(next,id,getLocale());if(next!==this.project)this.onChange(next);}
  private paste():void{
    if(!this.project||!this.view.allow_interaction||!this.clipboardIds.length)return;
    let next=this.project;
    for(const id of this.clipboardIds){
      if(next.shots.some(shot=>shot.id===id)){next=duplicateShot(next,id,getLocale());continue;}
      const source=next.assets.find(asset=>asset.id===id);
      // The host only accepts new inline text through an ordinary project save.
      if(!source||source.kind!=='text'||source.path||source.originalPath||source.generation||source.provenance)continue;
      const asset={...source,id:`asset-${crypto.randomUUID()}`,name:t('{name} 副本',{name:source.name})};
      const position=next.graph.positions[id]||this.nodes.get(id)?.pos||[35,55];
      next={...next,assets:[...next.assets,asset],graph:{...next.graph,positions:{...next.graph.positions,[asset.id]:[position[0]+35,position[1]+35]}},revision:next.revision+1};
    }
    if(next!==this.project)this.onChange(next);
  }
  groupSelection():void{if(!this.view.allow_interaction)return;const nodes=this.selectedIds().map(id=>this.nodes.get(id)).filter((n):n is StudioNode=>Boolean(n));if(!nodes.length)return;const x=Math.min(...nodes.map(n=>n.pos[0]))-24,y=Math.min(...nodes.map(n=>n.pos[1]-TITLE_H))-34;const right=Math.max(...nodes.map(n=>n.pos[0]+n.size[0]))+24,bottom=Math.max(...nodes.map(n=>n.pos[1]+n.size[1]))+24;const group=new LGraphGroup(t('镜头分组'));group.pos=[x,y];group.size=[right-x,bottom-y];this.graph.add(group);this.queueChange();}

  /** One readable row: assets stacked cleanly on the left, the shot spine left-to-right, output last. */
  arrange():void{
    if(!this.project||!this.view.allow_interaction)return;const positions:Record<string,[number,number]>={};let y=ASSET_Y;
    for(const asset of this.project.assets){
      positions[asset.id]=[SHOT_X-ASSET_GAP,y];
      const height=this.nodes.get(asset.id)?.size[1]??130;
      y+=height+TITLE_H+24;
    }
    const order=[...this.project.shotOrder,...this.project.shots.map(s=>s.id).filter(id=>!this.project!.shotOrder.includes(id))];
    order.forEach((id,i)=>positions[id]=[SHOT_X+i*SHOT_STEP,SHOT_Y]);
    positions['film-output']=[SHOT_X+order.length*SHOT_STEP,SHOT_Y];
    this.onChange({...this.project,graph:{positions,groups:[]},revision:this.project.revision+1});
    requestAnimationFrame(()=>{if(!this.disposed)this.fit();});
  }

  fit(animate=true):void{
    const nodes=[...this.nodes.values()];if(!nodes.length)return;
    const minX=Math.min(...nodes.map(n=>n.pos[0]))-36;
    const minY=Math.min(...nodes.map(n=>n.pos[1]-TITLE_H))-36;
    const maxX=Math.max(...nodes.map(n=>n.pos[0]+n.size[0]))+36;
    const maxY=Math.max(...nodes.map(n=>n.pos[1]+n.size[1]))+54; // extra bottom breathing room for HUD
    const raw=Math.min(this.logicalWidth/(maxX-minX),this.logicalHeight/(maxY-minY));
    const scale=Math.max(.18,Math.min(1,raw));
    this.moveTo(scale,[-minX+(this.logicalWidth/scale-(maxX-minX))/2,-minY+(this.logicalHeight/scale-(maxY-minY))/2],animate);
  }

  focus(id?:string,scale?:number,animate=true):void{
    const node=this.nodes.get(id||this.selectedIds()[0]||this.project?.shotOrder[0]||'');if(!node)return;
    const next=scale!==undefined?scale:this.view.ds.scale<.8?0.95:this.view.ds.scale;
    this.moveTo(next,[-node.pos[0]-node.size[0]/2+this.logicalWidth/(2*next),-node.pos[1]-(node.size[1]-TITLE_H)/2+this.logicalHeight/(2*next)],animate);
  }

  zoom(scale:number):void{this.stopAnimation();const rect=this.canvas.getBoundingClientRect();this.view.ds.changeScale(Math.max(.12,Math.min(2.6,scale)),[rect.left+rect.width/2,rect.top+rect.height/2]);this.viewportChanged();}
  private stopAnimation():void{if(this.animation)cancelAnimationFrame(this.animation);this.animation=0;}

  private moveTo(scale:number,offset:[number,number],animate:boolean):void{
    this.stopAnimation();
    if(!animate||reducedMotion()||typeof requestAnimationFrame!=='function'){this.view.ds.scale=scale;this.view.ds.offset=offset;this.viewportChanged();return;}
    const from={scale:this.view.ds.scale,offset:[...this.view.ds.offset] as [number,number]},start=performance.now(),duration=260;
    const centre=(s:number,o:[number,number])=>[this.logicalWidth/(2*s)-o[0],this.logicalHeight/(2*s)-o[1]];
    const [ax,ay]=centre(from.scale,from.offset),[bx,by]=centre(scale,offset);
    const step=(now:number)=>{
      if(this.disposed)return;const k=Math.min(1,(now-start)/duration),e=1-Math.pow(1-k,3);
      const s=from.scale+(scale-from.scale)*e,cx=ax!+(bx!-ax!)*e,cy=ay!+(by!-ay!)*e;
      this.view.ds.scale=s;this.view.ds.offset=[this.logicalWidth/(2*s)-cx,this.logicalHeight/(2*s)-cy];this.viewportChanged();
      this.animation=k<1?requestAnimationFrame(step):0;
    };
    this.animation=requestAnimationFrame(step);
  }

  get scale():number{return this.view.ds.scale;}
  private viewportChanged():void{this.view.setDirty(true,true);this.rememberViewport();this.drawMinimap();}
  private rememberViewport():void{this.onViewport(this.view.ds.scale);if(this.project&&!this.setting&&!this.disposed)LiteGraphEditor.viewports.set(this.project.id,{scale:this.view.ds.scale,offset:[...this.view.ds.offset] as [number,number]});}

  resize():void{
    if(this.disposed)return;const parent=this.canvas.parentElement;if(!parent)return;
    const metrics=canvasMetrics(parent.clientWidth,parent.clientHeight,window.devicePixelRatio||1);
    this.logicalWidth=metrics.width;this.logicalHeight=metrics.height;this.pixelRatio=metrics.dpr;
    this.view.resize(metrics.backingWidth,metrics.backingHeight);this.canvas.dataset.pixelRatio=String(metrics.dpr);
    this.view.ctx?.setTransform(metrics.dpr,0,0,metrics.dpr,0,0);this.view.setDirty(true,true);
    if(this.pendingInitialView&&metrics.width>100&&metrics.height>100){this.pendingInitialView=false;this.fit(false);}
    this.drawMinimap();
  }

  setInteractive(value:boolean):void{this.view.allow_interaction=value;}

  dispose():void{
    this.disposed=true;this.stopAnimation();clearTimeout(this.timer);this.observer.disconnect();
    for(const stop of this.minimapCleanup)stop();
    for(const stop of this.cleanup)stop();
    this.view.stopRendering();
    const view=this.view,canvas=this.canvas;
    if(view._mousedown_callback)canvas.removeEventListener('pointerdown',view._mousedown_callback,true);
    if(view._mouseup_callback)canvas.removeEventListener('pointerup',view._mouseup_callback,true);
    if(view._mousecancel_callback)canvas.removeEventListener('pointercancel',view._mousecancel_callback,true);
    if(view._key_callback){canvas.removeEventListener('keydown',view._key_callback,true);canvas.ownerDocument.removeEventListener('keyup',view._key_callback,true);}
    canvas.removeEventListener('dragover',view._doNothing,false);canvas.removeEventListener('dragend',view._doNothing,false);
    view.unbindEvents();this.graph.stop();this.graph.clear();this.nodes.clear();
  }
}

export function graphEdges(project:VideoProject):GraphEdge[]{const stored=project.extensions.graphEdges;if(Array.isArray(stored))return stored.filter((e):e is GraphEdge=>Boolean(e)&&typeof e==='object'&&typeof(e as GraphEdge).from==='string'&&typeof(e as GraphEdge).to==='string');return project.shotOrder.map((id,i)=>({from:id,to:project.shotOrder[i+1]||'film-output'}));}
function deriveOrder(shots:Shot[],edges:GraphEdge[]):string[]{const ids=new Set(shots.map(s=>s.id));const incoming=new Set(edges.map(e=>e.to));const starts=shots.filter(s=>!incoming.has(s.id));if(starts.length!==1)return [];const order:string[]=[],seen=new Set<string>();let current=starts[0]!.id;while(ids.has(current)&&!seen.has(current)){seen.add(current);order.push(current);const next=edges.filter(e=>e.from===current);if(next.length!==1)break;current=next[0]!.to;}return order;}
function projection(p:VideoProject):string{return JSON.stringify({assets:p.assets,shots:p.shots,order:p.shotOrder,graph:p.graph,edges:p.extensions.graphEdges});}
function ellipsize(ctx:CanvasRenderingContext2D,text:string,width:number):string{if(ctx.measureText(text).width<=width)return text;let value='';for(const character of text){if(ctx.measureText(value+character+'…').width>width)break;value+=character;}return value+'…';}
function wrap(ctx:CanvasRenderingContext2D,text:string,x:number,y:number,width:number,lineHeight:number,maxLines:number):void{let line='',row=0;for(const character of text){if(character==='\n'||ctx.measureText(line+character).width>width){ctx.fillText(line,x,y+row*lineHeight);row++;line=character==='\n'?'':character;if(row>=maxLines)return;}else line+=character;}if(row<maxLines)ctx.fillText(line,x,y+row*lineHeight);}
function blendHex(a:string,b:string,tVal:number):string{
  const parse=(hex:string)=>{const h=hex.replace('#','');if(h.length!==6)return null;return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)] as const;};
  const ca=parse(a),cb=parse(b);if(!ca||!cb)return a;
  const mix=(x:number,y:number)=>Math.round(x+(y-x)*tVal).toString(16).padStart(2,'0');
  return `#${mix(ca[0],cb[0])}${mix(ca[1],cb[1])}${mix(ca[2],cb[2])}`;
}

export function canvasMetrics(width:number,height:number,dpr:number){const logicalWidth=Math.max(100,Math.round(width)),logicalHeight=Math.max(100,Math.round(height)),ratio=Math.max(1,dpr||1);return {width:logicalWidth,height:logicalHeight,dpr:ratio,backingWidth:Math.round(logicalWidth*ratio),backingHeight:Math.round(logicalHeight*ratio)};}
