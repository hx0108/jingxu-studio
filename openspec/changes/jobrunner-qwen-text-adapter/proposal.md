## Why

Schema Registry（Change #4）已让四份正式 Schema 可离线校验，但 AI 生成的确定性编排、Provider 调用、凭据保管、Job/Invocation 证据和失败恢复均未实现（TECH_DESIGN v1.1 §3.4「AI/契约」尚未实现边界；§11 `job`/`provider`/`events` 命名空间标注「未实现；JobRunner 也未实现」）。若直接进入分阶段编剧（Change #6）或分镜（Change #7），每个业务阶段都将自行处理重试、取消、超时、崩溃恢复、凭据和两层契约，必然绕过 TECH_DESIGN v1.1 §5 与 AGENTS.md §11 的确定性边界，产生重复计费、重复版本和不可恢复的 Job。

根据 PRD v1.4 §9.4.2/§9.4.3（重试、取消、超时与失败矩阵）、§9.4.4（V1 锁定单一 Provider 前只能用 Mock）、AC-V1-04（模型失败恢复）以及 TECH_DESIGN v1.1 §5.1–§5.3.2、§6、§11、§15、§20 Sprint 3，需要先把「确定性 JobRunner + TextModelAdapter + Qwen/Mock Adapter + 凭据与 Provider 基线」作为可独立验证的基础设施落地：用 Mock 跑通完整状态机与崩溃恢复矩阵（AC-V1-04），再用 Qwen 完成真实凭据验证，而把五个编剧阶段、分镜生成、可生产性与 EpisodeValidator 留给后续 Change。

## What Changes

- 新增 Application 出站 `TextModelPort` 及 `TextModelAdapter` 契约（`validateCredential` / `generate(signal)` / `normalizeError`）：业务层只依赖该接口与归一化错误，不得读取百炼 `choices`、HTTP header 或 Provider 专有结构（TECH_DESIGN v1.1 §6.1）。
- 新增 `MockTextModelAdapter`：确定性、可注入的失败序列实现，覆盖 PRD §9.4 与 AGENTS.md §15.4 的 401、429、5xx、120 秒超时、非法 JSON、结构修复失败、STALE_INPUT、取消与迟到响应、各崩溃点；它是 AC-V1-04 与全部单元/集成测试的唯一模型来源。
- 新增 `QwenTextModelAdapter`：映射到阿里云百炼 OpenAI 兼容 Chat Completions，固定模型 `qwen3.7-plus-2026-05-26`（禁止漂移别名），非思考模式 + `response_format={"type":"json_object"}`，64K 输入硬上限，单次 120 秒 / Job 300 秒，归一化百炼错误为稳定 `NormalizedModelError`（TECH_DESIGN v1.1 §6.2、AGENTS.md §11.3）。
- 新增 Application 层 `JobRunner`：在 `packages/application/src/jobs/` 实现确定性编排——带条件原子领取（lease）、事务外 Provider 调用、ModelInvocation 证据落库、候选 Schema→注入系统字段→正式 Schema 的两层契约、`UnitOfWork` 短事务原子提交、transport retry ≤2（仅网络/429/5xx）、structure repair ≤1（仅修候选 JSON）、取消与 AbortController、启动恢复（§5.3 崩溃矩阵）、全局最多 1 个真实 LLM Job 且同项目严格串行（§15）。
- 新增 Job/Invocation 持久化：`script_stage_jobs` 与 `model_invocations` 的 Repository 与 `UnitOfWork`，**复用 `0001_initial.sql` 已存在且含完整状态机 CHECK 的两张表**，不新增 migration；Repository 不嵌套提交、不泄漏 Row/连接。
- 新增 `JobService` 与 `job create/get/list/cancel/retry` IPC、`events.subscribeJobUpdates`：Command 携带 `requestId`、修改命令携带 `expectedVersionId`，复用既有启动写门；页面切换或 Renderer 刷新不取消已持久化 Job（AGENTS.md §11.1、§14）。
- 新增 `ProviderService`、`CredentialPort` 与 Main 凭据 Adapter：API Key 经 Electron `safeStorage` 加密，SQLite 只存 `credential_ref` 与验证元数据；`provider getProfile/saveProfile/saveCredential/testCredential/deleteCredential` IPC；UI 只显示已配置状态与可选末 4 位，不回显完整 Key（AGENTS.md §13.2）。
- 接入启动状态机：JobRunner 调度与恢复扫描只在 `READY` 后激活，`READ_ONLY_FAULT` 期间暂停领取且 `job`/`provider` 写命令返回既有 `STARTUP_WRITE_BLOCKED`。
- 明确非目标：不实现五个编剧阶段链、ScriptService、stage_heads 指针写、script_versions、Prompt 模板正文、局部改写与依赖传播（Change #6）；不实现 SHOT_CONTRACT 生成、ModelShotBatchCandidate 6–10 约束、EpisodeValidator、DRAFT/READY 分镜语义与 ProducibilityService（Change #7）；不关闭 AC-V1-01。

## Capabilities

### New Capabilities

- `jobrunner-qwen-text-adapter`：定义 TextModelAdapter 契约、Qwen/Mock 实现、确定性 JobRunner 编排（领取、事务外调用、两层契约、证据、原子提交、重试、取消、恢复、并发）、Job/Invocation 持久化、`job`/`provider`/`events` IPC、凭据 safeStorage 保管与启动门衔接行为。

### Modified Capabilities

- `desktop-workspace-foundation`：启动状态机新增「JobRunner 调度与恢复扫描只在 `READY` 后激活、`READ_ONLY_FAULT` 期间不领取」的可观察约束；`job`/`provider` 写命令复用既有启动写门与 `STARTUP_WRITE_BLOCKED`。

## Impact

- **Schema**：四份根 Schema 与内部候选 Schema 字节不变；本 Change 只消费已发布的 `ScriptStageOutput.schema.json` 作为两层契约的正式层示例，不新增、不改写任何 PRD-owned 或内部 Schema 正文。
- **数据库**：**不新增 migration**，不改写 `0001_initial.sql` 或 `0002_project_command_receipts.sql`。`script_stage_jobs`（含 `status`/`transport_attempts`(0–3)/`structure_repair_attempts`(0–1)/`lease_token`/`deadline_at`/`cancel_requested_at`/`UNIQUE(project_id,idempotency_key)`）、`model_invocations`（含 `request_sent_at`/`response_complete_at`/`late_response_at`/`raw_response_blob`/`timeout_at`/`provider_request_id`）、`provider_profiles`（含 `credential_ref`/`base_url CHECK`/`enabled`）与 `prompt_templates` 已存在且 CHECK 与状态机一致；本 Change 只为它们补 Repository/UnitOfWork/Row mapper 与应用级不变量测试。
- **代码与依赖**：新增 `packages/application/src/jobs/`、`packages/application/src/ports/text-model/`、`packages/application/src/ports/credential/`、`packages/model-adapters/`（Qwen + Mock）、Main `CredentialAdapter`、`ProviderService`/`JobService`、`job`/`provider`/`events` IPC 与 Preload 逐方法白名单；精确锁定百炼兼容的 `fetch`/超时与（如需）SDK 依赖到唯一 `pnpm-lock.yaml`。Application/Domain 不得反向依赖 `model-adapters` 或 Electron Adapter。
- **IPC/UI**：新增 `job create/get/list/cancel/retry`、`provider getProfile/saveProfile/saveCredential/testCredential/deleteCredential` 与 `events.subscribeJobUpdates`；统一 `AppError`，Renderer 不接收 API Key、Authorization header 或未脱敏 Provider 错误；UI 提供任务状态、失败矩阵文案与 Provider 配置入口，但不提供剧本/分镜业务入口。
- **进程与安全**：Provider 网络只在 Main/`QwenTextModelAdapter` 边界发起；API Key 经 `safeStorage` 加密、只存 `credential_ref`，不进入日志/埋点/诊断包/Renderer/导出；所有外部调用接收 `AbortSignal`；JobRunner 不直接执行 SQL 或导入 `node:sqlite`，全部经 Repository/UnitOfWork Port。
- **兼容性**：现有 v2 SQLite 数据库与 Project 数据不迁移；旧包忽略新 IPC。真实模型调用仍受 PRD §9.4.4 约束——Provider/模型/地域/价格/数据处理快照在 AC-V1-01 前必须重新核对，未锁定前只允许 Mock；本 Change 不因此扩大 V1 范围。
- **测试与发布**：增加 Unit（状态机、幂等键、错误归一化、价格/Token 计算、退避）、Provider Contract（Mock 全矩阵）、Repository Integration（领取原子性、证据回滚、崩溃恢复矩阵）、Electron E2E（job 生命周期、凭据配置、启动门衔接）与 Windows x64 packaged smoke；本 Change 的验收证据为 **AC-V1-04 Mock 全矩阵通过 + 真实 Provider 凭据验证通过**，仍不构成 AC-V1-01 完成证据。
