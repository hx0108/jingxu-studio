## Why

当前 Renderer 以顶部页签和连续长卡片承载项目、Provider、五阶段剧本及专业证据，用户难以判断当前位置、阻塞原因和下一步操作，且用户可见状态仍混有英文。为满足 PRD v1.4 §15.1 的页面状态和操作反馈要求，需要在不改变既有领域语义的前提下建立引导式三栏工作台。

## What Changes

- 建立包含首页、项目、创作工作台、素材、任务、导出、质量与设置的固定左侧导航。
- 将项目创作组织为创作输入、剧本开发、分镜设计、画面生成、视频生成、合成导出六阶段，并在剧本开发中保留五个垂直子阶段。
- 将 Provider 凭据设置移出核心创作内容，只在工作台显示脱敏的配置状态和设置入口。
- 建立中间创作区、右侧上下文检查器、固定主操作和窄窗口抽屉行为。
- 将领域状态、任务状态和风险等级映射为中文展示，错误码仅在可展开的诊断详情中保留。
- 不修改 IPC、数据库、Schema、版本、锁、Job 或 READY 语义。

## Capabilities

### New Capabilities

- `guided-creator-workspace`: 定义引导式三栏工作台、阶段进度、主要操作、渐进式专业信息和中文展示要求。

### Modified Capabilities

- `desktop-workspace-foundation`: 将已实现桌面应用的 Renderer 从早期顶部导航演进为可访问、可适配的固定工作台框架。

## Impact

- 主要影响 `apps/desktop/src/renderer` 的应用壳、项目页、输入页、剧本工作区、共享样式与 Renderer 测试。
- 复用现有 Preload/IPC；不新增依赖、不改变数据库、Schema、Main、Provider 或安全边界。
- 需要复跑 PRD v1.4 §15.1 页面状态、TECH_DESIGN v1.1 §4.3 Renderer 边界及关键剧本 Electron E2E。
