import { LiteGraph, LGraph, LGraphNode, LGraphCanvas, LGraphGroup } from '@comfyorg/litegraph';
import { deleteShot, duplicateShot, unbindAsset } from '../core/index.ts';
import type { Asset, GraphEditorAdapter, Shot, VideoProject } from '../shared/types.ts';
import {t,subscribeLocale,getLocale} from './i18n.ts';
import {playhead} from './playhead-store.ts';

/** Canvas colours come from the studio's CSS custom properties so the graph follows light and dark schemes. */
interface GraphTheme {
  bg:string;dot:string;well:string;placeholder:string;caption:string;body:string;strong:string;meta:string;meta2:string;meta3:string;
  accent:string;media:string;rule:string;film:string;filmBody:string;titleText:string;port:string;selected:string;shadow:string;
  chrome:Record<'shot'|'film'|'image'|'asset',[string,string]>;links:{asset:string;reference:string;shot:string};
}
const DARK_THEME:GraphTheme={bg:'#111316',dot:'#ffffff14',well:'#23272d',placeholder:'#7d858f',caption:'#a7aeb7',body:'#d5d9de',strong:'#eceef1',meta:'#9aa2ac',meta2:'#8c949e',meta3:'#77808a',
  accent:'#4fd1ae',media:'#b8b4f0',rule:'#2c3238',film:'#e8c872',filmBody:'#a7aeb7',titleText:'#f2f4f6',port:'#a7aeb7',selected:'#4fd1ae',shadow:'',
  chrome:{shot:['#1f5b4e','#191d22'],film:['#6b5626','#1d1b16'],image:['#2f4f6e','#191d22'],asset:['#4f3f6e','#191d22']},links:{asset:'#6ea8e8',reference:'#a993d8',shot:'#4fd1ae'}};
let theme:GraphTheme=DARK_THEME;
function graphInk():GraphTheme{return theme;}
function readTheme(element:Element):GraphTheme{
  const style=getComputedStyle(element),v=(name:string,fallback:string)=>style.getPropertyValue(name).trim()||fallback,d=DARK_THEME;
  return {bg:v('--vs-g-bg',d.bg),dot:v('--vs-g-dot',d.dot),well:v('--vs-g-well',d.well),placeholder:v('--vs-g-text-3',d.placeholder),caption:v('--vs-g-text-2',d.caption),body:v('--vs-g-text',d.body),strong:v('--vs-g-strong',d.strong),
    meta:v('--vs-g-text-2',d.meta),meta2:v('--vs-g-text-2',d.meta2),meta3:v('--vs-g-text-3',d.meta3),accent:v('--vs-g-accent',d.accent),media:v('--vs-g-media',d.media),rule:v('--vs-g-rule',d.rule),
    film:v('--vs-g-film',d.film),filmBody:v('--vs-g-text-2',d.filmBody),titleText:v('--vs-g-title-text',d.titleText),port:v('--vs-g-port',d.port),selected:v('--vs-g-selected',d.selected),shadow:v('--vs-g-shadow',''),
    chrome:{shot:[v('--vs-g-title-shot',d.chrome.shot[0]),v('--vs-g-node',d.chrome.shot[1])],film:[v('--vs-g-title-film',d.chrome.film[0]),v('--vs-g-node-film',d.chrome.film[1])],
      image:[v('--vs-g-title-image',d.chrome.image[0]),v('--vs-g-node',d.chrome.image[1])],asset:[v('--vs-g-title-asset',d.chrome.asset[0]),v('--vs-g-node',d.chrome.asset[1])]},
    links:{asset:v('--vs-g-link-asset',d.links.asset),reference:v('--vs-g-link-reference',d.links.reference),shot:v('--vs-g-link-shot',d.links.shot)}};
}
function nodeChrome(kind: NodeKind, assetKind?: Asset['kind']): {color:string;bgcolor:string} {
  const [color,bgcolor]=kind==='shot'?theme.chrome.shot:kind==='film'?theme.chrome.film:assetKind==='image'?theme.chrome.image:theme.chrome.asset;
  return {color,bgcolor};
}
const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
export interface GraphRemoval { shots:string[]; assets:{name:string;links:number}[] }

export interface GraphEdge { from:string; to:string }
type NodeKind='image'|'text'|'audio'|'video'|'shot'|'film';
interface NodeData { id:string; kind:NodeKind; asset?:Asset; shot?:Shot; image?:HTMLImageElement; order:number; fps?:number }
class StudioNode extends LGraphNode {
  static title='Video node'; static title_text_color='#eef5f7'; data:NodeData={id:'',kind:'film',order:0};
  constructor(){super(t('视频节点'));this.size=[252,184];this.resizable=false;}
  get shotBodyTop():number{return this.inputs.length*LiteGraph.NODE_SLOT_HEIGHT+14;}
  resizeForPorts():void{if(this.data.kind==='shot'){this.size=[252,this.shotBodyTop+142];this.setDirtyCanvas(true,true);}}
  onDrawForeground(ctx:CanvasRenderingContext2D):void {
    const d=this.data,p=graphInk();ctx.save();ctx.font='14px system-ui, sans-serif';ctx.textBaseline='top';
    if(d.kind==='image'){
      const image=d.image;
      ctx.fillStyle=p.well;ctx.fillRect(14,50,224,92);
      if(image?.complete&&image.naturalWidth){const scale=Math.min(224/image.naturalWidth,92/image.naturalHeight);const w=image.naturalWidth*scale,h=image.naturalHeight*scale;ctx.drawImage(image,14+(224-w)/2,50+(92-h)/2,w,h);}
      else {ctx.fillStyle=p.placeholder;ctx.fillText(t('图片资产'),26,86);}
      ctx.fillStyle=p.caption;ctx.fillText(ellipsize(ctx,d.asset?.description||d.asset?.name||'',224),14,153);
    }else if(d.kind==='text'){
      ctx.fillStyle=p.body;wrap(ctx,d.asset?.text||d.asset?.description||t('文字内容'),14,54,220,18,5);
    }else if(d.kind==='video'){
      ctx.fillStyle=p.media;ctx.fillText(t('▶  视频素材'),14,57);ctx.fillStyle=p.body;wrap(ctx,d.asset?.description||d.asset?.name||'',14,86,220,20,2);
      ctx.fillStyle=p.meta;ctx.fillText(ellipsize(ctx,t('{seconds} 秒 · 镜头属性绑定',{seconds:(d.asset?.duration||0).toFixed(1)}),220),14,143);
    }else if(d.kind==='audio'){
      ctx.fillStyle=p.media;ctx.fillText(t('♫  音频素材'),14,57);ctx.fillStyle=p.body;wrap(ctx,d.asset?.description||d.asset?.name||'',14,86,220,20,2);
      ctx.fillStyle=p.meta;ctx.fillText(ellipsize(ctx,t('{seconds} 秒 · 声音面板安排',{seconds:(d.asset?.duration||0).toFixed(1)}),220),14,143);
    }else if(d.kind==='shot'){
      const top=this.shotBodyTop;
      ctx.strokeStyle=p.rule;ctx.beginPath();ctx.moveTo(14,top-12);ctx.lineTo(238,top-12);ctx.stroke();
      ctx.fillStyle=p.accent;ctx.fillText(t('镜头 {number}  ·  {seconds} 秒',{number:String(d.order+1).padStart(2,'0'),seconds:((d.shot?.durationFrames||0)/(d.fps||30)).toFixed(1)}),14,top);
      ctx.fillStyle=p.strong;wrap(ctx,d.shot?.intent||t('描述这个镜头想表达什么'),14,top+23,216,18,3);
      ctx.fillStyle=p.meta2;ctx.fillText(ellipsize(ctx,d.shot?.composition||t('可在右侧编辑构图和动作'),216),14,top+83);
      const n=(d.shot?.assetIds.length||0)+(d.shot?.referenceIds.length||0);ctx.fillStyle=p.meta3;ctx.fillText(t('{count} 项素材关联  ·  {transition}',{count:n,transition:t(d.shot?.transition==='fade'?'淡入淡出':'直接切换')}),14,top+109);
    }else {ctx.fillStyle=p.film;ctx.fillText(t('主镜头链的终点'),14,55);ctx.fillStyle=p.filmBody;wrap(ctx,t('最后一个镜头连接到这里，然后生成画面、预览并导出。'),14,83,220,19,3);}
    ctx.restore();
  }
}
const SHOT_X=380,SHOT_Y=120,SHOT_STEP=330,ASSET_GAP=340,ASSET_Y=60,ASSET_STEP=242;
let registered=false;
function register():void{if(registered)return;for(const kind of ['image','text','audio','video','shot','film'] as NodeKind[])LiteGraph.registerNodeType(`video-studio/${kind}`,StudioNode);registered=true;}

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
  /** The first view was computed while the canvas was hidden; fit it once the canvas has real size. */
  private pendingInitialView=false;
  constructor(private canvas:HTMLCanvasElement,private onChange:(project:VideoProject)=>void,private onSelect:(id:string|null)=>void,private onViewport:(scale:number)=>void=()=>{},private onRemoved:(removal:GraphRemoval)=>void=()=>{}){
    register();this.graph=new LGraph();this.view=new LGraphCanvas(canvas,this.graph);
    this.view.show_info=false;this.view.background_image='';this.view.clear_background_color=theme.bg;this.view.render_canvas_border=false;
    this.view.render_shadows=false;this.view.allow_searchbox=false;this.view.allow_dragcanvas=true;
    this.view.low_quality_zoom_threshold=.2;
    this.view.ds.min_scale=.08;this.view.ds.max_scale=3;
    // LiteGraph 0.17.2 scales its background for DPR, but leaves its foreground and
    // resize backing store to the host. Keep graph and pointer coordinates in CSS pixels.
    const front=this.view.drawFrontCanvas.bind(this.view);
    this.view.drawFrontCanvas=()=>{this.view.ctx?.setTransform(this.pixelRatio,0,0,this.pixelRatio,0,0);front();};
    const visible=this.view.ds.computeVisibleArea.bind(this.view.ds);
    this.view.ds.computeVisibleArea=(viewport)=>visible(viewport||[0,0,this.logicalWidth,this.logicalHeight]);
    this.view.ds.onChanged=()=>this.rememberViewport();
    const resized=()=>this.resize();window.addEventListener('resize',resized);window.visualViewport?.addEventListener('resize',resized);
    this.cleanup.push(()=>{window.removeEventListener('resize',resized);window.visualViewport?.removeEventListener('resize',resized);});
    let resolution:MediaQueryList;
    const watchDpr=()=>{resolution?.removeEventListener('change',changedDpr);resolution=window.matchMedia(`(resolution: ${window.devicePixelRatio||1}dppx)`);resolution.addEventListener('change',changedDpr);};
    const changedDpr=()=>{this.resize();watchDpr();};watchDpr();this.cleanup.push(()=>resolution.removeEventListener('change',changedDpr));
    // Dot grid in graph space so it pans and zooms with the nodes.
    this.view.onDrawBackground=(ctx:CanvasRenderingContext2D,area:number[])=>{
      const scale=this.view.ds.scale;if(scale<.35)return;const gap=24,size=Math.max(1,1.3/scale);
      ctx.save();ctx.fillStyle=theme.dot;const x0=Math.floor(area[0]!/gap)*gap,y0=Math.floor(area[1]!/gap)*gap,x1=area[0]!+area[2]!,y1=area[1]!+area[3]!;
      for(let x=x0;x<x1;x+=gap)for(let y=y0;y<y1;y+=gap)ctx.fillRect(x-size/2,y-size/2,size,size);ctx.restore();
    };
    this.applyTheme();
    const studio=canvas.closest('.vs-studio');
    if(studio&&typeof MutationObserver!=='undefined'){const themeObserver=new MutationObserver(()=>this.applyTheme());themeObserver.observe(studio,{attributes:true,attributeFilter:['data-scheme']});this.cleanup.push(()=>themeObserver.disconnect());}
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
      // Space plays the film like every other studio surface; dragging empty canvas already pans.
      if(event.key===' '&&!event.repeat&&!(this.view as unknown as {pointer?:{isDown?:boolean}}).pointer?.isDown){event.preventDefault();event.stopPropagation();playhead.toggle();return;}
      if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();event.stopImmediatePropagation();this.remove(this.selectedIds());}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'){event.preventDefault();event.stopImmediatePropagation();this.duplicateSelection();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'){event.preventDefault();event.stopImmediatePropagation();this.clipboardIds=this.selectedIds();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='v'){event.preventDefault();event.stopImmediatePropagation();this.paste();}
    };
    // Capture above the canvas so business copy/delete runs before LiteGraph's keyboard handler.
    const keyboardOwner=canvas.parentElement!;
    keyboardOwner.addEventListener('keydown',key,true);this.cleanup.push(()=>keyboardOwner.removeEventListener('keydown',key,true));
    const drag=(e:DragEvent)=>{if(e.dataTransfer?.types.includes('application/x-dsh-video-asset')){e.preventDefault();e.dataTransfer.dropEffect='move';}};
    const drop=(e:DragEvent)=>{const id=e.dataTransfer?.getData('application/x-dsh-video-asset');if(!id||!this.project)return;e.preventDefault();const rect=canvas.getBoundingClientRect();const ds=this.view.ds;const node=this.nodes.get(id);if(!node)return;node.pos=[(e.clientX-rect.left)/ds.scale-ds.offset[0],(e.clientY-rect.top)/ds.scale-ds.offset[1]];this.onSelect(id);this.queueChange();};
    canvas.addEventListener('dragover',drag);canvas.addEventListener('drop',drop);this.cleanup.push(()=>{canvas.removeEventListener('dragover',drag);canvas.removeEventListener('drop',drop);});
    this.resize();
  }
  private paint(node:StudioNode):void {const chrome=nodeChrome(node.data.kind,node.data.asset?.kind);node.color=chrome.color;node.bgcolor=chrome.bgcolor;}
  /** Re-read colours from CSS after a scheme change and repaint every node. */
  applyTheme():void{
    if(this.disposed||typeof getComputedStyle!=='function')return;
    theme=readTheme(this.canvas);
    this.view.clear_background_color=theme.bg;
    this.view.default_connection_color_byType={...this.view.default_connection_color_byType,...theme.links};
    const lite=LiteGraph as unknown as Record<string,unknown>;
    lite.NODE_TEXT_COLOR=theme.port;lite.NODE_SELECTED_TITLE_COLOR=theme.titleText;lite.NODE_BOX_OUTLINE_COLOR=theme.selected;
    if(theme.shadow){this.view.render_shadows=true;lite.DEFAULT_SHADOW_COLOR=theme.shadow;}else this.view.render_shadows=false;
    StudioNode.title_text_color=theme.titleText;
    for(const node of this.nodes.values())this.paint(node);
    this.view.setDirty(true,true);
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
    const signature=projection(project);this.project=project;
    if(signature===this.serialized){
      for(const shot of project.shots){const node=this.nodes.get(shot.id);if(node){node.data.shot=shot;const order=project.shotOrder.indexOf(shot.id);node.data.order=order<0?project.shots.indexOf(shot):order;node.data.fps=project.target.fps.num/project.target.fps.den;}}
      for(const asset of project.assets){const node=this.nodes.get(asset.id);const url=assetUrl(asset);if(node&&asset.kind==='image'&&url&&node.data.image?.src!==url){const image=new Image();image.onload=()=>node.setDirtyCanvas(true,true);image.src=url;node.data.image=image;}}
      this.view.setDirty(true,true);return;
    }
    this.setting=true;clearTimeout(this.timer);
    try{
      const initial=this.nodes.size===0;
      const scale=this.view.ds.scale,offset=[...this.view.ds.offset] as [number,number];
      this.graph.clear();this.nodes.clear();
      const assetX=Math.min(SHOT_X,...project.shots.map(s=>project.graph.positions[s.id]?.[0]??SHOT_X))-ASSET_GAP;
      project.assets.forEach((asset,index)=>{
        const node=this.add(asset.id,asset.kind,asset.name,project.graph.positions[asset.id]||[assetX,ASSET_Y+index*ASSET_STEP]);node.data.asset=asset;this.paint(node);
        if(asset.kind!=='audio'&&asset.kind!=='video'){node.addOutput(t('使用素材'),'asset');node.addOutput(t('仅供参考'),'reference');}
        if(asset.kind==='image'){const url=assetUrl(asset);if(url){const image=new Image();image.onload=()=>node.setDirtyCanvas(true,true);image.src=url;node.data.image=image;}}
      });
      project.shots.forEach((shot,index)=>{
        const order=project.shotOrder.indexOf(shot.id),slot=order<0?index:order;
        const node=this.add(shot.id,'shot',shot.title,project.graph.positions[shot.id]||[SHOT_X+slot*SHOT_STEP,SHOT_Y]);node.data.shot=shot;node.data.order=order<0?index:order;node.data.fps=project.target.fps.num/project.target.fps.den;this.paint(node);
        node.addInput(t('上一镜头'),'shot');node.addOutput(t('下一镜头'),'shot');
        for(let i=0;i<Math.max(1,shot.assetIds.length+1);i++)node.addInput(t('使用 {number}',{number:i+1}),'asset');
        for(let i=0;i<Math.max(1,shot.referenceIds.length+1);i++)node.addInput(t('参考 {number}',{number:i+1}),'reference');
        node.resizeForPorts();
        node.onConnectionsChange=()=>{if(this.setting)return;for(const type of ['asset','reference'])if(!node.inputs.some(input=>input.type===type&&input.link==null))node.addInput(t(type==='asset'?'使用 +':'参考 +'),type);node.resizeForPorts();this.queueChange();};
      });
      const film=this.add('film-output','film',t('影片输出'),project.graph.positions['film-output']||[SHOT_X+project.shots.length*SHOT_STEP,SHOT_Y]);this.paint(film);film.addInput(t('最后镜头'),'shot');
      for(const shot of project.shots){const target=this.nodes.get(shot.id)!;shot.assetIds.forEach((id,i)=>this.nodes.get(id)?.connect(0,target,1+i));const offset=1+Math.max(1,shot.assetIds.length+1);shot.referenceIds.forEach((id,i)=>this.nodes.get(id)?.connect(1,target,offset+i));}
      for(const edge of graphEdges(project)){const from=this.nodes.get(edge.from),to=this.nodes.get(edge.to);if(from&&to)from.connect(0,to,0);}
      for(const saved of project.graph.groups){const group=new LGraphGroup(saved.title);group.pos=[saved.bounds[0],saved.bounds[1]];group.size=[saved.bounds[2],saved.bounds[3]];this.graph.add(group);}
      this.view.ds.scale=scale;this.view.ds.offset=offset;this.view.setDirty(true,true);this.serialized=signature;
      if(initial){const saved=LiteGraphEditor.viewports.get(project.id);if(saved){this.view.ds.scale=saved.scale;this.view.ds.offset=[...saved.offset];}else{this.focus(project.shotOrder[0]||project.assets[0]?.id, .9, false);this.pendingInitialView=this.logicalWidth<=100||this.logicalHeight<=100;}}
      this.onViewport(this.view.ds.scale);
    }finally{this.setting=false;}
  }
  private add(id:string,kind:NodeKind,title:string,position:[number,number]):StudioNode{
    const node=LiteGraph.createNode(`video-studio/${kind}`) as StudioNode;
    node.title=title;node.pos=[...position];node.data={id,kind,order:0};
    node.onSelected=()=>this.onSelect(node.data.id);node.onDblClick=()=>this.onSelect(node.data.id);
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
  /**
   * Shots are deleted (undoable through history). Asset nodes are only detached from every shot:
   * deleting the asset itself is an explicit library action with confirmation.
   */
  remove(ids=this.selectedIds()):void{
    if(!this.project)return;let next=this.project;const removal:GraphRemoval={shots:[],assets:[]};
    for(const id of ids){
      const shot=next.shots.find(s=>s.id===id);if(shot){next=deleteShot(next,id);removal.shots.push(shot.title);continue;}
      const asset=next.assets.find(a=>a.id===id);if(!asset)continue;let links=0;
      for(const target of next.shots){
        if(target.assetIds.includes(id)){next=unbindAsset(next,target.id,id,'asset');links++;}
        if(target.referenceIds.includes(id)){next=unbindAsset(next,target.id,id,'reference');links++;}
      }
      removal.assets.push({name:asset.name,links});
    }
    if(next!==this.project)this.onChange(next);
    if(removal.shots.length||removal.assets.length)this.onRemoved(removal);
  }
  duplicate(id:string):void{if(this.project)this.onChange(duplicateShot(this.project,id,getLocale()));}
  private duplicateSelection():void{if(!this.project)return;let next=this.project;for(const id of this.selectedIds())if(next.shots.some(shot=>shot.id===id))next=duplicateShot(next,id,getLocale());if(next!==this.project)this.onChange(next);}
  private paste():void{if(!this.project||!this.clipboardIds.length)return;let next=this.project;for(const id of this.clipboardIds){if(next.shots.some(s=>s.id===id))next=duplicateShot(next,id,getLocale());else{const source=next.assets.find(a=>a.id===id);if(!source)continue;const asset={...source,id:`asset-${crypto.randomUUID()}`,name:t('{name} 副本',{name:source.name})};const position=next.graph.positions[id]||this.nodes.get(id)?.pos||[35,55];next={...next,assets:[...next.assets,asset],graph:{...next.graph,positions:{...next.graph.positions,[asset.id]:[position[0]+35,position[1]+35]}},revision:next.revision+1};}}if(next!==this.project)this.onChange(next);}
  groupSelection():void{const nodes=this.selectedIds().map(id=>this.nodes.get(id)).filter((n):n is StudioNode=>Boolean(n));if(!nodes.length)return;const x=Math.min(...nodes.map(n=>n.pos[0]))-25,y=Math.min(...nodes.map(n=>n.pos[1]))-60;const right=Math.max(...nodes.map(n=>n.pos[0]+n.size[0]))+25,bottom=Math.max(...nodes.map(n=>n.pos[1]+n.size[1]))+25;const group=new LGraphGroup(t('镜头分组'));group.pos=[x,y];group.size=[right-x,bottom-y];this.graph.add(group);this.queueChange();}
  /** One readable row: assets stacked by their real height on the left, the shot chain left-to-right, output last. */
  arrange():void{
    if(!this.project)return;const positions:Record<string,[number,number]>={};let y=ASSET_Y;
    for(const asset of this.project.assets){positions[asset.id]=[SHOT_X-ASSET_GAP,y];const height=this.nodes.get(asset.id)?.size[1]??184;y+=height+LiteGraph.NODE_TITLE_HEIGHT+28;}
    const order=[...this.project.shotOrder,...this.project.shots.map(s=>s.id).filter(id=>!this.project!.shotOrder.includes(id))];
    order.forEach((id,i)=>positions[id]=[SHOT_X+i*SHOT_STEP,SHOT_Y]);positions['film-output']=[SHOT_X+order.length*SHOT_STEP,SHOT_Y];
    this.onChange({...this.project,graph:{positions,groups:[]},revision:this.project.revision+1});
    requestAnimationFrame(()=>{if(!this.disposed)this.fit();});
  }
  fit(animate=true):void{const nodes=[...this.nodes.values()];if(!nodes.length)return;const minX=Math.min(...nodes.map(n=>n.pos[0]))-40,minY=Math.min(...nodes.map(n=>n.pos[1]))-70,maxX=Math.max(...nodes.map(n=>n.pos[0]+n.size[0]))+40,maxY=Math.max(...nodes.map(n=>n.pos[1]+n.size[1]))+40;const scale=Math.max(.08,Math.min(1,this.logicalWidth/(maxX-minX),this.logicalHeight/(maxY-minY)));this.moveTo(scale,[-minX+(this.logicalWidth/scale-(maxX-minX))/2,-minY+(this.logicalHeight/scale-(maxY-minY))/2],animate);}
  focus(id?:string,scale?:number,animate=true):void{const node=this.nodes.get(id||this.selectedIds()[0]||this.project?.shotOrder[0]||'');if(!node)return;const next=scale!==undefined?scale:this.view.ds.scale<.75?1:this.view.ds.scale;this.moveTo(next,[-node.pos[0]-node.size[0]/2+this.logicalWidth/(2*next),-node.pos[1]-node.size[1]/2+this.logicalHeight/(2*next)],animate);}
  zoom(scale:number):void{this.stopAnimation();const rect=this.canvas.getBoundingClientRect();this.view.ds.changeScale(Math.max(.08,Math.min(3,scale)),[rect.left+rect.width/2,rect.top+rect.height/2]);this.viewportChanged();}
  private stopAnimation():void{if(this.animation)cancelAnimationFrame(this.animation);this.animation=0;}
  /** Ease the viewport to a target so focus/fit never teleports the user's spatial context. */
  private moveTo(scale:number,offset:[number,number],animate:boolean):void{
    this.stopAnimation();
    if(!animate||reducedMotion()||typeof requestAnimationFrame!=='function'){this.view.ds.scale=scale;this.view.ds.offset=offset;this.viewportChanged();return;}
    const from={scale:this.view.ds.scale,offset:[...this.view.ds.offset] as [number,number]},start=performance.now(),duration=260;
    // Interpolate the screen-space centre so the motion reads as a straight pan with zoom.
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
  private viewportChanged():void{this.view.setDirty(true,true);this.rememberViewport();}
  private rememberViewport():void{this.onViewport(this.view.ds.scale);if(this.project&&!this.setting&&!this.disposed)LiteGraphEditor.viewports.set(this.project.id,{scale:this.view.ds.scale,offset:[...this.view.ds.offset] as [number,number]});}
  resize():void{if(this.disposed)return;const parent=this.canvas.parentElement;if(!parent)return;const metrics=canvasMetrics(parent.clientWidth,parent.clientHeight,window.devicePixelRatio||1);this.logicalWidth=metrics.width;this.logicalHeight=metrics.height;this.pixelRatio=metrics.dpr;this.view.resize(metrics.backingWidth,metrics.backingHeight);this.canvas.dataset.pixelRatio=String(metrics.dpr);this.view.ctx?.setTransform(metrics.dpr,0,0,metrics.dpr,0,0);this.view.setDirty(true,true);if(this.pendingInitialView&&metrics.width>100&&metrics.height>100){this.pendingInitialView=false;this.fit(false);}}
  setInteractive(value:boolean):void{this.view.allow_interaction=value;}
  dispose():void{
    this.disposed=true;this.stopAnimation();clearTimeout(this.timer);this.observer.disconnect();for(const stop of this.cleanup)stop();this.view.stopRendering();
    // LiteGraph 0.17.2 unbindEvents omits capture=true and two drag listeners. Remove only this view's callbacks.
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

export function canvasMetrics(width:number,height:number,dpr:number){const logicalWidth=Math.max(100,Math.round(width)),logicalHeight=Math.max(100,Math.round(height)),ratio=Math.max(1,dpr||1);return {width:logicalWidth,height:logicalHeight,dpr:ratio,backingWidth:Math.round(logicalWidth*ratio),backingHeight:Math.round(logicalHeight*ratio)};}
