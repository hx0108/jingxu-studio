## ADDED Requirements

### Requirement: 媒体页面必须按原型完整展示镜头与候选

分镜、画面和视频页面 SHALL 共享横向镜头条、选中镜头大预览、要求/参数检查器和唯一主要操作；画面与视频候选 MUST 全部可到达，不能因固定视口或固定底栏永久裁掉底部候选。

#### Scenario: 候选数量超出首屏
- **GIVEN** 当前镜头有多个画面或视频候选且内容超过可视高度
- **WHEN** 用户滚动媒体工作区
- **THEN** 所有候选 SHALL 可完整展示、选择和查看状态
- **THEN** 固定操作区 MUST NOT 遮挡最后一个候选

#### Scenario: 切换镜头保持上下文同步
- **GIVEN** 用户位于画面或视频生成页
- **WHEN** 用户选择另一镜头
- **THEN** 大预览、候选、要求、任务状态和下一步 SHALL 同步为该镜头的真实数据

### Requirement: 原型视觉不得降低状态与错误可访问性

电影感背景、蒙版、暗角和模糊 SHALL 只作为视觉层；正文、表单、状态、错误与主要操作 MUST 保持可读对比度，状态不得只依赖颜色，拖动操作 MUST 提供按钮或键盘替代。

#### Scenario: 生成失败且背景较亮
- **GIVEN** 当前背景图在错误区域后方具有高亮内容
- **WHEN** 页面展示生成失败状态
- **THEN** 错误码、影响对象和可执行下一步 MUST 保持可读
- **THEN** 用户 SHALL 能在不拖动的情况下重试、选择或返回修复

### Requirement: 图片与视频新生成任务必须统一使用 AGNES

图片生成与视频生成的新任务 SHALL 只使用已登记的 AGNES 图片模型和 AGNES 视频模型。设置页 MUST 只提供 AGNES 图片与视频模型及其脱敏凭据配置，不得提供 Seedance 作为当前生成选项。开发与自动化测试可以显式使用 Mock，但 MUST 显示为模拟且不得把 Mock 证据计入真实 Provider 验收。历史 Seedance 任务、候选和调用证据 MUST 保留原 Provider 标识用于只读回看与审计，系统不得将其改写为 AGNES 成功。

#### Scenario: 用户创建新的图片或视频生成任务
- **GIVEN** 应用不处于显式 Mock 测试模式
- **WHEN** 用户发起图片候选或视频候选生成
- **THEN** 系统 SHALL 分别冻结 AGNES 图片或 AGNES 视频的 Profile、模型和能力快照
- **THEN** 系统 MUST NOT 读取 Seedance 当前偏好或回退到 Seedance

#### Scenario: 用户查看设置页
- **WHEN** 用户打开画面生成服务或视频生成服务配置
- **THEN** 页面 SHALL 只展示 AGNES 的受限模型列表和脱敏凭据状态
- **THEN** 页面 MUST NOT 提供切换到 Seedance 的按钮

#### Scenario: 用户查看历史 Seedance 证据
- **GIVEN** 项目中存在升级前创建的 Seedance 候选或调用记录
- **WHEN** 用户查看候选来源或审计证据
- **THEN** 系统 SHALL 继续显示其原始 Seedance 来源
- **THEN** 新任务的 AGNES 路由不得改写历史记录
