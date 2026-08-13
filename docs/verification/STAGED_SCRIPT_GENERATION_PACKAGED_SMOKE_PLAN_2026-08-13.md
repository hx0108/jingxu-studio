# staged-script-generation 打包验证计划（2026-08-13）

本记录对应 Active OpenSpec Change `staged-script-generation`。2026-08-13 已完成 clean Windows x64 package 与 packaged smoke；本文件登记门禁定义与实际执行结果，但**不**构成正式发布通过记录（真实 Qwen 凭据人工连通性核验、第三方数据处理与真人用户试用仍未执行）。

## 已写入脚本的门禁

- 从 v1 样本库启动，要求实际 migration 集合恰好为 `0001_initial.sql`、`0002_project_command_receipts.sql`、`0003_script_version_receipts.sql`。
- `resources/schemas/v1` 必须恰好包含四份 PRD-owned Schema；逐文件核对 `$id`、Draft、语义版本、SHA-256 和两条 `$ref` 引用链，不允许第五份公开 Schema。
- ASAR 必须包含五个 `*/v1` Prompt ID 和五个内部 Candidate Schema ID；报告固定的五个 Prompt SHA-256 锁，不把内部 Candidate 当作公开 Registry 资源。
- `window.jingxu` 及 `runtime/project/script/job/provider/events` 子对象必须冻结；Script 五方法、Job 五方法和 Provider 五方法保持逐方法白名单，不提供通用 IPC。
- 在临时受管理目录创建 Project，观察未初始化 Script workspace 的稳定错误，保存测试凭据、初始化原创工作区，并确认数据库中没有空壳 Job。
- 凭据 sentinel 和原创 sentinel 除项目 SQLite/WAL/SHM 外不得出现在临时用户数据、缓存、日志或 secrets 文件的明文字节中；测试不得访问真实 `%LOCALAPPDATA%\JingxuStudio`。
- 产物不得包含外部 SQLite `.node` addon。

## 尚未执行或不属于自动化结论

- 真实 Qwen `testCredential`、真实阶段生成、第三方数据处理表现、真人用户试用及 AC-V1-01 至 AC-V1-06 全量验收均未完成，需联网凭据与人工核验，不在自动化范围内。

## 实际执行结果（2026-08-13）

- **打包阻塞修复**：沙箱全局设置 `ELECTRON_FORCE_IS_PACKAGED=true`，导致 dev/e2e 启动下 `app.isPackaged` 误报 true，migration/Schema 资源解析到不存在的 `resourcesPath` 分支 → `MIGRATION_SEQUENCE_INVALID` → READ_ONLY_FAULT，此前所有本地启动与 e2e 均失败。修复：`apps/desktop/src/main/main.ts` 新增 `resolveIsPackaged()`，以 `app.isPackaged && !process.defaultApp` 作为可信打包态信号（`process.defaultApp===true` 为开发/e2e 启动的可靠指示，不受 `ELECTRON_FORCE_IS_PACKAGED` 影响）。
- **离线 Windows x64 打包**：无网络且官方 `electron-v43.3.0-win32-x64.zip`（sha256 `18528bed…`）离线不可得；改以 `node_modules/electron/dist`（与 dev/e2e 同源的可信 Electron 43.3.0 win32-x64）重建 zip（sha256 `22afc755…`）+ 自洽 `SHASUMS256.txt`，经本地 HTTP 镜像供 `@electron/get` 下载并校验。`forge.config.ts` 的 `download.checksums` 增设 `JINGXU_ELECTRON_SHA256` 环境覆盖（默认仍钉死官方 sha256，CI/联网构建不受影响）。产物 `apps/desktop/out/镜序 Studio-win32-x64/jingxu-studio.exe`（约 349 MB）。
- **Packaged smoke**：Playwright 启动打包 exe，断言标题「镜序 Studio」可见——通过；同时证明打包态下 migration/Schema 资源解析正确（`resolveIsPackaged()` 在真实打包态返回 true）。新增 `apps/desktop/e2e/packaged-smoke.e2e.spec.ts`，无打包产物时自动 skip。
- **资源静态核验**：`resources/migrations` 恰为 `0001/0002/0003`；`resources/schemas/v1` 恰为四份公开 Schema（无第五份）；ASAR 含五阶段 Prompt ID 与五方法 Script/Job/Provider 白名单；扫描无 `sk-` 形式明文 Key（仅 64 字符内容哈希）。
- **字节审计**（vs `merge-base main` `dbee68f0`）：`0001_initial.sql`、`0002_project_command_receipts.sql` 及四根 Schema（`EpisodeStoryboardExport`/`ProjectTransferBundle`/`ScriptStageOutput`/`ShotContract`）**字节未变**；`0003_script_version_receipts.sql` 为本 Change 新增；无 V2/V3 泄漏。
- **门禁计数**：`format:check`/`lint`(--max-warnings=0)/`typecheck`(tsc -b)/`test:collection` 通过；Unit **487/487**、Contract **83/83**、Integration **159/159**、E2E **7/7**（bootstrap 4 + staged-script 2 + packaged-smoke 1）；`openspec validate staged-script-generation --strict` 通过。

## Requirement/Scenario → 代码/测试 覆盖映射（§5.8）

- 五阶段闭环（CONCEPT→STORY_BIBLE→EPISODE_OUTLINE→BEAT_SHEET→SCENE_SCRIPT，DRAFT/READY/STALE_INPUT）：`packages/application/src/script/*`、`apps/desktop/src/main/composition/register-script-features.ts`；E2E `staged-script-generation.e2e.spec.ts`（test 1）；集成 `script-version-service`/`script-job-submission`/`script-job-scheduler`/`script-job-recovery`/`script-generation-runtime`。
- 失败矩阵（401/429/5xx/120s 超时/非法JSON/结构修复失败/提交前STALE/取消迟到/完整响应恢复/未知不重发）：`packages/model-adapters/src/mock/ac-v1-04-provider-matrix.integration.test.ts`（8 场景）+ `packages/application/src/script/script-job-recovery.test.ts`（完整响应恢复·幂等提交一次）+ `script-generation-runtime.test.ts`（`MODEL_UNKNOWN` 不重发）；Mock 适配器 `apps/desktop/src/main/adapters/e2e-script-text-model-adapter.ts`。
- 失败保留/并发/软删恢复/dirty 三选项/只读故障写门/Schema 缺失重试：E2E `bootstrap.e2e.spec.ts` §9.1–§9.4。
- 资源冻结与白名单（Script/Job/Provider 各五方法、`window.jingxu` 冻结、无通用 IPC）：`apps/desktop/src/preload/jingxu-api.contract.test.ts`、`job-provider-api.contract.test.ts`；E2E `staged-script-generation`（test 2）+ `runtime-ipc.contract.test.ts`。
- Migration/Schema 完整性：`packages/persistence/src/migrations/migration-loader.test.ts`、`migration-runner.integration.test.ts`、`apps/desktop/src/main/adapters/schema-resource-adapter.test.ts`；字节审计见上节。
- 凭据安全（safeStorage 加密、仅存 credential_ref、删除同步密文+审计、Renderer 不收 Key/Authorization/原始错误）：`apps/desktop/src/main/ipc/job-provider-service.test.ts`、`job-provider-gate.contract.test.ts`、`register-job-provider-features.test.ts`。

## Sync/Archive

- `openspec validate --strict` 通过、字节审计无阻断。Sync/Archive 属 OpenSpec 生命周期收尾（写入 `openspec/specs/`、归档 change），按惯例在实现合并后执行；本会话已提交实现代码，归档留待合并节点由人工确认后执行。
