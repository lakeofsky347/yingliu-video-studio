# README 配图来源

## 当前 README 配图

`workbench.png` 于 2026 年 11 月 16 日从映流 **0.8.2** 的独立 DSH Web 环境重新截取。使用仓库提交 `acaab0c` 的源码构建插件，通过官方 DSH 宿主运行，直接截取工作台区域，未修改界面内容或后期合成。

演示工程「城市漫步 · 影片示例」包含三个镜头，规格为 1280 × 720、24 FPS、12 秒。文案、动画和提示音均为文档专门制作的本地示例。截图显示第 36 帧的实际预览，包含资产库、分镜画布、镜头属性、镜头顺序和当前工作面板入口。

截图前已刷新预览、确认画面加载并定位到第 36 帧。过程没有调用模型生成或语音合成服务，也没有执行成片导出；预览运行的是示例工程的实际源码。截图环境与用户的日常工程、会话和模型配置相互独立。

## 英文界面配图 / English interface

`workbench-en.png` 于 2026 年 11 月 16 日从本次中英文本地化源码构建的独立 DSH Web 环境截取，基于仓库提交 `f4a7e4f`。通过宿主设置将界面从中文切换为英文，直接截取工作台区域，未修改界面内容或后期合成。片名、素材名和画面文案保留中文，以展示界面语言与影片内容相互独立。

演示规格仍为 1280 × 720、24 FPS、12 秒，预览定位第 36 帧。已验证中文 → 英文 → 中文切换后，工程内容和版本号保持不变；过程没有调用模型或配音服务，也未执行成片导出。

The English screenshot was captured directly from the official isolated DSH Web host using this localization change, based on commit `f4a7e4f`. The sample film keeps its Chinese titles, assets, and on-screen text. Switching Chinese → English → Chinese preserved the project and revision. The preview shows frame 36 of a 12-second, 1280 × 720, 24 FPS local demo. No model or speech service was called, and no final video was exported.

## 保留的历史配图

以下图片仍来自 2026 年 10 月 7 日的映流 **0.4.0** 独立 DSH Web 环境，当前 README 不再引用。它们保留为历史资料，不用于说明 0.8.2 的界面。

| 文件 | 展示内容 |
| --- | --- |
| `home.png` | 首次打开的影片首页，新建、打开工程和会话筛选入口 |
| `environment.png` | 本地浏览器、FFmpeg 和 ffprobe 的环境检查 |
| `audio.png` | 本地合成音效的试听、时间、裁剪、音量与淡入淡出参数 |
| `source.png` | 当前镜头的前端源码与保存入口 |
| `export.png` | 输出规格设置，未展示已导出成片 |
| `session.png` | 专用演示会话的关联选择 |

界面截图用于解释操作位置。演示数据和固定响应模型名称不表示真实云端模型的制作质量、服务可用性或配音效果。
