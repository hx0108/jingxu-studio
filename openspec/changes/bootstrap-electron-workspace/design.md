## Context

当前仓库只包含 PRD v1.4、TECH_DESIGN v1.1、AGENTS.md、四份 PRD-owned Schema 和示例，尚无 `package.json`、lockfile 或 TypeScript/Electron 代码。变更动机见 `proposal.md`，可观察行为见 `specs/desktop-workspace-foundation/spec.md`。

实现必须遵守 TECH_DESIGN v1.1 §4.1–§4.3的技术栈、工程规范和依赖方向，以及 TECH_DESIGN v1.1 §13.1 的 Electron 安全基线。该 Change 只拆出 TECH_DESIGN v1.1 §20 Sprint 1 中的“Electron/React 工程与安全 BrowserWindow”；SQLite、Repository、Project 等工作留给后续 Change。

## Goals / Non-Goals

**Goals:**

- 交付能安装、启动、检查、测试和打包的最小 Windows x64 Electron/React workspace。
- 从第一个窗口开始落实 Main/Preload/Renderer 边界和默认拒绝安全策略。
- 用显式互斥的测试配置和 Smoke E2E 为后续 Change 建立合并门禁。
- 保持产品真实状态：只显示工程基线，不伪造业务能力。

**Non-Goals:**

- 不创建 SQLite 数据库、migration、Repository、UnitOfWork 或备份逻辑。
- 不实现 Project、FormatProfile、SourceInput、剧本、分镜、导入导出或页面状态矩阵。
- 不引入 Qwen、API Key、safeStorage、Provider 网络或任何真实外部请求。
- 不复制或改写四份业务 Schema，不实现 Schema Registry。
- 不实现图片、视频、TTS、口型、成片或其他 V2/V3 模块。

## Decisions

### 1. 使用单一 pnpm workspace 和 Electron Forge Vite 集成

根目录统一管理 scripts、TypeScript、Lint、格式和测试配置，`apps/desktop` 是唯一可运行应用。使用 Electron Forge 的 Vite 集成分别构建 Main、Preload 和 Renderer，不引入第二套打包系统。根 `packageManager` 和 `engines` 固定支持环境，仓库只保留 `pnpm-lock.yaml`。

**被否决方案：**

- 同时保留 npm/yarn 锁文件：会破坏可重现依赖基线。
- 使用 Next.js 或独立 Web 服务器：增加 V1 本地桌面应用不需要的运行时和网络边界。
- 一次性创建 TECH_DESIGN 中所有未使用 packages：会生成无责任的空模块。本 Change 只创建 `packages/contracts` 用于共享 Preload 公开类型；Domain、Application 和 Adapter packages 由实际需要它们的后续 Change 创建。

### 2. Main、Preload 和 Renderer 保持物理入口分离

`apps/desktop/src/main`、`src/preload` 和 `src/renderer` 分别作为独立构建入口。Main 只负责应用生命周期、安全窗口创建和最小 Composition Root；Preload 只负责白名单暴露；Renderer 只包含 React UI。

`packages/contracts` 公开导出 `JingxuApi = Readonly<Record<string, never>>` 及 Renderer 的 `Window` 类型扩展。Preload 在运行时通过 `contextBridge` 暴露 `Object.freeze({})`；不注册 `ipcMain.handle/on`，也不提供通用通道包装。

**被否决方案：**

- 暴露通用 `invoke(channel, payload)`：频道参数会绕过逐方法 DTO 和 sender 校验。
- 为 Smoke Test 临时新增 `system.ping` IPC：会让脚手架 Change 引入没有产品用例的公开 API。

### 3. 安全策略采用默认拒绝

在 `app.ready` 前调用 `app.enableSandbox()`。通过纯函数构造 BrowserWindow 选项，固定 `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`、`webSecurity=true`，便于 Unit/Integration 直接断言。

生产构建使用受信本地应用 origin 和 CSP `default-src 'self'; script-src 'self'; connect-src 'none'; object-src 'none'`。开发模式仅允许 Forge/Vite 提供的本地开发 origin 和 HMR 所需连接；该例外不进入生产 CSP。

`setWindowOpenHandler` 始终返回 deny；`will-navigate` 只允许当前受信 origin；permission handler 默认返回 false。本 Change 不调用 `shell.openExternal`。

**被否决方案：**

- 依赖 Renderer 隐藏链接或不渲染按钮：这不是运行时安全边界。
- 在开发和生产共用放宽 CSP：会把 HMR 例外带入发布产物。

### 4. 四类测试使用互斥配置

根目录提供三份 Vitest 配置和一份 Playwright 配置：

- `vitest.config.ts` 只收集 `*.test.ts`/`*.test.tsx`，显式排除 Contract、Integration 和 E2E。
- `vitest.contract.config.ts` 只收集 `*.contract.test.ts`。
- `vitest.integration.config.ts` 只收集 `*.integration.test.ts`。
- `playwright.config.ts` 只收集 `*.e2e.spec.ts`。

每类在本 Change 至少有一个真实断言，不使用 `passWithNoTests` 掩盖空门禁：Unit 验证窗口安全选项，Contract 验证 Preload 公开表面，Integration 验证安全窗口装配不注册业务 IPC，E2E 启动 Electron 并检查页面、Node 隔离和 `window.jingxu`。

### 5. 代码风格和边界由静态门禁执行

TypeScript 基线开启 `strict`、`noImplicitAny`、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`。ESLint 使用 Flat Config，包含 TypeScript、React Hooks、Promise 和跨层 import 边界规则；Prettier 是唯一排版工具，EditorConfig 固定 UTF-8、LF 和文件末尾换行。

没有对应代码的目录不预先创建。边界规则从实际存在的 Main/Preload/Renderer/Contracts 开始，后续 Change 新增 Domain/Application/Adapters 时同步扩展。

### 6. 不适用的设计面

- **Application Ports**：本 Change 无业务用例和出站依赖，因此不定义 Port；只用目录与 Lint 规则保留后续依赖方向。
- **业务 IPC/DTO**：不适用；只有空白名单 `JingxuApi` 类型，无 Command/Query、`requestId` 或错误 DTO。
- **数据流与事务**：不适用；不保存数据、不请求 Provider、不启动 UnitOfWork。
- **业务错误码**：不适用；启动、构建和测试失败保留工具非零退出码和诊断输出。
- **Migration**：不适用；不引入数据库或持久化格式。

## Risks / Trade-offs

- **[Windows 本地模块安装和 Electron 下载可能受网络影响]** → lockfile 锁定依赖，失败时保留原始诊断并不降级包管理器或安全选项。
- **[Electron Forge/Vite 开发模式需要本地端口与 HMR]** → 开发例外只对 Forge 注入的本地 origin 生效，生产 CSP 保持 `connect-src 'none'`，E2E 同时断言生产安全配置。
- **[空白名单 `window.jingxu` 短期内没有业务价值]** → 该入口只是进程边界契约；后续 Change 必须逐方法增加类型和校验，不得替换为通用通道。
- **[首个 Change 未创建全部目标 packages]** → 避免空模块和未来推测；每个后续 Change 在首次需要包时建立其公开入口和边界测试。
- **[当前系统 pnpm/npm 全局入口存在环境差异]** → 仓库通过 `packageManager`、`engines`、lockfile 和安装文档声明支持环境；不把开发机全局 PATH 状态写入项目逻辑。

## Migration Plan

1. 从当前文档基线创建 `codex/bootstrap-electron-workspace` 分支。
2. 先落地 workspace、工具配置和可失败的安全/边界测试，再实现最小 Electron 进程与 React 空白界面。
3. 运行全部格式、Lint、类型、Unit、Contract、Integration 和 E2E 门禁，再生成 Windows x64 本地打包产物做 Smoke 验证。
4. 验证通过后 Sync 并 Archive；本 Change 无数据迁移或用户数据切换。

回滚时只回退本 Change 新增的工程与依赖文件，保留归档前已存在的 PRD、TECH、Schema、AGENTS 和 OpenSpec 基线。由于无数据库和公开业务 API，不需要数据恢复或兼容分支。
