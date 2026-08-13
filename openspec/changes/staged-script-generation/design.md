## Context

See `proposal.md - Why`. 当前生产 Composition Root 在 READY 后注册 Provider 与类型化 Job Host，但注入的是 `UNAVAILABLE_SUBMISSION/UNAVAILABLE_RUNNER`；JobRunner 的 `JobCommitHandler` 只能看到 Job/Invocation Repository，无法在同一事务写 Script 版本。`0001_initial.sql` 已包含本 Change 所需业务表、阶段头唯一索引和版本不可变触发器，公开 Schema Registry 已锁定且只发布四份 PRD-owned Schema。Renderer 目前只有 Project 工作区，Provider/Job IPC 已存在但没有用户页面。

本设计遵守 PRD v1.4 §9.1–§9.4、§15.1，TECH_DESIGN v1.1 §5、§6、§9、§16–§20，以及已同步的 `jobrunner-qwen-text-adapter` 和 `desktop-workspace-foundation` 主规范。

## Goals / Non-Goals

**Goals:**

- 用 AI 原创 SourceInput 打通五阶段 Mock/真实 Qwen 共用的生产路径。
- 保持 Provider 事务外、版本与 Job 终态同一短事务、历史版本不可变。
- 冻结由服务端推导的完整输入版本集合，支持确认、全文编辑、恢复和下游失效传播。
- 在既有安全 Preload/IPC 与启动门内增加可演示的剧本工作区。
- 让 Apply 可在公共接口冻结后按三线并行开发并独立验证。

**Non-Goals:**

- 不实现授权改编、AI 优化、文件导入、选区操作、锁或局部 write_set；`operation_type` 只开放 GENERATE。
- 不实现 SHOT_CONTRACT、EpisodeVersion/镜头集合、可生产性、导入导出、评测或 V2/V3 能力。
- 不修改四份 PRD-owned Schema，不把内部 Candidate Schema 注册成第五份公开 Schema。
- 不用真实 Qwen 调用作为自动化或归档门禁。

## Decisions

### 1. 复用 0001 业务表并新增最小 0003 migration

`0001_initial.sql` 已包含业务表、`ux_stage_heads_*` 和不可变触发器，但存在两个已证实结构缺口，故新增不可变 `0003_script_version_receipts.sql`，不得改写 0001/0002：

1. SQLite UNIQUE 对 NULL 不冲突，现有 `UNIQUE(project_id, episode_id, stage, version_no)` 无法约束项目级 CONCEPT；新增 `ux_script_versions_project_level(project_id, stage, version_no) WHERE episode_id IS NULL`。
2. `command_receipts.command_name` CHECK 只允许四个 Project 命令；0003 以 SQLite 安全重建表流程扩展到 INITIALIZE_ORIGINAL、SAVE_SCRIPT_DRAFT、CONFIRM_SCRIPT_VERSION、RESTORE_SCRIPT_VERSION，完整复制并对账旧行、恢复 PK/FK/CHECK/index。回执仍只保存 requestId、payload hash、安全结果引用、traceId 和时间，不保存原文或文档。

项目级/集级阶段 scope、父链同聚合、stage_head 多态指针继续由 Repository/Application 与 invariant audit 校验，不预建复杂触发器。

被否决方案：新增第二张 Script receipt 表或给所有版本表添加 current 指针。前者会拆分通用 requestId 事实源，后者会与 stage_heads 竞争；两者都增加不必要兼容负担。

### 2. ScriptJobUnitOfWork 扩展现有 Job 事务，而不是嵌套事务

Application 新增 Source/Consent/Episode/Version/StageHead/Dependency/Audit Ports，并定义 `ScriptJobRepositories extends JobRepositories`。JobRunner/JobCommitHandler 调整为带 Repository 泛型，使 Script commit handler 在现有最终 `unitOfWork.run` 内写版本、阶段头、依赖、审计和 Job→SUCCEEDED；SQLite 只开启一次 BEGIN IMMEDIATE。普通 JobRunner 测试仍使用默认 JobRepositories，保持现有 Adapter 兼容。

PersistenceRuntime 在 READY 后从唯一写连接提供 ScriptJobUnitOfWork 和只读 Script 查询 Repository；关闭或启动失败时清空引用。所有 Project/Schema/Job/Provider/Script UoW 必须复用 runtime 级单一异步 transaction coordinator，不能各自维护会在同一连接上交叉 BEGIN 的 private tail。Repository 使用显式列、参数绑定、有界历史查询和边界错误归一化，不泄漏 Row/连接。

被否决方案：commit handler 内调用独立 Script UoW。它会让业务版本提交和 Job 终态分裂，违反 TECH_DESIGN v1.1 §5.2。

### 3. 初始化与阶段版本语义

`initializeOriginal` 单事务写 CREATIVE SourceInput、DATA_PROCESSING Consent、Episode、审计和 command receipt；字符数按 JavaScript Unicode code points（`Array.from` 等价语义）计算，保存前不 trim，hash 使用原始 UTF-8 字节。

AI、人工全文保存和恢复都创建 DRAFT。确认创建内容相同的 READY 子版本并更新 stage_head；不 UPDATE DRAFT 状态。项目级 CONCEPT/STORY_BIBLE 使用 episode_id=null，集级阶段绑定唯一 Episode。恢复版本的 parent 指向恢复前当前版本，audit metadata 记录 restored_from_version_id，避免把历史选中版本误作父链当前。

StoryBible 写 story_bible_versions；其他四阶段写 script_versions。StageHead 是唯一 current 事实源，读取时同时校验 version type、项目、Episode、stage 和 JSON 内元数据一致。

### 4. 输入版本集合由 ScriptService 推导和冻结

`job.create` strict DTO 改为 `{projectId, episodeId, stage, operationType:'GENERATE', expectedInputVersionId, idempotencyKey, requestId}`。expectedInputVersionId 是阶段的主前置：CONCEPT 为 source_input_id，STORY_BIBLE 为 CONCEPT READY，OUTLINE 为 STORY_BIBLE READY，BEAT 为 OUTLINE READY，SCENE 为 BEAT READY。ScriptService 在同一短事务读取其余必需 READY 头并生成规范排序的 `input_versions_json` 与 SHA-256；客户端不能传完整集合。

固定依赖：CONCEPT=SourceInput+当前 FormatProfile；STORY_BIBLE=CONCEPT；OUTLINE=CONCEPT+STORY_BIBLE+Episode；BEAT=OUTLINE+STORY_BIBLE；SCENE=BEAT+STORY_BIBLE+FormatProfile.dialogueRenderMode。任一头不是 READY、归属不匹配或 expected 过期即在建 Job 前失败。

### 5. Candidate、Prompt 与正式 Schema 分层

新增 `packages/prompts`，每个阶段提供不可变 `<stage>/v1` 模板、manifest/hash 和纯 `buildPrompt`；模板把用户内容置于数据分隔区，列出显式输入版本、write_set（本 Change 为阶段 data 根）和目标 Candidate Schema ID，不包含 API Key。

`ModelScriptStageCandidate` 为 TECH-internal Draft 2020-12 Schema，固定只允许 `{data}` 并按五阶段约束 data；它在 Validation 内独立编译，不加入公开四 Schema Registry、Forge `resources/schemas/v1` 或 manifest。每阶段提供 valid 与 single-error invalid Fixture。系统注入正式元数据后，通过已发布的 ScriptStageOutput 1.0.0；人工全文保存同样必须通过正式 Schema。

结构修复只接收原响应、脱敏 issue 和 Candidate Schema 摘要；重新生成 invocation_id 和系统字段。正式 Schema、输入复检或 stage ownership 失败不可修复。

### 6. DRAFT 确认与 STALE_INPUT 传播在一个事务

确认先验证 expected head=DRAFT，再创建 READY 子版本。若替换了旧 READY，按固定 DAG 查询所有已有下游当前版本，为每个下游复制业务文档并创建 STALE_INPUT、source=SYSTEM_INVALIDATION 的新版本，parent 指向原当前版；更新 stage_heads、写 dependency_edges 和审计。不得自动生成下游。

依赖顺序为 CONCEPT→STORY_BIBLE/OUTLINE/BEAT/SCENE，STORY_BIBLE→OUTLINE/BEAT/SCENE，OUTLINE→BEAT/SCENE，BEAT→SCENE。去重后按固定 stage 顺序写入，任何插入或审计失败整体回滚。首次确认或没有下游时只写 READY 与直接依赖。

### 7. Main 调度、恢复与事件

READY 后 Composition Root 构造 ScriptService、真实 JobSubmissionPort、泛型 Script JobRunner、序列化 scheduler 与恢复 revalidate handler，再一次性替换 unavailable seam。scheduler 使用单进程 singleflight drain：新建/重试 Job 后 kick，循环通过现有全局并发门领取；不在事务中等待模型。启动恢复先执行 recoverPendingJobs，再 kick QUEUED；完整响应走相同 Candidate/正式 Schema/输入复检/commit handler，未知结果不调用 Provider。

现有 `events.subscribeJobUpdates` 只返回 subscriptionId，尚无安全的 Main→Renderer 推送通道；本 Change 不把占位订阅伪装成实时事件。Renderer 对非终态 Job 使用固定 1 秒、有页面可见性守卫的 `job.get/list` 有界轮询，终态后停止；断线/刷新后重新查询 SQLite 事实状态。真正推送需后续独立修改公开事件契约。

### 8. IPC 与页面状态

新增 `script` namespace 五方法：initializeOriginal/getWorkspace/saveDraft/confirmVersion/restoreVersion。所有 DTO Zod strict、Command 带 requestId 和 expectedVersionId（初始化无版本但带 requestId），Main 按 sender→DTO→启动门→Application→output DTO 顺序执行；Preload 双端校验并冻结逐方法对象。

Workspace Query 返回 Source/Episode 摘要、五阶段 current、分页受限 history、prerequisite 状态和当前 Job 摘要，不返回 SQL、路径或用户未请求的完整历史。阶段内容使用 ScriptStageOutput DTO；字段错误只返回 JSON Pointer/message code。

现有 Provider API 的凭据保存与 Workspace 配置是两个独立事务，本 Change 的 UI 必须呈现两个明确动作和各自结果：先保存/测试凭据，再保存 Workspace 配置；任一步失败不得显示“Provider 设置整体成功”。不新增跨 safeStorage 文件与 SQLite 的伪原子命令。默认 `workspaceId='jingxu'` 只表示未配置占位，未由用户保存并通过凭据测试前不得开始阶段 Job。

Renderer 在 ProjectDetail 中启用“剧本生成”，路由到原创初始化/Provider 设置/五阶段编辑器；React Query 持有服务端事实，React Hook Form+Zustand 只持有草稿和离开对话框。状态覆盖 loading/empty/running/error/success/dirty/read-only；分镜入口继续可见禁用。

### 9. 稳定错误码

复用 STARTUP_WRITE_BLOCKED、STALE_INPUT、Provider/Job 错误；新增并集中注册：SCRIPT_INPUT_LENGTH_INVALID、SCRIPT_INPUT_CONSENT_REQUIRED、SCRIPT_WORKSPACE_NOT_INITIALIZED、SCRIPT_STAGE_PREREQUISITE_MISSING、SCRIPT_STAGE_NOT_READY、SCRIPT_VERSION_NOT_FOUND、SCRIPT_VERSION_CONFLICT、SCRIPT_SCHEMA_INVALID、SCRIPT_STAGE_UNSUPPORTED。AppError 继续零路径/SQL/Key/原响应泄漏。

### 10. 三线并行与文件所有权

先由集成线冻结 Contracts、Application Ports、错误码、ScriptJobRepositories 泛型和测试 Fixture 类型，形成接口 checkpoint 后再并行：

- **A Persistence 线**：只修改 `packages/persistence/src/script/**`、runtime 的 Script getter 和 Integration tests；实现 Repository/UoW/事务故障矩阵。
- **B Application/AI 线**：只修改 `packages/application/src/script/**`、`packages/prompts/**`、Validation internal candidate、JobRunner 泛型与 Unit/Contract tests；实现服务、Prompt、Candidate、commit/recovery/scheduler ports。
- **C Desktop/UI 线**：只修改 Contracts 的已冻结实现消费面、Main Script IPC、Preload、Renderer 与 E2E；在 A/B 接口冻结前使用严格 Fake，不自行改变 Ports。

共享 `index.ts`、package/tsconfig、Composition Root、README、Forge 与 packaged smoke 由主集成线统一修改。任何线不得改四份根 Schema、0001/0002 或其他线文件。每条线在交付 checkpoint 前运行 scoped format/lint/typecheck/tests，主线汇合后跑全量门禁。

## Risks / Trade-offs

- [单 Change 跨层较大] → 先冻结公共接口，三线按目录所有权并行，每个检查点独立提交；Composition/E2E 最后串行汇合。
- [DRAFT→READY 复制增加版本数] → 保留清晰不可变语义，历史查询使用 keyset/limit；不以 UPDATE 状态换取少一行。
- [StageHead 无目标表 FK] → Repository 所有权检查、启动 invariant audit 和故障测试共同约束；不增加多态 FK 伪实现。
- [上游失效传播写入多行] → V1 固定五阶段且每阶段一个 current，事务规模有界；固定顺序去重并覆盖各故障点回滚。
- [Prompt/模型快照漂移] → Prompt/hash 随包锁定；Qwen 真实验收前核对官方快照，冲突时停止真实接线而非改用别名；Mock 不受阻。
- [事件丢失] → SQLite/Job Query 是事实源，事件仅触发缓存失效；刷新不取消 Job。
- [Provider 两步配置部分成功] → 凭据和 Workspace 分步操作、分步反馈；阶段生成同时要求非占位 Workspace、已配置凭据和 enabled profile，不能把部分成功当可用。
- [用户内容泄漏] → 普通日志只记 ID/hash/状态/Token；Contract、E2E 和 packaged smoke 扫描 API Key、Prompt、原文与响应泄漏。

## Migration Plan

1. fast-forward 已归档 JobRunner 基线到 main，从 `codex/staged-script-generation` 实施。
2. 先提交 0003：验证空库、v2 库、100+版本库、旧回执逐行对账、checksum、升级前备份和失败回滚；打包产物必须包含 0001–0003。
3. 依次合入公共接口、A/B/C 三线、Composition 和 UI；未完成组装时保留既有 JOB_SUBMISSION_UNAVAILABLE，不能形成半可用入口。
4. 完成 Mock E2E、clean Windows x64 package 和 packaged smoke 后 Verify；真实 Qwen testCredential 只记录人工结果。
5. 回滚到前一提交时，未增加 migration 则旧应用可忽略未使用业务表中的新数据；若新增 0003，不做降级写入，保留备份并用前版只读打开策略处理。

## Open Questions

无。授权改编/AI 优化、局部锁定/改写和 ShotContract 已作为后续 Change 明确延期，不影响本 Change 的接口与任务拆分。
