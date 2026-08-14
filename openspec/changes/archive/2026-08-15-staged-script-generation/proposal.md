## Why

镜序 Studio 已具备 Project、离线 Schema Registry、JobRunner、Qwen/Mock Adapter 与安全凭据基座，但尚未把这些能力接成用户可操作的 AI 剧本流程：当前 Job 写命令只能安全返回 `JOB_SUBMISSION_UNAVAILABLE`。依据 PRD v1.4 §9.1–§9.4、§15.1 与 TECH_DESIGN v1.1 §5、§6、§9、Sprint 4，本 Change 要先交付 AI 原创的五阶段生成闭环，使用户可以从原始创意得到可编辑、可确认、可恢复且可追溯的场景剧本。

## What Changes

- 新增 AI 原创初始化：原样保存 20–2,000 字符 SourceInput、DATA_PROCESSING Consent 与单 Episode；不静默裁剪，提交前显示 Provider 数据处理边界。
- 新增 CONCEPT、STORY_BIBLE、EPISODE_OUTLINE、BEAT_SHEET、SCENE_SCRIPT 五阶段生成、阶段依赖、版本历史、全文编辑、确认、恢复和下游 `STALE_INPUT` 传播。
- AI 与人工结果先创建不可变 DRAFT；用户确认时以相同内容创建新的 READY 版本，下一阶段只读取 READY 上游。
- 新增版本化 Prompt、`ModelScriptStageCandidate` 内部契约与 ScriptStageOutput 正式校验；模型只生成 `data`，系统注入 ID、阶段和 Invocation 元数据。
- 将现有 JobRunner 的 submission、commit、调度与恢复重校验 seam 接到真实 Script Repository/UnitOfWork；Provider 调用保持事务外，版本、阶段头、依赖、审计和 Job 终态短事务原子提交。
- 新增冻结的 `window.jingxu.script` 逐方法 IPC，并调整 `job.create` 的阶段生成 DTO；增加原创输入、Provider 设置、五阶段工作区、Job 状态、编辑、确认、历史和恢复 UI。
- 同步 README 的 Active Change、已实现能力与未实现边界；补齐 Unit、Contract、Integration、Electron E2E 和 Windows x64 packaged smoke。
- 明确不实现授权改编、AI 优化、TXT/Markdown 导入、选区改写、字段锁、ShotContract/分镜、导入导出、评测和任何图片/视频/TTS/口型能力。

## Capabilities

### New Capabilities

- `staged-script-generation`: AI 原创初始化、五阶段版本工作流、阶段生成/确认/编辑/恢复、依赖失效传播、剧本工作区及其安全 IPC。

### Modified Capabilities

- `jobrunner-qwen-text-adapter`: 用真实阶段 submission/commit/recovery seam 替换 Job 写命令的安全不可用降级，并冻结完整输入版本集合。
- `desktop-workspace-foundation`: READY 后才激活 Script 写服务、Job 调度和恢复；Preload 增加冻结的 `script` 命名空间且保持 Renderer 权限隔离。

## Impact

- **产品/验收**：直接覆盖 PRD v1.4 V1-IN-001/002/004、V1-SCR-001/004 与五阶段主流程；AC-V1-01 仅形成 Mock 可重复的剧本闭环，不宣称分镜或真实用户验收完成。授权改编 V1-IN-003、局部改写 V1-SCR-002、字段锁 V1-SCR-003 留给后续独立 Change。
- **Schema**：四份 PRD-owned Schema 字节不变；正式结果使用 ScriptStageOutput 1.0.0，新增的 ModelScriptStageCandidate 与 Prompt manifest 属于 TECH-internal 契约。
- **数据库**：复用 `0001_initial.sql` 的业务表且不得改写 0001/0002；新增 `0003_script_version_receipts.sql`，为 `episode_id IS NULL` 的项目级 ScriptVersion 补 partial unique，并将通用 command_receipts 安全扩展到四个 Script 写命令，保留全部旧 Project 回执。
- **IPC/兼容性**：增加 `script.initializeOriginal/getWorkspace/saveDraft/confirmVersion/restoreVersion`；`job.create` 处于尚未对外发布的开发期，允许以 strict DTO 增加 episode、operation 与 expected input 字段，但必须同步 Main、Preload、Renderer、Contract 和 E2E。
- **进程/安全**：Qwen 仍只在 Main Adapter 内访问受限 HTTPS；API Key 继续由 safeStorage 保存且不回流 Renderer；Prompt、原文和响应不得进入普通日志或诊断白名单。
- **并行实施**：Apply 在公共 Contract/Application Port 冻结后分三线推进：A 线 Persistence/事务，B 线 Application/Prompt/Job，C 线 IPC/Renderer/E2E；共享入口与 Composition Root 由集成线统一修改。
