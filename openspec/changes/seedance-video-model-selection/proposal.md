## Why

当前视频生成路径把 Seedance 1.5 Pro 固定在 Composition Root 与 Adapter 中，用户无法为不同镜头选择已获授权的视频模型；且模型不可用时只能在候选失败后看到通用错误。用户需要在本地桌面端选择 Seedance 2.0 mini、Seedance 2.0 或 Seedance 2.5，并自行通过现有安全凭据入口配置 ARK API Key。

## What Changes

- 在视频 Provider 设置中提供受限的视频模型选择器；Renderer 只提交预定义模型键，不能提交任意模型 ID、端点或路径。
- 将已选择的视频模型和版本化能力快照写入现有 Provider Profile，并在每次视频任务建档时冻结实际模型 ID，避免设置变更影响历史任务。
- 让视频生成服务、Seedance Adapter 与请求参数按选定模型的固定能力约束执行，并保留当前首帧图生视频、异步轮询、调用证据和内容寻址落盘边界。
- 保持 API Key 仅由 Main 通过 safeStorage 保存；模型切换不得读出、回显或导出 API Key。
- 将“模型不存在或账号/接入点未授权”的 Provider 响应映射为稳定、可执行的错误提示，而不泄露原始响应。
- Seedance 2.5 的调用仍以用户账号在火山方舟控制台实际可见并已开通的模型或接入点为准；模型不可用时必须保留失败证据并给出开通提示，不得自动回退。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `shot-video-generation`: 视频 Provider 选择、任务模型冻结、能力约束和模型权限失败提示。

## Impact

- 影响 `packages/model-adapters` 的 Seedance Adapter、`packages/application` 的视频生成请求与任务快照、SQLite Provider Profile/Capability Snapshot、`packages/contracts` 的受限 IPC DTO，以及 Main/Preload/Renderer 的视频 Provider 设置。
- 复用现有 `provider_profiles.model_id` 与 `model_snapshot_date` 持久化选择；不得改写既有视频任务、候选、调用证据或已发布 migration。
- 此变更由用户明确扩大到视频能力，属于 PRD v1.4 当前 V1 范围之外的受控扩展；不改变 V1 发布验收结论，也不增加 TTS、口型、时间线或成片能力。
