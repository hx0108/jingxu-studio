## Why

当前分镜、首帧、视频和合成能力纵向堆叠在同一长页面中，镜头对象、候选结果、生成参数、历史和导出状态缺少稳定分区，已经实现的 V2 能力难以连续使用。需要在第一阶段工作台框架上建立面向单镜头生产和整集合成的上下文工作区。

## What Changes

- 分镜阶段使用左侧镜头列表、中间镜头内容、右侧属性/锁/质量/操作检查器。
- 图片和视频阶段按镜头呈现生成状态、当前候选、历史候选和可执行失败恢复动作。
- 合成导出阶段使用预览、时间线与右侧背景音乐/输出/任务区域。
- 统一媒体候选卡片、任务状态、错误提示、键盘替代操作和窄窗口抽屉。
- 不展示本地路径、FFmpeg 命令、API Key 或 Provider 原始响应。
- 不新增转场、TTS、口型、多集时间线、云协作或新的 Provider 能力。

## Capabilities

### New Capabilities

- `storyboard-media-workspace`: 定义分镜、首帧、视频与合成导出的分栏交互、对象选择和状态反馈。

### Modified Capabilities

- `shot-first-frame-image-generation`: 调整已实现图片生成能力的 Renderer 展示与失败恢复入口。
- `shot-video-generation`: 调整已实现视频生成能力的 Renderer 展示与候选选择入口。
- `video-composition-export`: 调整已实现单集合成能力的时间线、音频、任务和导出展示。

## Impact

- 主要影响 `StoryboardPanel`、`FirstFramePanel`、`VideoPanel`、`VideoCompositionPanel`、共享布局组件、样式与 Renderer/Electron E2E。
- 复用现有媒体和合成 IPC，不修改 migration、文件 Port、FFmpeg 调用、输出验证或 Job 状态机。
- 属于用户明确授权的 V2 Renderer 改造，不改变 V1 发布门槛和真实用户试用条件。
