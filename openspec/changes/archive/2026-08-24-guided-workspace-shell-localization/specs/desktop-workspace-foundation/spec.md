## ADDED Requirements

### Requirement: 桌面应用必须提供稳定的中文全局导航

桌面应用 SHALL 提供首页、我的项目、创作工作台、素材库、生成任务、导出记录、质量与评测和设置入口；未实现为独立页面的入口 MUST 显示真实状态说明，不得伪造业务数据或成功结果。

#### Scenario: 用户切换全局区域

- **GIVEN** 应用已经通过启动门并进入可写状态
- **WHEN** 用户从全局导航选择任一区域
- **THEN** 导航 SHALL 标识当前位置并显示对应页面或真实的待建设说明
- **THEN** 页面 MUST NOT 通过外部导航或新窗口加载内容

### Requirement: Provider 配置不得干扰核心创作内容

Provider 凭据和模型配置 SHALL 位于独立设置区域，创作页面 MUST 只显示脱敏配置状态及设置入口。

#### Scenario: 用户在剧本阶段查看模型状态

- **GIVEN** 文本模型已经配置
- **WHEN** 用户打开剧本开发阶段
- **THEN** 页面 SHALL 只显示“文本模型已配置”及必要的连接状态
- **THEN** 页面 MUST NOT 展示 API Key、Base URL 或 Provider 原始响应
