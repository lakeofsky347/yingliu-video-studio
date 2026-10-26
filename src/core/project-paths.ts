/** Basic safety remains separate from portability so existing Unix projects can be read. */
export function safeRelativeProjectPath(value:unknown):value is string {
  return typeof value==='string'&&!!value.trim()&&!value.startsWith('/')&&!value.includes('\\')
    &&!value.includes('\0')&&!/[\uD800-\uDFFF]/u.test(value)&&!/^[a-zA-Z]:/.test(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..');
}

export function portableProjectPathReason(value:unknown):string|undefined {
  if(!safeRelativeProjectPath(value))return '须为安全的项目内相对路径';
  for(const part of value.split('/')){
    if(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/.test(part))return '含控制字符或 Windows 不支持的文件名字符';
    if(/[. ]$/.test(part))return '路径段不能以点或空格结尾';
    const stem=part.split('.')[0]!.replace(/[. ]+$/,'');
    if(/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(stem))return '含 Windows 保留名称 '+JSON.stringify(part);
  }
  return undefined;
}

interface ProjectPaths {
  shots:readonly {id:string;sourcePath:unknown}[];
  assets:readonly {id:string;path?:unknown;originalPath?:unknown}[];
}
export interface ProjectPathIssue {
  code:'nonportable'|'conflict';
  paths:string[];
  message:string;
}
interface PathEntry { path:string;label:string;kind:'source'|'asset';key:string }
function caselessKey(value:string):string{return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');}

/** New writes use a portable policy, independent of the host filesystem's case sensitivity. */
export function inspectProjectPaths(project:ProjectPaths):ProjectPathIssue[] {
  const entries:PathEntry[]=[];
  for(const shot of project.shots)if(safeRelativeProjectPath(shot.sourcePath))entries.push({path:shot.sourcePath,label:'镜头 '+shot.id,kind:'source',key:''});
  for(const asset of project.assets)if(safeRelativeProjectPath(asset.path))entries.push({path:asset.path,label:'资产 '+asset.id,kind:'asset',key:''});
  for(const asset of project.assets)if(safeRelativeProjectPath(asset.originalPath))entries.push({path:asset.originalPath,label:'原始资产 '+asset.id,kind:'asset',key:''});
  const issues:ProjectPathIssue[]=[],conflicts=new Set<string>();
  function conflict(a:PathEntry,b:PathEntry,reason:string){
    const key=[a.label+'\0'+a.path,b.label+'\0'+b.path].sort().join('\n');
    if(conflicts.has(key))return;conflicts.add(key);
    issues.push({code:'conflict',paths:[a.path,b.path],message:`${a.label} 路径 ${JSON.stringify(a.path)} 与 ${b.label} 路径 ${JSON.stringify(b.path)} 冲突：${reason}`});
  }
  const aliases=new Map<string,{spelling:string;entry:PathEntry}>();
  for(const entry of entries){
    entry.key=caselessKey(entry.path);
    const reason=portableProjectPathReason(entry.path);
    if(reason)issues.push({code:'nonportable',paths:[entry.path],message:`${entry.label} 路径 ${JSON.stringify(entry.path)} 不能跨平台使用：${reason}`});
    const parts=entry.path.split('/');
    for(let i=1;i<=parts.length;i++){
      const spelling=parts.slice(0,i).join('/'),key=caselessKey(spelling),previous=aliases.get(key);
      if(previous&&previous.spelling!==spelling)conflict(previous.entry,entry,'大小写或 Unicode 归一化别名');
      else if(!previous)aliases.set(key,{spelling,entry});
    }
  }
  const stored=new Map<string,PathEntry>();
  for(const entry of entries){
    const previous=stored.get(entry.key);
    if(previous){
      // Multiple asset IDs may intentionally reference the exact same media file.
      if(entry.kind!=='asset'||previous.kind!=='asset'||entry.path!==previous.path)conflict(previous,entry,'路径不能指向同一存储位置');
    }else stored.set(entry.key,entry);
  }
  for(const entry of entries){
    const parts=entry.key.split('/');
    for(let i=1;i<parts.length;i++){
      const parent=stored.get(parts.slice(0,i).join('/'));
      if(parent)conflict(parent,entry,'源码目录不能嵌套，媒体文件不能用作目录');
    }
  }
  return issues;
}
