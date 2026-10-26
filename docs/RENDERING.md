# 渲染链路与性能验证

## 调用链

工作台的 `Preview` 使用一个 sandbox iframe。`StudioService.refreshPreview()` 经 `VideoRenderer.prepare()` 将当前版本的镜头源码和规格写入工程 runtime；浏览器由 `renderFrame({frame})` 按帧号独立求值。声音由 `AudioMixer` 单独混音，并作为实时播放时钟。

导出通过 `VideoRenderer.export()` 保存不可变输入快照、混音并启动专用 Chromium。每帧依次执行场景、等待布局和字体、经 CDP 捕获无损 PNG、带背压地写入 FFmpeg。编码结束后重新验证关键帧的逆序 seek 和冷启动一致性，再用 FFprobe 解码计数并核对尺寸、帧率、时长、像素格式和音轨。

## 优化范围

- 移除每帧两次 `requestAnimationFrame` 的刷新等待；专用 CDP 会话替代通用截图的重复页面准备、字体查询和视口测量。离线浏览器解除刷新率限制，使用快速无损 PNG 压缩。
- 三个关键帧 iframe 改为静态 PNG。单个请求批量生成最多三张，按版本和渲染输入缓存、合并相同的并发请求，完成后关闭浏览器。播放期间不重新生成缩略图。
- 镜头模块和媒体按需加载。只保留当前镜头需要的解码图片和视频；跨镜头 seek 会重新加载已释放的资源。
- HTML 使用预解析模板，每帧克隆；未变化的 CSS 不重复写入。每帧仍重新创建干净的 DOM 和 Canvas，及时释放上一帧的 Canvas backing store，保留场景 `ready(ctx)` 的逐帧语义。
- 单个离线页面限制备用 renderer 进程；FFmpeg 限制 PNG 解码、像素转换和 H.264 编码线程，已知格式与帧率不再长时间探测。
- 快照复制使用文件系统支持的 copy-on-write，系统不支持时由 Node 回退普通复制。继续读取输入计算 SHA-256，不使用可能过期的元数据替代内容校验。

不通过跳帧、降分辨率或有损截图提速。`libx264` 的 `medium` preset、各质量档 CRF、AAC 和音视频校验继续使用原有规格。PNG 压缩和编码线程变化可能改变文件字节，因此像素对照使用解码后的 RGBA，而不要求 MP4 或 PNG 文件的字节相同。

## 复现基准

在插件根目录运行：

```sh
npm run bench:render -- --label=current --output=artifacts/render-benchmark/current.json
```

默认每个规格渲染 60 帧，依次测试 1280 × 720 和 1920 × 1080。两个镜头覆盖中文 DOM、图片、Canvas 图形、运动和淡入；总耗时包含快照、浏览器启动、全部帧、编码、seek/冷启动验证与媒体检查。结果记录单帧均值/P50/P95、端到端吞吐、关键帧 RGBA hash、文件大小以及近似进程树 RSS 峰值。RSS 每 250 ms 采样、包含共享页，不等同于独占内存；Windows 不采样该指标。

`--frames=180` 可延长样片；`--renderer-root=/path/to/checkout` 可使用另一个本地源码副本中的 renderer 复测相同输入。基准会关闭自己启动的进程并清理临时工程。结果只代表本机和该工作负载，不代表复杂用户场景、长片或其他平台的吞吐。

2026-10-27 的本机 macOS arm64 验证使用 Node 26.8.2、Chrome 155.0.8059.86，优化前代码为 `aac0fdd332cc9e820c2e1cde14666d99cad383ac` 的渲染实现。一次相同输入的顺序测量结果如下：

| 规格 / 60 帧 | 优化前导出 | 优化后导出 | 吞吐提升 | 单帧捕获均值：前 → 后 |
|---|---:|---:|---:|---:|
| 1280 × 720 | 4.60 s | 1.64 s | 2.80 倍 | 49.78 → 9.83 ms |
| 1920 × 1080 | 5.01 s | 1.98 s | 2.53 倍 | 52.39 → 15.18 ms |

两组共 12 个关键帧的解码像素 hash 全部相同。导出进程树的采样 RSS 峰值为 720p 约 1272 → 1333 MiB、1080p 约 1719 → 1690 MiB；不能据此宣称导出峰值内存显著下降。延长至每规格 180 帧后，720p / 1080p 导出耗时为 2.79 / 3.72 秒，采样 RSS 峰值约 1461 / 1778 MiB。预览的资源缩减由浏览器交互测试确认：三个静态缩略图加载后，只保留一个主 iframe，缩略图浏览器已关闭，播放不重复请求缩略图。

## 回归检查

```sh
npm run typecheck
node --import tsx --test tests/render-performance.test.ts tests/preview-performance.test.ts
npm test
npm run build
```

真实 Chromium/FFmpeg 检查覆盖通用截图与 CDP 的像素对照、图片/视频按镜头加载、旧视频解码器释放、缓存与版本失效、并发批次合并、缩略图取消和资源清理、UI 播放与切镜，以及分数帧率。原有媒体测试继续验证混音、旧版本导出、候选快照隔离、取消任务和错误归属。缺少媒体工具的平台会跳过相关实际媒体检查，不应将跳过计作通过。
