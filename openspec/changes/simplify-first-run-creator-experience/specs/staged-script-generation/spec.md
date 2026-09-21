## ADDED Requirements

### Requirement: 五阶段内容必须默认使用结构化表单编辑

CONCEPT、STORY_BIBLE、EPISODE_OUTLINE、BEAT_SHEET 和 SCENE_SCRIPT 的默认编辑界面 MUST 按 `ScriptStageOutput` 1.0.0 对应阶段的业务字段展示中文表单、列表和可重复项，不得要求普通用户阅读或修改 JSON。表单 SHALL 保留未知为空与用户明确填写为空的语义，并在保存前将字段映射为正式 `data` 对象交由既有 Schema 和主进程校验。

#### Scenario: 编辑故事概念

- **GIVEN** 当前 CONCEPT 已有可编辑 DRAFT
- **WHEN** 用户修改标题、类型、目标受众、核心冲突、主题和简介并保存
- **THEN** 系统 SHALL 使用结构化字段构造完整 concept `data` 并创建新的 DRAFT
- **THEN** 页面 SHALL 将 Schema 字段错误映射到对应中文控件而非只显示 JSON Pointer

#### Scenario: 编辑可重复的故事圣经项目

- **GIVEN** 当前 STORY_BIBLE 包含多个角色、场景、世界规则和道具
- **WHEN** 用户新增、删除、排序或修改一个可重复项
- **THEN** 表单 SHALL 保持未修改项目及稳定业务键
- **THEN** 保存结果 MUST 通过正式 Schema，失败时 SHALL 保留全部未提交编辑

#### Scenario: 编辑场景和对白

- **GIVEN** 当前 SCENE_SCRIPT 包含多个场景与对白行
- **WHEN** 用户修改动作、出场角色、对白类型、说话人或预计时长
- **THEN** 表单 SHALL 以场景卡片和对白列表呈现这些字段
- **THEN** 无效角色/场景引用或时长 SHALL 在对应控件附近显示中文错误

### Requirement: 高级 JSON 编辑必须与结构化表单共享同一草稿

用户主动进入“高级编辑”后 SHALL 可查看和编辑当前阶段 `data` JSON；结构化表单与高级 JSON MUST 映射到同一份未提交草稿并使用同一保存命令、expectedVersionId、Schema 校验、dirty 离开保护和不可变版本规则。模式切换时若 JSON 无法解析或不符合当前阶段结构，系统 MUST 阻止覆盖结构化表单并保留原文本。

#### Scenario: 从表单切换到高级编辑

- **GIVEN** 用户在结构化表单中有未保存修改
- **WHEN** 用户展开高级 JSON 编辑
- **THEN** JSON SHALL 反映当前未提交表单值而非最后一次已保存版本
- **THEN** 切换本身 MUST NOT 创建版本或清除 dirty 状态

#### Scenario: 无效 JSON 返回结构化表单

- **GIVEN** 用户在高级编辑中输入无法解析或不符合阶段结构的 JSON
- **WHEN** 用户尝试返回结构化表单
- **THEN** 系统 SHALL 保留高级编辑文本并显示可定位错误
- **THEN** 系统 MUST NOT 用无效内容覆盖当前结构化草稿或提交业务版本

#### Scenario: 高级编辑保存成功

- **GIVEN** 高级 JSON 对当前阶段有效且 expectedVersionId 匹配
- **WHEN** 用户保存
- **THEN** 系统 SHALL 通过与表单相同的主进程 Schema 和事务路径创建新 DRAFT
- **THEN** 返回表单后 SHALL 展示该新版本的业务内容而不暴露系统元数据字段

### Requirement: 表单不得让用户编辑系统控制字段

结构化表单和高级 `data` JSON MUST NOT 允许用户编辑 `schema_version`、`project_id`、`episode_id`、`source_invocation_id`、阶段状态、版本 ID、锁或审计字段；这些字段 SHALL 继续由 Application/JobRunner 注入和验证。

#### Scenario: 高级 JSON 包含系统字段

- **GIVEN** 用户在高级 `data` JSON 中加入系统元数据或版本字段
- **WHEN** 用户保存
- **THEN** 系统 SHALL 返回字段级错误且不创建版本
- **THEN** Renderer MUST NOT 将这些字段提升为正式信封元数据

