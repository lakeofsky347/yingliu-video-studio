# 0.3.0 实现参考

本轮以既有 `dsh-video-studio` 0.2.0 为基础，参考同一工作区的独立应用 `yingliu-studio` 0.2.0，参考版本为 Git `a7d7a8d`。独立应用作为只读来源保留，没有修改其源码、配置或仓库。

适配内容包括工程库、完整工程与源码版本、持久撤销/重做、串行写入与 revision 检查、任务记录/显式重试、源码草稿和历史成片界面。插件继续使用 DSH 的 Session、LLM、凭据及 Jobs；没有引入独立应用的 Electron 壳、模型设置或对话服务。

原先工作区已有的 Canvas2D 软件光栅捕帧修复一并保留，用于倒序定位和冷加载的可复现检查。LiteGraph 0.17.2 及其许可保持原有说明，其他外部依赖未增加。

参考文件哈希和版本保存在本地验收记录 `artifacts/verification/v0.3/reference-baseline.json`。引用独立应用的设计和测试方法，不代表本版插件自动继承独立应用的验收结果；本版的宿主、界面和实际媒体分别执行验证。


# 2026-11-11 选择性迁移：A+B

供体固定为 [yingliu-agent main@ef3fc82e62ff57c8654e827e4e75b8eb7c7f0fc6](https://github.com/lakeofsky347/yingliu-agent/commit/ef3fc82e62ff57c8654e827e4e75b8eb7c7f0fc6)（独立版 1.1.0）；目标基线为插件 `ae05700953a4a92b7c6f56bca64b7bf89a08ec0f`。当时插件包版本保持 0.7.0，该批在开发分支上完成，尚未发布。此句描述 2026-11-11 的历史状态。

| 范围 | 供体参考 | 插件适配 |
| --- | --- | --- |
| M01 回执/排空 | `src/workflows/service.ts`、`src/agent/durable-file.ts` | 保留插件 productionPolicy、候选哈希、人审、DSH text port；独立成功回执与不确定状态、关闭排空 |
| M02 CAS/本地重试 | `src/host/service.ts`、`src/app/application.ts` | 全部公开写入口同步更新版本契约；固定本地输入、逐项导入回执；只对证明尚未写入的冲突重试 |
| M03/M04 运行时/客户端 | `src/host/renderer.ts`、`src/runtime/browser.ts`、`src/client/Preview.tsx`、`src/shared/task-diagnostic.ts` | 保留 CDP、静态缩略图、每镜头独立 origin 白名单；哈希资源和固定文档；首帧与超时恢复；源码身份补丁 |
| M05 计划角色 | `src/agent/story.ts` | 扩展现有 DirectorPlan，不引入独立 Story；角色和计划进入项目 extensions，批准经可信工作台 |
| M06 本地 QC | `src/agent/tools.ts` | 固定内容抽样，结构硬失败阻止导出，启发式明确未覆盖范围；不代替候选人审 |
| M07 本地音效 | `src/agent/synth.ts` | 独立纯 WAV 合成、严格有界参数、seed可复现，经已有音轨管线导出 |

未迁入独立 Agent、Electron/Tauri/SEA/Bun 外壳、自动按已配置模型选择制作模式、任意 URL 模板和 force 导出绕过。累计费用账本/费用试算、尾帧、显式配音对齐、一致性复核和新增供应商（M08–M12）留在后续批次。

工程格式保持 schema v3；旧工程没有导演文档或回执时按旧数据正常打开。文档和导入回执扩展字段是宿主保护字段；普通保存不能伪造，完整工程备份应连同 `.studio` 一并保存。已发生执行的回执不应被回退代码清除；不建议旧插件覆盖写入本批产生的新字段。导演内容随创作历史恢复，制作许可仍遵循现有不回滚规则，导入请求身份跨撤销保留；复制新工程清除执行请求身份并将导演批准降为草稿。

验收结果见 [MIGRATION-20261111.md](MIGRATION-20261111.md)。供体验收通过不替代插件本机、宿主与真实供应商的独立证据。

## 0.8.0 主线版本

上述架构实验、选择性迁移与后续稳定性修复已汇入 `main`；0.8.0 的合并基线为 `0aa5e3c`。本版继续沿用 DSH 的宿主职责和原有工作台布局，不新增第二套聊天 Agent，也未扩展至 M08–M12。功能摘要与升级注意见 [0.8.0 发布说明](RELEASE-0.8.0.md)。

历史实施与验收文档保留其原日期、提交、包版本和验证边界；这些历史结果不替代最终 0.8.0 安装包的发布验证。发布包的来源信息以 `SOURCE.json` 和对应源码提交为准。
