# storyboard-evaluation-set Specification

## Purpose

以受控、可追溯的方式积累结构化分镜评测判例：样本入库必经确定性校验并保存规则命中，人工结论追加式留痕，去重与授权状态可审计，满足 PRD v1.4 §9.11 对 20–40 个样本与第一版标注指南的发布门槛。

## Requirements

### Requirement: 样本入库与去重

系统 MUST 通过 `dedup_key` 全局唯一约束接收评测样本，拒绝缺少授权状态、重复键或非法期望契约，并逐样本列出拒绝原因且 MUST NOT 写入部分字段。

#### Scenario: 创建或拒绝样本

- **GIVEN** 用户提交完整样本，或提交重复键、缺失授权、非法期望的样本
- **WHEN** 提交创建命令
- **THEN** 合法样本在同一事务中保存规则命中和审计；非法样本返回稳定错误且数据库无新增行

### Requirement: 项目派生样本

系统 MUST 仅从项目当前 READY 的整集分镜阶段头派生样本，冻结输入上下文并归属该项目。

#### Scenario: READY 与非 READY 派生

- **GIVEN** 项目当前整集版本为 READY，或为 DRAFT/STALE_INPUT
- **WHEN** 用户从项目评测入口发起派生
- **THEN** READY 版本以镜头集合和上下文生成项目样本；非 READY 版本返回稳定错误且零入库

### Requirement: 确定性规则命中

系统 MUST 在入库时执行离线 Registry Schema、可生产性与集合派生规则，并保存命中列表和 `rule_version`。

#### Scenario: 规则结果可追溯

- **GIVEN** 候选文档存在确定性问题或通过全部规则
- **WHEN** 样本入库
- **THEN** 相应问题码或空命中列表与规则版本一同被保存并可读取

### Requirement: 人工标注追加式留痕

系统 MUST 追加保存标注指南版本、结论、依据和标注人，MUST NOT 覆盖历史标注。

#### Scenario: 追加或拒绝标注

- **GIVEN** 样本存在，或标注字段缺少指南版本、结论或依据
- **WHEN** 用户提交标注
- **THEN** 合法标注按时间序追加返回；非法标注返回稳定错误且零写入

### Requirement: JSON 批量导入

系统 MUST 通过系统文件对话框批量导入 JSON，逐样本独立事务返回创建、重复或拒绝原因；路径 MUST NOT 进入 Renderer、回执或审计。

#### Scenario: 混合与损坏导入

- **GIVEN** 文件包含合法、重复、非法条目，或文件本身不是合法 JSON/导入信封
- **WHEN** 用户确认导入
- **THEN** 混合批次逐项处理；损坏文件整体拒绝且零样本入库

### Requirement: 安全 IPC 与评测集页面

系统 MUST 通过冻结的 `evaluation` 白名单和双端 strict DTO 提供评测操作，MUST NOT 暴露路径、SQL、Key 或内部堆栈；页面 MUST 提供全局/项目双入口、三种筛选、空态说明和删除确认。

#### Scenario: 筛选与删除

- **GIVEN** 用户从主导航或项目入口进入评测集
- **WHEN** 切换筛选或确认删除样本
- **THEN** 列表按归属正确过滤；删除样本及标注并写入审计后刷新列表

### Requirement: 种子样本与标注指南

系统 MUST 在迁移中幂等播种不少于 20 个 SYNTHETIC 样本（至少 10 个可接受和 10 个问题样本），覆盖 PRD §9.9 九类问题，并内置第一版指南版本。

#### Scenario: 新库种子覆盖

- **GIVEN** 全新空库执行迁移
- **WHEN** 迁移完成并按问题类型统计
- **THEN** 种子键唯一、保存规则命中和版本，九类问题各至少一个样本且页面可展示
