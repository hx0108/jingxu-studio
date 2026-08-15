# jobrunner-qwen-text-adapter Specification（Delta）

## MODIFIED Requirements

### Requirement: Provider 调用必须事务外，证据与版本短事务原子提交

Provider 网络请求 MUST 发生在事务外；网络前 MUST 先在同一提交中写 `request_sent_at` 并将 Invocation 置为已发送，崩溃时按「结果未知」处理。完整非流式响应到达后，系统 MUST 在同一短事务写响应 blob、hash、`response_complete_at` 并将 Job 置为 `VALIDATING`；最终业务提交 MUST 在单一 `UnitOfWork` 短事务内原子完成（复检输入版本、复检锁、校验 Job 未取消、写版本或分镜集合/指针/审计、置 `SUCCEEDED`），任一步失败整体回滚。SHOT_CONTRACT 的整集分镜集合（episode_version、shots、shot_contract_versions、episode_version_shots）MUST 与阶段头在同一短事务原子落库，MUST NOT 分批提交。Repository MUST NOT 自行嵌套提交，JobRunner MUST NOT 直接执行 SQL 或导入 `node:sqlite`。

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

#### Scenario: 分镜集合单事务原子落库

- **GIVEN** SHOT_CONTRACT Job 通过候选、最终与集合校验
- **WHEN** commit 在 JobRunner 最终短事务执行
- **THEN** episode_version、全部 shots、shot_contract_versions 与 episode_version_shots SHALL 与阶段头、依赖、审计、Job→`SUCCEEDED` 同事务提交
- **THEN** 任一行写入失败 MUST 整体回滚，MUST NOT 留下部分镜头或无集合的 episode_version
