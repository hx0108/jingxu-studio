## ADDED Requirements

### Requirement: 视频联调必须默认使用可识别的零网络 Mock

开发启动与自动化测试中的视频生成 MUST 默认使用确定性 Mock，Mock 模式 MUST NOT 读取真实 Provider 凭据、发起网络请求或产生 Provider 费用。切换到真实 Seedance 或 Agnes MUST 是显式动作，并在提交前通过对应凭据闸；正式打包运行 MUST NOT 因凭据缺失或 Provider 失败而静默回退到 Mock。Mock 任务、候选、调用证据和界面状态 MUST 明确标记为模拟结果，不得被展示或导出为真实 Provider 生成证据。

#### Scenario: 开发联调默认零网络

- **GIVEN** 开发者未显式选择真实视频 Provider
- **WHEN** 启动应用并完成视频单镜头、批量、取消、失败或恢复联调
- **THEN** 系统 SHALL 只消费确定性 Mock 步骤且不读取任何真实视频凭据
- **THEN** 网络观察 SHALL 不出现火山方舟或 Agnes AI 视频请求

#### Scenario: 正式运行不得静默伪造成功

- **GIVEN** 正式打包应用选择了真实 Provider 但对应凭据缺失或请求失败
- **WHEN** 用户发起视频生成
- **THEN** 系统 SHALL 以稳定错误拒绝或记录真实失败
- **THEN** 系统 MUST NOT 自动回退到 Mock、创建模拟成功候选或把模拟证据标记为真实 Provider

#### Scenario: 真实调用必须显式开启

- **GIVEN** 当前运行处于 Mock 联调模式且已保存某个真实 Provider 凭据
- **WHEN** 用户未显式切换到该真实 Provider 便发起视频生成
- **THEN** 系统 SHALL 继续使用 Mock 且不得读取该密文
- **WHEN** 用户显式切换并确认真实调用边界后再次生成
- **THEN** 系统 SHALL 在凭据闸通过后仅调用被选中的真实 Provider

## MODIFIED Requirements

### Requirement: 视频 Provider 必须提供受限的 Seedance 模型选择

视频 Provider 设置 SHALL 提供 `Seedance` 与 `Agnes` 两个真实 Provider（万相档已于 2026-09-20 按用户决策整体移除）；开发和自动化环境另提供明确标记的 `Mock` 联调模式。Seedance SHALL 仅提供 `Seedance-2.0-mini`、`Seedance-2.0`、`Seedance-2.5` 三个模型选项，新安装或尚未保存模型选择的 Seedance Profile MUST 默认 `Seedance-2.0-mini`，已有 Seedance Profile MUST 保持原选择。Agnes SHALL 仅提供 `agnes-video-v2.0`（默认）与 `agnes-video-2.5-flash` 两个冻结模型，固定 `apihub.agnes-ai.com` 端点、data URL 首帧图生视频、5 秒时长与 720P（2.5 Flash 为服务端硬校验），并在设置界面标注当前 $0/秒促销与免费档 1 RPM 限制。Renderer MUST 只提交受限 Provider/模型枚举，MUST NOT 接收任意模型 ID、Provider URL、地域、Workspace、端点 ID、音频开关或本地路径。

Seedance 与 Agnes MUST 使用独立 Provider Profile 和独立凭据引用。模型及当前 Provider 选择与 API Key 分开保存；切换 Provider 或模型 MUST NOT 读取、回显、导出、替换或删除任一 API Key。

#### Scenario: 新 Seedance 档默认 mini

- **GIVEN** 应用已进入可写状态且不存在既有 Seedance 视频 Profile
- **WHEN** 用户首次打开视频 Provider 设置或保存 Seedance 档
- **THEN** 系统 SHALL 将 `Seedance-2.0-mini` 作为受限默认模型
- **THEN** 系统 MUST NOT 自动选择 Seedance-2.0 或 Seedance-2.5

#### Scenario: 用户选择受支持的视频模型

- **GIVEN** 应用已进入可写状态，对应真实 Provider Profile 可用
- **WHEN** 用户选择受支持的 Seedance 模型并保存
- **THEN** 系统 SHALL 保存对应的受限 Provider/模型快照并在重新读取设置时展示所选值
- **THEN** 系统 MUST NOT 在返回 DTO、SQLite 明文字段、日志或 Renderer 状态中暴露 API Key

#### Scenario: 已有 Seedance 选择兼容保留

- **GIVEN** 升级前 Seedance Profile 已保存 Seedance-2.0 或 Seedance-2.5
- **WHEN** 应用完成迁移并重新读取 Profile
- **THEN** 系统 SHALL 展示并继续使用原模型，SHALL NOT 将其自动改写为 mini

#### Scenario: 用户选择受支持的 Agnes 模型

- **GIVEN** 应用已进入可写状态且 Agnes Profile 可用
- **WHEN** 用户选择 Agnes 并保存 `agnes-video-v2.0` 或 `agnes-video-2.5-flash`
- **THEN** 系统 SHALL 保存固定端点、data URL 首帧、5 秒、720P 能力快照并展示该选择与免费促销/1 RPM 提示
- **THEN** 系统 MUST NOT 在 DTO、SQLite 明文字段、日志或 Renderer 状态中暴露 Agnes API Key

#### Scenario: 各 Provider 凭据相互隔离

- **GIVEN** 用户已分别保存 Seedance ARK API Key 与 Agnes API Key
- **WHEN** 用户在 Seedance、Agnes 和 Mock 之间切换
- **THEN** 系统 SHALL 只读取当前真实 Provider 对应的凭据引用
- **THEN** 其他 Provider 的密文、末四位和验证元数据 SHALL 保持不变

#### Scenario: 非法 Provider 或模型选择被拒绝

- **GIVEN** Renderer 或其他调用方提交不在受支持列表的 Provider、模型、地域、URL 或参数
- **WHEN** Main 校验视频 Provider 设置命令
- **THEN** 系统 SHALL 返回稳定请求错误且不得修改当前选择、Provider Profile、凭据或视频任务

#### Scenario: 非法模型选择被拒绝

- **GIVEN** Renderer 或其他调用方提交不在当前 Provider 受支持列表中的模型值
- **WHEN** Main 校验视频 Provider 设置命令
- **THEN** 系统 SHALL 返回稳定请求错误且不得修改 Provider Profile、凭据、当前选择或视频任务

### Requirement: 视频任务必须冻结所选模型并按模型能力提交

每次视频任务建档 SHALL 读取当前视频模式和受支持的 Provider/模型选择，并把模式、Provider、实际模型 ID、能力快照 ID 写入候选、生成输入哈希和调用证据。后续切换模式、Provider 或模型 MUST NOT 改写已建档任务、候选或调用证据；历史任务 SHALL 继续使用建档时冻结的 Adapter、Provider 任务 ID、模型和凭据引用完成轮询或恢复。每个模型的时长、分辨率、首帧图生视频、地域和音频约束 MUST 由受版本控制的本地能力表执行；不支持的参数 MUST 在请求发出前拒绝，不得静默降级、自动换 Provider、开启音频或篡改用户输入。

#### Scenario: 切换 Provider 不改变已建档任务

- **GIVEN** 镜头 L 的视频候选已使用 Provider A、模型 A 建档但尚未完成
- **WHEN** 用户将当前视频 Provider 切换为 Provider B
- **THEN** L 的候选和后续轮询/下载 SHALL 保持 Provider A、模型 A、原能力快照与调用证据
- **THEN** 此后新建的视频候选 SHALL 冻结 Provider B 的当前受支持模型

#### Scenario: 切换模型不改变已建档任务

- **GIVEN** 镜头 L 的视频候选已使用 Provider A 的模型 A 建档但尚未完成
- **WHEN** 用户把同一 Provider 的当前模型切换为模型 B
- **THEN** L 的候选和后续轮询/下载 SHALL 保持 Provider A、模型 A、原能力快照与调用证据
- **THEN** 此后新建的视频候选 SHALL 冻结模型 B

#### Scenario: Agnes 只提交固定免费档参数子集

- **GIVEN** 用户选择 Agnes `agnes-video-v2.0` 或 `agnes-video-2.5-flash`，镜头具有合法已选首帧
- **WHEN** 系统建立真实视频请求
- **THEN** 请求 SHALL 使用固定 `apihub.agnes-ai.com` 端点、data URL 首帧、5 秒时长与 720P（2.5 Flash 显式 `size:"720P"`）
- **THEN** 系统 MUST NOT 提交任意 Base URL、参考音频/视频输入、首尾帧序列、其他时长或分辨率参数

#### Scenario: 新模型的有效子集参数被提交

- **GIVEN** 用户选择任一受支持模型，镜头具有合法已选首帧
- **WHEN** 系统按冻结 Provider 和模型的本地能力约束建立视频请求
- **THEN** 系统 SHALL 只提交该模型确认支持的首帧图生视频参数子集
- **THEN** 系统 MUST NOT 因 Provider 或模型切换自动启用音频、视频编辑、续写或成片能力

#### Scenario: Mock 任务切换后仍可追溯

- **GIVEN** 镜头 L 已在 Mock 模式建档且任务仍在轮询
- **WHEN** 用户把当前视频 Provider 切换为 Seedance 或 Agnes
- **THEN** L SHALL 继续按冻结的 Mock 步骤完成并保持模拟标记
- **THEN** 系统 MUST NOT 把该任务转交真实 Adapter 或读取真实凭据

### Requirement: 模型无权限错误必须可执行且不泄露 Provider 原文

当火山方舟返回模型、地域、接入点不存在、未开通或无权限的错误时，系统 SHALL 将失败归一化为稳定的非重试错误，并按冻结 Provider 提示用户在对应平台为当前 API Key 所属账号开通模型或核对地域/业务空间。Renderer MUST NOT 展示 Provider 原始错误体、请求 ID、Authorization、API Key、签名信息或结果 URL；原始响应仅按既有调用证据边界在 Main/持久化层留存。

#### Scenario: Seedance 模型未获账号授权

- **GIVEN** 已配置的 ARK API Key 无权调用冻结的 Seedance 模型
- **WHEN** 视频候选提交得到模型或接入点不可用响应
- **THEN** 候选 SHALL 以稳定模型不可用错误终态留存，并提示前往火山方舟开通模型或接入点
- **THEN** 系统 MUST NOT 自动切换到 Mock 或其他 Seedance 模型

#### Scenario: 所选模型未获账号授权

- **GIVEN** 已配置的视频 API Key 无权调用建档时冻结的真实 Provider 模型
- **WHEN** 视频候选提交得到模型、地域或接入点不可用的 Provider 响应
- **THEN** 候选 SHALL 以稳定的模型不可用错误终态留存，并向用户展示对应平台的开通或配置下一步
- **THEN** 系统 MUST NOT 自动切换 Provider、自动重试非重试错误或篡改历史证据

#### Scenario: Agnes 限流或促销到期

- **GIVEN** 已配置的 Agnes API Key 在免费档（1 RPM/每日时长配额）或促销计费规则变化
- **WHEN** 视频候选提交得到 429 或计费相关 4xx 响应
- **THEN** 429 SHALL 归一为可重试限流错误并交给既有调度退避；非重试计费错误 SHALL 以稳定错误终态留存并提示核对 Agnes 账号状态
- **THEN** 系统 MUST NOT 自动改用其他 Provider、静默降级参数或篡改历史证据
