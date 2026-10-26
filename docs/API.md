# DSH 视频工作台：数据与场景接口

本文描述首版插件的稳定业务语义。类型入口为 `src/shared/types.ts`，业务函数入口为 `src/core/index.ts`。第三方图引擎的节点和连线对象不写入项目文件。

## 项目文件与编辑真源

`VideoProject.schemaVersion` 为 `1`。项目保存标题、主题、目标时长、输出规格、资产、镜头、镜头顺序、画布布局、输出记录和扩展数据。

- `shots` 保存镜头内容，镜头 ID 在参数编辑、AI 修改和顺序调整后保持稳定。
- `shotOrder` 是播放顺序的真源；镜头从其顺序累加整数帧区间。画布横纵坐标不影响时间和播放顺序。
- `graph.positions`、`graph.groups` 只保存画布布局。位置使用画布坐标，图片构图参数使用画面百分比，两者互不混用。
- `assetIds` 是生产资产绑定；`referenceIds` 是设计参考。图片未绑定到镜头时不会自动出现在画面里。
- `params` 保存可即时编辑的文案、颜色、图片位置/缩放、字号和运动方式。生成源码须读取这些参数。
- `sourcePath` 是项目内源码目录，默认 `shots/<shot-id>`。一个镜头的文件为 `index.html`、`style.css`、`scene.js` 和便于搬运的 `source.json`。独立源码文件可继续编辑。
- 复制镜头时 `extensions.sourceCopies[newShotId]` 记录原源码目录，宿主将当前已编辑代码复制到新目录。新镜头不与原镜头共享源码文件。
- `targetDuration` 是初始规划目标。实际片长由镜头帧数求和得到；手动增删镜头不会机械缩放其余镜头来凑目标时长。
- `revision` 表达内容版本。导出使用启动任务时的一份项目和源码快照，输出记录注明对应版本。

默认新项目为 1920 × 1080、30/1 FPS、30 秒目标、无声，初始三个各 300 帧的手动镜头，无资产。

## 连线与断链草稿

主链连线保存为可选 `extensions.graphEdges`：

```json
[
  {"from": "shot-a", "to": "shot-b"},
  {"from": "shot-b", "to": "film-output"}
]
```

`from` 是镜头 ID，`to` 是下一镜头 ID 或固定输出节点 `film-output`。图没有独立开始节点；唯一零入度镜头是起点。末镜头必须连接输出节点。生产主链恰好经过每个镜头一次，拒绝循环、分叉、合流、重复线、未知节点、遗漏镜头和断链。

没有 `graphEdges` 字段时，按 `shotOrder` 理解为完整隐含主链。显式空数组代表用户断开全部连线，不能恢复成隐含主链。`reorderFromGraph` 保留原始连线，最多遍历实际能走通的部分，不凭空补线或补镜头。

未完成的图可以保存。`validateProject` 对图缺口返回警告；`validateGraph` 和 `compileSpec` 在制作前要求主链完整。这样，保存画布草案不会受到“还没有完整影片”的限制，预览和导出也不会悄悄遗漏镜头。

## 核心函数

所有项目编辑函数返回新对象，保留调用者的原对象，实际编辑使 revision 加一。已经绑定的同一资产再次绑定不改变版本。

| 函数 | 输入与结果 |
|---|---|
| `createProject(title, topic?)` | 新建默认 `VideoProject` |
| `defaultShot(index?, fps?)` | 新建具有独立 ID 的十秒镜头；时长四舍五入为整数帧 |
| `validateProject(project)` | `{ok, errors, warnings}`；检查项目数据、参数、资产引用和路径；允许图草稿 |
| `validateGraph(project)` | `{ok, errors, warnings}`；检查完整生产主链 |
| `compileSpec(project)` | 返回 `VideoSpec`；遇到无效项目或断链抛出带具体原因的错误 |
| `specMarkdown(spec)` | 输出中文可读制作要求，含镜头、帧区间、素材、参数和验收要求 |
| `normalizeSceneDurations(shots, targetFrames)` | 根据原时长权重分配精确整数帧预算，每镜头至少一帧；总和严格等于 targetFrames |
| `reorderShots(project, ids)` | 显式重排，必须包含全部镜头且每镜头出现一次 |
| `reorderFromGraph(project, edges)` | 保存连线并求可遍历顺序；无效图保留为草稿 |
| `addShot(project, shot?, afterId?)` | 插入镜头，默认追加至最后 |
| `duplicateShot(project, id)` | 复制镜头数据，分配新镜头 ID 与源码目录，放在原镜头之后；宿主负责复制对应源码文件 |
| `deleteShot(project, id)` | 删除镜头及对应布局，衔接剩余顺序链；原素材仍保留 |
| `updateShot(project, id, patch)` | 更新字段，不能改变镜头 ID；共享参数在 `params` 中提交 |
| `addAsset(project, asset)` | 添加图片或文字资产；素材导入和本地文件写入由宿主完成 |
| `bindAsset` / `unbindAsset` | `(project, shotId, assetId, kind?)`，kind 为 `asset` 或 `reference`，默认生产资产 |
| `deleteAsset(project, assetId)` | 删除资产与布局，并移除所有镜头中的生产/参考绑定 |

`UndoHistory<T>` 保存独立快照：`current`、`canUndo`、`canRedo` getter，以及 `push(value)`、`undo()`、`redo()`、`reset(value)`。新的编辑清除 redo 分支，默认最多保存 50 个快照。此工具处理内存中的编辑历史；宿主的源码备份与恢复是另一层文件操作。

## 镜头要求编译

每个镜头的帧区间为 `[startFrame, endFrame)`；首镜头从 0 开始，最后镜头结束于 `durationFrames`。第零帧对应 0 秒，时间为 `frame × fps.den / fps.num`。编译结果按主链排序并解析生产资产，画布位置不会改变编译结果。

`specMarkdown` 描述主题、输出规格、片长，每镜头的意图、构图、动作、转场、文案、生产/参考资产与参数。这是模型和人的制作接口；它不会把尚未生成的源码或尚未执行的媒体检查写成已经成功的影片。

## 场景源码接口

场景使用 HTML、CSS 和 ES 模块 JavaScript，支持 DOM 和 Canvas2D。HTML 是镜头根节点内的静态初始内容；CSS 使用镜头局部 class；JS 导出 `render`，可选导出异步 `ready`。

模型在修改镜头时可返回可选 `shotPatch`，更新标题、意图、构图、动作、正整数帧时长、绑定、转场和参数。参数 patch 合并到现有参数；镜头 ID 和源码目录不由模型改写。初始分镜按目标时长使用最大余数法分配整数帧，防止逐镜头四舍五入后全片超时。

```js
export async function ready(ctx) {
  // 图片与字体由宿主准备。这里可以验证镜头所需的 DOM 或轻量资源。
}

export function render(ctx) {
  const heading = ctx.root.querySelector('.heading');
  heading.textContent = ctx.params.text;
  heading.style.opacity = String(ctx.helpers.easeOutCubic(Math.min(1, ctx.time / 0.4)));
  ctx.ctx2d.fillStyle = ctx.params.background;
  ctx.ctx2d.fillRect(0, 0, ctx.width, ctx.height);
}
```

| ctx 字段 | 含义 |
|---|---|
| `root` | 覆盖画布的本镜头 DOM 根节点 |
| `canvas`, `ctx2d` | 目标尺寸画布及其 Canvas2D context |
| `params` | 当前镜头共享参数；文字与颜色应从这里读取 |
| `assets` | 本镜头可用资产；图片具有 `url` 和预解码的 `image`，文字资产具有 `text` |
| `frame`, `localFrame` | 全片整数帧和镜头局部整数帧，均从 0 开始 |
| `progress` | `localFrame / max(durationFrames - 1, 1)`，范围 0–1 |
| `time`, `duration` | 当前镜头局部秒数、镜头时长秒数 |
| `width`, `height` | 完整目标画面尺寸，与预览显示缩放无关 |
| `seed` | 根据镜头 ID 得到的稳定种子 |
| `helpers` | `clamp`、`lerp`、`smoothstep`、`easeOutCubic`、`easeInOutCubic`、按 key 稳定的 `random` |

共享参数中 `imageX`、`imageY` 是画面百分比，例如 `74` 表示画面宽度的 74%；`imageScale` 是正比例缩放，`fontSize` 是目标画面字号参数。`imageFit` 为 `cover`/`contain`，`motion` 为 `fade`/`slide`/`zoom`/`none`。

`render` 必须每次按给定帧完整求值。重复、逆序与跨镜头 seek 应成立。不要通过 `Date.now()`、`Math.random()`、独立计时器或自动播放动画累积状态。DOM 初始状态可被宿主重建，`ready` 应轻量且可重复；不要假定上一次帧调用已经执行。

镜头必须读取共享参数，而不是把全部文字、图片位置和颜色写死。模型仍可创建新的布局和动作；参数契约保障已暴露属性能够即时编辑。任意源码不能可靠地反向还原为节点图或可视对象，源码修改后也不自动反推镜头语义。

首版不要求场景安装依赖、加载外网或读取本地任意文件。第三方 runtime 能力需要由插件实现并明示，不能在生成的源码里自动安装。

## 验证范围

核心单元测试检查：主链帧区间、分数 FPS、精确整数帧预算、资产删除清理、镜头增删复制、断链/分叉/循环拒绝、无效引用/路径、undo/redo，以及执行默认源码时文案/图片绘制与重复取帧。这些测试证明核心逻辑和受控场景逻辑；浏览器真实布局、生成模型质量、DSH 原生接入和最终媒体输出由对应的运行与回读测试证明。

## V0.2：会话、输出与声音

项目新增可选 `sessionIds`、`audioClips`；镜头新增可选 `narration`；资产 kind 扩展为 `audio`，保存相对路径、MIME、duration、sampleRate 和 channels。`target.audioMode` 为 `none` 或 `mixed`，`target.quality` 为 `standard`、`high` 或 `small`。旧工程缺少这些字段时仍按无声工程处理。

`updateTarget(project, patch)` 保持镜头的实际秒数，再按新 FPS 换算整数帧。`extensions.timebaseSeconds` 保存当前秒数依据；直接修改镜头帧数后，下一次规格变更按新的实际时长重新计算。

### 模型工具

| 工具 | 操作与关键输入 | 返回 |
|---|---|---|
| `video_project` | create/open/get/list/bind；target、title、topic、targetDuration 或 projectId/path | 稳定 ID、完整镜头/素材/声音片段、revision、关联 session ID |
| `video_update` | update 含 shots、shotOrder、shotPatches、sources、target 等；imports 含 durable attachment、文字或本地文件；expectedRevision 可检查手动编辑版本 | 更新后的工程回执 |
| `video_inspect` | shotId、frame、includeSource | VideoSpec、可选源码、实际 PNG 帧路径/URL/hash；卡片可定位工作台 |
| `video_render` | preview/check/export；foreground 默认 false | 后台返回 DSH jobId；前台等待并返回工程与输出 |
| `video_audio` | import/add/update/remove/synthesize；request 含 assetId、shotId、角色、裁剪等 | 导入/片段更新结果，合成返回后台 jobId |

`exec.agent.id` 是实际工具调用者 Session。Session 索引位于工程基目录 `sessions.json`，v2 bindings 保存 currentProjectId、relatedProjectIds、updatedAt；不写入影片内容版本。省略 projectId 时查当前会话显式绑定，subagent/team 成员沿真实委派链查最近祖先；普通 fork 不继承，显式空绑定停止继承。后台任务 owner 始终是实际调用者，进度、日志、完成通知及取消复用 DSH Jobs。模型提交现有对话中的要求和源码，不通过插件重复调用另一个聊天模型。

`video_update.sources` 接受 `{shotId,source:{html,css,js}}[]`，先验证整批镜头引用和源码结构，再写入文件。模型应先读取最新 revision 并保留稳定镜头 ID，只提交用户要求修改的范围。

### AudioClip

```ts
interface AudioClip {
  id: string;
  assetId: string;
  role: 'voice' | 'music' | 'sfx';
  shotId?: string; // 有值则 startSeconds 相对镜头，否则相对成片
  startSeconds: number;
  trimStart: number;
  trimEnd?: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  loop?: boolean;
}
```

音频片段以秒保存；排序或 FPS 变化后，镜头起点根据新主链重新计算。混音使用 FFmpeg，将裁剪、循环、音量、淡化、延迟处理后合成 48 kHz 双声道 PCM WAV；MP4 编码为 AAC。缓存文件名含音频输入与片段计划的内容 hash，不覆盖旧混音，URL 版本变化不会改变已加载内容。

绑定镜头的非循环旁白所需长度为 `startSeconds + min(trimEnd ?? asset.duration, asset.duration) - trimStart`。若超过镜头，默认扩展到所需时长加 0.25 秒；未超过则不延长。`extensions.lockDuration === true` 或请求 `fitDuration:false` 时超出会返回明确差额。更新、save、apply 共用政策。全片旁白不自动选择哪个镜头延长；超片尾返回错误。音乐/音效可按片尾裁剪。重新合成同镜头旁白替换原 voice 片段，旧资产继续保留。

TTS 是独立能力，不把 ctx.llm 当作音频接口。本地适配为 macOS say；HTTP 适配由用户明确配置 endpoint/model/voice/speed/enabled。凭据引用 `DSH_VIDEO_STUDIO_TTS_API_KEY` 经 DSH credentials 保存/清除/解析，snapshot 只返回是否配置，不返回值。

### 精确帧与预览

`inspect` 使用当前项目源码在 Playwright 中调用同一 `ready()` / `renderFrame({frame,fps})`，保存真实 PNG。frame 为全片零起始帧，输出包含对应 shotId、文件路径、URL 与 SHA-256。工作台关键帧也运行同一代码。实时播放含音轨时使用音频 currentTime 作为时钟；任意帧定位、冷启动和导出仍使用帧号确定画面。

`thumbnails` 接收 `{projectId, expectedRevision, frames}`，`frames` 为 1–3 个有效的全片整数帧，返回 `{projectId, revision, frames:[{frame, shotId, path, url, sha256}]}`。它在同一个短时浏览器中生成尺寸不超过 320 × 180 的 PNG；场景仍按完整目标尺寸计算。缓存键包括项目规格、内容版本、所请求帧和 runtime，相同批次的并发请求共用任务，版本过期返回 `REVISION_CONFLICT`。工作台只保留主预览 iframe，关键帧使用静态图片；生成结束即关闭对应浏览器。完整帧 PNG 仍使用 `inspect`。

runtime 只解码当前镜头绑定的图片和视频，切镜释放不再使用的视频解码器。HTML 预解析为模板，CSS 仅在变化时更新；每帧仍提供新的 DOM、Canvas 状态和参数副本，并调用轻量、可重复的场景 `ready(ctx)`。离线导出通过 Chromium CDP 无损 PNG 捕获，等待布局与字体就绪，不等待显示器刷新。FFmpeg 的 PNG 解码和像素转换各使用一个线程，H.264 编码最多使用四个线程；画面尺寸、帧率、CRF、编码 preset 和音频规格保持原有约定。性能验证方法见 [渲染性能](RENDERING.md)。

# 0.3.0 工程管理与制作记录

既有视频工具保持原有职责，当前 Session 的模型仍直接提交分镜和源码。写入支持 `expectedRevision`；提供时在实际提交前检查，过期请求返回 `REVISION_CONFLICT`。`video_update` 在导入素材后继续使用本次已确认 revision 提交，不会跳过服务侧冲突检查。

| RPC | 输入 | 返回 |
| --- | --- | --- |
| `list` | `includeArchived?:boolean` | `{projects:[{id,path,title,createdAt?,updatedAt?,archived?,archivedAt?}],sessions,selected?}` |
| `rename` | `projectId,title,expectedRevision?` | 当前工程 `StudioSnapshot` |
| `duplicate` | `projectId,title?` | 新工程 `StudioSnapshot`；新 ID，不复制 Session、输出及历史 |
| `archive` / `restore` | `projectId` | 当前选中工程或空工程的 `StudioSnapshot`；归档不删除文件 |
| `history` | `projectId` | `{canUndo,canRedo,cursor,entries:[{id,label,createdAt,revision}]}` |
| `undo` / `redo` | `projectId,expectedRevision?` | 内容恢复后的 `StudioSnapshot`；revision 递增 |
| `tasks` / `jobs` | `projectId` | `{tasks:[TaskState & {retryable,revision?,retryOf?}]}` |
| `retry` / `job.retry` | `projectId,taskId,expectedRevision?` | 新任务的 `StudioSnapshot`，使用当前工程 |

同一工程的写请求和后台提交排队。工程及全部镜头源码以完整版本保存；状态指针切换是提交点，投影中断可在重开时修复。旧工程首次打开迁移到该协议，schemaVersion 仍为 1。导出以指定 revision 读取源码，历史镜头删除或移动源码路径后仍可复核旧输入。

任务执行前保存记录，结束保存状态；重启将未完成记录标为 `interrupted`。只允许插件自己记录的预览、导出和生成请求由用户重试，配音不自动重放。没有逐帧断点续渲或跨进程工程锁。

## 0.4.0 会话关联与代理协作

| RPC | 输入 | 语义 |
| --- | --- | --- |
| `list` | `includeArchived?:boolean` | 返回工程摘要、`bindings`、兼容的当前工程 `sessions` 映射及 `selected` |
| `bindSession` | `projectId,sessionId,expectedCurrentProjectId?:string|null` | 建立关系并设为当前；保留其他关联影片；不改变当前浏览工程 |
| `unbindSession` | `projectId,sessionId,expectedCurrentProjectId?:string|null` | 解除指定关系；若是当前则清空当前；不自动选替代工程 |
| `focus` | `projectId,sessionId?,shotId?,frame?` | 浏览定位，保持与关联写入分开 |

`expectedCurrentProjectId:null` 表示提交时应无当前工程。服务在原子索引提交中检查，关系已改变返回 `BINDING_CONFLICT`。绑定提交校验实际宿主目录；正在运行的调用者或继承其工程的后代阻止界面换绑。工具可在自己回合内创建或明确绑定工程。

`video_project create` 对已继承影片的子代理返回同一工程，设置 `forceNew:true` 可创建专属工程。`video_update` 和 `video_audio` 对子代理/team 调用要求 `expectedRevision`，省略时返回 `REVISION_REQUIRED`；过期 revision 返回冲突并要求重新读取。

工具回执增加 `callerSessionId`（实际调用者）、`ownerSessionId`（当前工程归属会话）与 `routingSource`（`explicit-project`、`session-binding`、`subagent-ancestor` 或 `selected-project`）。显式 projectId 固定操作工程，任务启动后使用已解析工程与 revision，不随默认关联变化转向。`sessionId` 为兼容导航字段，客户端优先使用 callerSessionId 返回实际调用会话；子代理导航使用宿主 durable parent/child/mode 地址。

旧 v1 sessions 字典迁移为 v2 当前及关联工程。项目 JSON 的 sessionIds 不再用于重启自动绑定；复制或导入影片不会自动激活来源会话。详细使用规则见 [SESSION-WORKFLOW.md](SESSION-WORKFLOW.md)。

## 0.5.0 自定义视频风格

桌面工作台提供 `styles.list`、`styles.save` 和 `styles.delete` RPC。风格库保存在 DSH 视频工程基目录的 `styles.json`，不属于单个影片工程；新建影片时选择风格，会将风格副本保存到影片 JSON 的 `videoStyle` 字段。故事板与镜头生成把这段内容作为创作参考。

本地界面可导入 Markdown、TXT、JSON、ZIP 风格包和文件夹。导入器读取文字描述及常见 JSON 名称、说明和 prompt 字段，不执行导入文件中的代码。每个风格最多保存 80,000 字符的 prompt。
