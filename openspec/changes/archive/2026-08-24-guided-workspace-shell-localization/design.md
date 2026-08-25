## Context

现有 Renderer 已具备项目、输入、五阶段剧本、Provider 设置、版本、锁和分镜入口，但使用顶部导航与纵向卡片堆叠。变更必须遵守 TECH_DESIGN v1.1 §4.3 的 Renderer/Preload 边界，并保持现有测试选择器和领域命令语义可兼容。

## Goals / Non-Goals

**Goals:**

- 用单一应用壳和可复用三栏布局承载全局与项目内导航。
- 用纯展示策略映射六阶段进度和中文状态。
- 将核心任务与高级证据分离，同时保留可访问性和诊断能力。

**Non-Goals:**

- 不新增业务 IPC、持久化 UI 状态、migration 或依赖。
- 不改变 Provider、版本、锁、Job、Schema 与 READY 规则。
- 不在未完成入口伪造素材、任务或导出数据。

## Decisions

1. 在 Renderer 增加共享 `AppShell`、`WorkspaceLayout`、`StatusBadge` 和状态映射模块。选择组合组件而非引入 UI 框架，以避免新增依赖和视觉分叉。
2. `ProjectWorkspace` 持有全局区域与项目上下文；进入项目后左栏显示六阶段，剧本阶段展开五个子阶段。选择稳定分栏而非无限画布，因为阶段顺序、READY 和锁是确定性流程。
3. 工作台进度从现有 workspace DTO 派生，不持久化新的领域枚举。未实现的全局区域显示说明页，避免虚构能力。
4. Provider 设置仅在“设置”区域渲染；剧本区接收其就绪状态并显示紧凑门禁。API Key 和技术错误仍由既有安全边界处理。
5. 右栏使用原生 `details` 与响应式抽屉语义；宽屏固定、窄屏折叠，不引入额外状态库。
6. IPC/DTO、Application Port、事务、错误码、migration 均不适用：本 Change 仅修改 Renderer 展示与导航。

## Risks / Trade-offs

- [现有 E2E 依赖 DOM 层级或文案] → 保留关键 `name`、ARIA 标签和业务按钮语义，并同步更新确实依赖旧布局的断言。
- [单页组件继续膨胀] → 把壳、状态词典和检查器拆为共享组件，业务命令留在原工作区。
- [窄屏信息密度过高] → 在 1360px 以下折叠检查器，在 980px 以下让流程栏变为顶部可滚动区。

## Migration Plan

先接入共享壳和中文词典，再迁移项目/输入/剧本页面，最后运行 Renderer、Electron E2E 和打包门禁。回滚只需恢复 Renderer 文件，不涉及数据迁移或用户数据转换。
