## Why

当前正式 Renderer 已具备引导式工作台骨架，但与最新可用性原型在页面密度、文字可读性、顶部信息、检查器宽度和模型服务布局上仍不一致，用户仍会遇到留白过多、信息过密和状态文字难读的问题。现在需要以 `designs/jingxu-studio-prototype/` 为唯一视觉基线，将已验证的界面规则落入真实业务页面，同时保持 PRD v1.4 §15.1 的页面状态、TECH_DESIGN v1.1 Renderer 分层和现有领域语义不变。

## What Changes

- 将正式 App Shell、全局导航、项目流程栏、创作画布和上下文检查器调整为原型定义的稳定三栏尺寸、间距和层级。
- 删除页面顶部重复的“项目进度自动保存 · 最近保存于刚刚”提示，只保留面包屑、当前区域和必要操作。
- 建立正式 Renderer 的可读字号下限与中文展示层级，放大流程状态、检查器、正文辅助信息和按钮文字。
- 统一创作输入、五阶段剧本、分镜、画面、视频和合成导出的卡片、底部主操作栏、状态与失败提示样式。
- 将“设置 → 模型服务”改为靠近侧边栏的左对齐纵向服务卡片；为“已配置”提供固定可容纳尺寸，避免溢出。
- 补充窄窗口适配、键盘焦点和用户可见英文/技术信息泄露检查。
- 不新增或修改业务 IPC、数据库、Schema、Provider、版本、锁、Job、READY 或导出事务语义。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `guided-creator-workspace`: 明确顶部信息精简、可读字号、检查器尺寸和模型服务页面的原型一致性要求。
- `storyboard-media-workspace`: 明确分镜、媒体候选与合成页面必须采用同一三栏视觉层级和固定底部主操作区域。

## Impact

- 主要影响 `apps/desktop/src/renderer/src/` 下 App Shell、工作区布局、项目/剧本/分镜/媒体/合成/设置组件与样式，以及相应 Unit/Electron E2E。
- 视觉基线为 `designs/jingxu-studio-prototype/index.html`、`styles.css`、`components.jsx` 和最新原型截图。
- 不影响 Preload/Main/Application/Domain/Persistence，不新增依赖，不修改 migration、公开 DTO 或四份 PRD-owned Schema。
- 兼容现有项目数据与任务状态；仅改变 Renderer 的信息组织和用户可见文案。
