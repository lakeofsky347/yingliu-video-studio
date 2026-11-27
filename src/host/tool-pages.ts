import type {DirectorDocument} from '../director/contracts.ts';
import type {VideoProject} from '../shared/types.ts';

const pageCharacters=8_000;
const directorSections=['shots','characters','locations','props','worldLayouts','storyBeats','identityMap','continuityLog'] as const;
export const directorReadSections=['summary',...directorSections] as const;
export const projectReadSections=['summary','shots','assets'] as const;
type PageInput={section?:unknown;offset?:unknown;limit?:unknown;textOffset?:unknown;shotIds?:unknown;expectedRevision?:unknown;expectedVersion?:unknown;expectedHash?:unknown};

export function isPagedRead(input:PageInput):boolean {
  return [input.section,input.offset,input.limit,input.textOffset,input.shotIds].some(value=>value!==undefined);
}

function count(value:unknown,fallback:number,min:number,max=Number.MAX_SAFE_INTEGER):number {
  if(value===undefined)return fallback;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new Error('分页位置或数量无效');
  return value;
}

function page(rows:unknown[],input:PageInput){
  const offset=count(input.offset,0,0),limit=count(input.limit,12,1,60),textOffset=count(input.textOffset,0,0);
  const pagination={offset,total:rows.length,limit};
  if(offset>=rows.length){if(textOffset)throw new Error('文字续读行不存在');return {items:[],pagination};}
  const first=JSON.stringify(rows[offset])!;
  if(textOffset||first.length>pageCharacters){
    if(textOffset>=first.length)throw new Error('文字续读位置超出行长度');
    const nextTextOffset=Math.min(textOffset+pageCharacters,first.length);
    const total=first.length;
    return {items:[],fragment:{encoding:'json',text:first.slice(textOffset,nextTextOffset),textOffset,total},
      pagination:{...pagination,...(nextTextOffset<total?{nextTextOffset}:offset+1<rows.length?{nextOffset:offset+1}:{})}};
  }
  const items=[];let size=0;
  for(const row of rows.slice(offset,offset+limit)){
    const length=JSON.stringify(row)!.length+1;
    if(items.length&&size+length>pageCharacters)break;
    items.push(row);size+=length;
  }
  const nextOffset=offset+items.length;
  return {items,pagination:{...pagination,...(nextOffset<rows.length?{nextOffset}:{})}};
}

function selectShots<T>(rows:T[],input:PageInput,key:(row:T)=>string):T[] {
  if(input.shotIds===undefined)return rows;
  if(!Array.isArray(input.shotIds)||!input.shotIds.length||input.shotIds.some(id=>typeof id!=='string'||!id))throw new Error('镜头 ID 列表无效');
  const ids=new Set(input.shotIds);
  const selected=rows.filter(row=>ids.has(key(row)));
  if(selected.length!==ids.size)throw new Error('指定的镜头不在当前记录中');
  return selected;
}

export function pagedProject(project:VideoProject,input:PageInput){
  if(input.expectedRevision!==undefined&&input.expectedRevision!==project.revision)throw Object.assign(new Error('工程版本已变化，请重新开始分页'),{code:'REVISION_CONFLICT'});
  const section=input.section??'shots';
  const productionPolicy=project.productionPolicy&&{...project.productionPolicy,hybridGrants:undefined,hybridGrantCount:project.productionPolicy.hybridGrants?.length??0};
  const header={projectId:project.id,title:project.title,target:project.target,revision:project.revision,shotCount:project.shots.length,assetCount:project.assets.length,productionPolicy};
  if(section==='summary')return {...header,section};
  if(section==='assets'){
    const assets=project.assets.map(({id,kind,name,description,mime,duration,width,height,hasAudio,provenance})=>({id,kind,name,description,mime,duration,width,height,hasAudio,provenance}));
    return {...header,section,...page(assets,input)};
  }
  if(section!=='shots')throw new Error('未知工程分页栏目');
  const byId=new Map(project.shots.map(shot=>[shot.id,shot]));
  const order=[...new Set([...project.shotOrder,...project.shots.map(shot=>shot.id)])];
  const shots=order.flatMap(id=>{const shot=byId.get(id);if(!shot)return [];const {sourcePath:_sourcePath,...detail}=shot;return [detail];});
  return {...header,section,...page(selectShots(shots,input,shot=>shot.id),input)};
}

export function pagedDirector(document:DirectorDocument|undefined,input:PageInput){
  if(!document)return {document:null};
  if(input.expectedVersion!==undefined&&input.expectedVersion!==document.version||input.expectedHash!==undefined&&input.expectedHash!==document.hash)throw Object.assign(new Error('导演计划版本已变化，请重新开始分页'),{code:'REVISION_CONFLICT'});
  const {plan,...documentHeader}=document;
  const section=input.section??'shots';
  if(section==='summary')return {documentHeader,section,plan:{filmKind:plan.filmKind,title:plan.title,logline:plan.logline?.slice(0,1000),counts:Object.fromEntries(directorSections.map(key=>[key,plan[key]?.length??0]))}};
  if(typeof section!=='string'||!directorSections.some(key=>key===section))throw new Error('未知导演计划分页栏目');
  const key=section as typeof directorSections[number];
  const rows=key==='shots'?selectShots(plan.shots,input,shot=>shot.shotId):plan[key]??[];
  return {documentHeader,section,...page(rows,input)};
}
