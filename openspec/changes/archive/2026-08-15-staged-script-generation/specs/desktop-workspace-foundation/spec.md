## MODIFIED Requirements

### Requirement: JobRunner 调度与 Job/Provider IPC 必须受启动门约束

JobRunner 的任务领取、阶段提交器与启动恢复扫描 MUST 只在启动进入 `READY`、Schema Registry 已发布且 Script Persistence 可用后激活；`READ_ONLY_FAULT` 或其他非 `READY` 状态下 MUST NOT 领取或重发任何 Job。`script`、`job`、`provider` 写命令在非 `READY` 状态下 MUST 返回既有 `STARTUP_WRITE_BLOCKED`，且 MUST NOT 构造 ScriptService、JobRunner、Provider 写入或真实模型调用入口。READY 后恢复扫描 SHALL 按崩溃恢复矩阵处理 QUEUED/RUNNING/VALIDATING；完整响应只执行确定性正式 Schema、输入版本和阶段头复检并幂等提交，已发送但结果未知的请求 MUST NOT 自动重发。

#### Scenario: 仅 READY 后激活调度与恢复

- **GIVEN** 启动尚处于数据库或 Schema 自检阶段、Script Persistence 未就绪或处于 `READ_ONLY_FAULT`
- **WHEN** 启动进程推进状态
- **THEN** JobRunner MUST NOT 领取或恢复任何 Job，MUST NOT 发起 Provider 调用
- **THEN** 只有全部依赖可用并进入 `READY` 后 SHALL 激活阶段 submission、领取与崩溃恢复扫描

#### Scenario: 非就绪态阻断 Job/Provider 写命令

- **GIVEN** 当前启动状态非 `READY`
- **WHEN** Renderer 调用 `script.initializeOriginal`、`job.create`、`job.retry`、`provider.saveCredential` 或 `provider.deleteCredential`
- **THEN** 命令 MUST 返回稳定 `STARTUP_WRITE_BLOCKED`
- **THEN** 系统 MUST NOT构造 UnitOfWork 驱动的业务服务或真实 Provider 写入

#### Scenario: 完整响应恢复只做确定性提交

- **GIVEN** 启动进入 READY 且某 VALIDATING Job 已保存完整、hash 正确的响应
- **WHEN** 恢复扫描处理该 Job
- **THEN** 系统 SHALL 重新执行候选/正式 Schema、当前输入版本和阶段头复检并幂等提交
- **THEN** 恢复 MUST NOT 再次调用 Provider 或创建重复业务版本
