## Context

见 `proposal.md` 的 Why。当前启动链已在 `READY` 前完成 Persistence 与 Schema Registry 自检（Change #4），并在 `READY/writeEnabled=true` 后注入目录 Adapter、`ProjectUnitOfWork` 与 `ProjectService`；`project.*` 六个 IPC 与启动写门已就绪。`packages/application/src/ports/` 已有 persistence/project/schema-registry 三组 Port，但 **没有 text-model、credential Port**，没有 `packages/application/src/jobs/`，没有 `packages/model-adapters/` 包，也没有 `job`/`provider`/`events` IPC。

`0001_initial.sql` 已存在且 **不可改写**，已声明本 Change 所需的全部表与约束：

| 表 | 关键列 / 约束 | 本 Change 用途 |
|---|---|---|
| `script_stage_jobs` | `status IN('DRAFT','QUEUED','RUNNING','VALIDATING','SUCCEEDED','FAILED','CANCELLED')`、`transport_attempts` 0–3、`structure_repair_attempts` 0–1、`lease_token`、`lease_expires_at`、`deadline_at`、`cancel_requested_at`、`UNIQUE(project_id,idempotency_key)` | Job 状态机、领取 lease、幂等、超时与取消 |
| `model_invocations` | `status IN('STARTED','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED_UNKNOWN_OUTCOME')`、`attempt_kind IN('INITIAL','TRANSPORT_RETRY','STRUCTURE_REPAIR')`、`request_sent_at`、`response_complete_at`、`late_response_at`、`raw_response_blob`、`raw_response_sha256`、`timeout_at`、`provider_request_id` | 每次真实调用的证据、崩溃恢复、迟到响应 |
| `provider_profiles` | `base_url LIKE 'https://%')`、`model_id`、`model_snapshot_date`、`credential_ref`、`enabled` | Provider 配置与凭据引用 |
| `prompt_templates` | `stage` 枚举、`version`、`sha256`、`active` | Prompt 版本引用（正文由 Change #6 注入） |

表 CHECK 与 TECH_DESIGN v1.1 §11.1 状态机、§5.3 崩溃矩阵一致；本 Change 只为它们补 Repository/UnitOfWork/Row mapper，**不新增 migration**。模型锁定为 `qwen3.7-plus-2026-05-26`、OpenAI 兼容 Chat Completions、JSON Mode、64K 输入上限、120s/300s（TECH_DESIGN v1.1 §6.2）。

## Goals / Non-Goals

**Goals:**

- 在 Application 层落地确定性 JobRunner：领取、事务外调用、证据、两层契约、原子提交、重试、取消与崩溃恢复，全部经 Port，不直接碰 SQL 或 Adapter。
- 定义 `TextModelPort`/`CredentialPort` 等 Application Port，并由 `model-adapters` 与 Main Adapter 实现；Provider 专有结构不出 Adapter。
- 用 `MockTextModelAdapter` 跑通 PRD v1.4 AC-V1-04 全矩阵，再用 `QwenTextModelAdapter` 完成真实凭据验证。
- 把 Job/Provider/Events IPC、幂等与启动门衔接做成可观察、可测试的稳定 Contract。
- 保持错误码稳定、证据完整、零 Key 泄漏、零静默重发。

**Non-Goals:**

- 不实现五个编剧阶段链（CONCEPT→SCENE_SCRIPT）、`ScriptService`、`stage_heads` 指针写、`script_versions`、Prompt 模板正文、局部改写与依赖传播（Change #6 `staged-script-generation`）。
- 不实现 SHOT_CONTRACT 生成、`ModelShotBatchCandidate` 6–10 约束、`EpisodeValidator`、分镜 DRAFT/READY 语义与 `ProducibilityService`（Change #7 `storyboard-editing`）。
- 不以真实模型调用关闭 AC-V1-01；真实调用仅限凭据验证。
- 不新增 migration，不改写 `0001_initial.sql`/`0002_project_command_receipts.sql`，不修改四份正式 Schema 正文。
- 不实现多 Provider 路由、云同步、真实账单对账或图片/视频/TTS。

## Decisions

### 1. Application 拥有 JobRunner 与全部出站 Port，Adapter 实现 Port

按 TECH_DESIGN v1.1 §4.3.3 规则 4 与 AGENTS.md §7.1，`JobRunner` 业务编排位于 `packages/application/src/jobs/`，经 Repository/UnitOfWork Port 领取、落证据与原子提交，经 `TextModelPort`/`CredentialPort` 调用模型与凭据，MUST NOT 导入 `node:sqlite`、百炼 SDK 或任何 Adapter。新增 Port：

- `TextModelPort`：`validateCredential` / `generate(request, signal)` / `normalizeError(error)`，返回 `TextGenerationResult` 或 `NormalizedModelError`（TECH_DESIGN v1.1 §6.1）。
- `CredentialPort`：保存/读取/删除密文，`safeStorage` 不可用时返回稳定错误；只回吐 `credential_ref` 与验证元数据，不回吐明文 Key。
- Job/Invocation 的 `Repository` 与 `UnitOfWork` 属于持久化 Port，归 Application 所有。

`packages/model-adapters` 实现 `QwenTextModelAdapter` 与 `MockTextModelAdapter`；Main 实现 `CredentialAdapter`（Electron `safeStorage`）；Composition Root 在 `READY` 后注入。Application/Domain 不反向依赖这些实现包。

被否决方案：把 JobRunner 放进 Main 调度层（违反「Application 拥有事务边界与出站 Port」）；让 Application 直接持有百炼 SDK（破坏 Port 边界与可测试性）。

### 2. 不新增 migration，复用 0001 已存在的两张表

`script_stage_jobs` 与 `model_invocations` 已在 `0001_initial.sql` 声明，且 `status`/`attempt_kind`/`transport_attempts`/`structure_repair_attempts` 的 CHECK 与状态机一致。本 Change 只新增 Repository（带条件领取、证据写回、崩溃恢复查询）、`UnitOfWork`（短事务原子提交）与 Row mapper，并在 persistence 边界归一化数据库异常。这与 Change #4 复用 `schema_registry_manifest` 的策略一致。

被否决方案：新增 `0003` 重建 Job/Invocation 表（现有表已足够且 CHECK 已守卫边界，增加 migration 无收益且扩大 diff）；放宽任一 CHECK 以适配实现（违反「不得通过放宽门禁制造通过」）。

### 3. 两层契约为通用管线，阶段化提交经可替换 Commit Handler

JobRunner 固定执行「候选 Schema → 注入系统字段 → 正式 Schema → 集合校验」的确定性顺序（TECH_DESIGN v1.1 §6.1.1）。为保持本 Change 独立可验证又不侵入 Change #6/#7 的业务语义，JobRunner 通过一个 `JobCommitHandler` Port 完成最终业务提交（写版本、更新指针、依赖边、STALE_INPUT），提交协议本身（复检输入 hash、复检锁、校验 Job 未取消、写审计、置 `SUCCEEDED`、单事务原子）由 JobRunner 拥有。

本 Change 通过测试注入最小 `JobCommitHandler`，让真实 `MockTextModelAdapter × JobRunner` 跑通 `QUEUED→…→SUCCEEDED` 并验证原子提交；生产 Main 不写“证据性假版本”，而是在 Change #6 注入真实 `ScriptStage` 提交（`script_versions`、`stage_heads`、依赖传播）前，让 Job 写入口返回稳定不可用。Change #7 再提供 `SHOT_CONTRACT` 提交。失败路径（AC-V1-04 矩阵）不依赖业务版本提交，因此本 Change 可独立验证通用基座。

被否决方案：在本 Change 内实现完整五阶段与分镜提交（超出 #5 边界，与 #6/#7 重叠）；把两层契约下沉到 Adapter（让 Provider 层决定系统字段，违反 §7.2「LLM 不决定系统 ID」）。

### 4. 事务外调用、标记发送先于网络、证据与版本短事务

按 AGENTS.md §11.2 与 TECH_DESIGN v1.1 §4.3.4：Provider 请求在事务外；网络前在同一提交写 `request_sent_at` 并置 Invocation 已发送，崩溃按「结果未知」；完整响应到达后在短事务写 blob/hash/`response_complete_at` 并置 `VALIDATING`；最终提交在单一 `UnitOfWork` 短事务原子完成，事务内不等待网络、不做长文件操作；Repository 不嵌套提交。重试沿用同一业务幂等键，但每次真实调用创建独立 `ModelInvocation`。

被否决方案：把 Provider 调用放进提交事务（长事务持锁、阻塞其他写入）；先发请求再补写 `request_sent_at`（崩溃时无法区分「未发出」与「结果未知」，可能重复计费）。

### 5. 并发门：全局单一真实 Job + 同项目串行，经 DB lease 与应用门共同守卫

按 TECH_DESIGN v1.1 §15「全局最多 1 个真实 LLM Job；同项目严格串行」，用「单写连接 + 领取条件更新 + 应用级领取调度」共同实现：领取调度在选取下一 Job 时校验全局无 `RUNNING` 真实 Job 且同项目无非终态 Job；DB 层 `WHERE status='QUEUED'` 条件更新提供最后一致性防线。Mock 驱动的测试 Job 与真实 Job 共用同一并发门，便于以 Mock 验证。

被否决方案：纯内存信号量（Renderer 刷新或崩溃后失真，违反 §4.3.4「不得用全局 Promise 维护任务事实」）；多 Job 并行后用版本冲突回退（产生输入版本竞争与意外成本，违反 §15 设计意图）。

### 6. 凭据：safeStorage 加密 + credential_ref，UI 只显末 4 位

按 AGENTS.md §13.2：API Key 经 Electron `safeStorage` 加密、密文独立保存，SQLite 只存 `credential_ref` 与验证元数据；`safeStorage` 不可用阻断保存不降级明文；UI 只显示已配置状态与可选末 4 位；删除同步删密文并写审计；Key 不进日志/埋点/诊断包/导出。`ProviderService` 负责配置、凭据引用、数据处理提示与连通性测试；Base URL 由受校验配置派生，UI 不接受任意 Base URL（AGENTS.md §11.3）。

被否决方案：明文存 SQLite（违反 §13.2）；Key 存 `.env`（打包态不可用且易泄漏）；UI 回显完整 Key（扩大泄漏面）。

### 7. Mock 优先验证，真实调用仅凭据检查

`MockTextModelAdapter` 按声明序列确定性输出全矩阵失败与崩溃点，是 AC-V1-04、单元、Provider Contract 与 Integration 的唯一模型来源。`QwenTextModelAdapter` 在本 Change 内只支撑 `provider.testCredential` 的低成本受控连通性检查；真实阶段生成验收留给 Change #6（且需按 PRD §9.4.4 重新核对 Provider/模型/地域/价格/数据处理快照）。时间、ID、随机数与 Provider 响应在测试中均可注入或固定（AGENTS.md §15.3）。

被否决方案：用真实百炼跑失败矩阵（不可重复、计费、违反「单元测试不访问真实网络」）；把 Mock 放进生产代码路径（污染真实行为）。

### 8. 启动门衔接：READY 后激活调度，非就绪阻断写命令

通用 Job/Provider Host 只在 `READY` 后构造；`READ_ONLY_FAULT` 或其他非 `READY` 状态不领取、不重发且不构造写路径，写命令返回 `STARTUP_WRITE_BLOCKED`（详见 `desktop-workspace-foundation` delta）。生产阶段 JobRunner、提交器与可提交恢复由 Change #6 在 READY 门后注入；注入前 Job 写命令返回稳定不可用，迁移失败时按 AGENTS.md §12.2 不启动任何 JobRunner。

### 9. 错误归一化与脱敏

可预期业务失败用稳定 `AppError.code` + 类型化 details + `traceId` 返回；编程错误在 JobRunner/IPC/启动边界捕获并转安全错误（TECH_DESIGN v1.1 §4.3.4）。百炼专有错误在 `QwenTextModelAdapter` 边界归一化为 `NormalizedModelError`（稳定 `code`、`retryable`、`userAction`），Authorization header 与原始错误体不跨边界。日志只记录必要 ID、状态、耗时、错误码、Token、版本与 hash（AGENTS.md §13.3）。

## Risks / Trade-offs

- [JobRunner 与业务提交以 Commit Handler 解耦] → 成功路径在本 Change 内只能用最小 handler 证明；完整 `SUCCEEDED` 业务语义留待 #6/#7。用 AC-V1-04 失败矩阵作为本 Change 的硬验收，避免「成功路径看似完成实则空壳」。
- [表已存在但无 Repository] → 用 Repository 集成测试覆盖空表、领取原子性、证据回滚与崩溃恢复矩阵；不依赖 `integrity_check` 代替 `foreign_key_check` 与应用级 invariant audit（AGENTS.md §12.2）。
- [真实 Provider 配置漂移] → 模型固定 `qwen3.7-plus-2026-05-26`、禁漂移别名；Provider/价格/数据处理快照在 #6 真实验收前必须重新核对并以新 Change 固化。
- [并发门实现复杂度] → 单写连接 + 条件领取 + 应用调度的组合需显式并发集成测试；Mock Job 复用同一并发门以可验证。
- [Key 泄漏面随 IPC 扩大] → safeStorage + `credential_ref` + UI 末 4 位 + 产物白名单审计四重防护；新增 IPC 不得回吐 Key 或原始 Provider 错误。
- [崩溃恢复矩阵路径多] → 以 §5.3.2 矩阵为 Contract Fixture 清单逐条覆盖，任一未覆盖点记为阻断。
- [百炼依赖升级] → 精确锁版本到唯一 `pnpm-lock.yaml`；Provider 错误断言只针对稳定归一化 `code`，不绑百炼原始文本。**核验（2026-08-12，task 1.1）**：Node v22.16.0 全局 `fetch`/`AbortController`/`AbortSignal.timeout()` 已覆盖百炼 OpenAI 兼容 Chat Completions 的传输与超时；全仓零 `openai`/`dashscope`/`qwen`/`axios`/`node-fetch`/`undici` 依赖，本 Change 不引入任何 Provider SDK 依赖，`pnpm-lock.yaml` 无变更、无 `latest`、无第二锁文件；超时以 `AbortSignal.timeout(120_000)`（Invocation）/`(300_000)`（Job）实现，错误在 Adapter 边界归一化。
- [`provider_profiles` 模型三方不一致（DB / Application / Contract）] → **已按 Option A「虚拟默认 + 配置后落行」收敛（2026-08-12，task 6.4）**。DB `credential_ref TEXT NOT NULL CHECK length>0`（0001 字节锁，8.4 不改）强制「行存在 ⟺ 凭据存在」：`saveCredential` 首次落行（INSERT）/换凭据（upsert），`deleteCredential` 删整行 + 写审计，`saveProfile` 仅改已存在行的 enabled/workspaceId（行不存在则 `PROVIDER_PROFILE_NOT_FOUND`，凭据先于配置）。`lastValidatedAt`/`credentialLast4`/数据处理提示同存 `config_json`（末四位属验证元数据、非密钥），`lastValidatedAt` 在 Application 类型单一来源于 `ProviderProfileConfig`（不再顶层重复）。`versionId = profile.id`；Contract DTO `providerProfileSchema` 字节未动，由 7.2 IPC Host 把 `ProviderProfileView`→DTO 投影（注入 versionId）。GPT 旧实现「save null credentialRef」对真实 DB 必然违反 NOT NULL，本 Change 已修正为删行语义并以集成测试固化。
- [生产 JobRunner 依赖后续业务 seam] → **已选择显式推迟**。本 Change 注册类型化 IPC Host、Provider/Credential 基座与 READY 门，但不注入会写假业务版本的生产 handler；`job.create/retry/cancel` 在 `staged-script-generation` 接入前稳定返回不可用。Change #6 必须把阶段提交器、真实 `createJobRunner`、调度与恢复重校验一次性注入并补 E2E。

## Migration Plan

1. 不修改 `0001_initial.sql` 与 `0002_project_command_receipts.sql`；先用现有 v2 临时库验证 `script_stage_jobs`/`model_invocations`/`provider_profiles` 空表与约束行为。
2. 引入 `TextModelPort`/`CredentialPort`、Job/Invocation Repository/UnitOfWork 与架构边界测试；在接入 IPC 与调度前保持运行行为不变。
3. 实现 `JobRunner`、`MockTextModelAdapter` 与最小 Commit Handler，跑通状态机与 AC-V1-04 Mock 矩阵（单元 + Provider Contract + Integration）。
4. 实现 `QwenTextModelAdapter`、`ProviderService`、Main `CredentialAdapter` 与 `job`/`provider`/`events` IPC，完成真实凭据验证；接入启动门衔接。
5. 执行完整门禁、Electron E2E 与 Windows x64 packaged smoke；发布回滚仅回退二进制，数据库无 schema 版本变化，旧二进制忽略新 IPC。

## Open Questions

- 百炼 OpenAI 兼容接口的传输重试是否由 Adapter 内部 fetch 重试层承担、还是全部由 JobRunner 经 `attempt_kind=TRANSPORT_RETRY` 驱动？倾向后者（确定性归 JobRunner，Adapter 只做单次请求 + 归一化错误），但在 Apply 任务实现前需以一次最小连通性实验确认百炼 429/5xx 的可重试响应体可被稳定分类。该选择不改变本规范、分层或任务拆分。
