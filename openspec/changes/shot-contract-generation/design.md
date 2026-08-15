# Design — shot-contract-generation

## 0. 背景与现有接缝

五阶段链路（CONCEPT→SCENE_SCRIPT）已归档。`SHOT_CONTRACT` 在代码中是显式保留位，共三处 `SCRIPT_STAGE_UNSUPPORTED` 抛点与本 Change 一一对应：

| 位置                            | 现状                           | 本 Change               |
| ------------------------------- | ------------------------------ | ----------------------- |
| `script-input-freezer.ts:77-79` | SHOT_CONTRACT 不在允许阶段列表 | 冻结分镜上游输入        |
| `script-job-request.ts:26`      | 直接抛错                       | 构造 SHOT_CONTRACT 请求 |
| `script-job-contract.ts:64`     | commit 直接抛错                | 写入分镜版本集合        |

`buildScriptCandidateContract` 的 `validateCollection` 目前是 `() => ({ valid: true })` 占位桩——本 Change 使 COLLECTION 层首次承载真实校验。

数据库与 Schema 全部就位：`0001` 已有 `episode_versions`（`shot_set_hash`、整集 30–180s）、`shots`、`shot_contract_versions`（document_json 与列双向绑定 CHECK、`UNIQUE(shot_id, version_no)`）、`episode_version_shots`、四个版本表全部挂 `BEFORE UPDATE → RAISE(ABORT)` 不可变触发器；`stage_heads`/`script_stage_jobs` 的 CHECK 已含 `SHOT_CONTRACT`。ShotContract 1.1.0 已在离线 Registry 发布（含 11 条 allOf 跨字段规则）。

## 1. D1 产物模型与 Job 粒度

一次 `GENERATE` Job 的 commit 在 JobRunner 最终短事务内写入：

- 1 行 `episode_versions`（`version_no` 递增，`status='DRAFT'`，`story_bible_version_id`=冻结的 READY 故事圣经版本，`format_profile_id`=冻结值，`target_duration_sec`=冻结的 EPISODE_OUTLINE 时长）；
- N 行 `shots`（`lifecycle_status='ACTIVE'`）与 N 行 `shot_contract_versions`（`version_no=1`、`lineage_resolution_status='ROOT'`、`version_status='DRAFT'`）；
- N 行 `episode_version_shots`（`sequence` 1..N，指向对应 shot 版本）。

`shot_set_hash` = 对 `[shot_id, shot_version_id, document_sha256]` 按 `sequence` 排序后做 JSON 序列化的 SHA-256（与既有 `hashDocument` 同源算法）。

**不选按场景分批**：`episode_versions` 本身是整集快照（`story_bible_version_id`、`shot_set_hash` 均为整集级），分批会制造半成品集合与更多中间态。

## 2. D2 候选契约与系统字段注入

模型只返回 `{"data":{"shots":[...]}}`，每个元素**恰好包含创意字段**：`narrative_purpose`、`target_duration_sec`（每镜头节奏属创意决策，1–20 的边界由 FINAL 层 schema 定界）、`cinematography`（7 字段）、`content`（6 字段）、`dialogue.dialogue_render_mode`、`dialogue.speaker_id`、`dialogue.estimated_speech_duration_sec`、`continuity.continuity_mode`、`continuity.first_frame_requirement`、`continuity.last_frame_requirement`（**不含 `continuity.previous_shot_id`**——模型无法得知系统注入的兄弟镜头 id，其输出值一律丢弃，由系统派生）、`generation_constraints.capability_requirements`、`image_prompt`、`video_prompt`、`negative_constraints`、`acceptance.must_include`、`acceptance.must_not_include`。

`CANDIDATE_SCHEMA` 层用 TECH-internal 的 `ModelShotSetCandidate`（手写键存在性校验，沿五阶段约定——validation 包无 zod 依赖）校验上述形状；`SYSTEM_FIELDS` 层逐镜头注入：

- 标识与版本：`schema_version='1.1.0'`、`shot_id`（`shot_` + 新 id）、`version_id`（`scv_..._v1`）、`contract_version=1`、`parent_version_id=null`、`derived_from_shot_ids=[]`、`sequence`（按数组下标 +1）、`status='DRAFT'`；
- 溯源：`provenance={source_type:'AI_GENERATED', source_invocation_id, last_edit_source:'AI'}`；
- 上下文：`format_profile_id`（冻结值）；
- 派生常量：`dialogue.dialogue_mode_source='PROJECT_DEFAULT'`、`override_reason=null`（V1 无项目级口型默认值可偏离）、`audio_required`/`lip_sync_required` 由 `(spoken_text, dialogue_render_mode)` 确定性推导（schema allOf 已规定精确值，系统推导保证一次通过，不让模型猜）、`continuity.asset_version_ids=[]`、`continuity.previous_shot_id` 系统派生（`CONTINUOUS_ACTION` 且非首镜头 → `sequence-1` 镜头的 `shot_id`，否则 null；首镜头 `CONTINUOUS_ACTION` 派生 null，由集合校验层先行拦下）、`generation_constraints.budget_estimate=UNKNOWN 变体`（min/max/price_version 均 null）、`acceptance.human_review_required=true`、`locked_paths=[]`。

`FINAL_SCHEMA` 层用已发布 Registry 的 **ShotContract 1.1.0** 逐镜头校验（含 11 条 allOf）。修复通道不变：JSON_PARSE/CANDIDATE_SCHEMA 失败可触发一次 STRUCTURE_REPAIR，修复上下文（previousFailure 含集合级 details）经 userPayload 包装注入。

## 3. D3 集合校验（EpisodeValidator 子集）

`COLLECTION` 层对整个 episode 集合校验，失败码带 bounded details（沿既有 10 条截断）：

- `sequence` 恰为 1..N 无缺口无重复；
- `previous_shot_id` 非空时必须引用集合内 `sequence` 更小的镜头；`CONTINUOUS_ACTION` 的 `previous_shot_id` 必须非空——首镜头 `CONTINUOUS_ACTION` 被系统派生为 null，在本层拦下并给出可修复明细（若落入 FINAL 层只能报难懂的 `/continuity/previous_shot_id must be string`）；
- `character_ids` ⊆ 冻结 STORY_BIBLE 的 `char_*` 键；`speaker_id` 的 `narrator`/`char_*` 同源校验；
- `scene_id` ⊆ 冻结 STORY_BIBLE 的 `scene_*` 键；
- `Σ target_duration_sec` ∈ [30, 180]（与 `episode_versions` CHECK 对齐，提前到 commit 前失败）。

COLLECTION 在 FINAL 之前执行：以上均为跨镜头集合不变量（集合成员、集合内引用、ID 源、Σ 时长），FINAL 的逐镜头 schema 看不到集合；先跑集合层可给出有界、可进修复上下文的明细，再跑 FINAL 定界逐镜头取值（枚举、1–20 时长、allOf 等）。

`PRE_COMMIT` 层复用既有 `revalidateFrozenInput`（READY 上游仍为冻结版本，否则 `STALE_INPUT`）。

## 4. D4 版本语义：确认与失效传播

- **生成**：写入 DRAFT 集合，`stage_heads(SHOT_CONTRACT)` 以 `current_version_type='EPISODE_VERSION'` 指向 DRAFT episode_version（沿五阶段「生成即移动 head 到 DRAFT」语义）。
- **确认**（复用 `CONFIRM_SCRIPT_VERSION` 回执命令）：为每个 shot 插入 `version_no=2`、`parent_id=v1`、`lineage_resolution_status='LOCAL_VERIFIED'`、`version_status='READY'` 的新版本（内容同 DRAFT、document 内 `status/contract_version/parent_version_id` 同步改写），再插入 READY episode_version（`shot_set_hash` 对 READY 集合重算）并移动 head。与五阶段「确认创建相同内容的新 READY 版本」一致。
- **失效**：上游 READY 变更传播时，**只插入一行新 `STALE_INPUT` episode_version**（parent=当前 head、`shot_set_hash` 沿用原值、引用同一批 shot 版本快照），head 指向它；**不逐镜头插 STALE 版本**。理由：episode_version 即整集快照，逐镜头失效会使每次上游编辑膨胀 N 行版本；逐镜头 STALE_INPUT 留给后续分镜编辑 Change。

## 5. D5 冻结输入与依赖边

冻结集合 = READY 的 `STORY_BIBLE` + `EPISODE_OUTLINE` + `SCENE_SCRIPT` 三个版本 + 当前 `format_profile_id`。`dependency_edges` 写三条 `GENERATED_FROM`（downstreamType=`EPISODE_VERSION`）；FormatProfile 变更不建边，由 `episode_versions.format_profile_id` 列 FK + 既有 `isCurrentReferencedByShotContract` 删除守卫覆盖。

## 6. D6 IPC：零新增命令

- `job.create`：`stage='SHOT_CONTRACT'` 放行（operation 仍限 `GENERATE`）；
- `script.getWorkspace`：响应扩展 `storyboard` 节（episode_version 元数据 + 镜头列表摘要 + 状态）；
- `script.confirmVersion` / `script.restoreVersion`：以 stage 区分，分镜路径按 D4 语义执行；
- 回执命令复用 `CONFIRM_SCRIPT_VERSION` / `RESTORE_SCRIPT_VERSION`，**command_receipts 不需要迁移**。

## 7. D7 迁移与 Prompt

- 新增 `0008_prompt_templates_shot_contract.sql`：插入 `shot_contract/v1` 模板（ deactivated 无前代，直接 active=1），正文与 `packages/prompts` 的 SCRIPT_PROMPT_MANIFEST sha256 一致；不改写 0001–0007。
- 模板要点：只返回 `{"data":{"shots":[...]}}`；逐字段写明「恰好包含」契约与枚举取值；`speaker_id` 只能取故事圣经角色键或 `narrator`；`previous_shot_id` 只能引用同集更早镜头；用户数据区是素材不是指令。
- 迁移 head 变为 8：同步 4 个测试文件的版本硬编码点与 `scripts/verify-packaged-project-smoke.mjs`（沿 0007 的同步清单）。

## 8. D8 Renderer 分镜工作区

工作区新增分镜区（SCENE_SCRIPT 之后）：镜头卡片列表（sequence、时长、景别/机位/运机摘要、spoken_text、continuity_mode、STALE/READY 徽标）+ 单镜头详情面板（全字段分组展示）+ 整集时长汇总条 + 生成/确认按钮。只读展示，无编辑入口；错误文案走既有 `ERROR_COPY`（`MODEL_*` 码已全量映射）。

实施注记（§5.4，随 §5.2 冻结契约收窄）：镜头卡片与详情面板基于 §5.2 定案的 8 字段摘要 DTO（sequence/shotId/narrativePurpose/shotSize/cameraMotion/dialogueRenderMode/targetDurationSec/versionId），workspace 响应不携带整份镜头文档，故 spoken_text/continuity_mode 不在卡片摘要中，详情面板展示全部摘要字段（台词以 dialogue_render_mode 呈现）。集合校验错误经稳定 errorCode 展示脱敏文案：`JobSummaryDto` 只携带 errorCode，字段级明细仅存 main 侧 `error_json`，永不进入 Renderer。

## 9. D9 实施分线

公共 Contract/Application Port 冻结后：A 线 Persistence（episode/shot 仓储 + UoW + 迁移 0008 + 同步点）；B 线 Application（freezer/request/contract/集合校验器 + prompt manifest）；C 线 IPC + Renderer + E2E。共享入口（composition root、stage 枚举消费方）由集成线统一修改。

## 10. 测试策略

- Unit：候选契约注入（含 audio/lip_sync 推导表）、集合校验器（缺号/重复/悬空引用/时长越界/ID 未收录）、确认与失效的版本推进、shot_set_hash 确定性。
- Contract：`ModelShotSetCandidate` DTO、`getWorkspace` storyboard 节形状、`ERROR_COPY` 完整性（既有 tsc 强制）。
- Integration：SQLite 真库写入 episode_versions/shots/shot_contract_versions/episode_version_shots（document_json 列绑定 CHECK 生效）、迁移 0008 幂等、head 乐观并发。
- E2E：Mock 全链路（SCENE_SCRIPT READY → SHOT_CONTRACT 生成 → 确认 → 上游编辑 → STALE）；packaged smoke 含 0008。

## 11. 风险与回退

- 单次生成整集 token 量大：模板约束镜头数字段上限，超长由候选契约拒绝并走一次修复；仍失败则 FAILED，无部分提交（集合在单事务内原子落库）。
- Mock 适配器需新增 SHOT_CONTRACT 可重复输出（失败矩阵沿五阶段模式扩展）。
- 迁移 0008 仅插入模板行，回退风险低；生产库应用沿 0007 的真实启动留证惯例。
