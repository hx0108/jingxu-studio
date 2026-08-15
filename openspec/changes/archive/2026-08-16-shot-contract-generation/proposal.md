## Why

`staged-script-generation` 已于 2026-08-15 归档：五阶段剧本链路（CONCEPT→SCENE_SCRIPT）经真实 Qwen 全流程联调闭环。但 V1 目标「AI 剧本与结构化分镜」的另一半尚未接入——`SHOT_CONTRACT` 在 stage 枚举、`stage_heads`/`script_stage_jobs` 的 CHECK 约束中保留，`0001_initial.sql` 的分镜表结构（shots / shot_contract_versions / episode_versions / episode_version_shots）已就位但无任何业务方法，ShotContract 1.1.0 与 EpisodeStoryboardExport 1.1.0 两份 PRD-owned Schema 仅在 Registry 离线编译、未被业务调用。依据 PRD v1.4 分镜相关条目与 TECH_DESIGN v1.1 §6，本 Change 把 READY 场景剧本转换为可审阅、可确认的逐镜头契约集合，使分镜成为第六个真实生成阶段。

## What Changes

- 新增 SHOT_CONTRACT 阶段生成：以 READY 的 SCENE_SCRIPT（直接上游）、STORY_BIBLE（角色/场景 ID 来源）、EPISODE_OUTLINE（整集时长目标）与 FormatProfile 为冻结输入，一次 `GENERATE` Job 为整集生成结构化分镜集合：一个 episode_version + 逐镜头 shot_contract_versions + episode_version_shots 关联，`shot_set_hash` 锁定集合。
- 模型只生成镜头创意字段（narrative_purpose / cinematography / content / dialogue / continuity / generation_constraints / acceptance）；shot_id、版本 id、contract_version、sequence（按数组顺序注入）、provenance、format_profile_id、status 等系统字段由系统注入，沿用五阶段候选契约模式（JSON_PARSE→…→COLLECTION→PRE_COMMIT，最多一次结构修复）。
- COLLECTION / PRE_COMMIT 层首次承载真实集合校验：接入 EpisodeValidator 集合规则——sequence 连续且唯一、`continuity.previous_shot_id` 引用集合内镜头、`character_ids`/`scene_id` 引用 READY 上游 ID、逐镜头与整集时长预算（镜头 1–20s、整集 30–180s）；失败明细走既有 bounded details 通道。
- 沿用 DRAFT→READY 版本语义：生成结果先落不可变 DRAFT 镜头版本与剧集分镜版本，用户确认时创建 READY 版本；上游剧本变更将 episode_version 与关联镜头版本传播为 STALE_INPUT。
- V1 边界内固定：`budget_estimate` 恒为 UNKNOWN 变体（无价格供给，可制片性评测属后续 Change）；`locked_paths` 恒 `[]` 与 `continuity.asset_version_ids` 恒 `[]`（字段锁与资产版本属后续 Change）。
- 复用既有冻结 IPC：`job.create` 放行 `stage=SHOT_CONTRACT`，`script.getWorkspace/confirmVersion/restoreVersion` 以 stage 区分分镜路径，零新增命令（回执命令复用，无 command_receipts 迁移）；Renderer 新增分镜工作区：镜头列表与详情只读展示、确认、STALE 状态展示。
- 同步 README 已实现/未实现边界；补齐 Unit、Contract、Integration、Electron E2E 与 Windows x64 packaged smoke。
- 明确不实现：分镜编辑、拆分、合并、复制、排序、软删除与恢复（`shot_derivations` 表保留不接线）、字段锁、EpisodeStoryboardExport 导入导出、评测标注，以及任何图片/视频/TTS/口型生成能力。

## Capabilities

### New Capabilities

- `shot-contract-generation`: 整集分镜生成、集合校验、DRAFT/READY/STALE_INPUT 版本链、分镜工作区及其安全 IPC。

### Modified Capabilities

- `staged-script-generation`: 阶段依赖图与 STALE_INPUT 传播纳入 SHOT_CONTRACT；stage_heads 以 EPISODE_VERSION 指针指向当前分镜版本；工作区需求覆盖分镜只读展示。
- `jobrunner-qwen-text-adapter`: 冻结输入版本集合扩展到分镜阶段；最终短事务原子提交覆盖整集分镜集合。

`desktop-workspace-foundation` 无需修改：本 Change 零新增 IPC 方法，冻结逐方法白名单不变。

## Impact

- **产品/验收**：覆盖 PRD v1.4 分镜生成、展示与确认主流程；[AGENTS.md:59](../../../AGENTS.md) 所列分镜编辑能力（编辑/拆分/合并/复制/排序/软删除/恢复）、字段锁 V1-SCR-003、导入导出与评测样本留给后续独立 Change。不宣称任何视觉生成可制片性。
- **Schema**：六份 PRD-owned Schema 字节不变；ShotContract 1.1.0 首次被业务正式消费（已发布 Registry 接入）；新增 ModelShotSetCandidate 与 SHOT_CONTRACT Prompt manifest 属 TECH-internal 契约。
- **数据库**：复用 `0001_initial.sql` 分镜表且不得改写 0001–0007；新增 `0008_prompt_templates_shot_contract.sql` 播种 SHOT_CONTRACT v1 模板（沿 0004/0005 模式），迁移 head 变为 8；回执命令复用，command_receipts 不变。
- **IPC/兼容性**：`script` 白名单新增分镜方法，开发期 strict DTO 变更须同步 Main、Preload、Renderer、Contract 与 E2E。
- **进程/安全**：边界不变——Qwen 仅在 Main Adapter 访问受限 HTTPS；API Key 不回流 Renderer；Prompt、原文与响应不进入普通日志或诊断白名单。
- **并行实施**：公共 Contract/Application Port 冻结后分三线推进：A 线 Persistence/事务，B 线 Prompt/集合校验，C 线 IPC/Renderer/E2E；共享入口与 Composition Root 由集成线统一修改。
