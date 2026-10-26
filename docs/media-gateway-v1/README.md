# 映流媒体网关 v1

本协议是独立应用与 DSH 插件的共同客户端契约，不是已部署的公共服务。用户配置实现此协议的网关地址；普通厂商生视频接口只有适配此契约后才能直接使用。两端实现独立打包，不互相调用。

## 连接与操作

Base URL 可填写 `https://gateway.example/v1` 或网关根地址；客户端仅在末尾没有 `/v1` 时追加它。支持 Bearer API Key 和明确配置的无认证本地服务。模型需声明 text 输入和 video 输出；图生视频还需声明 image 输入。

| 请求 | 语义 |
| --- | --- |
| `POST /v1/media/jobs` | 以 `clientRequestId` 幂等提交，请求见 request.schema.json |
| `GET /v1/media/jobs/{jobId}` | 返回 response.schema.json 格式的最新任务与产物地址 |
| `GET /v1/media/jobs?clientRequestId=…` | 按请求 ID 对账；不存在返回 404 或 JSON null，禁止创建新任务 |
| `POST /v1/media/jobs/{jobId}/cancel` | 请求远程取消；不支持可返回 405/501，不得谎报已取消 |

同一请求 ID 的重复提交必须返回同一任务，不再次计费。任务查询应刷新已过期的产物下载地址。取消请求可返回 running；只有 cancelled 回执才代表云端已确认取消。费用无法提供时省略 usage.cost，不填写 0。

产物 URL 必须提供可直接读取的 HTTP(S) 下载地址。下载请求不携带网关 Authorization，不向下载主机或重定向目标泄露密钥。客户端以字节签名和实际媒体探测确认产物；文件扩展名或 Content-Type 不能替代探测。

## 本地任务与恢复

提交前写入稳定 taskId 和 clientRequestId，并冻结连接与模型配置。每次提交、查询、取消都重新解析凭据，因此密钥轮换无需重启。参考图片须属于当前工程／镜头且本次明确授权，最多 3 张、合计 6 MiB、最长边 4096；日志保存 asset ID 和 SHA256，不保存像素 data URL。

提交响应丢失会进入“结果待确认”。视频恢复时先按 jobId 或 clientRequestId 查询，绝不盲目重新 POST。生图兼容接口没有通用查单能力，提交结果丢失须由用户核对服务记录；下载失败可重取已获得产物，不重新生成。

本地停止等待与云端取消分开。尚未提交的本地排队任务可以直接取消，不声称发生云端取消。主动暂停跨重启保留；进程关闭中断的观察可恢复。DSH job_kill 仅结束宿主等待，插件自身任务 ID 与日志才是恢复依据。结果下载／检查后处于 ready，显式采用时校验当前 revision，并由宿主一次事务登记素材；版本冲突不丢弃生成结果。

默认总并发 4、单连接并发 2（可配置）；每个产物最大 512 MiB、每任务合计 1 GiB（服务配置可调整）。任务文件位于应用／插件自己的 media-tasks 目录，不进入可移植工程包。原始 API Key 不进入任务记录或前端响应。

## 兼容生图接口

使用连接 Base URL 下的 `/images/generations`，请求至少包含 model、prompt。支持 size、quality、style、response_format、background、output_format、n 参数，n 为 1–4。响应支持 data[].url 或 data[].b64_json；所有结果先成为待采用素材。

## 验证

`tests/media-gateway.ts` 是本地 HTTP 测试网关，覆盖丢失提交回执、排队、取消、下载失败和带鉴权的 API。`tests/media-tasks.test.ts` 覆盖持久恢复、凭据轮换、并发、授权图片、结果完整性和 CAS 采用。测试数据与 mock 协议成功不代表真实供应商生成质量。
