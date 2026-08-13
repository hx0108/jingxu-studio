## ADDED Requirements

### Requirement: JobRunner 调度与 Job/Provider IPC 必须受启动门约束

JobRunner 的任务领取与启动恢复扫描 MUST 只在启动进入 `READY` 后激活；`READ_ONLY_FAULT` 或其他非 `READY` 状态下 MUST NOT 领取或重发任何 Job。`job`/`provider` 写命令（create/retry/saveProfile/saveCredential/testCredential/deleteCredential 等）在非 `READY` 状态下 MUST 返回既有 `STARTUP_WRITE_BLOCKED`，且 MUST NOT 构造 JobRunner、Provider 写入或真实模型调用入口。恢复扫描 SHALL 在 `READY` 后按崩溃恢复矩阵处理 `QUEUED/RUNNING/VALIDATING`，MUST NOT 在启动自检未完成时先行调用 Provider；具体阶段提交与可提交恢复只有在后续 Change 注入对应业务 seam 后才激活，未注入时 MUST 安全返回不可用而非创建空壳任务。

#### Scenario: 仅 READY 后激活调度与恢复

- **GIVEN** 启动尚处于数据库或 Schema 自检阶段、或处于 `READ_ONLY_FAULT`
- **WHEN** 启动进程推进状态
- **THEN** JobRunner MUST NOT 领取或恢复任何 Job，MUST NOT 发起 Provider 调用
- **THEN** 只有进入 `READY` 后 SHALL 激活领取与崩溃恢复扫描

#### Scenario: 非就绪态阻断 Job/Provider 写命令

- **GIVEN** 当前启动状态非 `READY`
- **WHEN** Renderer 调用 `job.create`、`job.retry`、`provider.saveCredential` 或 `provider.deleteCredential`
- **THEN** 命令 MUST 返回稳定 `STARTUP_WRITE_BLOCKED`
- **THEN** 系统 MUST NOT 构造 JobRunner、UnitOfWork 驱动的业务服务或真实 Provider 写入
