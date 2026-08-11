# 镜序 Studio

镜序 Studio 当前是面向 Windows x64 的 Electron/React V1 开发基线。当前已建立 Main/Preload/Renderer 进程隔离、SQLite 启动与恢复运行时、离线 Schema Registry，以及 Project/FormatProfile 的本地创建、查询、更新、软删除和恢复闭环；这不代表 AI 剧本、结构化分镜或 PRD v1.4 全量验收已经实现。

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

当前 Active Change 为 `schema-registry-version-locks`。在 Codex 中使用 `$openspec-apply-change schema-registry-version-locks` 继续实施，完成后使用 `$openspec-verify-change schema-registry-version-locks` 验证。完整规则见 `docs/SDD_WORKFLOW.md` 和 `AGENTS.md`。

## 当前已实现的 Project 与 Schema Registry 切片

- `ProjectService` 支持稳定 keyset 列表、活动/回收站隔离、详情、原子创建、乐观并发更新、FormatProfile 不可变版本链、软删除、恢复和 requestId 幂等回放。
- SQLite `ProjectUnitOfWork` 在单一 `BEGIN IMMEDIATE` 中提交 Project、FormatProfile、审计、本地分析事件和 `command_receipts`；失败回滚不留下部分记录。
- `0002_project_command_receipts.sql` 只保存 requestId、命令名、payload SHA-256、traceId 和安全结果引用，不保存名称、题材、风格、目录或完整命令载荷。
- Main Composition Root 只在启动状态 `READY/writeEnabled=true` 后构造 ProjectService 并注册六个 Project IPC；注册幂等且复用唯一 SQLite 写连接。
- Renderer 已接入 React Query、React Hook Form 和最小 Zustand UI 协调状态，覆盖列表、创建设定、详情、回收站、错误反馈和 dirty 离开保护。
- 四份 PRD-owned Schema 使用固定 `$id`、Draft、语义版本和 SHA-256 离线编译；启动时在短事务精确替换 `schema_registry_manifest`，提交成功后才发布完整 Registry。
- Forge 产物固定包含 `resources/schemas/v1` 四文件；Schema 故障只允许重试，不开放 Project 写服务，也不提供路径或通用 IPC。
- 当前自动化范围包含 Project 与 Schema Registry 的 Unit、Contract、Integration、Electron E2E 和 Windows x64 packaged smoke；OpenSpec Verify 与全量发布门禁仍以本 Change 最终运行结果为准。

## 当前尚未实现

- SourceInput 文本输入和 Consent 授权记录业务用例
- Episode、剧本、StoryBible、分镜、锁、导入导出和评测业务用例
- EpisodeValidator 集合规则，以及剧本/分镜业务调用方对已发布 Registry 的接入
- JobRunner、ScriptStageJob、ModelInvocation 和 Qwen 文本模型调用
- Qwen、API Key、Provider 网络请求
- 图片、视频、TTS、口型、成片和其他 V2/V3 能力
- AC-V1-01 至 AC-V1-06 尚未完成；尤其不能声称 AC-V1-01 AI 原创链路已经验收

这些能力将分别进入后续 OpenSpec Change。`0001_initial.sql` 中存在对应表结构不等于业务方法、页面、Schema 校验或验收链路已经实现。
