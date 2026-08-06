## Why

镜序 Studio 当前只有 PRD、技术设计和机器契约，还没有可启动、可验证的 Electron 工程基线。在实现数据库或 AI 工作流前，需要先建立符合进程隔离、依赖方向和测试门禁的最小可运行桌面工程，避免后续能力建立在不安全或不可重现的脚手架上。

## What Changes

- 建立仅使用 `pnpm-lock.yaml` 的 pnpm workspace，引入 Electron、React、TypeScript、Vite 和 Electron Forge 的最小可启动工程。
- 按 TECH_DESIGN v1.1 §4.2 建立 Main、Preload、Renderer 及当前所需最小 packages 目录，保持 TECH_DESIGN v1.1 §4.3.3 的依赖方向。
- 建立安全 BrowserWindow 和本地受信资源加载基线，落实 TECH_DESIGN v1.1 §13.1 的 sandbox、context isolation、导航和窗口限制。
- 通过 Preload 暴露冻结的类型化 `window.jingxu` 空白名单入口；本 Change 不新增业务 IPC，不暴露通用 `send/on/invoke`。
- 落地 TECH_DESIGN v1.1 §4.3.1–§4.3.2 的 strict TypeScript、ESLint Flat Config、Prettier 和 EditorConfig。
- 配置互斥的 Unit、Contract、Integration 和 Playwright Electron E2E 收集范围，建立格式、Lint、类型和测试命令。
- 添加 Electron 启动与 Renderer 隔离 Smoke E2E，为 PRD v1.4 §9.10 的 AC-V1-01 至 AC-V1-06 和 PRD v1.4 §19.2 的可运行 Demo 提供后续自动化载体；本 Change 不宣称完成任一业务 AC。

## Capabilities

### New Capabilities

- `desktop-workspace-foundation`: 定义镜序 Studio 最小可启动桌面工程、Electron 安全边界、Renderer/Preload 隔离以及开发门禁的可观察要求。

### Modified Capabilities

- 无。当前 `openspec/specs/` 尚无已归档能力，本 Change 只新增工程基础能力。

## Impact

- **代码与目录**：新增 `apps/desktop` 和当前脚手架所需的最小 `packages/` 结构，不创建空的 V2/V3 模块。
- **依赖与构建**：新增根 `package.json`、`pnpm-workspace.yaml`、唯一 lockfile、Vite/Electron Forge 配置及测试 Runner 配置。
- **公开接口**：只新增类型化 `window.jingxu` 空白名单入口，无业务方法、命令或查询。
- **Schema**：不修改四份 PRD-owned JSON Schema；不实现 Schema Registry，仅保留后续资源复制与 Contract Test 的工程位置。
- **数据库与 migration**：不引入 SQLite、`better-sqlite3`、Repository、migration runner 或数据文件。
- **进程与安全**：建立 Main/Preload/Renderer 边界；Renderer 不获得 Node、文件系统、Shell、Provider 或通用 IPC 能力。
- **兼容性**：当前无已发布代码、数据库或公开 IPC，因此无数据迁移和向后兼容负担。
- **明确非目标**：SQLite/Project/FormatProfile、Qwen/API Key/网络请求、剧本与分镜业务、导入导出，以及图片、视频、TTS、口型和其他 V2/V3 能力均不在本 Change 范围。
