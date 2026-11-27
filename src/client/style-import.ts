import { strFromU8, unzipSync } from 'fflate';
import type { VideoStyle } from '../shared/types.ts';

export type VideoStyleDraft=Pick<VideoStyle,'name'|'description'|'prompt'|'sourceFormat'|'sourceName'>;
interface TextDocument {path:string;text:string;origin:'file'|'zip'|'folder';group:string}

const MAX_FILE_BYTES=32*1024*1024,MAX_TEXT_CHARS=80000,MAX_ZIP_ENTRIES=500;
const ignoredPath=/(^|\/)(?:__MACOSX|\.git|node_modules|demo|dist|build)(\/|$)/i;
const styleText=/\.(?:md|markdown|txt|json)$/i;
const leaf=(path:string)=>path.split('/').filter(Boolean).at(-1)||path;
const parent=(path:string)=>path.split('/').slice(0,-1).join('/');
const cleanPath=(path:string)=>path.replace(/\\/g,'/').split('/').filter(part=>part&&part!=='.'&&part!=='..').join('/');
function safeText(text:string,source:string):string{if(text.length>MAX_TEXT_CHARS)throw new Error(`${source} 超过 80000 字符上限`);return text.replace(/^\uFEFF/,'').trim();}
function validateZip(bytes:Uint8Array,name:string){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),start=Math.max(0,bytes.length-65557);let end=-1;
  for(let offset=bytes.length-22;offset>=start;offset--)if(view.getUint32(offset,true)===0x06054b50){end=offset;break;}
  if(end<0)throw new Error(`${name} 不是有效 ZIP 文件`);
  const count=view.getUint16(end+10,true),directorySize=view.getUint32(end+12,true),directoryOffset=view.getUint32(end+16,true);
  if(count===0xffff||directorySize===0xffffffff||directoryOffset===0xffffffff)throw new Error(`${name} 暂不支持 ZIP64 风格包`);
  if(count>MAX_ZIP_ENTRIES)throw new Error(`${name} 包含过多文件`);
  if(directoryOffset+directorySize>end)throw new Error(`${name} 的 ZIP 目录已损坏`);
  let offset=directoryOffset,total=0;
  for(let index=0;index<count;index++){
    if(offset+46>directoryOffset+directorySize||view.getUint32(offset,true)!==0x02014b50)throw new Error(`${name} 的 ZIP 目录已损坏`);
    if(view.getUint16(offset+8,true)&1)throw new Error(`${name} 含有加密文件，无法导入`);
    const uncompressed=view.getUint32(offset+24,true),nameLength=view.getUint16(offset+28,true),extraLength=view.getUint16(offset+30,true),commentLength=view.getUint16(offset+32,true);
    if(uncompressed===0xffffffff)throw new Error(`${name} 暂不支持 ZIP64 风格包`);
    total+=uncompressed;if(total>MAX_FILE_BYTES)throw new Error(`${name} 解压后超过 32 MB 上限`);
    offset+=46+nameLength+extraLength+commentLength;
  }
}

export async function parseStyleFiles(files:File[]):Promise<VideoStyleDraft[]>{
  const documents:TextDocument[]=[];
  for(const [index,file] of files.entries()){
    const relative=file.webkitRelativePath?cleanPath(file.webkitRelativePath):'';
    if(relative&&(ignoredPath.test(relative)||!(styleText.test(relative)||/\.zip$/i.test(relative))))continue;
    if(file.size>MAX_FILE_BYTES)throw new Error(`${file.name} 超过 32 MB 上限`);
    if(/\.zip$/i.test(file.name)){
      const bytes=new Uint8Array(await file.arrayBuffer());validateZip(bytes,file.name);
      const entries=unzipSync(bytes,{filter:entry=>{
        const path=cleanPath(entry.name);
        return !/[\\/]$/.test(entry.name)&&styleText.test(path)&&!ignoredPath.test(path);
      }});
      const keys=Object.keys(entries);
      if(keys.length>MAX_ZIP_ENTRIES)throw new Error(`${file.name} 包含过多文件`);
      let total=0;
      for(const entryPath of keys){
        const path=cleanPath(entryPath);
        const bytes=entries[entryPath]!;total+=bytes.length;if(total>MAX_TEXT_CHARS*8)throw new Error(`${file.name} 中的文本总量超过限制`);
        documents.push({path,text:safeText(strFromU8(bytes),path),origin:'zip',group:`archive:${index}:${parent(path)}`});
      }
      continue;
    }
    const path=relative||cleanPath(file.name);
    if(!styleText.test(path))throw new Error(`暂不支持 ${file.name}；请使用 Markdown、TXT、JSON、ZIP 或风格文件夹`);
    const text=safeText(await file.text(),file.name);
    documents.push({path,text,origin:relative?'folder':'file',group:relative?`folder:${parent(path)}`:`file:${index}`});
  }

  const groups=new Map<string,TextDocument[]>();
  for(const document of documents){const rows=groups.get(document.group)||[];rows.push(document);groups.set(document.group,rows);}
  const output:VideoStyleDraft[]=[];
  for(const rows of groups.values()){
    const markdown=rows.find(row=>/^style\.(md|markdown)$/i.test(leaf(row.path)))||rows.find(row=>/\.(md|markdown|txt)$/i.test(leaf(row.path)))||rows.find(row=>/^readme\.md$/i.test(leaf(row.path)));
    const jsonDocument=rows.find(row=>/^style\.json$/i.test(leaf(row.path)))||rows.find(row=>/\.json$/i.test(leaf(row.path)));
    if(!markdown&&!jsonDocument)continue;
    let metadata:Record<string,unknown>={};
    if(jsonDocument){try{const parsed=JSON.parse(jsonDocument.text);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))metadata=parsed as Record<string,unknown>;}
      catch(error){throw new Error(`${jsonDocument.path} 不是有效 JSON：${error instanceof Error?error.message:String(error)}`);}}
    const heading=markdown?.text.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.replace(/\s*[—–-]\s*(?:style\s+prompt|style)$/i,'').trim();
    const name=[metadata.cn,metadata.name,metadata.title,metadata.en,metadata.slug,heading,leaf(markdown?.path||jsonDocument!.path).replace(/\.(md|markdown|txt|json)$/i,'')]
      .find(value=>typeof value==='string'&&value.trim()) as string;
    const desc=[metadata.summary,metadata.description,metadata.line_cn,metadata.line].find(value=>typeof value==='string'&&value.trim()) as string|undefined;
    const promptValue=[metadata.prompt,metadata.stylePrompt,metadata.style_prompt,metadata.instructions].find(value=>typeof value==='string'&&value.trim());
    const prompt=markdown?.text||(typeof promptValue==='string'?promptValue:typeof metadata.description==='string'?metadata.description:JSON.stringify(metadata,null,2));
    const origin=rows[0]!.origin;
    const sourceFormat:VideoStyleDraft['sourceFormat']=origin==='zip'?'zip':origin==='folder'?'folder':jsonDocument&&!markdown?'json':'markdown';
    output.push({name:name.slice(0,100),description:(desc||'').slice(0,1000),prompt:safeText(prompt,leaf(markdown?.path||jsonDocument!.path)),sourceFormat,sourceName:leaf(markdown?.path||jsonDocument!.path)});
  }
  if(!output.length)throw new Error('没有找到可导入的风格描述；请选择包含 STYLE.md、Markdown、TXT 或 style.json 的文件或 ZIP');
  return output;
}
