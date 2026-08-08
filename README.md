# 镜序 Studio

镜序 Studio 当前是面向 Windows x64 的 Electron/React V1 开发基线。当前已建立 Main/Preload/Renderer 进程隔离，以及 SQLite 启动、migration、升级备份、自检、只读故障和受控恢复运行时；这不代表 PRD 中的 Project、AI 剧本或结构化分镜业务能力已经实现。

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
- 应用只有在数据库打开、PRAGMA、migration、audit 和 recovery gate 全部通过后才进入 `READY`；否则只显示独立只读故障页。
- Renderer 只能通过 `runtime.getStartupStatus`、`runtime.retryStartup` 和 `runtime.restoreBackup` 使用 opaque backup id，不能提交路径、SQL 或连接。
- V1 JSON 导入导出是 CURRENT_ONLY 交换格式，不是完整 SQLite 备份，不能替代受管理数据库备份。
- 当前版本不会自动删除备份或诊断副本；空间治理需后续独立 Change。

## OpenSpec 开发流程

功能、架构、IPC、数据库、Schema、Provider 或安全边界变更必须先建立 Active Change：

```text
Explore -> Propose -> 人工审查 -> Apply -> Verify -> Sync -> Archive
```

当前 Active Change 为 `sqlite-migration-runtime`。在 Codex 中使用 `$openspec-apply-change sqlite-migration-runtime` 实施，完成后使用 `$openspec-verify-change sqlite-migration-runtime` 验证。完整规则见 `docs/SDD_WORKFLOW.md` 和 `AGENTS.md`。

## 当前明确不做

- Project Repository、UnitOfWork 和业务用例
- Project、FormatProfile、剧本、分镜、导入导出和页面状态矩阵
- Qwen、API Key、Provider 网络请求
- 图片、视频、TTS、口型、成片和其他 V2/V3 能力

这些能力将分别进入后续 OpenSpec Change；当前 SQLite 表结构只建立持久化约束，不提供伪造业务入口。
