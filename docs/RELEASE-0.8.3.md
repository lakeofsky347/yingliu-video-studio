# yingliu-video-studio 0.8.3

## 中文

本次更新让工作台支持中文和英文。到 **DSH 设置 → 通用设置 → 语言** 切换，工作台会随之更新，无需重新打开工程。

- 首页、分镜画布、镜头属性、预览、源码、模型、素材、声音、协作制作和导出面板都提供中英文。
- 操作提示、已收录的系统错误、任务进度和日期随语言切换；制作要求的查看、复制和 Markdown 导出也支持双语。
- 新建影片与镜头的默认文字使用创建时的界面语言。已有片名、字幕、素材名、源码和未保存草稿保持原样，画布位置、选中状态与工程版本不会因切换语言而改变。
- 影片文字与旁白遵循创作要求中的语言。未知服务商报错、自定义历史标签及模型原文保持原样。
- 使用说明提供 [中文](../README.md) 与 [English](../README.en.md)，英文版配有实际界面截图。

在 DSH 的 **插件管理 → 添加插件** 中填写 `yingliu-video-studio@0.8.3`，安装后启用。也可以填写本地 `yingliu-video-studio-0.8.3.tgz` 的绝对路径。

本次继续使用 schema v3，不改变工程存储格式。升级前备份整个工程目录，包括 `.studio/`。详细用法见 [README](../README.md)，文案维护约定见 [语言与文案](LOCALIZATION.md)，旧工程升级说明见 [0.8.0 发布说明](RELEASE-0.8.0.md)。

## English

The studio now supports Chinese and English. Switch languages in **DSH Settings → General → Language**; the studio updates without reopening your project.

- Both languages are available across the home page, storyboard canvas, shot properties, preview, source editor, models, media, audio, production workflow, and export panels.
- Controls, known system messages, task progress, and dates follow the selected language. Production requirements also support both languages when viewed, copied, or exported as Markdown.
- New films and shots use the interface language for their default text. Existing titles, subtitles, asset names, source code, and unsaved drafts stay unchanged, as do canvas positions, selections, and the project revision.
- Film text and narration follow the language requested in the creative brief. Unknown provider errors, custom history labels, and original model output are preserved.
- The user guide is available in [Chinese](../README.md) and [English](../README.en.md), with an actual English interface screenshot.

In DSH, open **Plugin management → Add plugin**, enter `yingliu-video-studio@0.8.3`, and enable it after installation. You can also enter the absolute path to a local `yingliu-video-studio-0.8.3.tgz` file.

Project storage remains on schema v3. Before upgrading, back up the complete project folder, including `.studio/`. See the [README](../README.en.md) for usage, [Language and localization](LOCALIZATION.md) for text maintenance, and the [0.8.0 release notes](RELEASE-0.8.0.md) for older project upgrades.
