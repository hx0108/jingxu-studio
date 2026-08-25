## ADDED Requirements

### Requirement: 视频 Provider 必须提供受限的 Seedance 模型选择

视频 Provider 设置 SHALL 提供且仅提供 `Seedance-2.0-mini`、`Seedance-2.0`、`Seedance-2.5` 三个模型选项。Renderer MUST 只提交该受限枚举值，MUST NOT 接收任意模型 ID、Provider URL、端点 ID 或本地路径。模型选择与 API Key 分开保存：切换模型 MUST NOT 读取、回显、导出或替换 API Key；用户仍须通过既有视频 Provider 设置自行输入 API Key。已有视频 Profile 未选择新选项时 SHALL 保持现有模型，确保升级兼容。

#### Scenario: 用户选择受支持的视频模型

- **GIVEN** 应用已进入可写状态，视频 Provider Profile 可用
- **WHEN** 用户选择 `Seedance-2.0-mini`、`Seedance-2.0` 或 `Seedance-2.5` 并保存
- **THEN** 系统 SHALL 保存对应的固定方舟模型快照并在重新读取 Profile 时展示所选模型
- **THEN** 系统 MUST NOT 在返回 DTO、SQLite 明文字段、日志或 Renderer 状态中暴露 API Key

#### Scenario: 非法模型选择被拒绝

- **GIVEN** Renderer 或其他调用方提交不在受支持列表的模型值
- **WHEN** Main 校验视频 Provider 设置命令
- **THEN** 系统 SHALL 返回稳定请求错误且不得修改 Provider Profile、凭据或视频任务

### Requirement: 视频任务必须冻结所选模型并按模型能力提交

每次视频任务建档 SHALL 读取当前视频 Provider 的受支持模型选择，并把实际方舟模型 ID 写入候选、生成输入哈希和调用证据。后续修改 Provider 设置 MUST NOT 改写已建档任务、候选或调用证据；历史任务 SHALL 继续使用其冻结的模型 ID。每个模型的时长、分辨率与首帧图生视频约束 MUST 由受版本控制的本地能力表执行；不支持的参数 MUST 在请求发出前拒绝，而不得静默降级或篡改用户输入。

#### Scenario: 切换模型不改变已建档任务

- **GIVEN** 镜头 L 的视频候选已使用模型 A 建档但尚未完成
- **WHEN** 用户将视频 Provider 模型切换为模型 B
- **THEN** L 的候选和后续轮询/下载 SHALL 保持模型 A 的调用证据与输入哈希
- **THEN** 此后新建的视频候选 SHALL 冻结模型 B

#### Scenario: 新模型的有效子集参数被提交

- **GIVEN** 用户选择任一受支持模型，镜头具有合法已选首帧
- **WHEN** 系统按该模型的本地能力约束建立视频请求
- **THEN** 系统 SHALL 只提交该模型确认支持的首帧图生视频参数子集
- **THEN** 系统 MUST NOT 因模型切换自动启用音频、视频编辑、续写或成片能力

### Requirement: 模型无权限错误必须可执行且不泄露 Provider 原文

当火山方舟返回模型或接入点不存在、未开通或无权限的错误时，系统 SHALL 将该失败归一化为稳定的非重试错误，并提示用户在火山方舟为当前 API Key 所属账号开通所选模型或配置对应接入点。Renderer MUST NOT 展示 Provider 原始错误体、请求 ID、Authorization 或 API Key；原始响应仅按既有调用证据边界留存。

#### Scenario: 所选模型未获账号授权

- **GIVEN** 已配置的视频 API Key 无权调用当前所选 Seedance 模型
- **WHEN** 视频候选提交得到模型/接入点不可用的 Provider 响应
- **THEN** 候选 SHALL 以稳定的模型不可用错误终态留存，并向用户展示开通模型或接入点的下一步
- **THEN** 系统 MUST NOT 自动切换到其他模型、自动重试或篡改历史证据
