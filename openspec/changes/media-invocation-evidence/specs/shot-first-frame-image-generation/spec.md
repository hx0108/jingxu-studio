## MODIFIED Requirements

### Requirement: ImageModelAdapter 必须屏蔽 Provider 专有结构与凭据

Application/Renderer MUST 只依赖 ImageModelPort 与 NormalizedModelError；DashScope 任务结构、HTTP header、Authorization 或 Provider 专有错误 MUST 只存在于 Adapter 实现。凭据 MUST 沿用 safeStorage 加密与独立密文保存；Renderer 只能获取 configured 状态与末 4 位。Adapter 的原始响应证据通道（成功响应原文与 `evidenceOf`）MUST 仅由主进程证据链消费，MUST NOT 进入 NormalizedModelError、日志或 Renderer。

#### Scenario: Provider 任务错误归一化

- **GIVEN** poll 返回 Provider 专有的任务失败结构
- **WHEN** Adapter 归一化错误
- **THEN** 应用层 SHALL 只收到稳定 NormalizedModelError，不含原始 payload 或 Authorization

#### Scenario: 原始响应通道不泄漏进归一错误

- **GIVEN** submit 收到含 Provider 专有结构的错误响应（如 HTTP 429 限流原文）
- **WHEN** Adapter 归一化错误并暴露证据通道
- **THEN** NormalizedModelError SHALL 保持稳定码且 detail 为 null；原始响应 SHALL 只经主进程证据通道（evidenceOf）落库，不进入 Renderer 可达的任何路径

#### Scenario: Mock 矩阵作为离线门禁证据

- **GIVEN** 未配置真实凭据
- **WHEN** 运行全量门禁与 packaged smoke
- **THEN** MockImageModelAdapter SHALL 提供确定性字节与失败矩阵完成验证
- **THEN** 全程 SHALL 不发生真实网络调用或真实用户目录访问

## ADDED Requirements

### Requirement: 媒体调用证据必须真实落库且与候选终态原子提交

每段真实 Provider 请求（SUBMIT/DOWNLOAD）MUST 在 `media_model_invocations` 落一条证据行：请求快照（prompt、size、参数指纹与参考图 sha256 清单，MUST NOT 含参考图字节或凭据）、响应全文（含失败原文）及其 sha256、`provider_reported_usage`（图片数与输出 tokens）。终态候选的 `invocation_evidence_ref` MUST 指向真实证据行；证据终态收尾与候选终态 MUST 在同一事务原子提交；中断残留的 STARTED 行 MUST 如实保留且不参与恢复决策。图片字节 MUST NOT 写入证据行（下载段证据只记结果 URL 快照与落盘 sha256，字节留在内容寻址存储）。

#### Scenario: 整集真实生成后证据可 SQL 复盘

- **GIVEN** 一个 4 候选任务经真实 Provider 全部生成成功
- **WHEN** 任务驱动完成
- **THEN** `media_model_invocations` SHALL 存在 4 条 SUBMIT 终态行（含响应原文与 usage 图片数；provider_request_id 以 Provider 实际返回为准，Provider 未返回任务 id 时记 null）与对应 DOWNLOAD 行；每条终态候选行的 invocation_evidence_ref SHALL 可 JOIN 到其 SUBMIT 证据行

#### Scenario: 限流失败留档原文且 Renderer 仍只见归一码

- **GIVEN** submit 收到 HTTP 429 限流错误响应
- **WHEN** 候选按归一错误码落 FAILED
- **THEN** 同一事务 SHALL 收尾证据行（error_code=MODEL_RATE_LIMITED、错误响应原文落 blob）
- **THEN** Renderer SHALL 仍只收到归一错误码，不含原文

#### Scenario: 下载段轻量证据不重复存字节

- **GIVEN** 同步 submit 成功并进入下载段
- **WHEN** 图片字节落盘内容寻址存储且候选 SUCCEEDED
- **THEN** SHALL 存在 DOWNLOAD 段证据行（结果 URL 快照与落盘 sha256，耗时可由 created_at/finished_at 复盘）；其 response_body_blob SHALL 为 NULL

#### Scenario: 崩溃窗口残留 STARTED 且恢复语义不变

- **GIVEN** submit 网络在飞时进程崩溃
- **WHEN** 下次启动恢复扫描
- **THEN** 证据行 SHALL 停留 STARTED 如实反映中断；候选恢复决策 SHALL 仍只依据 provider_task_id 证据（缺失即 INTERRUPTED 待人工），MUST NOT 因证据行存在而自动重发
