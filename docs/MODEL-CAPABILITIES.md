# 媒体模型能力契约与验证边界

检查日期：2026-11-06。本文描述当前适配器实现与模拟接口测试，不代表真实供应商、账号、地区或模型可用性验收；本次没有发起真实生成。

## 校验入口

src/models/capabilities.ts 提供两个无副作用函数：

- getMediaCapabilities(resolved)：返回具体协议与模型的有效能力、可编码参数、参考用途和数量、音频证据、验证状态、恢复语义。
- validateMediaRequest(resolved, request)：校验请求并返回相同能力对象，不发网络请求。失败抛出 MediaCapabilityError，code 为 UNSUPPORTED_MEDIA_CAPABILITY，submissionUncertain 为 false。

resolved 是现有 ResolvedModel，即 connection 和 model。request 包含 operation、合并后的 parameters，以及 imageAssetIds 或 adapter inputs；可选 referenceRoles 必须与图片逐项对应，requiresAudio 为本次是否要求模型原生音频。referenceRoles 接受字符串列表，再由校验器检查用途，不能凭类型声明绕过运行时检查。

任务服务应在两个位置调用：创建任务时合并参数后、读取/上传参考图片和持久化待提交任务前；真正发起 HTTP 之前、进入 submitting 状态前。已持久化任务使用其模型和连接快照校验，不能用当前全局模型重解释。适配器 submitGeneration、公开 generateImage 与 submitVideo 也执行校验，防止直接调用绕过任务服务。

输入参数不能先静默过滤再校验。maxDurationSeconds、maxWidth、maxHeight、maxFps 是模型本地限制配置，supportsCancel 是本地取消控制，均不是提交参数；校验器直接从 model.parameters 读取这些上限，且配置不能扩大插件硬上限。其余不在有效能力中的生成参数明确拒绝。校验不会四舍五入时长，不会丢掉第二张图，不会自动切模型。

## 参考用途与音频

| 协议 | 当前适配器参考输入 | 未标用途的兼容行为 |
|---|---|---|
| images / gemini-image | 无；当前只实现文生图 | 有参考图直接拒绝 |
| video-gateway | 最多 3 张图片，reference 用途 | 沿用 v1 通用图片参考 |
| 六个原生视频协议 | 最多 1 张图片，first_frame 用途 | 沿用原实现的单首帧语义 |

last_frame、character、style、layout、多图参考、视频参考和音频参考目前均未实现，不会按首帧请求伪装支持。供应商文档有某种能力不代表本插件已经接好。对已识别的万相纯文生视频型号，连单首帧也会拒绝。

requiresAudio=true 在已核查的具体 Sora 2 和 Veo 3.1 preview 型号上识别为原生音频；官方文档同时注明它们已退役，历史能力证据不等于端点仍可使用。未知型号即使在注册信息里自行勾选 audio 输出，也不会据此承诺带音频成片。其他协议当前没有实现音频开关或参考音频的可靠映射，要求原生音频会明确拒绝。requiresAudio=false 表示没有此要求，并不表示要求静音；静音/音轨保留属于后续合成策略。任务服务还须检查实际产物 hasAudio=true，否则不能成为合格候选。

## 适配器参数映射

| 协议 | 当前接受的生成参数 | 关键映射或限制 |
|---|---|---|
| images | size、quality、style、response_format、background、output_format、n | 原有 /images/generations；n 为 1–4；请求参数不能覆盖 model/prompt |
| gemini-image | 暂无可调参数 | 使用已有 generateContent 文生图；不再接受后又忽略 size 等参数 |
| video-gateway | durationSeconds、width、height、fps、aspectRatio、seed、negativePrompt | v1 字段和三图透传保持兼容；role 与 requiresAudio 不新增到网关请求体 |
| openai-videos | durationSeconds、width、height、aspectRatio | seconds 保持整数原值；尺寸为 width x height；单独 16:9/9:16 分别映射 1280x720/720x1280；同时给尺寸和画幅必须一致 |
| kling-video | durationSeconds、negativePrompt；文生视频还可 aspectRatio | 当前图生视频画幅控制未验证，明确拒绝；时长不再四舍五入 |
| minimax-video | durationSeconds | 未实现画幅、fps、seed 等映射，明确拒绝 |
| volc-video | durationSeconds、aspectRatio、seed | 直接写入 JSON 的 duration、ratio、seed；首帧明确 role=first_frame；不依赖易被忽略的提示词后缀 |
| dashscope-video | 通用未知型号仅 durationSeconds；已识别文生视频型号另支持 width、height、seed、negativePrompt | 使用 size=width*height 和 input.negative_prompt；不发送旧实现中未经确认的 parameters.ratio |
| gemini-video | durationSeconds、aspectRatio | 对应原有 predictLongRunning 字段；fps、seed、额外参考控制未实现 |

除网关既有协议外，当前原生视频接口都拒绝 fps；精确像素尺寸只在实现了尺寸映射的 OpenAI 和已识别万相文生视频型号中接受。拒绝表示当前插件不能可靠满足该要求，并非宣称供应商永远不支持。

## 具体模型与证据等级

verification.level 分为 adapter-contract 与 documentation-checked；两者 realProviderTested 均为 false。前者只表明适配器能编码相应请求，不能确认未知模型支持；后者表示对确切型号查过官方文档，仍未验证当前账号、地区和真实生成结果。未知模型或私有部署别名不会自动匹配某个新型号的多模态能力。

| 具体型号 | 当前实现采用的限制 | 官方依据与保留边界 |
|---|---|---|
| sora-2、sora-2-2025-10-06、sora-2-2025-12-08 | 4/8/12 秒；720x1280 或 1280x720；原生音频 | API reference 与 cookbook 的范围存在差异，采用共同的保守子集；官方 API 已于 2026-09-24 退役，不宣称当前可用 |
| sora-2-pro、sora-2-pro-2025-10-06 | 4/8/12 秒；上述尺寸加 1024x1792、1792x1024；原生音频 | 同上；参考图片尺寸与真实素材像素匹配仍需提交层/素材层验证 |
| doubao-seedance-2-5-260628 | 4–30 整秒；官方枚举画幅；首帧生视频只能 adaptive | 文档更多多图、音频、视频和首尾帧能力尚未接入本适配器 |
| doubao-seedance-2-0-260128、doubao-seedance-2-0-fast-260128、doubao-seedance-2-0-mini-260615 | 4–15 整秒；官方枚举画幅 | 当前仅文本或单首帧路径；不接受 -1 自动时长，避免把明确时长改为模型自选 |
| wan2.6-t2v | 2–15 整秒；720P/1080P 文档枚举像素尺寸 | 只接受文生视频；使用旧 video-synthesis 协议 |
| wan2.5-t2v-preview | 5/10 秒；480P/720P/1080P 文档枚举像素尺寸 | 同上 |
| wan2.2-t2v-plus | 5 秒；480P/1080P 文档枚举像素尺寸 | 同上 |
| wanx2.1-t2v-turbo / wanx2.1-t2v-plus | 5 秒；分别 480P/720P 与 720P 枚举像素尺寸 | 同上 |
| veo-3.1-generate-preview、veo-3.1-fast-generate-preview、veo-3.1-lite-generate-preview | 4/6/8 秒、16:9/9:16；文档描述原生音频 | Google 页面注明这些 preview ID 已于 2026-10-22 停用；不自动迁移至另一模型或协议 |

官方来源（2026-11-06 核查）：

- [OpenAI Videos 创建 API](https://developers.openai.com/api/reference/resources/videos/methods/create) 与 [Sora 2 官方提示词指南](https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide)：参数枚举与图片首帧语义；采用两者共同支持的保守范围。
- [Sora 2 模型卡](https://developers.openai.com/api/docs/models/sora-2)、[Sora 2 Pro 模型卡](https://developers.openai.com/api/docs/models/sora-2-pro) 与 [OpenAI 退役记录](https://developers.openai.com/api/docs/deprecations)：原生同步音频与官方 Videos API/型号的退役状态。
- [火山方舟视频生成教程](https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=en&redirect=1) 与 [Seedance 2.5 教程](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=en)：明确 JSON 参数、型号、画幅及首帧限制。
- [阿里云万相 2.1–2.6 文生视频 API](https://help.aliyun.com/en/model-studio/legacy-wan-text-to-video-api-reference)：具体型号的时长和尺寸、负向提示、seed 及旧协议边界。
- [Google Veo 文档](https://ai.google.dev/gemini-api/docs/veo)：时长、画幅、音频与 preview 退役说明。此来源不会用来假定其他 Gemini 模型继续支持相同接口。

## 提交可靠性

预提交能力错误标记 submissionUncertain=false，任务服务可将其归为未发请求的失败；发出 HTTP 后的超时、断连、无效响应不能标为安全未提交。适配器没有自动重试生成请求。

网关沿用 clientRequestId 查询。原生视频协议缺少 remoteJobId 时，pollGeneration 返回 null，不用请求 ID 猜远端任务，不重新 POST。远端任务 ID 已知时只查单；下载失败由任务服务恢复下载，不重新付费生成。可灵缺少 task_id 时会报错，不再制造 image2video: 或 text2video: 这种虚假任务 ID。

## 本地验证与仍需验收的事项

新增 tests/model-capabilities.test.ts 覆盖六个原生接口的多图零网络拒绝、用途和模态拒绝、音频要求、非法参数、整数时长、具体型号范围、OpenAI JSON/单图 multipart、火山字段、万相字段、网关三图及参数兼容、公开适配器绕过、未知提交不重投和缺失任务 ID。所有请求使用本地模拟 fetch 或已有测试网关。

tests/media-capability-boundary.test.ts 使用真实任务服务与假 registry/project port，覆盖创建任务前的零读取/零请求拒绝、模型默认参数不能被过滤、实际音轨检查、恢复 pending 时重新校验、stable request 不能改变音频/参考用途，以及质检重试不重新生成。模拟视频头只用于下载协议检查，媒体元数据由假 port 提供，不代表真实视频质量验收。

真实供应商任务创建与轮询、账号权限和地区限制、参考图尺寸要求、实际输出音轨、视频质量、用量与取消行为仍需独立验收。文档核查和模拟请求通过不能替代这些验证。
