# Apply 实施基线

记录日期：2026-09-23

## 当前工作树

- 开始 Apply 前工作树已有 55 个受版本控制文件被修改，另有原型目录、结构化表单、首次体验准备服务和本 Change 等未跟踪内容。
- 这些修改属于用户已有工作；本 Change 只在需要的文件上做增量修改，不回退、不覆盖无关改动。
- 当前数据库 migration head 为 `0026_project_experience_mode.sql`；本 Change 使用新的 `0027_editable_composition_timeline.sql`，不改写历史 migration。
- `simplify-first-run-creator-experience` 已有完整实现改动，主要覆盖首页续作、DEMO 项目、准备检查和结构化脚本表单。本 Change 在其结果上实现正式十页工作台。
- Agnes Provider 已有未提交修改，涉及模型清单、图片适配器、注册和设置页。本 Change 仅复用其公开状态与命令，不重写 Provider 行为。
- `designs/jingxu-ai-drama-prototype/` 是已批准交互与视觉参考；正式实现不得嵌入该静态页面，也不得把其 `localStorage` 或演示数组作为业务事实源。

## 重叠文件保护清单

### Renderer

- `apps/desktop/src/renderer/src/project/ProjectWorkspace.tsx`
- `apps/desktop/src/renderer/src/project/CreatorHome.tsx`
- `apps/desktop/src/renderer/src/project/ProjectDetail.tsx`
- `apps/desktop/src/renderer/src/script/ScriptWorkspace.tsx`
- `apps/desktop/src/renderer/src/script/StoryboardPanel.tsx`
- `apps/desktop/src/renderer/src/script/FirstFramePanel.tsx`
- `apps/desktop/src/renderer/src/script/VoicePanel.tsx`
- `apps/desktop/src/renderer/src/script/VideoCompositionPanel.tsx`
- `apps/desktop/src/renderer/src/script/ProviderSettings.tsx`
- `apps/desktop/src/renderer/src/ui/AppShell.tsx`
- `apps/desktop/src/renderer/src/ui/WorkspaceLayout.tsx`
- `apps/desktop/src/renderer/src/styles.css`

### Main / Preload

- `apps/desktop/src/main/composition/register-video-features.ts`
- `apps/desktop/src/main/composition/register-voice-features.ts`
- `apps/desktop/src/main/composition/register-image-features.ts`
- `apps/desktop/src/main/main.ts`
- `apps/desktop/src/preload/jingxu-api.ts`

### Application / Contracts

- `packages/contracts/src/video-api.ts`
- `packages/application/src/media/video-composition-service.ts`
- `packages/application/src/ports/media/video-composition-repository.ts`

### Persistence

- `packages/persistence/src/media/sqlite-video-composition-repository.ts`
- `packages/persistence/src/media/media-migration.integration.test.ts`
- `packages/persistence/src/runtime/persistence-runtime-adapter.ts`

## 实施约束

1. 每个重叠文件先查看现有 diff，再做局部补丁。
2. 正式项目数据只来自 IPC/Application/SQLite；原型数组只用于视觉和文案映射。
3. Renderer 撤销/重做历史只属于未保存草稿；保存后以 SQLite 不可变时间线版本为事实源。
4. V1 四份 JSON Schema 不因本 Change 修改；媒体与剪辑能力仍按 V2 实施证据单独验收。

## 定向测试基线

Apply 修改开始前已运行：

- Renderer / Application 定向单元测试：6 个文件、65 个测试全部通过。
- SQLite 合成时间线 Repository 集成测试：1 个文件、3 个测试全部通过。
- 创作首页与六步续作 Electron E2E：8 个测试全部通过，耗时约 1.1 分钟。

基线未发现既有失败。十页完整导航与真实三轨编辑尚无对应 E2E，属于本 Change 需要新增的验收覆盖，不能用上述结果代替。
