## Context

见 `proposal.md` 的 Why。当前 Renderer 已有 `AppShell`、`WorkspaceLayout`、项目工作区和媒体工作区，但样式来自多轮增量叠加，存在重复选择器、两套尺寸系统和设置页居中布局。最新批准原型位于 `designs/jingxu-studio-prototype/`，其 HTML/React/CSS 和同视口截图构成本 Change 的视觉事实源。PRD v1.4 §15.1 的页面状态与 TECH_DESIGN v1.1 的 Renderer→Preload/IPC 边界继续有效。

## Goals / Non-Goals

**Goals:**

- 用一套正式设计 token 和稳定布局骨架映射批准原型。
- 让真实数据驱动的输入、剧本、分镜、媒体、合成和设置页面共享字号、卡片、状态与操作层级。
- 保留现有组件行为、IPC 调用、测试选择器和可访问名称，降低回归风险。
- 在 1920×920、1366×768 和窄窗口状态下验证布局可用。

**Non-Goals:**

- 不把原型的 Mock 数据、计时器或演示行为复制到正式业务代码。
- 不调整 Application Port、IPC/DTO、Schema、SQLite、事务、错误码或 Provider 能力。
- 不新增图片/视频模型能力、转场、TTS、口型、多集时间线或云能力。

## Decisions

### 1. 原型作为视觉 token 与布局来源，正式组件继续承载业务行为

从原型提取颜色、宽度、间距、字号、状态和卡片规则到正式 `styles.css`，并按现有 React 组件结构应用 class；不直接把 `prototype.js` 或 Mock 组件复制进产品。这样可以保持真实 IPC/状态机不变，也避免形成第二套业务实现。否决“用 iframe 嵌入原型”，因为它破坏 Renderer 数据流、可访问性和安全边界。

### 2. 统一为两层 Shell

外层 `AppShell` 固定 216px 全局导航；项目内 `WorkspaceLayout` 使用 264px 流程栏、`minmax(0,1fr)` 画布和 368px 检查器。低于 1360px 时检查器改为跨列可折叠区域，低于 980px 时流程栏改为顶部可滚动区域。否决为媒体阶段继续维护独立三栏网格，因为它会造成脚本与媒体阶段切换时位置和字号跳变。

### 3. 顶部只承担定位，不承担保存状态

项目页头只保留返回/面包屑、当前项目或阶段和必要操作；保存反馈继续在触发保存的内容区或底部操作区展示。删除全局重复保存文案不会改变持久化语义。技术状态和错误码留在检查器的高级信息中。

### 4. 使用显式可读字号下限

业务信息最低 12px，正文/检查器常用信息 13–14px，导航 15px，阶段标题 14px，主要标题 26–32px。仅品牌副标题和纯装饰编号允许 10–11px。采用显式组件规则而非全局 `zoom`，避免表单点击区域、媒体比例和 Electron 缩放失真。

### 5. 模型服务使用纵向横卡和固定状态槽

设置内容取消居中最大宽布局，使用左侧 32px 起始间距和 980px 最大卡片宽度。每张卡片按服务标识、配置状态、当前模型、脱敏凭据和管理操作排列；状态槽 `min-width: 76px; min-height: 36px`。窄屏改为两列/单列字段，不隐藏状态。

### 6. 测试与视觉 QA 分层

Unit/React 测试断言中文文案、禁用原因、布局 class 和敏感信息不泄露；Electron E2E 复跑核心创作链与媒体链；视觉 QA 使用与原型相同视口、相同页面状态的截图并排对比，记录在 `design-qa.md`。截图只作为视觉证据，不替代行为测试。

## Architecture and Data Flow

- 受影响层：仅 Renderer 组件、CSS 和 Renderer/Electron E2E 测试。
- Application Ports：不适用；不新增或修改 Port。
- IPC/DTO：不适用；现有方法和 DTO 原样复用。
- 数据流：真实业务数据仍由 `window.jingxu` → React 状态/Query → 现有组件，新增的展示状态只在 Renderer 计算。
- 事务与 migration：不适用；无数据库写法变化，无 migration。
- 错误码：不新增；稳定错误码继续仅在展开的高级详情显示。
- 安全边界：Renderer 仍不接触本地路径、Key、FFmpeg 命令、SQL 或 Provider 原始响应。

## Risks / Trade-offs

- [风险] 单一 `styles.css` 已有重复规则，新增覆盖可能继续累积 → 按 Shell、工作区、组件、响应式四段整理，只修改本 Change 触及的选择器并用现有测试防回归。
- [风险] 固定三栏宽度在常见笔记本窗口拥挤 → 1360px 与 980px 两级折叠，保证画布和主操作优先。
- [风险] 视觉调整影响现有 E2E 定位 → 保留角色、标签和测试 ID，优先使用语义定位而不是 DOM 层级。
- [取舍] 原型含演示性的候选和导出反馈，正式页面不会复制假数据 → 仅迁移结构与样式，空/失败/运行状态继续由真实业务数据决定。

## Migration Plan

1. 先建立 token、App Shell 和工作区布局，保持页面组件可运行。
2. 迁移剧本与检查器，再迁移分镜/媒体/合成和设置。
3. 更新测试并执行静态门禁、Unit、Contract、Integration 和相关 Electron E2E。
4. 使用同视口截图完成视觉 QA；若出现回归，可按组件 CSS 变更回退，不涉及业务数据回滚。
