# 镜序 Studio

镜序 Studio 是面向个人 AI 漫剧创作者的本地优先质量工作台，当前开发目标为 V1“AI 剧本与结构化分镜”。项目尝试把模型生成转化为可编辑、可锁定、可恢复、可追溯的阶段化工作流，而不是直接承诺生成图片、视频或成片。

截至 2026-08-15，仓库已具备可运行的 Windows x64 Electron/React 工程、SQLite 启动与恢复运行时、Project/FormatProfile 管理、离线 Schema Registry，以及 JobRunner、文本模型 Adapter、凭据安全和类型化 IPC 基础；真实 Qwen 五阶段生成链路已于 2026-08-14 通过开发者环境全流程联调。项目仍处于开发验证阶段，尚未上线、完成真实用户试用或通过 PRD v1.4 全量验收。

## 支持环境

- Windows x64
- Node.js `22.16.x`（仓库接受 `>=22.16.0 <23`）
- pnpm `11.16.x`（仓库接受 `>=11.16.0 <12`）

仓库只使用 `pnpm-lock.yaml`。不要生成或提交 npm、Yarn 等其他包管理器的锁文件。

## 安装与启动

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

SQLite 使用锁定的 Node.js 与 Electron 内置 `node:sqlite`，不需要 Visual Studio、C++ Build Tools、外部 SQLite `.node` 或 Electron native rebuild。开发 Node 与 Electron 内置 Node 的兼容性分别由 Integration、Electron E2E 和 Windows x64 packaged smoke 验证。

若 Electron 官方二进制无法由安装脚本下载，应先核验官方压缩包的 SHA-256，再放入 Electron 缓存并重新运行官方安装脚本；不要伪造 `path.txt`、关闭 pnpm 供应链门禁或降低安全配置。

使用自定义已校验缓存时，安装脚本和 Packager 的缓存变量不同：

```powershell
$env:electron_config_cache = "C:\path\to\verified-electron-cache"
pnpm exec install-electron --no

$env:ELECTRON_CACHE = "C:\path\to\verified-electron-cache"
pnpm package:win

# Packager 也可直接使用已校验的 Electron ZIP 目录；目录内文件名必须为官方格式。
$env:JINGXU_ELECTRON_ZIP_DIR = "C:\path\to\verified-electron-zip-directory"
pnpm package:win
```

## 工程门禁

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:collection
pnpm test
pnpm test:contract
pnpm test:integration
pnpm test:e2e
pnpm package:win
```

Unit、Contract、Integration 和 E2E 使用互斥文件后缀；`pnpm test:collection` 会审计测试文件的唯一归属。

## 构建与打包

```powershell
pnpm build
pnpm package:win
```

生产 Renderer 只加载随应用发布的 `jingxu://app` 本地资源，并使用禁止外部连接的 CSP。开发期 Vite/HMR 例外不进入生产构建。

## 本地数据库与恢复边界

- 生产数据库：`%LOCALAPPDATA%\JingxuStudio\data\jingxu.sqlite`
- 受管理升级备份：`%LOCALAPPDATA%\JingxuStudio\backups\`
- 恢复诊断证据：`%LOCALAPPDATA%\JingxuStudio\diagnostics\`
- 应用只有在数据库打开、PRAGMA、migration、audit、recovery gate 和离线 Schema Registry 全部通过后才进入 `READY`；否则只显示独立只读故障页。
- Renderer 只能通过 `runtime.getStartupStatus`、`runtime.retryStartup` 和 `runtime.restoreBackup` 使用 opaque backup id，不能提交路径、SQL 或连接。
- Project 页面只通过 `project.list/get/create/update/delete/restore` 六个类型化方法访问 Main；Preload 不暴露通用 `send/on/invoke`。
- V1 JSON 导入导出是 CURRENT_ONLY 交换格式，不是完整 SQLite 备份，不能替代受管理数据库备份。
- 当前版本不会自动删除备份或诊断副本；空间治理需后续独立 Change。

## OpenSpec 开发流程

功能、架构、IPC、数据库、Schema、Provider 或安全边界变更必须先建立 Active Change：

```text
Explore -> Propose -> 人工审查 -> Apply -> Verify -> Sync -> Archive
```

当前 Active Change 为 `shot-contract-generation`（结构化分镜生成，提案审查中，尚未进入 Apply）。最近归档的 Change 为 `staged-script-generation`（2026-08-15）。该 Change 在代码层完成 AI 原创初始化、五阶段剧本版本链、JobRunner 生产接线、Provider 设置和剧本工作区，并通过最终全量门禁与 Windows x64 clean packaged smoke（离线 Mock）；真实 Qwen 凭据连通性与五阶段生成已于 2026-08-14 通过开发者环境全流程联调，真实用户验收仍待人工核验。完整规则见 `docs/SDD_WORKFLOW.md` 和 `AGENTS.md`。

## 当前已实现

- `ProjectService` 支持稳定 keyset 列表、活动/回收站隔离、详情、原子创建、乐观并发更新、FormatProfile 不可变版本链、软删除、恢复和 requestId 幂等回放。
- SQLite `ProjectUnitOfWork` 在单一 `BEGIN IMMEDIATE` 中提交 Project、FormatProfile、审计、本地分析事件和 `command_receipts`；失败回滚不留下部分记录。
- `0002_project_command_receipts.sql` 只保存 requestId、命令名、payload SHA-256、traceId 和安全结果引用，不保存名称、题材、风格、目录或完整命令载荷。
- Main Composition Root 只在启动状态 `READY/writeEnabled=true` 后构造 ProjectService 并注册六个 Project IPC；注册幂等且复用唯一 SQLite 写连接。
- Renderer 已接入 React Query、React Hook Form 和最小 Zustand UI 协调状态，覆盖列表、创建设定、详情、回收站、错误反馈和 dirty 离开保护。
- 四份 PRD-owned Schema 使用固定 `$id`、Draft、语义版本和 SHA-256 离线编译；启动时在短事务精确替换 `schema_registry_manifest`，提交成功后才发布完整 Registry。
- Forge 产物固定包含 `resources/schemas/v1` 四文件；Schema 故障只允许重试，不开放 Project 写服务，也不提供路径或通用 IPC。
- Application 层已定义 `TextModelPort`、`CredentialPort` 和确定性 `JobRunner`，覆盖任务领取、调用证据、受限重试、结构修复、取消、迟到响应、崩溃恢复和并发门；Provider 调用发生在事务外，业务提交保持短事务边界。
- `MockTextModelAdapter` 提供可重复的失败矩阵；`QwenTextModelAdapter` 锁定受控配置、JSON Mode 和错误归一化。生产入口已接入真实五阶段剧本生成（ScriptJobSubmission/Runner/Scheduler/Recovery），五阶段闭环经离线 Mock 验证；真实 Qwen 凭据连通性与五阶段生成已于 2026-08-14 通过全流程联调。
- API Key 由 Electron `safeStorage` 加密并独立保存，SQLite 只记录不透明凭据引用和验证元数据；Renderer 不接收完整 Key、Authorization 或原始 Provider 错误。
- Main/Preload 已提供逐方法的 `script`、`job`、`provider` 和 `events` IPC 白名单；`staged-script-generation` 已注入阶段提交器，`job.create` 开放真实剧本生成，不再返回 `JOB_SUBMISSION_UNAVAILABLE`，也不创建假版本或空壳任务。
- `staged-script-generation` 已实现 SourceInput/Consent/Episode 初始化、五阶段 ScriptService、不可变 DRAFT/READY/STALE_INPUT 版本链、版本历史与恢复、五阶段 Prompt（v2/story_bible v3）、Script Job 提交/校验/恢复，以及 `script` 五方法白名单和剧本工作区；已通过 `openspec validate --strict`、全量门禁与 clean packaged smoke（离线 Mock），后续经真实 Qwen 全流程联调于 2026-08-15 归档。

## 最近验证证据

2026-08-15 `staged-script-generation` 收尾记录（真实 Qwen 联调 + 缺陷修复 + 归档）：

- 真实 Qwen 五阶段生成于 2026-08-14 通过全流程联调：CONCEPT→STORY_BIBLE→EPISODE_OUTLINE→BEAT_SHEET→SCENE_SCRIPT 全部 SUCCEEDED，单次 INITIAL 零修复通过；联调发现的 `model_invocations` 外键删除阻塞经迁移 0006 与 `deleteCredential` 顺序修复后，生产库完成凭据清理并写入审计证据。
- 联调暴露的四项 UX 缺陷已修：STRUCTURE_REPAIR 修复上下文进入 messages（修复重试不再原样重发）、error_json 字段级明细（bounded details，截断 10 条）、testCredential 透传 `MODEL_*` 稳定失败码、凭据变更时 `lastValidatedAt` 归零；迁移 0007 解除两快照表 `provider_profiles` 外键，迁移 head=7。
- Format、ESLint、TypeScript 门禁零错误；Unit 493、Contract 83、Integration 159 全部通过；main/renderer/preload 产物重建。
- `openspec archive staged-script-generation` 完成（specs +7 能力）。
- 生产数据库 0007 已通过真实启动路径应用并留证：启动全阶段通过至 `READY/writeEnabled=true`，schema_migrations 记录 1–7 且 checksum 与源文件一致，`foreign_key_check` 零违例、`integrity_check` ok，业务表行数不变，升级前自动生成「Schema v6」在线备份。
- 真实用户使用、AC-V1-01 至 AC-V1-06 验收仍待人工核验。

2026-08-13 `staged-script-generation` Change 记录（离线 Mock，未含真实 Qwen 联调）：

- Format、ESLint、TypeScript 门禁零错误。
- Unit 487、Contract 83、Integration 159，共 729 项 Vitest 断言通过。
- Playwright Electron E2E 7/7 通过（bootstrap 4 + staged-script 2 + packaged-smoke 1）。
- Windows x64 clean packaged smoke 通过；`openspec validate staged-script-generation --strict` 通过；四根 Schema 与 0001/0002 字节未变。
- 真实 Qwen 凭据连通性、真实用户生成链路和 AC-V1-01 至 AC-V1-06 仍待人工核验。

2026-08-13 归档的 `jobrunner-qwen-text-adapter` Change 记录：

- Format、ESLint 和 TypeScript 门禁零错误。
- Unit 41 文件/382 项、Contract 10 文件/69 项、Integration 27 文件/142 项，共 593 项 Vitest 断言通过。
- Playwright Electron E2E 4/4 通过。
- Windows x64 packaged smoke 通过；Mock 失败矩阵不访问真实网络或真实用户目录。

完整映射与边界见 `openspec/changes/archive/2026-08-13-jobrunner-qwen-text-adapter/tasks.md`。真实 Qwen 凭据连通性和真实用户生成链路不包含在上述离线验证中。

## 当前尚未实现

- EpisodeValidator、结构化分镜生成与编辑、锁、导入导出和评测业务用例
- EpisodeValidator 集合规则，以及剧本/分镜业务调用方对已发布 Registry 的接入
- 真实用户使用和发布验收（真实 Qwen 阶段生成连通性已于 2026-08-14 通过开发者环境全流程联调）
- 图片、视频、TTS、口型、成片和其他 V2/V3 能力
- AC-V1-01 至 AC-V1-06 尚未全部完成；AC-V1-04 目前具备可重复的 Mock 自动化证据与一次真实 Qwen 开发者环境全流程运行，仍不能据此声称真实用户使用或 V1 发布验收已经完成

这些能力将分别进入后续 OpenSpec Change。`0001_initial.sql` 中存在对应表结构不等于业务方法、页面、Schema 校验或验收链路已经实现。
