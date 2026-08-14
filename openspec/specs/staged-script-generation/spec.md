# staged-script-generation Specification

## Purpose
为镜序 Studio V1 提供从原创创意到场景剧本的五阶段 AI 生成闭环，并用不可变版本、人工确认、正式 Schema、输入冻结和依赖失效传播保证每个阶段可编辑、可追溯、可恢复且不会把未确认或过期内容静默带入下游。
## Requirements
### Requirement: 原创初始化必须保留原始输入并记录数据处理确认

系统 MUST 只接受 20–2,000 个 Unicode 字符的 AI 原创输入，MUST 原样保存 content、char_count 与 SHA-256，不得先 trim 或静默截断；初始化 SHALL 在同一事务创建 SourceInput、DATA_PROCESSING Consent 和项目的单 Episode。提交前界面 MUST 说明内容将发送给当前文本 Provider，且不承诺第三方保密或训练政策。

#### Scenario: 合法原创输入完成原子初始化

- **GIVEN** 用户输入 20–2,000 个字符并确认数据处理说明
- **WHEN** 用户初始化剧本工作区
- **THEN** 系统 SHALL 原子创建 SourceInput、DATA_PROCESSING Consent 和 Episode
- **THEN** 保存内容、字符数与 hash SHALL 对应用户提交的原始字符串

#### Scenario: 边界外输入不进入模型调用

- **GIVEN** 输入为 19 或 2,001 个字符，或仅靠删除前后空白才满足长度
- **WHEN** 用户提交初始化
- **THEN** 系统 MUST 返回字段级稳定错误并保留输入
- **THEN** 系统 MUST NOT 创建 SourceInput、Consent、Episode 或 Job

### Requirement: 五阶段必须按 READY 上游依赖顺序生成

系统 SHALL 支持 CONCEPT、STORY_BIBLE、EPISODE_OUTLINE、BEAT_SHEET、SCENE_SCRIPT 五阶段；CONCEPT 和 STORY_BIBLE 为项目级且 `episode_id=null`，其余三阶段必须绑定 Episode。除 CONCEPT 外，每一阶段 MUST 只读取规范声明的 READY 上游版本；DRAFT、STALE_INPUT、缺失或不属于当前项目/Episode 的版本 MUST 阻断生成。

#### Scenario: 依赖齐全时创建阶段 Job

- **GIVEN** 当前阶段所需上游均存在 READY 当前版本，且客户端 expected input 与服务端当前版本一致
- **WHEN** 用户请求生成下一阶段
- **THEN** 系统 SHALL 冻结完整 input version set、Prompt 版本、操作类型和幂等键并创建一个 QUEUED Job
- **THEN** Renderer MUST NOT 自行决定或补齐隐含上游版本

#### Scenario: 未确认上游阻断下一阶段

- **GIVEN** 所需上游缺失、为 DRAFT/STALE_INPUT 或 expected input 已过期
- **WHEN** 用户请求生成下一阶段
- **THEN** 系统 MUST 返回稳定的前置条件或 STALE_INPUT 错误
- **THEN** 系统 MUST NOT 创建 Job 或调用 Provider

### Requirement: 模型候选必须经过两层契约后才可保存

模型 MUST 只返回 `{data}` 候选，不得决定 schema_version、project_id、episode_id、source_invocation_id 或 stage。系统 SHALL 依次执行 JSON 解析、候选契约、系统字段注入和 ScriptStageOutput 1.0.0 正式 Schema；结构修复最多一次且只修改候选 JSON。任何校验失败 MUST 保留证据但不得创建业务版本。

#### Scenario: 合法候选保存为 DRAFT

- **GIVEN** Provider 返回符合当前阶段候选契约的 `{data}`
- **WHEN** 系统注入元数据并通过 ScriptStageOutput 正式校验与提交前复检
- **THEN** 系统 SHALL 创建不可变 DRAFT 版本、更新阶段头、写依赖与审计并将 Job 置为 SUCCEEDED
- **THEN** 模型输出中的任何系统字段 MUST 被拒绝或忽略后由系统重新生成

#### Scenario: 正式 Schema 失败不产生版本

- **GIVEN** 候选在一次结构修复后仍不符合正式阶段 Schema
- **WHEN** Job 结束校验
- **THEN** 系统 MUST 将 Job 置为 FAILED 并返回脱敏的字段路径与错误码
- **THEN** 系统 MUST NOT 创建版本、移动阶段头或覆盖既有内容

### Requirement: 阶段确认必须创建新的 READY 版本

AI 生成、人工全文保存和历史恢复 MUST 创建不可变 DRAFT；用户确认 DRAFT 时，系统 MUST 以相同业务文档创建新的 READY 子版本并原子更新阶段头。系统 MUST NOT UPDATE 历史版本的内容、状态、父链或 hash；下一阶段只能读取确认后的 READY 版本。

#### Scenario: 确认 DRAFT 创建 READY 子版本

- **GIVEN** 当前阶段头指向属于当前项目/Episode 的 DRAFT
- **WHEN** 用户以匹配的 expectedVersionId 确认
- **THEN** 系统 SHALL 创建内容相同、parent 指向该 DRAFT 的 READY 新版本并更新阶段头
- **THEN** 原 DRAFT 的全部持久化字段 MUST 保持不变

#### Scenario: 过期确认不会覆盖当前版本

- **GIVEN** 当前阶段头已不再指向客户端提交的 expectedVersionId
- **WHEN** 用户确认、保存或恢复
- **THEN** 系统 MUST 返回 STALE_INPUT 或版本冲突
- **THEN** 系统 MUST NOT 创建部分版本、更新阶段头或传播下游失效

### Requirement: 全文编辑、历史与恢复必须可追溯

用户 SHALL 能查看五阶段当前版本和有界历史摘要、读取选定历史内容、全文编辑当前阶段并保存为新 DRAFT，以及基于历史内容恢复为新的当前 DRAFT。保存失败 MUST 保留编辑内容；恢复 MUST NOT 把历史行重新设为当前或修改历史状态。

#### Scenario: 全文编辑保存新 DRAFT

- **GIVEN** 用户编辑当前阶段完整结构化文档且正式 Schema 有效
- **WHEN** 用户保存并提交匹配的 expectedVersionId 与 requestId
- **THEN** 系统 SHALL 创建 source=USER 的新 DRAFT 并更新阶段头
- **THEN** UI SHALL 显示新版本、来源、时间和当前状态

#### Scenario: 历史恢复复制为新 DRAFT

- **GIVEN** 用户选择属于同一阶段和项目/Episode 的历史版本
- **WHEN** 用户确认恢复影响
- **THEN** 系统 SHALL 复制其业务内容创建新的当前 DRAFT，parent 指向恢复前当前版本并记录恢复来源
- **THEN** 被选择的历史版本和恢复前版本 MUST 保持不可变且可查看

### Requirement: READY 上游变化必须版本化传播 STALE_INPUT

当新的 READY 上游替换旧 READY 时，系统 MUST 根据固定依赖图寻找已有下游当前版本；对每个受影响下游 SHALL 复制原业务内容创建 status=STALE_INPUT、source=SYSTEM_INVALIDATION 的新当前版本并记录原因，不得 UPDATE 原 DRAFT/READY。确认、失效版本、阶段头、依赖和审计 MUST 在同一事务提交，失败时整体回滚且不得自动重生成。

#### Scenario: 确认新上游使已有下游失效

- **GIVEN** 用户确认一个新的 READY CONCEPT，且 StoryBible 与后续阶段已有当前版本
- **WHEN** 确认事务提交
- **THEN** 系统 SHALL 为每个受影响下游创建内容相同的 STALE_INPUT 新版本并更新其阶段头
- **THEN** 原下游版本 SHALL 保持不变，界面 SHALL 列出受影响阶段及重新确认或生成动作

#### Scenario: 传播中途失败整体回滚

- **GIVEN** 确认上游时任一版本、依赖或审计写入失败
- **WHEN** UnitOfWork 回滚
- **THEN** 新 READY、所有 STALE_INPUT、阶段头和 Job 终态变更 MUST 全部不可见
- **THEN** 用户 SHALL 继续看到事务前的一致阶段链

### Requirement: 剧本工作区必须呈现完整异步与离开状态

Renderer SHALL 提供原创输入、Provider 设置和五阶段工作区，逐阶段显示前置条件、QUEUED/RUNNING/VALIDATING/终态、DRAFT/READY/STALE_INPUT、校验错误、历史与恢复。异步命令 MUST 在 1 秒内显示已接收或运行反馈；dirty 编辑离开时 MUST 提供保存、放弃、取消，页面切换不得取消持久化 Job。分镜入口 SHALL 保持可见禁用并说明未实现。

#### Scenario: Job 运行期间切换阶段

- **GIVEN** 当前阶段已有持久化 Job 处于 QUEUED、RUNNING 或 VALIDATING
- **WHEN** 用户切换到其他阶段再返回
- **THEN** Job SHALL 继续由 Main 运行，界面 SHALL 从持久化状态恢复进度
- **THEN** 页面切换 MUST NOT 隐式调用 cancel

#### Scenario: dirty 编辑阻止静默离开

- **GIVEN** 用户对阶段文档有未保存修改
- **WHEN** 用户切换项目、阶段、刷新或关闭窗口
- **THEN** 系统 MUST 提供保存、放弃、取消三种选择
- **THEN** 保存失败 SHALL 保留当前页面和编辑内容，取消 SHALL 停留且不丢失内容

