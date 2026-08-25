## ADDED Requirements

### Requirement: 视频生成界面必须区分结果与任务证据

视频生成界面 SHALL 优先展示可播放候选和用户可执行动作，任务与调用证据 MUST 置于可展开的高级信息中。

#### Scenario: 当前镜头视频已生成

- **GIVEN** 当前镜头存在 SUCCEEDED 且可用的视频候选
- **WHEN** 用户进入视频生成阶段
- **THEN** 页面 SHALL 显示受限媒体预览及“选用”状态
- **THEN** 页面 MUST NOT 显示文件路径或 Provider 原始响应
