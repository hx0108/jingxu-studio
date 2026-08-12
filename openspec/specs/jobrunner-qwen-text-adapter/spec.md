# jobrunner-qwen-text-adapter Specification

## Purpose
为镜序 Studio V1 提供确定性的 AI 文本生成任务基线：Application 层 JobRunner 负责领取、事务外调用、证据落库、两层契约、原子提交、重试、取消与崩溃恢复；TextModelAdapter 契约与 Qwen/Mock 实现屏蔽 Provider 专有结构；凭据经 safeStorage 保管；Job/Provider IPC 服从启动门与幂等。该能力用 Mock 跑通 PRD v1.4 AC-V1-04 的失败恢复全矩阵，再用 Qwen 完成真实凭据验证，但不实现五个编剧阶段、分镜生成与可生产性。
## Requirements
### Requirement: TextModelAdapter 契约必须屏蔽 Provider 专有结构

Application/Domain MUST 只依赖 `TextModelAdapter` 的 `validateCredential` / `generate(signal)` / `normalizeError` 接口与 `NormalizedModelError`，且 MUST NOT 读取百炼 `choices`、HTTP header、Authorization 或 Provider 专有错误结构。Provider 专有 DTO、字段与错误 SHALL 只存在于 `QwenTextModelAdapter`。每次真实 Provider 调用 SHALL 创建独立的 `ModelInvocation`。

#### Scenario: 业务层只依赖归一化结果

- **GIVEN** JobRunner 通过 `TextModelPort` 调用 `generate`
- **WHEN** Qwen 返回 OpenAI 兼容响应或百炼专有错误
- **THEN** Adapter SHALL 返回 `TextGenerationResult`（含 `rawText`、`usage`、`finishReason`）或归一化 `NormalizedModelError`
- **THEN** Application 对象与 Renderer MUST NOT 出现百炼专有字段或原始错误体

#### Scenario: 不可注入的 Provider 类型被架构测试拒绝

- **GIVEN** 仓库存在架构边界测试
- **WHEN** `packages/application` 或 `packages/domain` 尝试导入百炼 SDK 或专有响应类型
- **THEN** 类型/lint 或架构测试 MUST 失败
- **THEN** Provider 专有符号 MUST 只在 `packages/model-adapters` 内可见

### Requirement: Job 领取必须原子且仅领取成功方调用 Provider

JobRunner MUST 通过 Repository 执行带条件原子更新领取 `QUEUED` 任务（`WHERE id=:job_id AND status='QUEUED'`，写入 `lease_token`、`lease_expires_at`、`started_at`、`deadline_at`），且只有领取成功的 runner SHALL 发起 Provider 调用。`lease_expires_at` MUST 只用于发现异常占用，MUST NOT 自动接管已标记 `request_sent_at` 的 Invocation。

#### Scenario: 唯一领取方调用 Provider

- **GIVEN** 同一项目存在一个 `QUEUED` Job 且全局并发门允许领取
- **WHEN** JobRunner 通过条件更新领取
- **THEN** 恰好一个领取方 SHALL 获得 `RUNNING` 与有效 `lease_token`
- **THEN** 只有该领取方 SHALL 创建 `ModelInvocation` 并调用 Provider

#### Scenario: 已发送请求的 Invocation 不被自动接管

- **GIVEN** 某 Invocation 已写 `request_sent_at` 但未写 `response_complete_at`，且原 runner 异常
- **WHEN** 启动恢复或 lease 过期检查发现该状态
- **THEN** 系统 MUST NOT 让另一 runner 重新领取或重发该请求
- **THEN** 系统 SHALL 按崩溃恢复矩阵确定终态，宁可人工重试也不自动产生重复费用

### Requirement: Provider 调用必须事务外，证据与版本短事务原子提交

Provider 网络请求 MUST 发生在事务外；网络前 MUST 先在同一提交中写 `request_sent_at` 并将 Invocation 置为已发送，崩溃时按「结果未知」处理。完整非流式响应到达后，系统 MUST 在同一短事务写响应 blob、hash、`response_complete_at` 并将 Job 置为 `VALIDATING`；最终业务提交 MUST 在单一 `UnitOfWork` 短事务内原子完成（复检输入版本、复检锁、校验 Job 未取消、写版本/指针/审计、置 `SUCCEEDED`），任一步失败整体回滚。Repository MUST NOT 自行嵌套提交，JobRunner MUST NOT 直接执行 SQL 或导入 `node:sqlite`。

#### Scenario: 请求标记发送先于网络

- **GIVEN** JobRunner 准备发起一次真实 Provider 调用
- **WHEN** 标记发送与发起请求之间发生崩溃
- **THEN** 系统 MUST 按「结果未知」处理，即使请求实际未离开本机
- **THEN** 恢复时 MUST NOT 自动重发，SHALL 要求人工重试

#### Scenario: 响应证据与业务版本原子提交

- **GIVEN** Provider 返回完整非流式响应
- **WHEN** JobRunner 执行校验与提交
- **THEN** 响应 blob/hash/`response_complete_at` 与 Job→`VALIDATING` SHALL 在提交证据时一致
- **THEN** 业务版本写入、指针更新、审计与 Job→`SUCCEEDED` SHALL 在同一 `UnitOfWork` 短事务内原子完成
- **THEN** 任一步失败 MUST 整体回滚，MUST NOT 留下半个版本或半个证据

### Requirement: 重试与结构修复必须受状态机、次数与错误类型约束

Job 主路径与合法分支固定为 `DRAFT→QUEUED→RUNNING→VALIDATING→SUCCEEDED`，允许 `RUNNING→RUNNING`（transport retry）与 `VALIDATING→RUNNING`（structure repair）。transport retry MUST 仅针对网络错误、429、5xx 且最多 2 次；401、内容拒绝、上下文超限与业务校验失败 MUST NOT 盲目重试。structure repair MUST 最多一次且只修候选 JSON 结构、不修系统字段。终态 MUST NOT 回退。数据库 CHECK 约束（`transport_attempts` 0–3、`structure_repair_attempts` 0–1）与应用状态机 SHALL 共同守卫这些边界。

#### Scenario: 可重试错误触发 transport retry

- **GIVEN** Mock 固定返回 429 或 5xx，且 `transport_attempts < 2`
- **WHEN** JobRunner 处理该归一化错误
- **THEN** 系统 SHALL 以指数退避重试，最多累计 2 次
- **THEN** 每次 transport retry SHALL 创建独立 `ModelInvocation`（`attempt_kind=TRANSPORT_RETRY`）

#### Scenario: 不可重试错误直接终态

- **GIVEN** Mock 固定返回 401、内容拒绝、上下文超限或结构校验失败
- **WHEN** JobRunner 处理该错误
- **THEN** 系统 MUST 直接置 `FAILED` 且 `error_code` 稳定，MUST NOT 自动重试或改写用户原文

#### Scenario: 结构修复只修候选一次

- **GIVEN** 候选 JSON 结构非法但可修复，且尚未用过 structure repair
- **WHEN** JobRunner 触发结构修复
- **THEN** 系统 SHALL 仅修改候选 JSON 并重新注入系统字段后重校验
- **THEN** 第二次结构失败 MUST 进入 `FAILED`，MUST NOT 把首次失败响应中的 ID 当真

### Requirement: 取消与迟到响应不得创建版本或触发重试

取消 MUST 先在事务原子写 `cancel_requested_at` 并将 Job 置为 `CANCELLED`，再触发 `AbortController`。取消后到达的响应 MUST 只写 hash 与 `late_response_at`（`LATE_RESPONSE`），MUST NOT 写 parsed JSON、创建业务版本或触发重试。终态 `CANCELLED` MUST NOT 回退。

#### Scenario: 取消先持久化再中断

- **GIVEN** 用户对运行中 Job 发起取消
- **WHEN** JobRunner 处理取消
- **THEN** 系统 SHALL 先原子写 `cancel_requested_at` 与 Job→`CANCELLED`，再 abort 进行中请求
- **THEN** 页面切换或 Renderer 刷新 MUST NOT 取消已持久化的非取消 Job

#### Scenario: 取消后的迟到响应只留证据

- **GIVEN** Job 已为 `CANCELLED` 且存在 `cancel_requested_at`
- **WHEN** Provider 随后返回响应
- **THEN** 系统 SHALL 只记录响应 hash 与 `late_response_at`
- **THEN** 系统 MUST NOT 写 parsed JSON、创建版本或触发任何重试

### Requirement: 崩溃恢复必须按持久化证据确定终态且不自动重发未知请求

启动恢复 MUST 扫描 `QUEUED/RUNNING/VALIDATING`：`QUEUED`（无已发送 Invocation）可重新领取；`request_sent_at` 非空但 `response_complete_at` 为空 MUST 置 `FAILED`/`INTERRUPTED_UNKNOWN_OUTCOME` 且禁止自动重发；`response_complete_at` 非空且 hash 正确 MUST 重跑确定性校验与提交（幂等键阻止重复版本）；`cancel_requested_at` 非空 MUST 保持 `CANCELLED`；超过 `deadline_at` MUST 置 `FAILED`/`JOB_DEADLINE_EXCEEDED`。重启后 MUST NOT 重置 `deadline_at`/`timeout_at`。

#### Scenario: 已发送未完成定为未知结果

- **GIVEN** 启动时某 Invocation `request_sent_at` 非空、`response_complete_at` 为空
- **WHEN** 恢复扫描处理该 Job
- **THEN** 系统 MUST 置 `FAILED` 且 `error_code=INTERRUPTED_UNKNOWN_OUTCOME`
- **THEN** 系统 MUST NOT 自动重发该 Provider 请求

#### Scenario: 完整响应可幂等重校验

- **GIVEN** 启动时某 Job 为 `VALIDATING` 且 Invocation 响应 blob hash 正确
- **WHEN** 恢复扫描处理该 Job
- **THEN** 系统 SHALL 重新执行确定性校验与提交
- **THEN** 同一幂等键 MUST 阻止创建重复业务版本

#### Scenario: 超过墙钟上限终态失败

- **GIVEN** Job 已超过创建后 300 秒的 `deadline_at`，或 Invocation 超过 120 秒 `timeout_at`
- **WHEN** 恢复或运行检查发现超时
- **THEN** 系统 MUST 置 `FAILED` 且 `error_code` 稳定（如 `JOB_DEADLINE_EXCEEDED`）
- **THEN** 系统 SHALL 保留所有已有 Provider 任务 ID 作为证据

### Requirement: 真实 LLM Job 全局唯一且同项目严格串行

系统 MUST 保证全局同时最多 1 个真实 LLM Job 处于 `RUNNING`，且同一项目内的 Job 严格串行执行，以避免输入版本竞争与意外成本。Mock 驱动的测试 Job 与真实 LLM Job 的并发约束 SHALL 一致，便于以 Mock 验证并发门。

#### Scenario: 全局单一真实 Job

- **GIVEN** 已有一个真实 LLM Job 处于 `RUNNING`
- **WHEN** 另一真实 Job 尝试领取
- **THEN** 系统 MUST 使其后等待，直到前者离开 `RUNNING`
- **THEN** 并发门 MUST NOT 允许两个真实 Job 同时调用 Provider

#### Scenario: 同项目严格串行

- **GIVEN** 同一项目存在多个 `QUEUED` Job
- **WHEN** JobRunner 选取下一个领取对象
- **THEN** 同项目内 SHALL 至多一个 Job 处于非终态执行
- **THEN** 系统 MUST NOT 因并发产生输入版本竞争或重复版本

### Requirement: 凭据必须经 safeStorage 加密且不回流 Renderer

API Key MUST 经 Electron `safeStorage` 加密保存；`safeStorage` 不可用时 MUST 阻断保存且不降级为明文。SQLite MUST 只保存 `credential_ref` 与验证元数据，密文独立保存。Key MUST NOT 进入 `.env` 示例、SQLite 明文字段、Renderer 状态、日志、埋点、诊断包、Fixture、截图或导出包。UI MUST 只显示已配置状态与可选末 4 位，MUST NOT 回显完整 Key；删除凭据 MUST 同步删除密文并写审计事件。

#### Scenario: safeStorage 不可用阻断明文降级

- **GIVEN** 运行环境 `safeStorage` 不可用（如未解锁钥匙串）
- **WHEN** 用户尝试保存 API Key
- **THEN** 系统 MUST 拒绝保存并返回稳定错误
- **THEN** 系统 MUST NOT 以明文写入 SQLite、文件或内存长期持有

#### Scenario: Renderer 与产物不含 Key

- **GIVEN** 已配置凭据且应用产生日志、埋点、诊断包或导出包
- **WHEN** 审查这些产物与 Renderer 状态
- **THEN** 完整 API Key MUST NOT 出现在其中
- **THEN** UI SHALL 只显示已配置状态或末 4 位

#### Scenario: 删除凭据同步清理密文

- **GIVEN** 用户删除已配置凭据
- **WHEN** 系统处理删除命令
- **THEN** 系统 MUST 同步删除密文与 SQLite 的 `credential_ref` 引用
- **THEN** 系统 SHALL 写审计事件记录删除

### Requirement: Qwen Adapter 必须锁定固定模型与 JSON Mode 且归一化错误

`QwenTextModelAdapter` MUST 固定模型为 `qwen3.7-plus-2026-05-26`，MUST NOT 使用会漂移的无日期别名；MUST 使用非思考模式 + `response_format={"type":"json_object"}`；组装输入 MUST NOT 超过 64K Token 硬上限，超限时 MUST 阻断而非静默裁剪；单次调用 120 秒、Job 墙钟 300 秒。Adapter MUST 将百炼专有错误归一化为带稳定 `code` 的 `NormalizedModelError`，MUST NOT 把 Authorization header 或原始错误体返回业务层。

#### Scenario: 漂移别名被拒绝

- **GIVEN** 配置或请求尝试使用无日期别名模型标识
- **WHEN** Qwen Adapter 准备调用
- **THEN** 系统 MUST 使用锁定的 `qwen3.7-plus-2026-05-26`，MUST NOT 提交漂移别名

#### Scenario: 输入超限阻断不裁剪

- **GIVEN** 组装后的输入超过 64K Token 硬上限
- **WHEN** JobRunner 提交调用前检查
- **THEN** 系统 MUST 阻断该 Job 并返回稳定错误
- **THEN** 系统 MUST NOT 静默裁剪输入后继续调用

#### Scenario: Provider 错误归一化且脱敏

- **GIVEN** Qwen 返回 401/429/5xx/超时或非法 JSON
- **WHEN** Adapter 处理该错误
- **THEN** 系统 SHALL 返回稳定 `code` 与可执行 `userAction` 的 `NormalizedModelError`
- **THEN** 错误 MUST NOT 携带 Authorization header 或完整原始响应

### Requirement: Job/Provider IPC 必须服从启动写门与幂等

`job create/get/list/cancel/retry`、`provider getProfile/saveProfile/saveCredential/testCredential/deleteCredential` 与 `events.subscribeJobUpdates` SHALL 经 Preload 逐方法白名单暴露。所有 Command MUST 携带 `requestId`，修改类命令 MUST 携带 `expectedVersionId`；同一 `(project_id, idempotency_key)` MUST 去重为同一 Job。非 `READY` 状态下，写命令 MUST 返回既有 `STARTUP_WRITE_BLOCKED` 且不构造 JobRunner/Provider 写路径。本 Change 不实现具体 ScriptStage 提交器；在 `staged-script-generation` 注入阶段提交与恢复重校验 seam 前，READY 状态的 Job 写命令 MUST 返回稳定 `JOB_SUBMISSION_UNAVAILABLE` 或 `JOB_NOT_CANCELLABLE`，MUST NOT 创建空壳 Job 或伪造成功。

#### Scenario: 幂等键去重重复提交

- **GIVEN** `staged-script-generation` 已注入具体阶段提交器，且同一项目以相同 `idempotency_key` 重复提交 `job.create`
- **WHEN** JobService 处理后续请求
- **THEN** 系统 SHALL 返回同一 `job_id`，MUST NOT 创建重复 Job

#### Scenario: 启动未就绪阻断写命令

- **GIVEN** 启动状态非 `READY`（如 `READ_ONLY_FAULT`）
- **WHEN** Renderer 调用 `job.create` 或 `provider.saveCredential`
- **THEN** 系统 MUST 返回稳定 `STARTUP_WRITE_BLOCKED`
- **THEN** 系统 MUST NOT 构造 JobRunner 领取或 Provider 写入

#### Scenario: 未接入阶段提交器时安全降级

- **GIVEN** 应用已进入 `READY`，但具体阶段提交与恢复重校验 seam 尚未由 `staged-script-generation` 注入
- **WHEN** Renderer 调用 `job.create`、`job.retry` 或 `job.cancel`
- **THEN** 系统 MUST 返回稳定 `JOB_SUBMISSION_UNAVAILABLE` 或 `JOB_NOT_CANCELLABLE`
- **THEN** 系统 MUST NOT 创建空壳 Job、调用 Provider 或伪造成功

### Requirement: Job 基线必须以 Mock 全矩阵作为 AC-V1-04 证据

`MockTextModelAdapter` MUST 能按固定序列输出 401、429、5xx、120 秒超时、非法 JSON、结构修复失败、STALE_INPUT、取消与取消后迟到响应，以及各崩溃恢复点。AC-V1-04 的失败恢复全矩阵 MUST 以 Mock 在单元/集成测试下可重复地通过；真实 Qwen 调用在本 Change 内 SHALL 仅用于用户主动发起的凭据验证与低成本受控连通性检查，MUST NOT 用于开始 AC-V1-01 真实用户验收，也 MUST NOT 成为离线自动化归档门禁。

#### Scenario: Mock 失败矩阵可重复

- **GIVEN** Mock 按声明序列依次输出各类失败与崩溃点
- **WHEN** 运行 AC-V1-04 矩阵测试
- **THEN** 终态、错误码、是否重试、是否创建版本与是否保留 Provider 任务 ID SHALL 符合 PRD §9.4.2/§9.4.3
- **THEN** 系统 MUST NOT 产生重复版本，终态 MUST NOT 回退，原始输入 MUST NOT 丢失

#### Scenario: 真实调用仅限凭据验证

- **GIVEN** 已配置真实 Qwen 凭据
- **WHEN** 执行 `provider.testCredential`
- **THEN** 系统 SHALL 以低成本受控请求验证凭据可用性
- **THEN** 本 Change MUST NOT 以真实模型调用关闭 AC-V1-01

#### Scenario: 无真实凭据时离线验证可收口

- **GIVEN** 自动化验证环境没有用户 Qwen 凭据或未获联网授权
- **WHEN** 执行 Verify、Sync 与 Archive
- **THEN** 系统 SHALL 以注入式 Adapter 测试验证连通性请求形态、错误归一化和零密钥泄漏
- **THEN** 真实 `testCredential` SHALL 记录为发布前人工检查，MUST NOT 注入假凭据或阻断离线归档
