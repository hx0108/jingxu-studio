## ADDED Requirements

### Requirement: 启动门必须包含 Schema 与关键资源自检阶段

应用 MUST 在数据库打开、migration 与数据库审计成功后执行 `SCHEMA_REGISTRY` 阶段，并且只有 Schema Registry、资源核验和成功证据提交全部完成后才能进入 `READY`。该阶段失败 SHALL 复用既有只读故障页、运行时状态查询、写入门和幂等重试，不得构造可写业务服务。

#### Scenario: Schema 阶段成功后进入 READY

- **GIVEN** 数据库阶段已经完成且四份 Schema 资源与锁清单一致
- **WHEN** 启动门执行 `SCHEMA_REGISTRY` 阶段
- **THEN** 状态 SHALL 把该阶段加入 `completedPhases` 后进入 `READY`
- **THEN** Project 写入入口才 SHALL 激活真实 Application Service

#### Scenario: Schema 阶段失败进入只读故障

- **GIVEN** 数据库可读且 migration 成功，但 Schema 资源核验或证据提交失败
- **WHEN** 启动门处理该失败
- **THEN** 状态 MUST 进入 `READ_ONLY_FAULT`、`currentPhase=SCHEMA_REGISTRY` 且 `writeEnabled=false`
- **THEN** 故障页 SHALL 显示稳定错误码、脱敏摘要和重试动作，不得显示绝对路径、Schema 原文或堆栈

#### Scenario: 故障态尝试业务写入

- **GIVEN** 当前故障发生在 `SCHEMA_REGISTRY` 阶段
- **WHEN** Renderer 尝试创建、更新、删除或恢复 Project
- **THEN** 六个 Project IPC 安全边界 SHALL 保持注册
- **THEN** 所有 Command MUST 返回稳定的 `STARTUP_WRITE_BLOCKED` 且不得构造 UnitOfWork 驱动的业务服务

#### Scenario: 修复资源后幂等重试

- **GIVEN** 用户已修复或重新安装缺失资源，当前状态为 Schema 只读故障
- **WHEN** Renderer 使用当前 revision 和 requestId 调用既有 `runtime.retryStartup`
- **THEN** 系统 SHALL 从数据库阶段开始重新执行完整启动检查并重新核验全部四份 Schema
- **THEN** 同一 requestId 的并发重试 MUST 共享结果，只有全部阶段通过才恢复 `READY`
