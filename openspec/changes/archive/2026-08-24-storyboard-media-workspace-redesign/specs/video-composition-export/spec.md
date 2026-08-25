## ADDED Requirements

### Requirement: 合成界面必须以时间线和导出检查器组织操作

合成界面 SHALL 将预览、时间线编辑与背景音乐/输出/任务设置分区展示，运行、取消、失败、恢复和成功预览状态 MUST 保持可区分。

#### Scenario: 用户开始合成导出

- **GIVEN** 当前时间线和媒体输入通过导出前校验
- **WHEN** 用户开始导出 MP4
- **THEN** 页面 SHALL 显示中文进度、取消入口和当前阶段
- **THEN** 成功前 MUST NOT 显示可播放的假输出
