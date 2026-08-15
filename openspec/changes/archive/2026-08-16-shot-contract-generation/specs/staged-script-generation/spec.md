# staged-script-generation Specification（Delta）

## RENAMED Requirements

- FROM: `### Requirement: 五阶段必须按 READY 上游依赖顺序生成`
- TO: `### Requirement: 生成阶段必须按 READY 上游依赖顺序执行`

## MODIFIED Requirements

### Requirement: 生成阶段必须按 READY 上游依赖顺序执行

系统 SHALL 支持 CONCEPT、STORY_BIBLE、EPISODE_OUTLINE、BEAT_SHEET、SCENE_SCRIPT、SHOT_CONTRACT 六阶段；CONCEPT 和 STORY_BIBLE 为项目级且 `episode_id=null`，其余阶段必须绑定 Episode。除 CONCEPT 外，每一阶段 MUST 只读取规范声明的 READY 上游版本；DRAFT、STALE_INPUT、缺失或不属于当前项目/Episode 的版本 MUST 阻断生成。SHOT_CONTRACT 的上游 MUST 为 READY 的 STORY_BIBLE、EPISODE_OUTLINE 与 SCENE_SCRIPT，并冻结当前 format_profile_id；其产物为整集分镜集合（EPISODE_VERSION），生成细节由 `shot-contract-generation` 能力约束。

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

#### Scenario: 分镜阶段消费三重 READY 上游

- **GIVEN** STORY_BIBLE、EPISODE_OUTLINE、SCENE_SCRIPT 当前版本均为 READY
- **WHEN** 用户请求生成 SHOT_CONTRACT
- **THEN** 系统 SHALL 冻结三个上游版本与 format_profile_id 并创建分镜 GENERATE Job
- **THEN** 任一上游为 DRAFT 或 STALE_INPUT 时 MUST 阻断并返回稳定错误

### Requirement: 阶段确认必须创建新的 READY 版本

AI 生成、人工全文保存和历史恢复 MUST 创建不可变 DRAFT；用户确认 DRAFT 时，系统 MUST 以相同业务文档创建新的 READY 子版本并原子更新阶段头。系统 MUST NOT UPDATE 历史版本的内容、状态、父链或 hash；下一阶段只能读取确认后的 READY 版本。SHOT_CONTRACT 确认 MUST 按整集语义执行：为每个镜头创建 READY 子版本并创建引用 READY 集合的新 episode_version（见 `shot-contract-generation`）。

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

### Requirement: READY 上游变化必须版本化传播 STALE_INPUT

当新的 READY 上游替换旧 READY 时，系统 MUST 根据固定依赖图寻找已有下游当前版本；对每个受影响下游 SHALL 复制原业务内容创建 status=STALE_INPUT、source=SYSTEM_INVALIDATION 的新当前版本并记录原因，不得 UPDATE 原 DRAFT/READY。SHOT_CONTRACT 下游的失效单位是整集 episode_version，MUST NOT 逐镜头创建 STALE 版本。确认、失效版本、阶段头、依赖和审计 MUST 在同一事务提交，失败时整体回滚且不得自动重生成。

#### Scenario: 确认新上游使已有下游失效

- **GIVEN** 用户确认一个新的 READY CONCEPT，且 StoryBible 与后续阶段已有当前版本
- **WHEN** 确认事务提交
- **THEN** 系统 SHALL 为每个受影响下游创建内容相同的 STALE_INPUT 新版本并更新其阶段头
- **THEN** 原下游版本 SHALL 保持不变，界面 SHALL 列出受影响阶段及重新确认或生成动作

#### Scenario: 分镜失效只推进整集快照

- **GIVEN** 分镜已有当前 episode_version，且其上游剧本阶段确认了新 READY
- **WHEN** 失效传播事务提交
- **THEN** 系统 SHALL 只创建一个引用同批镜头版本的 STALE_INPUT episode_version 并更新阶段头
- **THEN** 既有 shot 与 shot_contract_versions 行 MUST 保持不变

#### Scenario: 传播中途失败整体回滚

- **GIVEN** 确认上游时任一版本、依赖或审计写入失败
- **WHEN** UnitOfWork 回滚
- **THEN** 新 READY、所有 STALE_INPUT、阶段头和 Job 终态变更 MUST 全部不可见
- **THEN** 用户 SHALL 继续看到事务前的一致阶段链

### Requirement: 剧本工作区必须呈现完整异步与离开状态

Renderer SHALL 提供原创输入、Provider 设置和六阶段工作区，逐阶段显示前置条件、QUEUED/RUNNING/VALIDATING/终态、DRAFT/READY/STALE_INPUT、校验错误、历史与恢复。SHOT_CONTRACT 分镜区 SHALL 只读展示镜头列表（sequence、时长、景别/机位/运机摘要、台词、连续性模式与状态徽标）、单镜头全字段详情、整集时长汇总，并提供生成与确认入口；MUST NOT 提供编辑、拆分、合并、排序或删除入口。异步命令 MUST 在 1 秒内显示已接收或运行反馈；dirty 编辑离开时 MUST 提供保存、放弃、取消，页面切换不得取消持久化 Job。

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

#### Scenario: 分镜区只读展示与集合校验错误

- **GIVEN** 分镜 Job 以集合校验失败终态结束
- **WHEN** 用户进入分镜区
- **THEN** 界面 SHALL 展示脱敏的失败层与有界明细，不展示模型原始输出
- **THEN** 分镜区 MUST NOT 出现任何编辑、拆分或删除控件
