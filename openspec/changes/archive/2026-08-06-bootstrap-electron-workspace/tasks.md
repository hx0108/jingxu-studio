## 1. 工作区与工具基线

- [x] 1.1 创建并切换到 `codex/bootstrap-electron-workspace` 分支，记录 Node/pnpm 版本与干净安装前置条件。
- [x] 1.2 建立根 `package.json`、`pnpm-workspace.yaml` 和 `apps/desktop`/`packages/contracts` package manifests，声明 `packageManager`、`engines`、Electron/React/Vite/Forge 依赖和稳定根脚本；精确固定 Forge `8.0.0-alpha.10` 与 TypeScript `6.0.3`，保持 pnpm 11 供应链门禁并记录发布前升级退出条件。[Spec: 可重现的工程工作区]
- [x] 1.3 使用 pnpm 安装并生成唯一 `pnpm-lock.yaml`，核对固定 Git 提交可审计且冻结安装通过，并检查仓库不存在 npm/Yarn 锁文件或被误提交的依赖产物。[Scenario: 干净环境安装与启动]
- [x] 1.4 落地 strict `tsconfig` 基线、ESLint Flat Config 跨层边界、Prettier 和 EditorConfig，保证不支持的引擎环境以非零结果停止。[Scenario: 不支持的环境无法安静降级]

## 2. 测试先行与收集边界

- [x] 2.1 创建三份 Vitest 配置和一份 Playwright Electron 配置，显式设置互斥 `include`/`exclude`/`testMatch`，并将根四个测试脚本分别绑定到对应配置。[Scenario: 四类测试不重复收集]
- [x] 2.2 先添加会失败的 Unit Test，断言主窗口四项安全选项、导航/窗口/权限默认拒绝和生产 CSP。[Spec: 安全桌面运行时基线]
- [x] 2.3 先添加会失败的 Contract Test，断言 `window.jingxu` 类型/运行时表面为冻结空白名单，且不含 `send/on/once/invoke`。[Scenario: 首个 Change 不暴露业务 IPC]
- [x] 2.4 先添加会失败的 Integration Test，断言安全窗口装配不注册业务 IPC、不调用 Shell 且只接受受信 origin。[Spec: Renderer 权限与 Preload 白名单隔离]
- [x] 2.5 先添加会失败的 Electron E2E，断言应用启动、空白工程文案、Node 全局隔离、`window.jingxu` 表面及无伪造业务入口。[Scenarios: Renderer 无法访问 Node.js；空白界面显示真实开发状态]
- [x] 2.6 添加测试收集自检或 Runner 列表断言，证明每个样本只归属一个命令，任一断言失败时保留非零退出码。[Spec: 互斥且可审计的工程门禁]

## 3. 最小 Electron/React 实现

- [x] 3.1 在 `packages/contracts` 定义并公开导出空白名单 `JingxuApi` 和 Renderer `Window` 类型扩展，不定义业务 DTO 或通用频道入口。[Scenario: 首个 Change 不暴露业务 IPC]
- [x] 3.2 实现 Preload 入口，只通过 `contextBridge` 暴露 `Object.freeze({})` 并通过 Contract Test。[Spec: Renderer 权限与 Preload 白名单隔离]
- [x] 3.3 实现可独立测试的受信 origin、BrowserWindow 选项、导航、新窗口和权限拒绝策略，在应用 ready 前启用 sandbox。[Spec: 安全桌面运行时基线]
- [x] 3.4 实现最小 Main 入口与 Composition Root，加载开发期本地 Vite origin 或生产期受信本地资源，不注册 IPC、不访问网络/数据库/密钥。[Scenarios: 未受信导航与新窗口被拒绝；打包应用不连接外部资源]
- [x] 3.5 实现 React 空白工程页，只显示“镜序 Studio V1 工程基线”和当前非业务状态，不添加 Project、AI、分镜、Provider 或导入导出控件。[Spec: 工程基线不伪造业务能力]
- [x] 3.6 配置 Forge/Vite 的 Main、Preload、Renderer 构建和 Windows x64 package 脚本，将开发 HMR 例外与生产 CSP 彻底分离。[Spec: 可重现的工程工作区]

## 4. 工程文档与全量验证

- [x] 4.1 新增最小开发 README，记录支持环境、pnpm 安装/启动/测试/打包命令、当前非目标和 OpenSpec Apply/Verify 路径，不宣称业务 AC 已完成。[Scenario: 空白界面显示真实开发状态]
- [x] 4.2 运行 `pnpm format:check`、`pnpm lint` 和 `pnpm typecheck`，修复实际失败而不关闭 strict、Lint 或格式门禁。[Scenario: 任一必需门禁失败时整体失败]
- [x] 4.3 分别运行 `pnpm test`、`pnpm test:contract`、`pnpm test:integration` 和 `pnpm test:e2e`，记录各 Runner 收集数、通过/失败数和未验证项。[Spec: 互斥且可审计的工程门禁]
- [x] 4.4 运行 Windows x64 package 命令并启动本地打包产物做 Smoke 检查，验证本地资源、生产 CSP、Renderer 隔离和空白 `window.jingxu`。[Scenarios: 打包应用不连接外部资源；Renderer 无法访问 Node.js]
- [x] 4.5 执行 OpenSpec Verify，逐项对账 Requirement/Scenario、任务、测试和 diff；处理所有阻断项后再 Sync/Archive，并在归档记录实际证据与剩余风险。
