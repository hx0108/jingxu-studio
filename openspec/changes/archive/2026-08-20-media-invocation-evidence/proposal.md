# Proposal: media-invocation-evidence

## Why

现行 spec 已承诺但从未兑现：`shot-first-frame-image-generation` 的适配器屏蔽 Requirement 内含「每段真实 Provider 请求 MUST 记一条调用证据并登记 `provider_reported_usage`（图片数）」，`ImageModelPort` 文档同样承诺「N 候选 = N 次独立 submit，每次各记一条 model_invocations」。实际实现媒体域在 `model_invocations` 零留痕：2026-08-19 真实整集联调（25 张真实生成）后该表无任何媒体行；候选行 `invocation_evidence_ref` 装的是本地随机 id 的悬空引用，背后无证据行。该欠账在 shot-first-frame 归档 tasks.md 有正式 defer 记录（「invocationEvidenceRef 先行落候选行，证据接线因 job_id FK 不兼容 deferred 至独立 change」）。

排查代价已在联调实录兑现：火山方舟 `SetLimitExceeded` 限流只能靠 batches/tasks/candidates 三表侧写加直连复现定位；若调用证据在库（provider_request_id、原始错误响应、usage、耗时），一次 SQL 即可定位。Seedance 视频（长异步、失败模式更多）在路线图上，证据地基应先于其铺设。

根因是结构性不兼容：`model_invocations.job_id` 为 `TEXT NOT NULL REFERENCES script_stage_jobs` 双约束，媒体任务独立于 jobrunner（该表 stage/operation_type CHECK 均限定文本域，伪造 jobs 行不可行），媒体行无法插入既有表；SQLite 无法就地放宽 NOT NULL/FK，表重建工艺成本高且 CHECK 枚举（attempt_kind/transport_attempt）与媒体形态（无重试段、候选粒度、参考图字节不可 JSON 快照）根本不匹配。

## What Changes

- 迁移 0011 新表 `media_model_invocations`（媒体域自有证据表，形态与粒度见 design D1/D2）：SUBMIT 段每候选一行（1 任务 4 候选 = 4 行）+ DOWNLOAD 段轻量行（字节 sha256/大小/耗时，不重复存图片字节）；列含 provider_request_id、请求快照（prompt 文本 + size + 参数指纹 + 参考图 sha256 清单，不含字节）、响应全文 blob 与 sha256、usage（generated_images/output_tokens）、段起止时间戳、归一 error_code、media_task_id 关联；迁移 head 10→11。
- 候选行 `invocation_evidence_ref` 从悬空本地 id 改为真实证据行 id；终态候选与证据行同事务原子提交（`MediaUnitOfWorkPort` 扩 invocations 仓储，对齐文本域「网络调用在事务外、证据与状态变更同短事务」红线）。
- 两段式留证：submit 前短事务插 STARTED（含请求快照）；响应后（成功或归一失败）在候选终态同一事务内 recordResponse + finish。失败路径适配器扩展：`SeedreamAdapterError` 携带原始响应体仅供 main 侧留证（renderer 仍只见归一码，detail 不透传不变）。
- 适配器 Port 扩展：submit 返回携带原始响应（responseBody/httpStatus）与 usage 透传（现状 `submission.usage` 被调度器丢弃）；`MockImageModelAdapter` 同步扩展供离线断言。
- 复盘工具 `print-real-probe-invocations.mjs` 扩媒体域查询（现仅文本域 JOIN）。
- spec 修订：`shot-first-frame-image-generation` 调用证据 Requirement 从未兑现态细化为可验收形态（证据表位置、两段式与原子性、内容口径、候选 ref 完整性 MUST）。

### 明确不做（非目标）

- 文本域证据链任何改动（JobRunner、model_invocations 既有表与行均不动）。
- model_invocations 表重建合一（放宽 job_id 可空方案的否决理由见 design D1）。
- Renderer/IPC 暴露证据：image 契约九方法零变化，renderer 仍只见归一错误码。
- 原始响应进日志/诊断包（既有红线不变；DB 内全文保留对齐文本域口径）。
- POLL 段实现（Seedream 为 SYNC 形态恒不触发，segment 枚举预留；PollOnly 形态留待真实异步 Provider）。
- TTS、视频、后帧能力。

## Capabilities

### New Capabilities

（无——本 Change 是既有图片能力内的证据欠账偿还。）

### Modified Capabilities

- `shot-first-frame-image-generation`：将既有「每段真实 Provider 请求 MUST 记一条调用证据并登记 provider_reported_usage」细化为可验收形态——媒体证据表与两段式留证、候选 ref 真实指向（消灭悬空引用）、usage 登记、失败原始响应留档（main-only）、证据与候选终态原子提交。

## Impact

- **产品/验收**：UI 与 IPC 零变化（纯 main 侧切片）；真实联调后媒体调用可 SQL 复盘（限流类问题一次查询定位）。验收含真实探针一次 + SQL 证据断言。
- **Schema**：六份 PRD-owned Schema 字节不变；TECH-internal 新表属媒体自有域（同 `media_generation_tasks` 先例）。
- **数据库**：迁移 0011（CREATE TABLE + 索引），head 10→11；触发仓库约定「新增迁移同步 4 文件 9 处硬编码版本断言」（initial-schema/project-command-receipts/script-migration/persistence-runtime-adapter）。
- **接口**：ImageModelPort 返回类型加字段（向后兼容）；MediaUnitOfWorkPort 签名扩展（组合根/内存仓/SQLite 三处同步）；无 IPC/renderer 变化。
- **安全**：请求快照不含参考图字节与凭据；原始响应仅 main 侧 DB 留档，不进 renderer/日志/诊断包；错误 detail 透传禁令不变。
- **并行实施**：单线 Change（迁移 → 持久化/内存仓 → 调度器接线 → 适配器 → 工具 → 门禁/E2E → 真实联调 → 归档），体量显著小于 batch-first-frame-generation（无 UI、无 IPC 面）。
