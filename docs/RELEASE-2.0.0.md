# yingliu-video-studio 2.0.0

## 中文

2.0.0 将长分镜导演计划、Blender 白模预演、本地审片和字幕交付接入 DSH 视频工作台。

- **工作台**沿用 DSH 的中英语言和明暗主题。时间线支持指针拖拽、边缘滚动和取消，窄栏可浏览关键帧。预览恢复时会重新读取已保存的工程。风格库可导入夹有图片等文件的目录，以及内部目录同名的多个 ZIP。
- **导演计划与白模预演**支持最多 120 个镜头，可记录场景、道具和连续性。协作制作可按多选镜头或已批准的场景分批。安装 Blender 后，可在 **白模预演** 生成镜头关键帧、逐像素深度参考图和可选预演视频。确认绑定当前批准的导演计划和实际产物，产物保存为参考素材。
- **媒体生成**按已配置接口支持首尾帧视频、多图融合和口型同步。每批最多 8 镜。向外部服务发送本地素材时，需要确认本次素材和目标服务。需要从 DSH 会话提交带参考素材的单镜请求时，可在媒体面板授权后复制请求。
- **本地审片与声音**在 **历史成片** 提供五帧宫格、参考视频切镜检测、字幕编辑及 SRT／ASS 导出。总混音支持对白避让、响度归一化和声学检查。
- **工程包**可从影片首页保存和导入 `.yingliu` 文件，携带工程、镜头源码和本地素材。导入后按新工程打开，需要重新确认制作模式。
- **剪辑交换**可在 **历史成片** 导出 OTIO、FCPXML 和支持帧率下的 CMX3600 EDL。交换包含逐镜头视频、音频文件、外挂字幕和校验清单。OTIO 和 FCPXML 保留分轨音频。EDL 提供主视频剪切表。

### 安装与验收范围

在 DSH Desktop 的 **插件管理 → 添加插件** 中输入 `yingliu-video-studio@2.0.0`，或填写本机 `yingliu-video-studio-2.0.0.tgz` 的绝对路径。项目 schema 仍为 v3。打开旧工程前，可备份工程目录及其 `.studio/` 历史。[宿主兼容说明](COMPATIBILITY.md)

验收覆盖 Chromium 工作台交互、实际 Blender／FFmpeg 预演和工程包往返。外部模型协议与上传授权使用模拟服务验证。

DaVinci Resolve 21 实测导入了 23.976 fps 的三种样包。移动交换包时请保留 `media/` 的目录结构。若 Resolve 提示素材缺失，选择该目录重新搜索。导入 EDL 时可先把包里的视频加入媒体池，并选择清单中的时间线帧率。

## English

2.0.0 brings long-form director plans, Blender previsualization, local picture and sound review, and subtitle delivery to the DSH Video Studio.

- **Studio.** The workbench follows DSH language and theme settings. Timeline dragging supports edge scrolling and cancellation, keyframes are available in narrow panes, and preview recovery reloads the saved project. Style imports handle mixed folders and multiple ZIPs with matching internal paths.
- **Director plans and previsualization.** Plans support up to 120 shots with locations, props, and continuity notes. Run collaborative production for selected shots or an approved location. With Blender installed, **Whitebox previsualization** can produce a keyframe, per-pixel depth reference, and optional preview video. Confirmation is tied to the approved director plan and the rendered reference assets.
- **Media generation.** Supported model connections offer first-and-last-frame video, multi-image composition, and lip sync. Submit up to eight shots per batch. Uploading local assets requires confirmation for the selected media and destination. To submit a reference-based request from a DSH conversation, authorize and copy it from the media panel.
- **Review and audio.** In **Exported films**, use five-frame contact sheets, reference-video cut detection, and subtitle editing or SRT/ASS export. The master mix supports dialogue ducking, loudness normalization, and acoustic checks.
- **Project packages.** Save and open `.yingliu` packages with project data, shot source, and local media. An imported package opens as a new project that requires production-mode confirmation.
- **Timeline exchange.** In **Exported films**, export OTIO, FCPXML, and CMX3600 EDL at supported frame rates. Packages include per-shot footage, audio, subtitle sidecars, and a checksum manifest. OTIO and FCPXML include separate audio tracks. EDL carries the main picture cut list.

### Installation and acceptance scope

In DSH Desktop, open **Plugin management → Add plugin** and enter `yingliu-video-studio@2.0.0` or the absolute path to a local `yingliu-video-studio-2.0.0.tgz`. The project schema remains v3. Before opening an older project, you can back up its folder along with the `.studio/` history. [Host compatibility](COMPATIBILITY.md)

Acceptance covered Chromium workbench interactions, real Blender/FFmpeg previsualization, and project-package round trips. External model protocols and upload consent were tested against fixture services.

DaVinci Resolve 21 imported all three 23.976 fps sample timelines. Keep `media/` with the exchange files when moving a package. If Resolve reports missing media, select that directory as the search location. For EDL, add the picture files to the media pool and select the timeline frame rate from the manifest.
