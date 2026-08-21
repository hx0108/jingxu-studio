## Purpose

以受控、可追溯的方式积累结构化分镜评测判例：样本入库必经确定性校验并保存规则命中，人工结论追加式留痕，去重与授权状态可审计，满足 PRD v1.4 §9.11 对 20–40 个样本与第一版标注指南的发布门槛。

## ADDED Requirements

### Requirement: 样本入库与去重

系统 MUST 通过 `dedup_key` 全局唯一约束接收评测样本，拒绝缺少授权状态、重复 `dedup_key` 或非法期望契约的样本，并逐样本列出拒绝原因，且 MUST NOT 写入部分字段。

#### Scenario: 创建可接受样本

- **GIVEN** 用户提供了完整样本（候选文档、最小上下文、期望结论、授权状态、数据拆分）
- **WHEN** 提交创建命令
- **THEN** 系统在同一事务中校验、计算规则命中并保存样本与审计，返回样本摘要

#### Scenario: 重复或缺失授权的样本被拒绝

- **GIVEN** 样本的 `dedup_key` 已存在，或授权状态缺失/非法
- **WHEN** 提交创建命令
- **THEN** 系统返回稳定错误并携带样本级原因，数据库无新增行

### Requirement: 项目派生样本

系统 MUST 支持从项目当前 READY 整集版本派生评测样本，归属该项目并冻结派生时的输入上下文。

#### Scenario: 从整集版本派生

- **GIVEN** 项目当前整集版本为 READY
- **WHEN** 用户从项目内评测集入口发起派生
- **THEN** 系统以该版本镜头集合与格式档案生成候选文档与上下文，`project_id` 归属该项目，并要求用户确认授权状态后入库

#### Scenario: 非 READY 版本拒绝派生

- **GIVEN** 项目当前整集版本为 DRAFT 或 STALE_INPUT
- **WHEN** 用户发起派生
- **THEN** 系统返回稳定错误且不产生样本

### Requirement: 确定性规则命中

系统 MUST 在样本入库时对候选文档执行确定性校验（离线 Registry Schema、可生产性规则、序列/枚举/必填/时长/DialogueRenderMode/锁定派生规则），并把命中结果与 `rule_version` 随样本落库。

#### Scenario: 问题样本命中预期规则

- **GIVEN** 候选文档包含缺失必填字段或正脸长对白等问题
- **WHEN** 样本入库
- **THEN** 规则命中列表包含对应规则标识与 `jingxu-producibility-rules/1` 等版本号，且与期望结论的偏差在回执中可见

#### Scenario: 可接受样本零命中

- **GIVEN** 候选文档通过全部确定性规则
- **WHEN** 样本入库
- **THEN** 规则命中为空列表且样本保存成功

### Requirement: 人工标注追加式留痕

系统 MUST 以追加方式保存人工标注（标注指南版本、结论、依据、标注人），MUST NOT 覆盖或修改历史标注行。

#### Scenario: 追加标注

- **GIVEN** 样本已存在且已有历史标注
- **WHEN** 用户提交新标注
- **THEN** 系统插入新标注行并按时间序返回全部标注，历史行不变

#### Scenario: 非法标注字段被拒绝

- **GIVEN** 标注缺少 `guideline_version`、结论或依据为空
- **WHEN** 提交标注
- **THEN** 系统返回稳定错误且不写任何标注行

### Requirement: JSON 批量导入

系统 MUST 支持经系统文件对话框选择 JSON 文件批量导入样本，逐样本独立事务处理并返回逐样本结果（创建/重复/拒绝+原因），导入期间 MUST NOT 阻塞其他只读页面，文件路径 MUST NOT 进入 Renderer、回执或审计。

#### Scenario: 混合批次导入

- **GIVEN** 导入文件包含合法样本、重复样本与非法样本
- **WHEN** 用户确认导入
- **THEN** 合法样本入库、重复与非法样本被拒绝，回执逐样本列出结果与原因，无部分字段写入

#### Scenario: 损坏文件整体拒绝

- **GIVEN** 导入文件不是合法 JSON 或不是合法导入信封
- **THEN** 系统返回稳定错误，零样本入库

### Requirement: 安全 IPC 与评测集页面

系统 MUST 通过冻结的 `evaluation` 白名单方法提供评测集操作，双端 strict DTO 校验，MUST NOT 向 Renderer 暴露路径、SQL、Key 或内部堆栈；页面 MUST 提供全局/项目双入口、「全部/全局/当前项目」筛选、正反例要求空态说明与删除确认。

#### Scenario: 全局入口筛选

- **GIVEN** 用户从主导航进入评测集
- **WHEN** 切换「全部/全局/当前项目」筛选
- **THEN** 列表按 `project_id` 归属过滤且样本计数与筛选一致

#### Scenario: 删除需确认并留审计

- **GIVEN** 用户删除样本
- **WHEN** 确认删除对话框
- **THEN** 样本与其标注被删除，审计记录 actor 与样本标识，列表刷新

### Requirement: 种子样本与标注指南

系统 MUST 在迁移中播种不少于 20 个 SYNTHETIC 种子样本（不少于 10 个可接受样本与 10 个问题样本，覆盖 PRD §9.9 九类问题）并内置第一版标注指南版本标识；种子 MUST 幂等（重复应用迁移不产生重复行）。

#### Scenario: 全新库播种

- **GIVEN** 全新空库执行迁移
- **WHEN** 迁移完成
- **THEN** 种子样本齐备、`dedup_key` 唯一、每行携带规则命中与版本，评测集页面可直接展示

#### Scenario: 九类问题覆盖

- **GIVEN** 种子样本集合
- **WHEN** 按问题类型分组统计
- **THEN** 缺失必填字段、枚举错误、时长偏离、角色过多、复杂动作、DialogueRenderMode 冲突、连续模式错误、能力 UNKNOWN/UNAVAILABLE、锁定冲突九类每类至少一个问题样本
