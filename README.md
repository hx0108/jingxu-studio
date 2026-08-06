# 镜序 Studio

镜序 Studio 当前是面向 Windows x64 的 Electron/React V1 工程基线。此版本只建立可启动桌面运行时、Main/Preload/Renderer 进程隔离和工程门禁，不代表 PRD 中的 Project、数据库、AI 剧本或结构化分镜能力已经实现。

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
```

Unit、Contract、Integration 和 E2E 使用互斥文件后缀；`pnpm test:collection` 会审计测试文件的唯一归属。

## 构建与打包

```powershell
pnpm build
pnpm package:win
```

生产 Renderer 只加载随应用发布的 `jingxu://app` 本地资源，并使用禁止外部连接的 CSP。开发期 Vite/HMR 例外不进入生产构建。

## OpenSpec 开发流程

功能、架构、IPC、数据库、Schema、Provider 或安全边界变更必须先建立 Active Change：

```text
Explore -> Propose -> 人工审查 -> Apply -> Verify -> Sync -> Archive
```

当前工程基线 Change 为 `bootstrap-electron-workspace`。在 Codex 中使用 `$openspec-apply-change bootstrap-electron-workspace` 实施，完成后使用 `$openspec-verify-change bootstrap-electron-workspace` 验证。完整规则见 `docs/SDD_WORKFLOW.md` 和 `AGENTS.md`。

## 当前明确不做

- SQLite、migration、Repository 和业务数据模型
- Project、FormatProfile、剧本、分镜、导入导出和页面状态矩阵
- Qwen、API Key、Provider 网络请求
- 图片、视频、TTS、口型、成片和其他 V2/V3 能力

这些能力将分别进入后续 OpenSpec Change；本工程基线不提供伪造入口。
