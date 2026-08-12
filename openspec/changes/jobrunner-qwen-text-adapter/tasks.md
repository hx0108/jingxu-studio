## 1. 依赖、Port 契约与架构基线

- [x] 1.1 核验百炼 OpenAI 兼容接口在 Node 22.16.0、TypeScript 下的传输与超时依赖，精确锁定版本到唯一 `pnpm-lock.yaml` 并记录核验日期；不得使用 `latest` 或第二锁文件。（Design §7、§9；AGENTS.md §11.3）✓ 核验日期 2026-08-12：Node v22.16.0 全局 fetch/AbortSignal.timeout 覆盖传输与超时，全仓零 SDK 依赖，本 Change 不引入新依赖、`pnpm-lock.yaml` 无变更（详见 design.md Risks「百炼依赖升级」核验条）。
- [x] 1.2 先添加架构边界测试：`packages/application`、`packages/domain` 不得导入百炼 SDK、`node:sqlite`、`model-adapters` 或 Electron 模块；`packages/model-adapters` 不得被 Application/Domain 反向依赖。（R: TextModelAdapter 契约必须屏蔽 Provider 专有结构 / 全部 Scenario；AGENTS.md §7.1、TECH_DESIGN v1.1 §4.3.3）✓ 已在 `eslint.config.mjs` 添加 application/domain zone（禁 electron/better-sqlite3/node:sqlite/openai/dashscope/@jingxu/persistence/@jingxu/model-adapters）与 model-adapters zone（禁 electron/better-sqlite3/node:sqlite/@jingxu/persistence）；正向探针验证两 zone 均触发 `no-restricted-imports`，现有代码零误报。
- [x] 1.3 在 Application 定义带 TSDoc 的 `TextModelPort`（`validateCredential`/`generate(signal)`/`normalizeError`）、`TextGenerationRequest`/`TextGenerationResult`/`NormalizedModelError` 类型与 `CredentialPort`；接口不得泄漏百炼类型、Row、Statement、连接、明文 Key 或可变 Buffer。（Design §1；TECH_DESIGN v1.1 §6.1）✓ 已实现：`packages/contracts/src/stage.ts`（ScriptStage zod enum，镜像 `prompt_templates.stage`）、`packages/application/src/ports/text-model/`（Port + 6 类型 + barrel + 类型测试）、`packages/application/src/ports/credential/`（Port + CredentialRef + barrel + 类型测试），均经 `tsc -b` + `vitest`(6/6) + `eslint` 验证通过。
- [x] 1.4 创建 `packages/model-adapters/`（Qwen + Mock）与 `packages/application/src/jobs/` 目录、strict tsconfig 与 workspace references；扩展 package 边界测试证明依赖方向。（AGENTS.md §7.1；TECH_DESIGN v1.1 §4.2）✓ 已建立 `@jingxu/model-adapters` strict 包、Application jobs 公开入口与根 solution reference；workspace frozen install、root `tsc -b`、ESLint 和双向非法导入探针均通过，未预建业务实现。

## 2. Job/Invocation Repository 与 UnitOfWork（复用 0001 表）

- [ ] 2.1 先添加 `script_stage_jobs` Row mapper/Repository 集成测试：空表、领取原子性（`WHERE status='QUEUED'` 条件更新只命中一个领取方）、`UNIQUE(project_id,idempotency_key)` 幂等冲突、坏 `status`/`transport_attempts`/`structure_repair_attempts` 值归一化、参数绑定 SQL、无 `SELECT *`，且 Repository 外不见 Row/连接。（R: Job 领取必须原子且仅领取成功方调用 Provider；Design §2）
- [ ] 2.2 先添加 `model_invocations` Repository 集成测试：写 `request_sent_at`、写响应 blob/hash/`response_complete_at`、写 `late_response_at`、`attempt_kind`/`transport_attempt` 约束、超时 `timeout_at` 与崩溃恢复查询矩阵的精确读取。（R: Provider 调用必须事务外，证据与版本短事务原子提交；R: 崩溃恢复必须按持久化证据确定终态；Design §2、§4）
- [ ] 2.3 实现 Job/Invocation Repository 与短事务 `UnitOfWork`（复用既有单写连接、`BEGIN IMMEDIATE`），由 Application/JobRunner 拥有事务边界；Repository 不嵌套提交，persistence 边界归一化数据库异常，不修改 `0001_initial.sql`/`0002_project_command_receipts.sql` 或新增 migration。（Design §2；AGENTS.md §11.2、§12.2）
- [ ] 2.4 添加应用级不变量测试：`transport_attempts` 仅 0–3、`structure_repair_attempts` 仅 0–1 与状态机一致；DB CHECK 与应用守卫共同阻断越界转移。（R: 重试与结构修复必须受状态机、次数与错误类型约束；AGENTS.md §11.1）

## 3. MockTextModelAdapter 与两层契约

- [ ] 3.1 先添加 Mock 单元测试：按声明序列确定性输出 401、429、5xx、120 秒超时、非法 JSON、结构修复失败、STALE_INPUT、取消与取消后迟到响应；时间/ID/随机可注入；不访问真实网络（网络守卫为零调用）。（R: Job 基线必须以 Mock 全矩阵作为 AC-V1-04 证据；AGENTS.md §15.3）
- [ ] 3.2 实现 `MockTextModelAdapter` 与可注入的时钟/响应序列；提供合法候选输出以驱动 `QUEUED→RUNNING→VALIDATING→SUCCEEDED` 成功路径。（Design §7）
- [ ] 3.3 先添加两层契约单元测试：候选 Schema → 注入系统字段 → 正式 Schema → 集合校验的固定顺序；系统字段每次由 JobRunner 重新生成；候选非法但可修复触发最多一次 structure repair；第二次结构失败终态 `FAILED`；任何一层失败不创建版本。（R: 重试与结构修复必须受状态机、次数与错误类型约束；TECH_DESIGN v1.1 §6.1.1）

## 4. JobRunner 确定性编排

- [ ] 4.1 先用 Fake Ports 添加 JobRunner 单元测试：领取条件更新只让一个 runner 胜出；Provider 调用在事务外；标记发送先于网络；响应证据与 Job→`VALIDATING` 一致；最终提交在单一 `UnitOfWork` 短事务原子完成，任一步失败整体回滚不留半个版本。（R: Job 领取必须原子；R: Provider 调用必须事务外；Design §3、§4）
- [ ] 4.2 实现 `JobRunner` 主循环：带条件领取、经 `TextModelPort.generate(signal)` 事务外调用、`ModelInvocation` 证据落库、两层契约与最小 `JobCommitHandler` 提交；JobRunner 不直接执行 SQL 或导入 `node:sqlite`/Adapter。（Design §1、§3、§4；AGENTS.md §11.2）
- [ ] 4.3 先添加重试策略单元测试：网络错误/429/5xx 触发最多 2 次 `TRANSPORT_RETRY` 且每次独立 Invocation；401/内容拒绝/上下文超限/结构校验失败直接 `FAILED` 不重试；structure repair ≤1 只修候选；终态不回退。（R: 重试与结构修复必须受状态机、次数与错误类型约束）
- [ ] 4.4 先添加取消与迟到响应单元测试：取消先原子写 `cancel_requested_at`+`CANCELLED` 再 abort；迟到响应只写 hash/`late_response_at`，不写 parsed JSON/版本/重试；页面刷新不取消非取消 Job。（R: 取消与迟到响应不得创建版本或触发重试）
- [ ] 4.5 先添加并发门集成测试：全局同时最多 1 个真实 `RUNNING` Job；同项目严格串行；Mock Job 复用同一并发门并可验证。（R: 真实 LLM Job 全局唯一且同项目严格串行；Design §5）

## 5. 崩溃恢复与 AC-V1-04 Mock 矩阵

- [ ] 5.1 先按 TECH_DESIGN v1.1 §5.3.2 矩阵添加崩溃恢复集成测试逐条覆盖：`QUEUED` 无 Invocation 重新领取；`request_sent_at` 非空/`response_complete_at` 为空 → `FAILED`/`INTERRUPTED_UNKNOWN_OUTCOME` 禁止重发；完整响应 hash 正确 → 幂等重校验不重复版本；`cancel_requested_at` 非空保持 `CANCELLED`；超过 `deadline_at`/`timeout_at` → `FAILED`/`JOB_DEADLINE_EXCEEDED`；重启不重置 deadline/timeout。（R: 崩溃恢复必须按持久化证据确定终态且不自动重发未知请求）
- [ ] 5.2 添加 AC-V1-04 Provider Contract/Integration：固定 Mock 依次模拟 401、429、5xx、120 秒超时、非法 JSON、结构修复失败、STALE_INPUT、取消、迟到响应与各崩溃点；断言终态不回退、不重复版本、原始输入不丢失、保留 Provider 任务 ID。（R: Job 基线必须以 Mock 全矩阵作为 AC-V1-04 证据；PRD v1.4 AC-V1-04、§9.4.2/§9.4.3）

## 6. QwenTextModelAdapter、ProviderService 与凭据

- [ ] 6.1 先添加 Qwen Adapter 单元测试：固定模型 `qwen3.7-plus-2026-05-26`、拒绝漂移别名、`response_format={"type":"json_object"}`、64K 输入超限阻断不裁剪、120s/300s 超时映射、401/429/5xx/超时/非法 JSON 归一化为稳定 `NormalizedModelError` 且不含 Authorization header/原始错误体。（R: Qwen Adapter 必须锁定固定模型与 JSON Mode 且归一化错误；Design §9）
- [ ] 6.2 实现 `QwenTextModelAdapter`（百炼 OpenAI 兼容 Chat Completions，Base URL 由受校验配置派生），只支撑单次请求 + 归一化错误；transport retry 由 JobRunner 驱动。（Design §7、§9；AGENTS.md §11.3）
- [ ] 6.3 先添加凭据单元/集成测试：`safeStorage` 不可用阻断保存不降级明文；SQLite 只存 `credential_ref`；UI 只显末 4 位；删除同步删密文并写审计；日志/诊断包/导出/Renderer 状态零完整 Key（白名单审计）。（R: 凭据必须经 safeStorage 加密且不回流 Renderer；AGENTS.md §13.2、§13.3）
- [ ] 6.4 实现 Main `CredentialAdapter`（Electron `safeStorage`，密文独立保存）与 `ProviderService`（配置、凭据引用、数据处理提示、低成本 `testCredential` 连通性检查）；真实模型调用在本 Change 内仅限凭据验证。（Design §6、§7；PRD v1.4 §9.4.4）

## 7. job/provider/events IPC、Preload 与启动门衔接

- [ ] 7.1 先扩展 IPC/Preload Contract 测试：`job create/get/list/cancel/retry`、`provider getProfile/saveProfile/saveCredential/testCredential/deleteCredential`、`events.subscribeJobUpdates` 逐方法白名单、双端 strict Zod DTO、`AppError` 输出；Renderer 无通用 `send/on/invoke` 入口。（R: Job/Provider IPC 必须服从启动写门与幂等；TECH_DESIGN v1.1 §11）
- [ ] 7.2 实现 IPC Host、Preload `window.jingxu` 冻结白名单与 `JobService`：Command 携带 `requestId`、修改命令携带 `expectedVersionId`、`(project_id,idempotency_key)` 去重为同一 Job；Renderer 不接收 Key/Auth/原始 Provider 错误。（Design §9；AGENTS.md §13.2、§14）
- [ ] 7.3 先扩展启动门测试：JobRunner 领取与恢复扫描只在 `READY` 后激活；非 `READY` 时 `job`/`provider` 写命令返回 `STARTUP_WRITE_BLOCKED` 且不构造写路径；恢复扫描不在自检完成前调用 Provider。（R: desktop-workspace-foundation 新增 Scenario；Design §8）
- [ ] 7.4 把 JobRunner/ProviderService/CredentialAdapter 在 Main Composition Root 于 `READY` 后组装；关闭应用释放资源，retry 重用安全边界并从崩溃矩阵恢复。（Design §1、§8）

## 8. 完整验证与 OpenSpec 收口

- [ ] 8.1 运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:contract`、`pnpm test:integration` 与适用 `pnpm test:e2e`，记录实际通过/失败数量、网络守卫与 Mock 矩阵证据。（AGENTS.md §15、§18）
- [ ] 8.2 从干净 `.vite/out` 运行 Windows x64 packaged smoke：确认凭据零明文、`job`/`provider` IPC 仅在 `READY` 可写、Mock 矩阵可重复、真实 `testCredential` 仅做低成本连通性检查，且零真实用户目录访问。（Design §6、§7；Migration Plan）
- [ ] 8.3 运行 `openspec validate jobrunner-qwen-text-adapter --strict` 并映射全部 Requirement/Scenario 到代码、Fixture 与测试；阻断问题清零后才可 Sync/Archive。（OpenSpec archive guidance）
- [ ] 8.4 最终 diff 证明 `0001_initial.sql`、`0002_project_command_receipts.sql` 与四份根 Schema 字节未变，未引入五编剧阶段、ScriptService、SHOT_CONTRACT 生成、EpisodeValidator、ProducibilityService 或 V2/V3 能力。（Proposal Non-Goals）
