# image-credential-management Specification

## Purpose
TBD - created by archiving change image-credential-management. Update Purpose after archive.
## Requirements
### Requirement: 图片 Provider 凭据必须经 UI 配置并沿用 safeStorage 边界

ARK API Key MUST 经与文本 Key 相同的凭据边界管理：Electron `safeStorage` 加密、独立密文（credential_ref=`profile-image-primary`，与 DashScope Key 分存互不覆盖）、SQLite 只存 credential_ref 与验证元数据。UI 保存成功后 MUST 立即清空输入框，MUST 只显示 configured 状态与可选末 4 位，MUST NOT 回显完整 Key；删除凭据 MUST 同步删除密文并写审计事件；`safeStorage` 不可用时 MUST 阻断保存且不降级为明文。完整 Key MUST NOT 进入日志、埋点、诊断包、Fixture、截图或导出包（沿用 `jobrunner-qwen-text-adapter` 凭据红线）。

#### Scenario: UI 保存独立密文且不回显

- **GIVEN** 用户在图片 Provider 卡片输入 ARK API Key 并保存
- **WHEN** 保存成功
- **THEN** 系统 SHALL 以 safeStorage 独立密文落盘（不触碰文本 Key 密文），SQLite 只落 credential_ref 与验证元数据
- **THEN** UI MUST 清空输入并只显示「已配置（末四位 ****）」状态

#### Scenario: 删除图片凭据同步清理

- **GIVEN** 已配置图片凭据
- **WHEN** 用户删除该凭据
- **THEN** 系统 MUST 同步删除密文与 credential_ref 引用，并写审计事件
- **THEN** 文本 Key 的密文与配置状态 MUST NOT 受影响

### Requirement: 图片凭据验证只做解密校验，不发计费请求

图片档 `testCredential` MUST 仅验证凭据可解密加载（零网络、零计费请求；ARK 无免费探测端点已由官方文档核对证实）；真实连通性 SHALL 以首次真实生成留证，失败以候选级稳定错误码呈现。UI 文案 MUST 如实标注验证范围，MUST NOT 宣称已验证 Provider 连通性。

#### Scenario: 已配置凭据的测试零网络通过

- **GIVEN** 图片凭据已配置且密文可解
- **WHEN** 用户执行测试凭据
- **THEN** 系统 SHALL 仅做解密加载校验并返回成功，MUST NOT 发起任何 Provider 请求

#### Scenario: 密文不可解时测试如实失败

- **GIVEN** 密文存在但于当前 userData 加密钥下不可解（如跨目录残留）
- **WHEN** 用户执行测试凭据
- **THEN** 系统 SHALL 返回稳定失败码（CREDENTIAL_INVALID 类）且不回显 Key 或密文内容

### Requirement: 未配置图片凭据时生成必须前置稳定失败

`generateCandidates` MUST 在图片凭据未配置或不可解密时以稳定错误码 `MODEL_CREDENTIAL_INVALID` 前置失败，userAction MUST 指向图片凭据配置入口；MUST NOT 以 MODEL_UNKNOWN 兜底呈现，MUST NOT 静默降级或跳过。其余五个 image 方法（候选/资产/任务查询与选择）MUST NOT 因凭据未配置而不可用。

#### Scenario: 未配置时生成前置失败并给出指引

- **GIVEN** 图片凭据未配置
- **WHEN** 用户对 READY 镜头发起首帧候选生成
- **THEN** 系统 MUST 拒绝并返回 `MODEL_CREDENTIAL_INVALID` 与指向配置入口的 userAction
- **THEN** 候选列表、资产列表、任务状态与选择方法 MUST 保持可用

#### Scenario: 密文不可解时同样前置失败

- **GIVEN** 密文存在但解密失败（跨 userData 目录残留等）
- **WHEN** 用户发起首帧候选生成
- **THEN** 系统 MUST 以 `MODEL_CREDENTIAL_INVALID` 前置失败；用户经 UI 重存凭据后 SHALL 可恢复生成

### Requirement: 环境变量引导路径与 UI 路径共存且语义固定

`JINGXU_IMAGE_CREDENTIAL_FILE` 环境变量引导 MUST 保留为联调/E2E 门控路径：wx 独占创建、目标密文已存在即跳过、MUST NOT 覆盖。UI 保存路径 SHALL 支持覆盖既有密文（轮换）。两路径写同一 credential_ref，均不使 Key 进入环境快照、日志或数据库明文字段。

#### Scenario: 引导路径不覆盖既有密文

- **GIVEN** secrets 目录已存在图片凭据密文
- **WHEN** 以环境变量引导启动
- **THEN** 系统 MUST 跳过写入，既有密文保持不变

#### Scenario: UI 路径支持轮换

- **GIVEN** 已有图片凭据密文（无论来自引导路径或 UI）
- **WHEN** 用户经 UI 保存新 ARK API Key
- **THEN** 系统 SHALL 覆盖旧密文，末 4 位展示随之更新

