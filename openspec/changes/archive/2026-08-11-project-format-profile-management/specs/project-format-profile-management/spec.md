## Purpose

为镜序 Studio V1 提供本地 Project 与版本化 FormatProfile 的可观察管理契约，使用户能在安全启动门之后创建、查看、修改、软删除和恢复项目，并为后续剧本与分镜流程获得唯一、可追溯的当前画面规格。

## ADDED Requirements

### Requirement: 项目查询必须稳定且区分活动与已删除状态

系统 MUST 提供稳定排序、有限分页的项目列表和单项目详情；默认列表只返回未删除项目，显式请求回收站时才返回软删除项目。可选名称搜索 SHALL 在请求 scope 内按规范化名称有界匹配，当候选超过内部扫描上限时 MUST 返回显式截断标志而非静默完整。详情 SHALL 包含 Project 字段、唯一 current FormatProfile 及其版本号，不得向 Renderer 暴露数据库路径、SQL 或内部连接对象。

#### Scenario: 新安装项目列表为空

- **GIVEN** 启动自检已进入 `READY` 且数据库中没有活动项目
- **WHEN** 用户打开项目列表
- **THEN** 系统 SHALL 返回可区分于筛选无结果的真实空状态
- **THEN** 页面 SHALL 只提供“创建第一个项目”这一主操作

#### Scenario: 活动项目按稳定游标分页

- **GIVEN** 数据库中存在多条活动项目且部分项目具有相同更新时间
- **WHEN** Renderer 使用有限 `limit` 和不透明 cursor 请求项目列表
- **THEN** 系统 SHALL 按 `updated_at DESC, id DESC` 稳定排序并返回下一页 cursor
- **THEN** 同一快照中的项目 MUST NOT 因同时间戳而重复或遗漏

#### Scenario: 默认列表排除已删除项目

- **GIVEN** 一个项目已被软删除
- **WHEN** 用户请求默认项目列表或该活动项目详情
- **THEN** 默认列表 MUST NOT 返回该项目
- **THEN** 活动详情查询 SHALL 返回稳定的 `PROJECT_NOT_FOUND`，回收站查询仍可找到该项目

#### Scenario: 名称搜索返回匹配的活动项目

- **GIVEN** 数据库中存在多条活动项目，且其中部分名称包含同一子串的 Unicode 大小写或 NFC 等价形式
- **WHEN** Renderer 在 `ACTIVE` scope 下提交有限 `limit`、不透明 cursor 和搜索文本
- **THEN** 系统 SHALL 按规范化名称匹配返回包含该文本的活动项目，并保持 `updated_at DESC, id DESC` 稳定排序
- **THEN** 软删除项目 MUST NOT 出现在活动搜索结果中

#### Scenario: 名称搜索达到有界扫描上限

- **GIVEN** 活动项目数量超过 Repository 的内部扫描硬上限，且搜索文本匹配其中一部分
- **WHEN** Renderer 请求名称搜索
- **THEN** 系统 SHALL 返回已扫描到的匹配项并附带显式「结果已截断」标志
- **THEN** 系统 MUST NOT 静默丢弃该标志、伪造完整结果或为匹配而读取无界数据

### Requirement: 创建项目必须原子保存 Project 与首个 FormatProfile

系统 MUST 在单一短事务中创建 Project、版本号为 1 的唯一 current FormatProfile、审计事件和必要本地事件；任一数据库写入失败时不得留下部分记录。创建前 SHALL 验证受管理项目目录可用，Renderer 不得提交或选择数据库内部数据路径。

#### Scenario: 使用 V1 默认值创建项目

- **GIVEN** 用户填写合法名称并选择 `AI_ORIGINAL`，未覆盖画幅或 DialogueRenderMode
- **WHEN** 用户提交创建命令
- **THEN** 系统 SHALL 创建 `LOCAL_DEMO` Project，默认 DialogueRenderMode 为 `NARRATION_FIRST`
- **THEN** 系统 SHALL 同时创建 `9:16`、1080×1920、30fps、`zh-CN` 的 current FormatProfile
- **THEN** 默认字幕安全区 SHALL 为 top 5%、right 5%、bottom 12%、left 5%

#### Scenario: 创建横屏项目

- **GIVEN** 用户选择 `16:9` 画幅和任一合法 DialogueRenderMode
- **WHEN** 用户提交合法创建命令
- **THEN** 系统 SHALL 原子保存 1920×1080、30fps、`zh-CN` 的首个 FormatProfile
- **THEN** Project SHALL 保存用户选择的项目级 DialogueRenderMode

#### Scenario: 项目字段非法或名称冲突

- **GIVEN** 项目名称为空、超过 100 个 Unicode 字符、包含首尾空白，或与活动项目规范化名称冲突
- **WHEN** 用户提交创建命令
- **THEN** 系统 MUST 拒绝创建并返回字段级错误或 `PROJECT_NAME_CONFLICT`
- **THEN** 页面 SHALL 保留用户已填内容且数据库 MUST NOT 出现 Project 或 FormatProfile 部分记录

#### Scenario: 项目目录不可用

- **GIVEN** Main 派生的受管理项目目录无法创建或写入探测失败
- **WHEN** 用户提交创建命令
- **THEN** 系统 MUST 返回脱敏的 `PROJECT_DIRECTORY_UNAVAILABLE`
- **THEN** 数据库 MUST NOT 创建 Project、FormatProfile、成功审计或成功事件

#### Scenario: 创建事务中途失败

- **GIVEN** Project 已准备写入但 FormatProfile、审计或本地事件写入被确定性故障点拒绝
- **WHEN** 创建事务执行
- **THEN** 系统 MUST 回滚本次全部数据库写入并返回安全错误
- **THEN** 重试相同 requestId MUST NOT 观察到半个项目

### Requirement: V1 FormatProfile 必须遵守正式规格边界

系统 MUST 只接受 `9:16` 或 `16:9` 的 V1 FormatProfile；宽高 SHALL 由画幅确定，fps MUST 固定为 30，language MUST 固定为 `zh-CN`，字幕安全区四个百分比 MUST 分别位于 0 至 30。系统不得在本 Change 中接受 `1:1`、任意分辨率、任意帧率或 `target_platform`。

#### Scenario: FormatProfile 与画幅不匹配

- **GIVEN** 命令声称画幅为 `9:16` 但提交 1920×1080，或尝试覆盖 fps/language
- **WHEN** Main 校验 DTO 和领域值
- **THEN** 系统 MUST 拒绝命令并返回对应字段错误
- **THEN** 系统 MUST NOT 依赖数据库较宽 CHECK 来放行超出 PRD v1.4 的值

#### Scenario: 字幕安全区达到边界

- **GIVEN** 四个字幕安全区百分比分别采用 0 或 30 的合法边界值
- **WHEN** 用户保存 FormatProfile
- **THEN** 系统 SHALL 接受并原样保存这些值

#### Scenario: 字幕安全区越界

- **GIVEN** 任一字幕安全区百分比小于 0、大于 30、非有限数或缺失
- **WHEN** 用户保存 FormatProfile
- **THEN** 系统 MUST 返回字段级错误且不得创建新 FormatProfile 版本

### Requirement: 项目更新必须使用乐观并发并保留 FormatProfile 版本链

系统 MUST 使用 `expectedUpdatedAt` 检测 Project 陈旧写入；项目元数据更新 SHALL 更新聚合行，FormatProfile 内容变化 SHALL 插入父版本指向当前版的新版本并在同一事务切换唯一 current。未变化的 FormatProfile 不得制造空版本。

#### Scenario: 只更新项目元数据

- **GIVEN** 用户读取了当前 Project 和 FormatProfile
- **WHEN** 用户仅修改 name、genre、style、creation_mode 或 DialogueRenderMode 并携带当前 `expectedUpdatedAt`
- **THEN** 系统 SHALL 更新 Project、审计变更且保留原 FormatProfile current
- **THEN** Project 的 `updated_at` SHALL 单调前进

#### Scenario: 更新当前画幅生成新版本

- **GIVEN** 项目当前 FormatProfile 为版本 1 且不存在下游 ShotContractVersion
- **WHEN** 用户把画幅改为 `16:9` 并携带当前 `expectedUpdatedAt`
- **THEN** 系统 SHALL 插入版本 2、令其 `parent_id` 指向版本 1 并成为唯一 current
- **THEN** 版本 1 的规格内容 MUST 保持可追溯且不得被覆盖

#### Scenario: 无实际变化不创建版本

- **GIVEN** 更新命令中的 FormatProfile 与 current 版本语义完全相同
- **WHEN** 用户提交项目更新
- **THEN** 系统 SHALL 不创建新的 FormatProfile 版本
- **THEN** 如果其他 Project 字段也未变化，系统 SHALL 返回当前状态而不写成功变更事件

#### Scenario: 陈旧更新被拒绝

- **GIVEN** 用户提交的 `expectedUpdatedAt` 已落后于数据库当前值
- **WHEN** 用户更新项目或 FormatProfile
- **THEN** 系统 MUST 返回 `PROJECT_VERSION_CONFLICT` 和当前安全版本摘要
- **THEN** 系统 MUST NOT 合并陈旧字段或产生部分新版本

#### Scenario: 已存在下游分镜依赖时修改 FormatProfile

- **GIVEN** current FormatProfile 已被任一 ShotContractVersion 引用，且当前 Change 尚未提供下游 STALE_INPUT 传播器
- **WHEN** 用户尝试修改 FormatProfile 内容
- **THEN** 系统 MUST 以 `FORMAT_PROFILE_DEPENDENCY_BLOCKED` 拒绝更新并说明需等待依赖处理能力
- **THEN** Project、FormatProfile 和下游版本 MUST 保持不变

### Requirement: 项目删除与恢复必须可审计且不静默删除文件

系统 MUST 将普通删除实现为 Project 聚合软删除，并 SHALL 在用户二次确认后记录影响范围；本 Change MUST NOT 删除项目目录、导出或子对象。恢复 SHALL 清除 `deleted_at`，并在名称仍可用且并发版本匹配时重新出现在活动列表。

#### Scenario: 用户确认软删除项目

- **GIVEN** 活动项目存在且用户已查看数据库记录、项目文件和 Provider 侧数据边界说明
- **WHEN** 用户二次确认删除并提交当前 `expectedUpdatedAt`
- **THEN** 系统 SHALL 原子设置 `deleted_at`、更新时间并记录审计
- **THEN** 系统 MUST NOT 删除项目目录、导出文件或 Provider 侧数据

#### Scenario: 用户取消删除

- **GIVEN** 删除确认框已显示
- **WHEN** 用户选择取消
- **THEN** 系统 MUST NOT 调用删除 Command
- **THEN** Project、FormatProfile 和文件状态 SHALL 保持不变

#### Scenario: 恢复软删除项目

- **GIVEN** 项目处于软删除状态且活动项目中没有同规范化名称
- **WHEN** 用户提交 restore Command 和当前 `expectedUpdatedAt`
- **THEN** 系统 SHALL 清除 `deleted_at`、记录恢复审计并使项目重新出现在活动列表

#### Scenario: 恢复时名称发生冲突

- **GIVEN** 软删除后已有另一个活动项目占用同一规范化名称
- **WHEN** 用户尝试恢复原项目
- **THEN** 系统 MUST 返回 `PROJECT_NAME_CONFLICT`
- **THEN** 原项目 MUST 保持软删除且不得自动改名

### Requirement: Project Command 必须幂等且提交证据一致

每个 Project Command MUST 携带 `requestId`，相同 requestId 与相同规范化载荷的重试 SHALL 返回第一次已提交结果；相同 requestId 携带不同载荷 MUST 返回 `REQUEST_ID_REUSED`。业务结果、审计和本地事件 SHALL 在同一事务提交，不得把失败写成成功。

#### Scenario: 创建响应丢失后重试

- **GIVEN** 创建事务已成功提交但 Renderer 未收到响应
- **WHEN** Renderer 使用相同 requestId 和相同载荷重试
- **THEN** 系统 SHALL 返回原 Project 与 FormatProfile 标识
- **THEN** 数据库 MUST 仍只有一个 Project、一个首版 FormatProfile 和一组成功证据

#### Scenario: requestId 被不同载荷复用

- **GIVEN** 一个 requestId 已绑定已提交或正在处理的规范化命令载荷
- **WHEN** 调用方使用同一 requestId 提交不同项目字段
- **THEN** 系统 MUST 返回 `REQUEST_ID_REUSED`
- **THEN** 系统 MUST NOT 执行第二个业务写入

#### Scenario: 更新失败不产生成功事件

- **GIVEN** Project 更新因字段、并发、依赖或持久化错误失败
- **WHEN** 事务回滚
- **THEN** 系统 MUST NOT 写入成功审计、`project_created` 或 `dialogue_mode_selected` 事件

### Requirement: Project IPC 必须是类型化白名单并服从启动写入门

系统 SHALL 仅通过 `project.list/get/create/update/delete/restore` 六个逐方法 IPC 暴露项目能力；每次调用 MUST 校验 sender、Zod DTO、项目 ID 和命令状态。系统不在 `READY` 时所有 Project Command MUST 被启动写入门拒绝，Query 只能返回启动边界允许的安全结果。

#### Scenario: 合法 Renderer 创建项目

- **GIVEN** 调用来自当前受信 Renderer、启动状态为 `READY` 且 DTO 合法
- **WHEN** Renderer 调用 `project.create`
- **THEN** Main SHALL 调用注入的 Application Service 并返回类型化结果
- **THEN** Preload MUST NOT 暴露通用 `send`、`on` 或 `invoke`

#### Scenario: 非法 sender 或 DTO

- **GIVEN** 调用来自非当前受信 frame，或 DTO 包含未知字段、路径、SQL、超限字符串或非法枚举
- **WHEN** Main 接收任一 Project IPC
- **THEN** 系统 MUST 在进入 Application Service 前拒绝调用
- **THEN** 返回错误 MUST NOT 包含 SQL、堆栈、绝对路径或内部对象

#### Scenario: 只读故障状态尝试写入

- **GIVEN** 启动状态不是 `READY`
- **WHEN** Renderer 尝试创建、更新、删除或恢复项目
- **THEN** 系统 MUST 返回稳定的写入门错误并保持数据库不变
- **THEN** Renderer MUST NOT 通过隐藏入口或直接基础设施访问绕过该门

### Requirement: 项目页面必须覆盖完整交互状态并保护未提交编辑

项目列表与创作设定页面 SHALL 覆盖加载、运行、真实空、筛选无结果、字段错误、持久化失败、成功、软删除和恢复状态；所有异步命令 MUST 在 1 秒内显示已接收或运行反馈。未提交表单 SHALL 进入 dirty 状态，离开时必须提供保存并离开、放弃修改、取消三种选择。

#### Scenario: 保存成功以后端提交为准

- **GIVEN** 用户提交合法项目表单
- **WHEN** Renderer 已乐观更新但 Main 事务尚未返回成功
- **THEN** 页面 MUST 保持保存中而不得显示已保存
- **THEN** 只有类型化成功结果到达后才 SHALL 清除 dirty 状态并刷新项目列表

#### Scenario: 保存失败保留输入

- **GIVEN** 用户填写了项目表单且 Main 返回字段、冲突、目录或持久化错误
- **WHEN** 页面展示错误
- **THEN** 页面 SHALL 保留全部未提交输入并定位可修正字段
- **THEN** 页面 MUST NOT 伪造项目卡片或清除 dirty 状态

#### Scenario: dirty 表单离开

- **GIVEN** 创作设定存在未提交修改
- **WHEN** 用户切换项目、刷新、关闭窗口或离开页面
- **THEN** 系统 SHALL 提供“保存并离开 / 放弃修改 / 取消”
- **THEN** 保存失败时 SHALL 留在当前页面，放弃时恢复最后提交状态，取消时保持编辑内容

#### Scenario: 后续能力尚未实现

- **GIVEN** Project 与 FormatProfile 已成功创建但 Schema Registry、剧本或分镜能力尚未 Apply
- **WHEN** 用户查看项目详情
- **THEN** 对应操作 SHALL 保持可见、禁用并说明缺少的前置能力
- **THEN** 页面 MUST NOT 显示伪造 StoryBible、剧本、ShotContract 或 Provider 结果
