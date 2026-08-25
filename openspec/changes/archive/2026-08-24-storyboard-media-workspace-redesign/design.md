## Context

第一阶段提供共享三栏工作台。本 Change 迁移当前纵向嵌套的分镜、图片、视频和合成面板，但必须复用现有 Main Dialog、媒体协议、任务状态机、不可变时间线及 FFmpeg 质量门禁。

## Goals / Non-Goals

**Goals:**

- 让镜头选择成为分镜和媒体页面的统一上下文。
- 将内容预览、候选操作和专业证据分区。
- 让合成时间线在不改变导出命令语义的情况下更易操作。

**Non-Goals:**

- 不新增媒体能力、Provider、转场、TTS、口型或多集导出。
- 不修改 IPC/DTO、Application Port、数据库、migration、FFmpeg 参数或文件落盘语义。

## Decisions

1. `StoryboardPanel` 负责镜头选择和阶段视图编排，现有 FirstFrame/Video/Composition 组件继续负责业务命令，避免将任务逻辑复制到新壳。
2. 分镜、图片、视频和合成使用统一的 `media-workspace` 布局类与候选卡片视觉语义；不引入新组件库。
3. 技术字段移动到原生 `details` 高级信息中，但测试和用户仍可访问错误码、版本 ID 与哈希摘要。
4. 时间线排序保留现有按钮，并强化其键盘可访问性；不增加新的拖拽依赖。
5. 安全边界保持不变：Renderer 仅使用 `jingxu://media` URL 和脱敏 DTO，路径、命令、密钥和原始响应不得进入 DOM。
6. IPC/DTO、Ports、事务、错误码和 migration 不适用；若实现发现缺失只读数据，必须先更新本设计和契约，不能在 Renderer 推断安全事实。

## Risks / Trade-offs

- [单镜头面板内容过多] → 默认只展开常用操作，历史和证据放入检查器分组。
- [既有组件测试依赖完整文本] → 保留业务状态含义并补充面向角色、标签和可执行动作的断言。
- [视频预览占用空间] → 约束预览高度并让时间线保持可见，不自动播放。

## Migration Plan

依次迁移分镜、图片、视频和合成面板；每迁移一组先运行对应 Renderer 单元测试，再运行 V1 分镜和 V2 合成 Electron E2E。无数据迁移，回滚只涉及 Renderer 文件。
