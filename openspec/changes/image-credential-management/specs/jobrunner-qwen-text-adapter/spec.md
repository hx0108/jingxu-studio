# jobrunner-qwen-text-adapter Specification（Delta）

> 数值（SHOT_CONTRACT 调用超时 300 秒 / 超时重试预算 1 次 / deadline 960 秒）为 design.md D3 方案一起草值，待产品负责人拍板后按 0.2 同步修订。

## MODIFIED Requirements

### Requirement: 重试与结构修复必须受状态机、次数与错误类型约束

Job 主路径与合法分支固定为 `DRAFT→QUEUED→RUNNING→VALIDATING→SUCCEEDED`，允许 `RUNNING→RUNNING`（transport retry）与 `VALIDATING→RUNNING`（structure repair）。transport retry MUST 仅针对网络错误、429、5xx 与调用超时（MODEL_TIMEOUT）且最多 2 次；其中调用超时（MODEL_TIMEOUT）的重试 MUST NOT 超过 1 次。401、内容拒绝、上下文超限与业务校验失败 MUST NOT 盲目重试。每次 transport retry MUST 在剩余 `deadline_at` 预算内执行，预算不足 MUST 直接终态。structure repair MUST 最多一次且只修候选 JSON 结构、不修系统字段。终态 MUST NOT 回退。数据库 CHECK 约束（`transport_attempts` 0–3、`structure_repair_attempts` 0–1）与应用状态机 SHALL 共同守卫这些边界。

#### Scenario: 可重试错误触发 transport retry

- **GIVEN** Mock 固定返回 429 或 5xx，且 `transport_attempts < 2`
- **WHEN** JobRunner 处理该归一化错误
- **THEN** 系统 SHALL 以指数退避重试，最多累计 2 次
- **THEN** 每次 transport retry SHALL 创建独立 `ModelInvocation`（`attempt_kind=TRANSPORT_RETRY`）

#### Scenario: 调用超时受限重试一次

- **GIVEN** Invocation 超过其阶段调用超时（SHOT_CONTRACT 300 秒，其余阶段 120 秒），此前无超时重试且剩余 `deadline_at` 预算充足
- **WHEN** JobRunner 处理 MODEL_TIMEOUT
- **THEN** 系统 SHALL 以指数退避重试至多 1 次并创建独立 `ModelInvocation`（`attempt_kind=TRANSPORT_RETRY`）
- **THEN** 第二次超时或剩余预算不足 MUST 直接置 `FAILED` 且 `error_code=MODEL_TIMEOUT` 稳定

#### Scenario: 不可重试错误直接终态

- **GIVEN** Mock 固定返回 401、内容拒绝、上下文超限或结构校验失败
- **WHEN** JobRunner 处理该错误
- **THEN** 系统 MUST 直接置 `FAILED` 且 `error_code` 稳定，MUST NOT 自动重试或改写用户原文

#### Scenario: 结构修复只修候选一次

- **GIVEN** 候选 JSON 结构非法但可修复，且尚未用过 structure repair
- **WHEN** JobRunner 触发结构修复
- **THEN** 系统 SHALL 仅修改候选 JSON 并重新注入系统字段后重校验
- **THEN** 第二次结构失败 MUST 进入 `FAILED`，MUST NOT 把首次失败响应中的 ID 当真

### Requirement: 崩溃恢复必须按持久化证据确定终态且不自动重发未知请求

启动恢复 MUST 扫描 `QUEUED/RUNNING/VALIDATING`：`QUEUED`（无已发送 Invocation）可重新领取；`request_sent_at` 非空但 `response_complete_at` 为空 MUST 置 `FAILED`/`INTERRUPTED_UNKNOWN_OUTCOME` 且禁止自动重发；`response_complete_at` 非空且 hash 正确 MUST 重跑确定性校验与提交（幂等键阻止重复版本）；`cancel_requested_at` 非空 MUST 保持 `CANCELLED`；超过 `deadline_at` MUST 置 `FAILED`/`JOB_DEADLINE_EXCEEDED`。`deadline_at` 与 Invocation `timeout_at` SHALL 按阶段推导：SHOT_CONTRACT 调用超时 300 秒、`deadline_at` 为创建后 960 秒；其余阶段调用超时 120 秒、`deadline_at` 为创建后 300 秒。重启后 MUST NOT 重置 `deadline_at`/`timeout_at`。

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

- **GIVEN** Job 已超过创建后的阶段 `deadline_at`（SHOT_CONTRACT 960 秒，其余阶段 300 秒），或 Invocation 超过其阶段 `timeout_at`（SHOT_CONTRACT 300 秒，其余阶段 120 秒）
- **WHEN** 恢复或运行检查发现超时
- **THEN** 系统 MUST 置 `FAILED` 且 `error_code` 稳定（如 `JOB_DEADLINE_EXCEEDED`）
- **THEN** 系统 SHALL 保留所有已有 Provider 任务 ID 作为证据
