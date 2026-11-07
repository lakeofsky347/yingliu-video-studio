import type {DirectorRule} from './contracts.ts';
export const DIRECTOR_RULESET_VERSION='2026-11-06.1';
const formula='https://www.bilibili.com/video/BV1jLug6LEgp';
const performance='https://www.bilibili.com/video/BV1Tnum6qEB5';
const space='https://www.bilibili.com/video/BV1XggH63EeM';
const topology='https://www.bilibili.com/video/BV1Tn836WEmb';
export const DIRECTOR_RULES:readonly DirectorRule[]=[
  {id:'performance.causal-beat',version:1,title:'表演由目标、刺激与可见反应组成',source:[{url:formula,range:'04:27–04:57（四层与六组字段）'},{url:performance,range:'02:12–03:49、06:16–06:30（情绪过程与八维公式）'}],applicability:'人物表演镜头；不要求信息图或产品镜头虚构人物',requirement:'逐拍记录时间、说话目标、精确台词与触发词、可见动作、声音动作、话轮归属和听者反应。AU 为可选实验，优先使用可见的自然语言动作。',failureCategories:['flat-performance','unmotivated-action'],origin:'tutorial'},
  {id:'dialogue.intentional-events',version:1,title:'保留刻意停顿、截断、重复与抢话',source:[{url:formula,range:'01:26–03:21、04:57–05:12（话轮、语言失序与审片）'},{url:performance,range:'02:52–03:49（台词触发与停顿）'}],applicability:'有对白镜头；由计划明确标记后启用',requirement:'不要自动补全被截断的话，不删除有动机的重复，不把计划内重叠判成串话；字幕只呈现实际说出的词。',failureCategories:['dialogue-completion','flattened-rhythm','speaker-confusion'],origin:'tutorial'},
  {id:'space.three-layers',version:1,title:'世界拓扑、人物映射与镜头事件分层',source:[{url:space,range:'02:35–03:59、04:44–05:07（编号、站位与运镜）'},{url:topology,range:'00:48–03:48、05:09–05:31（三层空间与新空间段）'}],applicability:'多人或跨镜头空间连续性',requirement:'世界坐标、屏幕坐标和人物相互关系分别记录；固定人物 ID；身份映射不附加位置。大幅移动后创建新的空间段，不沿用过期站位。',failureCategories:['identity-swap','coordinate-confusion','continuity'],origin:'tutorial'},
  {id:'story.genre-fit',version:1,title:'结构服务片型',source:[{url:'https://www.bilibili.com/video/BV1Re8q6zEqQ',range:'01:34–02:52、05:38–06:44（六拍与诊断）'}],applicability:'悬念短剧可选六拍；其他片型按内容自选结构',requirement:'异常、目标、规则、障碍、反转、未解问题是可选的悬念结构；每拍应改变信息、目标或局面。不得强制产品片、讲解片或抒情片套用六拍。',failureCategories:['forced-structure','empty-beat'],origin:'engineering'},
  {id:'reference.not-production',version:1,title:'参考用途与成片产物分离',source:[{url:'https://www.bilibili.com/video/BV1GPYj6nEo3',range:'02:48–04:24、05:32–08:00、09:52–10:37（精度、路线与适用范围）'}],applicability:'使用白模、俯视图、身份或风格参考',requirement:'参考只能指导约定的维度；白模与拓扑图不直接进入成片。先确定人物路线，再确定机位；只有生成的正式产物参与成片。',failureCategories:['reference-leak','wrong-reference-purpose'],origin:'engineering'},
  {id:'audio.preserve-performance',version:1,title:'原生表演声轨由明确策略控制',source:[{url:formula,range:'01:26–01:55、04:57–05:12（声音重叠与审片）'}],applicability:'原生音视频模型输出',requirement:'native 保留模型原声，external 为明确授权的外配音，silent 为明确静音；不得以默认 TTS 覆盖表演。',failureCategories:['native-audio-overwritten','audio-strategy'],origin:'engineering'},
  {id:'quality.evidence-scope',version:1,title:'检查结论不得超出证据范围',source:[],applicability:'所有候选评估',requirement:'静帧只能证明抽样帧的视觉现象；对白、口型、节奏、重叠和全片连续性需要音视频证据，未检查或低信心进入人工审看。重试保持模式与任务上限。',failureCategories:['unsupported-pass','unchecked-temporal','budget-overrun'],origin:'engineering'},
];
