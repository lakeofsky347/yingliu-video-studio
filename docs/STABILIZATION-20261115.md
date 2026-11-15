# 迁移分支完善与清理记录

日期：2026-11-15（Asia/Singapore）。承接 [M00–M07 迁移记录](MIGRATION-20261111.md)，在 `codex/agent-feature-migration-20261111` 上修复复审发现的问题，包版本继续为 0.7.0，尚未发布新版本。

## 远端基线

仓库正式地址是 <https://github.com/lakeofsky347/yingliu-video-studio>；本地 origin 已从旧仓库名改为此地址。核查时 main 为 `25928711e4109e81fd6d7a84853d7e1f4a372013`，PR #1、#2 均已合并，没有开放 PR。

本分支通过合并 `codex/video-architecture-experiment@cf5fba6c7871d168df2b6504d03b021014507f31` 纳入主线的预览负时钟修复（PR #2）。保留迁移分支已有的首帧就绪、版本身份检查和超时恢复，避免动画时钟略早于起点时请求第 -1 帧。合并提交为 `1ad5af65e5007e58d43e341ec7b183f413f583a2`。

核查时 main 和架构实验分支最近的 CI 成功；保留的 `grok-fronted@3bae3a41dad07f8afc96f3cff7da49a179997482` 最近矩阵为 8/9 通过，macOS/latest 的缩略图测试出现 `Screenshot 5 (30 s timeout)`。该日志不足以确定根因，也不等同于宿主接口不兼容。迁移分支的验证单独记录，不把其他分支的结果当作本分支验收。

## 本轮修复

- 工作流暂停立即登记暂停意图并中断在跑任务，与启动、重试、采用操作按工程串行；暂停抵达重试落盘阶段时，不再启动下一次模型请求。生命周期关闭继续排空已接受操作。
- 导入遇到 CAS 冲突时，只允许纯追加操作自动重试；替换配音或改变已有工程/镜头字段的旧请求不能覆盖并发修改。
- 被镜头、对白、表演、空间关系或身份映射引用的角色不可删除，界面说明需先解除引用。复杂导演约束继续保留。
- 协作面板按工程重建；刷新、候选预览和操作结果均检查工程身份，迟到的旧工程响应不能覆盖当前工程。
- 本地导演草稿读取先验证显示所需结构；损坏内容保留并显示提示，编辑中的空文本仍可保留。
- 导出快照构建、运行时发布和捕帧共用资源清理边界。发布失败也关闭快照监听器，已有预览仍可使用；日志写入失败不会掩盖原始导出错误。
- 迁移验收脚本支持显式宿主日志/URL、浏览器路径、隔离工程目录与输出目录；重启校验必须指明上次工程 ID，不再对任意旧工程套用测试断言。脚本纳入安装包文件清单。
- 补齐开发脚本的 TypeScript 声明文件打包清单，防止安装包源码中的测试导入脚本时因缺少声明而无法通过类型检查。

## 验收复现

本轮修复代码提交：`5ad07632a2fd127f6e9dc093a7f14133e8c52d54`。

| 验证 | 结果 |
| --- | --- |
| 全套 `verify:compat` | 486 项测试，485 通过、0 失败、1 项平台条件跳过；类型、构建与宿主兼容通过 |
| 隔离 DSH Web 首次验收 | 6/6；角色编辑与计划批准、本地钟声、6/6 实际抽样帧、AAC MP4 导出播放、完整 FFmpeg 解码、页面重载、1100px 布局 |
| 同一隔离宿主关闭后重启 | 7/7；上次工程的已批准计划、音轨和历史输出恢复，再完整运行上述流程 |
| 源码包解包检查 | 324 个打包文件；脚本和声明完整、临时目录排除、解包后类型检查通过；复用已安装开发依赖与宿主 peer，不声称全新联网安装验收 |
| 证据回读 | 固定 196 个源码/脚本/测试/配置文件与 3 个构建文件 SHA-256；保留测试日志、截图、样片和清理备份 |

唯一跳过项与 11 月 11 日相同：当前 macOS 有本地 `say`，因此“宿主缺少本地语音”的条件分支不适用。验收完成后已关闭本轮启动的宿主，删除临时认证配置，并从宿主日志中清除 URL 认证参数。

完整检查：`npm run verify:compat`。新增回归覆盖真实 React/Chromium 工程切换、角色删除与草稿恢复；工作流并发、导入 CAS、导出故障使用确定性故障注入。无浏览器环境按测试已有约定跳过交互项。

实际 DSH Web 验收使用独立配置与工程目录，可按以下命令运行。先启动宿主，待日志出现 `dsh web:` 后，在另一终端执行脚本：

```sh
npm run build
mkdir -p artifacts/stabilization-20261115
DSH_PREVIEW_HOME="$PWD/.local/stabilization-20261115/home" \
DSH_PREVIEW_PROJECTS="$PWD/.local/stabilization-20261115/projects" \
DSH_PREVIEW_PROFILE=migration-stability \
DSH_PREVIEW_PORT=19715 \
node scripts/preview.mjs > artifacts/stabilization-20261115/host.log 2>&1
```

```sh
MIGRATION_HOST_LOG="$PWD/artifacts/stabilization-20261115/host.log" \
MIGRATION_PROJECTS_DIR="$PWD/.local/stabilization-20261115/projects" \
MIGRATION_REPORT_DIR="$PWD/artifacts/stabilization-20261115/ui" \
node --import tsx scripts/verify-migration-20261111.mjs
```

可用 `MIGRATION_BROWSER_PATH` 显式指定 Chromium。若要验证实际宿主重启恢复，先关闭上面自己启动的宿主，再用相同隔离目录启动，将上次报告中的 `projectId` 作为 `MIGRATION_RESTORE_PROJECT_ID`，另设报告目录后重跑。宿主日志可能包含临时认证 URL，应限于本机使用，验收后清除认证信息。

最终结果与内容哈希见 [机器可读验收记录](validation/stabilization-20261115.json)。原始日志、截图、样片与清理备份位于被 Git 忽略的 `artifacts/stabilization-20261115/`。2026-11-11 的旧记录保持其原日期和原验证范围。

## 清理与保留

清理前创建并验证完整历史备份 `artifacts/stabilization-20261115/before-cleanup.bundle`；详细原引用与文件路径见该目录的 `cleanup.json`。

- 删除 5 个已进入主线的本地旧分支：`codex/apache-2-license`、`codex/gpl-3-license`、`codex/host-contract-compat`、`codex/npm-lks347-0.5.1`、`codex/pr1-sync-readme`。
- 删除 2 个已合并 PR 的远端分支：`feat/multimodal-model-center` 是主线祖先；`cursor/fix-preview-playback-frame-820b` 虽经 squash 合并，但完整 tree 与 main 一致。删除前回读远端 SHA，并使用带预期 SHA 的原子删除，避免删除后来更新的引用。
- 本地 main、`grok-fronted`、`codex/video-architecture-experiment` 均安全快进到各自远端。两个仍有独立内容的远端实验分支保留。
- 删除 8 个未运行的旧隔离验收 `.app` 副本，保留最新副本以及所有工程、home、日志、安装包和准备记录。删除内容逻辑大小约 7.65 GiB；不把此值视为 APFS 实际释放空间。
- 清除插件根目录 Finder 元数据，并将 `.DS_Store` 加入忽略规则。

本轮沿用 DSH 宿主接口和原有布局，没有新增依赖。M08–M12 仍不在本批内；真实收费供应商、正式 Desktop 安装和 npm 发布未在本轮执行。GitHub CI 的跨平台源码检查与本机 DSH Web/媒体验证分别记录，不能互相替代。
