import {clientMainEnglish} from '../locales/client-main.en.ts';
import {clientMediaEnglish} from '../locales/client-media.en.ts';
import {clientUtilityEnglish} from '../locales/client-utilities.en.ts';
import {backendMediaEnglish} from '../locales/backend-media.en.ts';
import {backendCoreEnglish} from '../locales/backend-core.en.ts';

export type StudioLocale='zh'|'en';
export type MessageValues=Record<string,string|number|boolean|null|undefined>;
/** Source-language messages are stable gettext-style identifiers. */
export const englishMessages:Readonly<Record<string,string>>={
  ...backendCoreEnglish,...backendMediaEnglish,...clientUtilityEnglish,...clientMainEnglish,...clientMediaEnglish,
};

export function normalizeLocale(value:unknown):StudioLocale{
  return typeof value==='string'&&/^zh(?:-|$)/i.test(value)?'zh':'en';
}

export function formatMessage(locale:StudioLocale,message:string,values:MessageValues={}):string{
  const template=locale==='en'&&Object.hasOwn(englishMessages,message)?englishMessages[message]:message;
  return template.replace(/\{([\w]+)\}/g,(token,key:string)=>Object.hasOwn(values,key)?String(values[key]??''):token);
}

// Only registered diagnostics and task progress can be recognized after interpolation.
// UI labels, generated names, document prose and arbitrary vendor text are not patterns.
// Add new dynamic system messages here when adding their source-language emission.
const systemTemplateSources=[
  'shotPatch.{0} 须为资产 ID 数组','第 {0} 个镜头须为对象',
  '旁白超出镜头时长 {0} 秒，请调整裁剪、旁白或解除时长锁定',
  '工程版本冲突：期望 v{0}，当前 v{1}；请读取最新工程后合并修改',
  '正在生成 · 已收到 {0} 字符','镜头 {0} 帧 {1}：{2}','生成镜头 {0}/{1}',
  '路径 {0} 不能在 Windows 访问：{1}','找不到镜头：{0}','{0}含空或无效 ID','{0}含重复 ID',
  '资产 {0} 类型不支持','资产 {0} 缺少名称','图片 {0} 需要项目内相对路径','文字资产 {0} 缺少文本',
  '视频 {0} 原始文件路径无效','视频 {0} 需要有效路径和时长','视频 {0} 尺寸无效','视频 {0} FPS 无效',
  '视频 {0} 帧数无效','视频 {0} 音轨信息无效','音频 {0} 需要有效路径和时长',
  '镜头 {0} 缺少标题','镜头 {0} 时长须为正整数帧','镜头 {0} 源码路径无效','镜头 {0} 转场无效',
  '镜头 {0} 的 {1} 须为数组','镜头 {0} 引用了不存在的资产 {1}','镜头 {0} 参数缺失',
  '镜头 {0} 参数 {1} 无效','镜头 {0} 参数 {1} 须为文字','镜头 {0} 参数 {1} 须为有限数值',
  '镜头 {0} 图片缩放和字号须大于零','镜头 {0} imageFit 无效','镜头 {0} motion 无效',
  '镜头顺序包含不存在的镜头 {0}','镜头 {0} 尚未连入主链','节点 {0} 的画布位置无效',
  '音频片段 {0} 引用的镜头不存在','音频片段 {0} 角色无效','音频片段 {0} {1} 无效','音频片段 {0} 裁剪区间无效',
  '主链草稿：{0}','主链连线包含未知节点 {0} → {1}','主链断开：{0} → {1}','无法编译视频要求：\n{0}',
  '镜头 ID 已存在：{0}','找不到资产：{0}','资产 ID 已存在：{0}',
  '镜头 {0} 缺少画面来源标记','资产 {0} 来源或用途无效','镜头 {0} 尚未确认画面来源',
  '镜头 {0} 尚未采用视频，禁止用代码或占位画面替代','参考专用视频 {0} 不得进入成片',
  '镜头 {0} 使用自有或未知来源视频前须得到用户许可','镜头 {0} 的模型视频来源标记与实际资产不符',
  '镜头 {0} 的导入视频来源标记与实际资产不符','镜头 {0} 视频长度不足，不能自动冻结末帧补齐成片',
  '参考专用资产 {0} 不得绑定为成片素材','视频 {0} 须通过明确的视频画面绑定使用，不能暴露给自由源码',
  '{0} 路径 {1} 与 {2} 路径 {3} 冲突：{4}','{0} 路径 {1} 不能跨平台使用：{2}',
  '{0} 配置路径不可执行，请在环境页检查路径：{1}','{0} 未就绪，请在环境页配置路径',
  '音频处理失败（{0}）：{1}','音频片段 {0} 缺少可读取的音频资产','音频片段 {0} 绑定的镜头不存在',
  '音频片段 {0} 的裁剪、音量或定位无效','音频片段 {0} 位于成片结束之后，请调整定位或时长',
  '旁白超出{0}时长 {1} 秒，请延长画面或调整旁白裁剪','配音请求失败：HTTP {0}',
  '无法启动系统文件打开程序：{0}','打开文件失败（{0}），请检查默认应用','捕获帧 {0} / {1}',
  '工程已保存，预览准备失败：{0}','镜头源码不可读：{0}','媒体文件不可读：{0}',
  '任务记录保存失败：{0}','任务结束记录保存失败：{0}','本地质检发现硬失败：{0}',
  '工程缺少媒体文件：{0}','媒体文件不存在：{0}','含 Windows 保留名称 {0}',
  '{0} JSON 超过 {1} MiB','模型目录鉴权失败（HTTP {0}），请检查 API Key 和权限。',
  '此服务地址未提供可用的模型目录（HTTP {0}），可手动填写模型 ID。',
  '无法读取模型目录{0}，请检查服务地址后重试，或手动填写模型 ID。',
  '{0}须为 {1}–{2} 的整数','字幕文字量约 {0} 行；这是字数估算，须在实际画面检查排版',
  '实际主链 {0} 秒，与目标 {1} 秒相差超过 20%','抽样帧 {0} 未检查：{1}','抽样帧 {0} 没有可分析的 PNG',
  '{0}须在 {1}–{2} 之间','映流视频工作台无法启动：DSH {0}缺少所需插件 API：\n{1}\n请检查 DSH 插件内核和相关服务是否完整加载。',
  '媒体接口请求失败（HTTP {0}）','{0}失败（HTTP {1}）','{0}响应为空','{0}返回无效 JSON',
  '所选模型/协议不支持此生成操作：{0}','当前适配器最多支持 {0} 张参考图片；不会只取首图',
  '当前适配器不支持参考角色：{0}','当前适配器不支持生成参数：{0}；不会静默忽略',
  '生成参数无效：{0}','生图参数须为文本：{0}','生成参数须为整数：{0}','模型参数上限无效：{0}',
  '生成参数超过模型范围：{0}','请先配置 {0} 角色的模型','媒体下载失败（HTTP {0}）','下载生成素材 {0}',
  '人物身份映射引用了不存在的图片：{0}','人物身份映射引用了本轮未授权的图片：{0}',
  '身份映射必须绑定到该镜头的身份参考：{0}','当前工作流参考仅支持已有图片：{0}','镜头尚未关联指定参考：{0}',
  '导演不能自行增加本轮未授权的上传参考：{0}','协作成功回执无法读取，已停止以免重复调用：{0}',
  '上次 {0} 模型提交结果待确认，缺少可复用的成功回执；不能自动重复调用，请检查供应商记录后明确新建制作',
  '结果已保存为工程 v{0}','候选质量硬性条件失败：{0}','已检查 {0} 张实际候选关键帧',
  '导演计划引用不存在的工程镜头：{0}','导演计划引用的图片资产不存在：{0}','导演计划引用的参考资产不存在：{0}',
  '{0} 未就绪，请在环境设置中配置','视频处理失败：{0}','视频文件超出本机大小限制（{0} 字节）',
  '{0} 超过 80000 字符上限','{0} 不是有效 ZIP 文件','{0} 暂不支持 ZIP64 风格包','{0} 包含过多文件',
  '{0} 的 ZIP 目录已损坏','{0} 含有加密文件，无法导入','{0} 解压后超过 32 MB 上限',
  '{0} 超过 32 MB 上限','{0} 中的文本总量超过限制','暂不支持 {0}；请使用 Markdown、TXT、JSON、ZIP 或风格文件夹',
  '{0} 不是有效 JSON：{1}',
  // These labels are program-owned enums, not values supplied by a caller.
  '连接版本须为 {0}–{1} 的整数','超时须为 {0}–{1} 的整数','并发数须为 {0}–{1} 的整数',
  '音效时长须在 {0}–{1} 之间','起始频率须在 {0}–{1} 之间','结束频率须在 {0}–{1} 之间',
  '音效音量须在 {0}–{1} 之间','音效种子须在 {0}–{1} 之间',
  '旁白超出镜头时长 {0} 秒，请延长画面或调整旁白裁剪','旁白超出成片时长 {0} 秒，请延长画面或调整旁白裁剪',
] as const;
const diagnosticMessages:Readonly<Record<string,string>>={...backendCoreEnglish,...backendMediaEnglish,...clientUtilityEnglish};
// These are the only interpolated notices emitted by the UI itself.
const uiSystemTemplateSources=['已导入 {value0} 个视频制作风格。','已删除「{value0}」。','第 {value0} 帧 PNG 已保存到项目中。'] as const;
interface MessageTemplate {english:string;keys:string[];literals:string[];literalLength:number}
function messageTemplates(entries:readonly [string,string|undefined][]):MessageTemplate[]{return entries.flatMap(([source,english])=>{
  if(!english)return [];
  const keys:string[]=[],literals:string[]=[];let index=0;
  for(const match of source.matchAll(/\{(\w+)\}/g)){
    literals.push(source.slice(index,match.index));keys.push(match[1]);index=match.index!+match[0].length;
  }
  literals.push(source.slice(index));
  const literalLength=literals.join('').replace(/\s/g,'').length;
  // Weak or adjacent placeholders cannot identify a system message reliably.
  if(!keys.length||literalLength<4||literals.slice(1,-1).some(text=>!text))return [];
  return [{english,keys,literals,literalLength}];
}).sort((a,b)=>b.literalLength-a.literalLength);}
const templates=messageTemplates([
  ...systemTemplateSources.map(source=>[source,diagnosticMessages[source]] as [string,string|undefined]),
  ...uiSystemTemplateSources.map(source=>[source,clientMainEnglish[source]] as [string,string|undefined]),
]);

/** Match fixed delimiters once, from left to right, with no regex backtracking.
 * The final delimiter is anchored at the end; captured details are never translated.
 */
function matchTemplate(template:MessageTemplate,value:string):MessageValues|undefined{
  const {keys,literals}=template,prefix=literals[0]!,suffix=literals.at(-1)!;
  if(!value.startsWith(prefix)||!value.endsWith(suffix))return;
  const limit=value.length-suffix.length,values:MessageValues={};let cursor=prefix.length;
  for(let index=0;index<keys.length;index++){
    const delimiter=literals[index+1]!,end=index===keys.length-1?limit:value.indexOf(delimiter,cursor);
    if(end<cursor||end>limit)return;
    const key=keys[index]!,captured=value.slice(cursor,end);
    if(Object.hasOwn(values,key)&&values[key]!==captured)return;
    values[key]=captured;cursor=end+delimiter.length;
  }
  return values;
}

/** Translate only explicitly identified system-message fields, never project data.
 * Stored messages stay in the source language. English vendor text is never reversed.
 * Captured parameters (including user names and vendor details) stay verbatim.
 */
export function translateSystemMessage(locale:StudioLocale,value:string|null|undefined):string{
  if(!value)return '';
  if(locale==='zh')return value;
  // Preserve oversized provider logs as a whole and bound work on every UI render.
  if(value.length>16_384||!/[\u3400-\u9fff]/.test(value))return value;
  return translateKnownMessage(value,0,true);
}

// These prefixes are emitted by our compiler, quality checker and task service.
// Only the list-producing callers are allowed to split their nested messages.
const nestedDiagnostics:[prefix:string,separator?:string][]=[
  ['无法编译视频要求：\n','\n'],
  ['本地质检发现硬失败：','；'],
  ['候选质量硬性条件失败：','；'],
  ['工程已保存，预览准备失败：'],
  ['主链草稿：'],
];
function translateKnownMessage(value:string,depth:number,allowLines:boolean):string{
  if(depth>=8)return value;
  const dictionary=allowLines?englishMessages:diagnosticMessages;
  if(Object.hasOwn(dictionary,value))return dictionary[value];
  for(const [prefix,separator] of nestedDiagnostics){
    if(!value.startsWith(prefix))continue;
    const detail=value.slice(prefix.length);
    let translated:string;
    if(separator){
      const parts=detail.split(separator),messages=parts.map(message=>translateKnownMessage(message,depth+1,false));
      // A user-supplied identifier can contain a list delimiter. If splitting
      // leaves an unrecognized fragment, prefer a complete diagnostic match
      // that retains that identifier as one opaque parameter.
      const whole=parts.some((part,index)=>part&&part===messages[index])
        ?translateKnownMessage(detail,depth+1,false):detail;
      translated=whole!==detail?whole:messages.join(separator);
    }else translated=translateKnownMessage(detail,depth+1,false);
    return formatMessage('en',prefix+'{0}',{0:translated});
  }
  for(const template of templates){
    const values=matchTemplate(template,value);if(!values)continue;
    return template.english.replace(/\{([\w]+)\}/g,(token,key:string)=>Object.hasOwn(values,key)?String(values[key]??''):token);
  }
  if(allowLines&&value.includes('\n'))return value.split('\n').map(line=>translateKnownMessage(line,depth+1,true)).join('\n');
  return value;
}

export function dateLocale(locale:StudioLocale):string{return locale==='zh'?'zh-CN':'en-US';}
