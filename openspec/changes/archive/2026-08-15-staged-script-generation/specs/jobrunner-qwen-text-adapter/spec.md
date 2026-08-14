## MODIFIED Requirements

### Requirement: Job/Provider IPC 必须服从启动写门与幂等

`job create/get/list/cancel/retry`、`provider getProfile/saveProfile/saveCredential/testCredential/deleteCredential` 与 `events.subscribeJobUpdates` SHALL 经 Preload 逐方法白名单暴露。所有 Command MUST 携带 `requestId`，修改类命令 MUST 携带 `expectedVersionId`；同一 `(project_id, idempotency_key)` MUST 去重为同一 Job。非 `READY` 状态下，写命令 MUST 返回既有 `STARTUP_WRITE_BLOCKED` 且不构造 JobRunner/Provider 写路径。READY 后，AI 原创五阶段的 `job.create/retry/cancel` MUST 委托真实阶段 submission/runner；创建命令 SHALL 携带 episodeId、stage、`operationType=GENERATE`、expectedInputVersionId、idempotencyKey 与 requestId，完整 input version set 必须由 Main 从当前 READY 阶段头推导并冻结。延期的授权改编、AI 优化、局部改写和 SHOT_CONTRACT 操作 MUST 返回稳定不支持错误，不得创建空壳 Job 或伪造成功。

#### Scenario: 幂等键去重重复提交

- **GIVEN** 同一项目以相同 `idempotency_key`、阶段和冻结输入重复提交 `job.create`
- **WHEN** JobService 处理后续请求
- **THEN** 系统 SHALL 返回同一 `job_id`，MUST NOT 创建重复 Job

#### Scenario: 启动未就绪阻断写命令

- **GIVEN** 启动状态非 `READY`（如 `READ_ONLY_FAULT`）
- **WHEN** Renderer 调用 `job.create` 或 `provider.saveCredential`
- **THEN** 系统 MUST 返回稳定 `STARTUP_WRITE_BLOCKED`
- **THEN** 系统 MUST NOT 构造 JobRunner 领取或 Provider 写入

#### Scenario: 五阶段生成委托真实 JobRunner

- **GIVEN** 应用已 READY、Provider 已配置且目标阶段 READY 前置条件满足
- **WHEN** Renderer 以匹配的 expectedInputVersionId 调用 `job.create`
- **THEN** 系统 SHALL 冻结服务端推导的完整输入集合并创建可被生产 JobRunner 领取的 QUEUED Job
- **THEN** Job 成功 SHALL 只产生一个通过正式 Schema 的 DRAFT 业务版本

#### Scenario: 未接入阶段提交器时安全降级

- **GIVEN** AI 原创五阶段已接入生产提交器，但 Renderer 请求仍未接入提交器的授权改编、AI 优化、局部改写或 SHOT_CONTRACT 生成
- **WHEN** Job Host 处理该请求
- **THEN** 系统 MUST 返回稳定不支持错误
- **THEN** 系统 MUST NOT 创建 Job、调用 Provider 或写业务版本
