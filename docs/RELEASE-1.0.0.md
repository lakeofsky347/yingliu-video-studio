# yingliu-video-studio 1.0.0

## 中文

映流的首个稳定版本重新组织了 DSH 视频工作台。打开影片即可在监视器预览画面，在时间线上调整镜头顺序，再从属性和底部工作面板完成编辑。

- 舞台可切换监视器和分镜画布，宽度充足时也可以用分栏同时查看两者。监视器提供帧号定位、逐帧查看和当前帧 PNG 导出。
- 分镜画布提供镜头预览卡片、连线端口、缩放与小地图。时间线按镜头时长显示片段，支持拖动排序。
- 资产库支持搜索和类型筛选。属性区随选中的镜头或素材切换，声音、源码、历史和运行环境可从工作面板打开。
- 重新生成已有分镜前会弹出确认。删除镜头后可从提示中撤销。顶栏显示制作进度，舞台工具栏可直接打开「用文字修改」。
- 本地渲染在 Chromium 短暂无法截取帧时会重试，覆盖此前出现于 Windows 的截图失败。

在 DSH 的 **插件管理 → 添加插件** 中填写 `yingliu-video-studio@1.0.0` 并启用。也可以填写本地发布包 `yingliu-video-studio-1.0.0.tgz` 的绝对路径。

工程使用 schema v3，可读取并迁移 v1/v2 工程。升级前请备份整个工程目录，包括 `.studio/`；旧工程首次继续制作时需确认制作模式。工作台随 DSH 在中文与英文之间切换。参见 [工作台使用说明](../README.md)、[宿主兼容](COMPATIBILITY.md)和 [旧工程升级说明](RELEASE-0.8.0.md)。

## English

Yingliu's first stable release reorganizes the DSH video workbench. Open a film to preview it in the monitor, rearrange shots on the timeline, and edit through the properties inspector and work panels.

- The stage switches between Monitor and Storyboard canvas. Wider workspaces can show both in Split view. The monitor supports frame jumps, frame-by-frame playback controls, and PNG export for the current frame.
- The storyboard canvas features shot preview cards, connection handles, zoom controls, and a minimap. The timeline sizes clips by duration and supports drag reordering.
- Search and filter the asset library. The properties inspector follows the selected shot or asset, and the work panels provide access to audio, scene source, edit history, and the runtime environment.
- Regenerating an existing storyboard prompts for confirmation. A toast offers undo after deleting a shot. The header shows production progress, and the stage toolbar opens Edit with words.
- Local rendering retries transient Chromium frame capture failures, including those previously observed on Windows.

In DSH, open **Plugin management → Add plugin**, enter `yingliu-video-studio@1.0.0`, and enable it. You can also enter the absolute path to a local `yingliu-video-studio-1.0.0.tgz` package.

Projects use schema v3 and can read and migrate v1/v2 data. Before upgrading, back up the entire project folder, including `.studio/`. Confirm the production mode when resuming an older project. The studio follows DSH's Chinese or English language setting. See the [user guide](../README.en.md), [host compatibility](COMPATIBILITY.md), and [instructions for upgrading older projects](RELEASE-0.8.0.md).
