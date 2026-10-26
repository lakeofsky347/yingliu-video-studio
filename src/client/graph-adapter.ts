import { LiteGraph, LGraph, LGraphNode, LGraphCanvas, LGraphGroup } from '@comfyorg/litegraph';
import { deleteAsset, deleteShot, duplicateShot } from '../core/index.ts';
import type { Asset, GraphEditorAdapter, Shot, VideoProject } from '../shared/types.ts';

export interface GraphEdge { from:string; to:string }
type NodeKind='image'|'text'|'audio'|'video'|'shot'|'film';
interface NodeData { id:string; kind:NodeKind; asset?:Asset; shot?:Shot; image?:HTMLImageElement; order:number; fps?:number }
class StudioNode extends LGraphNode {
  static title='视频节点'; static title_text_color='#eef5f7'; data:NodeData={id:'',kind:'film',order:0};
  constructor(){super('视频节点');this.size=[252,184];this.resizable=false;}
  get shotBodyTop():number{return this.inputs.length*LiteGraph.NODE_SLOT_HEIGHT+14;}
  resizeForPorts():void{if(this.data.kind==='shot'){this.size=[252,this.shotBodyTop+142];this.setDirtyCanvas(true,true);}}
  onDrawForeground(ctx:CanvasRenderingContext2D):void {
    const d=this.data;ctx.save();ctx.font='14px system-ui, sans-serif';ctx.textBaseline='top';
    if(d.kind==='image'){
      const image=d.image;
      ctx.fillStyle='#192a37';ctx.fillRect(14,50,224,92);
      if(image?.complete&&image.naturalWidth){const scale=Math.min(224/image.naturalWidth,92/image.naturalHeight);const w=image.naturalWidth*scale,h=image.naturalHeight*scale;ctx.drawImage(image,14+(224-w)/2,50+(92-h)/2,w,h);}
      else {ctx.fillStyle='#8397a7';ctx.fillText('图片资产',26,86);}
      ctx.fillStyle='#a8b7c4';ctx.fillText(ellipsize(ctx,d.asset?.description||d.asset?.name||'',224),14,153);
    }else if(d.kind==='text'){
      ctx.fillStyle='#d2dce4';wrap(ctx,d.asset?.text||d.asset?.description||'文字内容',14,54,220,18,5);
    }else if(d.kind==='video'){
      ctx.fillStyle='#bcbbeb';ctx.fillText('▶  视频素材',14,57);ctx.fillStyle='#d2dce4';wrap(ctx,d.asset?.description||d.asset?.name||'',14,86,220,20,2);
      ctx.fillStyle='#99a7ba';ctx.fillText(ellipsize(ctx,`${(d.asset?.duration||0).toFixed(1)} 秒 · 镜头属性绑定`,220),14,143);
    }else if(d.kind==='audio'){
      ctx.fillStyle='#bcbbeb';ctx.fillText('♫  音频素材',14,57);ctx.fillStyle='#d2dce4';wrap(ctx,d.asset?.description||d.asset?.name||'',14,86,220,20,2);
      ctx.fillStyle='#99a7ba';ctx.fillText(ellipsize(ctx,`${(d.asset?.duration||0).toFixed(1)} 秒 · 声音面板安排`,220),14,143);
    }else if(d.kind==='shot'){
      const top=this.shotBodyTop;
      ctx.strokeStyle='#36504f';ctx.beginPath();ctx.moveTo(14,top-12);ctx.lineTo(238,top-12);ctx.stroke();
      ctx.fillStyle='#79d8c0';ctx.fillText(`镜头 ${String(d.order+1).padStart(2,'0')}  ·  ${((d.shot?.durationFrames||0)/(d.fps||30)).toFixed(1)} 秒`,14,top);
      ctx.fillStyle='#e0e8ed';wrap(ctx,d.shot?.intent||'描述这个镜头想表达什么',14,top+23,216,18,3);
      ctx.fillStyle='#93a5b4';ctx.fillText(ellipsize(ctx,d.shot?.composition||'可在右侧编辑构图和动作',216),14,top+83);
      const n=(d.shot?.assetIds.length||0)+(d.shot?.referenceIds.length||0);ctx.fillStyle='#7892a3';ctx.fillText(`${n} 项素材关联  ·  ${d.shot?.transition==='fade'?'淡入淡出':'直接切换'}`,14,top+109);
    }else {ctx.fillStyle='#e2cf8e';ctx.fillText('主镜头链的终点',14,55);ctx.fillStyle='#aab7c2';wrap(ctx,'最后一个镜头连接到这里，然后生成画面、预览并导出。',14,83,220,19,3);}
    ctx.restore();
  }
}
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
  constructor(private canvas:HTMLCanvasElement,private onChange:(project:VideoProject)=>void,private onSelect:(id:string|null)=>void,private onViewport:(scale:number)=>void=()=>{}){
    register();this.graph=new LGraph();this.view=new LGraphCanvas(canvas,this.graph);
    this.view.show_info=false;this.view.background_image='';this.view.clear_background_color='#111c27';this.view.render_canvas_border=false;
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
    this.view.default_connection_color_byType={...this.view.default_connection_color_byType,asset:'#74a4d8',reference:'#ac94cc',shot:'#7bd6bd'};
    // Never expose LiteGraph's generic HTML property dialogs; React owns all text inputs.
    this.view.showEditPropertyValue=()=>undefined;
    this.view.showShowNodePanel=(node:LGraphNode)=>this.onSelect((node as StudioNode).data.id);
    this.view.showSearchBox=()=>undefined as never;
    this.view.prompt=()=>undefined as never;
    this.view.getNodeMenuOptions=(node:LGraphNode)=>[
      {content:'编辑属性',callback:()=>this.onSelect((node as StudioNode).data.id)},
      ...((node as StudioNode).data.kind==='shot'?[{content:'复制镜头',callback:()=>this.duplicate((node as StudioNode).data.id)}]:[]),
      ...((node as StudioNode).data.kind!=='film'?[{content:'删除节点',callback:()=>this.remove([(node as StudioNode).data.id])}]:[])
    ];
    this.view.getCanvasMenuOptions=()=>[{content:'整理画布',callback:()=>this.arrange()},{content:'选中节点分组',callback:()=>this.groupSelection()}];
    this.view.getGroupMenuOptions=()=>[];
    this.graph.onAfterChange=()=>this.queueChange();
    this.graph.onNodeRemoved=()=>this.queueChange();
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas.parentElement!);
    canvas.tabIndex=0;canvas.setAttribute('aria-label','资产与镜头连线画布');
    const key=(event:KeyboardEvent)=>{
      if(event.target!==canvas)return;
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
      const assetX=Math.min(375,...project.shots.map(s=>project.graph.positions[s.id]?.[0]??375))-335;
      project.assets.forEach((asset,index)=>{
        const node=this.add(asset.id,asset.kind,asset.name,project.graph.positions[asset.id]||[assetX,55+index*235]);node.data.asset=asset;
        node.color=asset.kind==='image'?'#315474':'#5f4e77';node.bgcolor='#1d2b3a';
        if(asset.kind!=='audio'&&asset.kind!=='video'){node.addOutput('使用素材','asset');node.addOutput('仅供参考','reference');}
        if(asset.kind==='image'){const url=assetUrl(asset);if(url){const image=new Image();image.onload=()=>node.setDirtyCanvas(true,true);image.src=url;node.data.image=image;}}
      });
      project.shots.forEach((shot,index)=>{
        const order=project.shotOrder.indexOf(shot.id);
        const node=this.add(shot.id,'shot',shot.title,project.graph.positions[shot.id]||[375+(index%3)*330,100+Math.floor(index/3)*300]);node.data.shot=shot;node.data.order=order<0?index:order;node.data.fps=project.target.fps.num/project.target.fps.den;
        node.color='#2c7168';node.bgcolor='#1a3033';node.addInput('上一镜头','shot');node.addOutput('下一镜头','shot');
        for(let i=0;i<Math.max(1,shot.assetIds.length+1);i++)node.addInput(`使用 ${i+1}`,'asset');
        for(let i=0;i<Math.max(1,shot.referenceIds.length+1);i++)node.addInput(`参考 ${i+1}`,'reference');
        node.resizeForPorts();
        node.onConnectionsChange=()=>{if(this.setting)return;for(const type of ['asset','reference'])if(!node.inputs.some(input=>input.type===type&&input.link==null))node.addInput(type==='asset'?'使用 +':'参考 +',type);node.resizeForPorts();this.queueChange();};
      });
      const film=this.add('film-output','film','影片输出',project.graph.positions['film-output']||[375+Math.min(project.shots.length,3)*330,100]);film.color='#897138';film.bgcolor='#332e21';film.addInput('最后镜头','shot');
      for(const shot of project.shots){const target=this.nodes.get(shot.id)!;shot.assetIds.forEach((id,i)=>this.nodes.get(id)?.connect(0,target,1+i));const offset=1+Math.max(1,shot.assetIds.length+1);shot.referenceIds.forEach((id,i)=>this.nodes.get(id)?.connect(1,target,offset+i));}
      for(const edge of graphEdges(project)){const from=this.nodes.get(edge.from),to=this.nodes.get(edge.to);if(from&&to)from.connect(0,to,0);}
      for(const saved of project.graph.groups){const group=new LGraphGroup(saved.title);group.pos=[saved.bounds[0],saved.bounds[1]];group.size=[saved.bounds[2],saved.bounds[3]];this.graph.add(group);}
      this.view.ds.scale=scale;this.view.ds.offset=offset;this.view.setDirty(true,true);this.serialized=signature;
      if(initial){const saved=LiteGraphEditor.viewports.get(project.id);if(saved){this.view.ds.scale=saved.scale;this.view.ds.offset=[...saved.offset];}else this.focus(project.shotOrder[0]||project.assets[0]?.id, .9);}
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
  remove(ids=this.selectedIds()):void{if(!this.project)return;let next=this.project;for(const id of ids){if(next.shots.some(s=>s.id===id))next=deleteShot(next,id);else if(next.assets.some(a=>a.id===id))next=deleteAsset(next,id);}if(next!==this.project)this.onChange(next);}
  duplicate(id:string):void{if(this.project)this.onChange(duplicateShot(this.project,id));}
  private duplicateSelection():void{if(!this.project)return;let next=this.project;for(const id of this.selectedIds())if(next.shots.some(shot=>shot.id===id))next=duplicateShot(next,id);if(next!==this.project)this.onChange(next);}
  private paste():void{if(!this.project||!this.clipboardIds.length)return;let next=this.project;for(const id of this.clipboardIds){if(next.shots.some(s=>s.id===id))next=duplicateShot(next,id);else{const source=next.assets.find(a=>a.id===id);if(!source)continue;const asset={...source,id:`asset-${crypto.randomUUID()}`,name:`${source.name} 副本`};const position=next.graph.positions[id]||this.nodes.get(id)?.pos||[35,55];next={...next,assets:[...next.assets,asset],graph:{...next.graph,positions:{...next.graph.positions,[asset.id]:[position[0]+35,position[1]+35]}},revision:next.revision+1};}}if(next!==this.project)this.onChange(next);}
  groupSelection():void{const nodes=this.selectedIds().map(id=>this.nodes.get(id)).filter((n):n is StudioNode=>Boolean(n));if(!nodes.length)return;const x=Math.min(...nodes.map(n=>n.pos[0]))-25,y=Math.min(...nodes.map(n=>n.pos[1]))-60;const right=Math.max(...nodes.map(n=>n.pos[0]+n.size[0]))+25,bottom=Math.max(...nodes.map(n=>n.pos[1]+n.size[1]))+25;const group=new LGraphGroup('镜头分组');group.pos=[x,y];group.size=[right-x,bottom-y];this.graph.add(group);this.queueChange();}
  arrange():void{if(!this.project)return;const positions:Record<string,[number,number]>={};this.project.assets.forEach((a,i)=>positions[a.id]=[35,80+i*235]);const order=[...this.project.shotOrder,...this.project.shots.map(s=>s.id).filter(id=>!this.project!.shotOrder.includes(id))];order.forEach((id,i)=>positions[id]=[375+(i%3)*320,140+Math.floor(i/3)*340]);positions['film-output']=[375+(order.length%3)*320,140+Math.floor(order.length/3)*340];this.onChange({...this.project,graph:{positions,groups:[]},revision:this.project.revision+1});}
  fit():void{const nodes=[...this.nodes.values()];if(!nodes.length)return;const minX=Math.min(...nodes.map(n=>n.pos[0]))-30,minY=Math.min(...nodes.map(n=>n.pos[1]))-70,maxX=Math.max(...nodes.map(n=>n.pos[0]+n.size[0]))+30,maxY=Math.max(...nodes.map(n=>n.pos[1]+n.size[1]))+30;const scale=Math.max(.08,Math.min(1,this.logicalWidth/(maxX-minX),this.logicalHeight/(maxY-minY)));this.view.ds.scale=scale;this.view.ds.offset=[-minX+(this.logicalWidth/scale-(maxX-minX))/2,-minY+(this.logicalHeight/scale-(maxY-minY))/2];this.viewportChanged();}
  focus(id?:string,scale?:number):void{const node=this.nodes.get(id||this.selectedIds()[0]||this.project?.shotOrder[0]||'');if(!node)return;if(scale!==undefined)this.view.ds.scale=scale;else if(this.view.ds.scale<.75)this.view.ds.scale=1;this.view.ds.offset=[-node.pos[0]-node.size[0]/2+this.logicalWidth/(2*this.view.ds.scale),-node.pos[1]-node.size[1]/2+this.logicalHeight/(2*this.view.ds.scale)];this.viewportChanged();}
  zoom(scale:number):void{const rect=this.canvas.getBoundingClientRect();this.view.ds.changeScale(Math.max(.08,Math.min(3,scale)),[rect.left+rect.width/2,rect.top+rect.height/2]);this.viewportChanged();}
  get scale():number{return this.view.ds.scale;}
  private viewportChanged():void{this.view.setDirty(true,true);this.rememberViewport();}
  private rememberViewport():void{this.onViewport(this.view.ds.scale);if(this.project&&!this.setting&&!this.disposed)LiteGraphEditor.viewports.set(this.project.id,{scale:this.view.ds.scale,offset:[...this.view.ds.offset] as [number,number]});}
  resize():void{if(this.disposed)return;const parent=this.canvas.parentElement;if(!parent)return;const metrics=canvasMetrics(parent.clientWidth,parent.clientHeight,window.devicePixelRatio||1);this.logicalWidth=metrics.width;this.logicalHeight=metrics.height;this.pixelRatio=metrics.dpr;this.view.resize(metrics.backingWidth,metrics.backingHeight);this.canvas.dataset.pixelRatio=String(metrics.dpr);this.view.ctx?.setTransform(metrics.dpr,0,0,metrics.dpr,0,0);this.view.setDirty(true,true);}
  setInteractive(value:boolean):void{this.view.allow_interaction=value;}
  dispose():void{
    this.disposed=true;clearTimeout(this.timer);this.observer.disconnect();for(const stop of this.cleanup)stop();this.view.stopRendering();
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
