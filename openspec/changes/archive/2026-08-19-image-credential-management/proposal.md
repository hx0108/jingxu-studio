# Proposal: image-credential-management

## Why

六阶段文本链路与逐镜头首帧图片链路已分别于 2026-08-16、2026-08-17 经真实联调全绿并归档，但对「真实用户可用」还剩两条硬缺口：

1. **图片凭据无配置入口**。ARK Key 只能经 `register-image-features.ts` 的 `bootstrapImageCredential` 以 `JINGXU_IMAGE_CREDENTIAL_FILE` 环境变量一次性 wx 独占写入（源码注释明示「正式配置 UI 另行接线」）；普通用户无法配置图片凭据，首帧功能对真实用户实际不可用。文本侧已有完整可复用模式：provider 五通道（getProfile/saveCredential/saveProfile/testCredential/deleteCredential）+ `ProviderSettings` UI + safeStorage 独立密文 + 末 4 位展示 + 删除审计。
2. **SHOT_CONTRACT 于真实网络高频失败**。2026-08-17 联调实录：当晚 8 次提交 5 次撞 `QWEN_INVOCATION_TIMEOUT_MS=120_000`（硬编码、不可按阶段配置）、2 次契约校验失败、1 次通过；MODEL_TIMEOUT 不在受限重试集合内 → 用户视角是「最重的一步高频失败，需手动重提」。附带产物：图片凭据密文不可解时（safeStorage v10 密钥随 userData 目录隔离，联调实录）首帧生成以 27ms MODEL_UNKNOWN 兜底呈现，指引自洽性差。

本 Change 有意保持小：不新增业务表、不动 PRD-owned Schema 字节、不新增媒体生成能力，只补「配置闭环」与「调用稳健性」两块拼图。完成后真实用户（含产品负责人自试用）可以纯 UI 完成「双 Key 配置 → 六阶段生成 → 首帧候选生成」全链路，无需任何环境变量。

## What Changes

- 图片 Provider 凭据配置 UI：沿用 provider 五通道与 ProviderProfile 乐观并发模式为图片档建档（credential_ref=`profile-image-primary` 独立密文不变，ARK Key 与 DashScope Key 分存）；UI 只显示 configured 状态与末 4 位、保存后立即清空输入、删除凭据同步删除密文并写审计事件——全部沿用既有凭据红线，零放宽。
- 图片档 `testCredential` 语义 = 解密加载校验（`SeedreamImageModelAdapter.validateCredential`，零计费请求；0.2 已核对 ARK 无免费探测端点）；真实连通性以首次真实生成留证，失败以候选级稳定错误码呈现；UI 文案如实标注验证范围。
- 未配置或密文不可解时 `generateCandidates` 前置稳定失败 `MODEL_CREDENTIAL_INVALID`（userAction 指向图片凭据配置入口），替代现行 MODEL_UNKNOWN 兜底。
- SHOT_CONTRACT 调用稳健性（三方案供拍板，推荐方案一）：调用超时按阶段化（SHOT_CONTRACT 300 秒，其余阶段 120 秒不变）；MODEL_TIMEOUT 纳入受限 transport retry（独立小预算：至多追加 1 次重试，仍在 `transport_attempts` 0–3 CHECK 内）；`deadline_at` 按阶段推导（SHOT_CONTRACT 960 秒，其余 300 秒不变）。
- `JINGXU_IMAGE_CREDENTIAL_FILE` 环境变量引导路径保留为联调/E2E 门控，语义不变（wx 独占创建、已存在跳过）；UI 保存路径支持覆盖轮换；两路径写同一 credential_ref。
- 明确不做：动态 ProviderCapabilityRegistry、第二家图片 Provider、价格表与成本对账、批量生成、后帧/视频、媒体域 `model_invocations` 证据接线（均维持既有 defer 决策）。

## Capabilities

### New Capabilities

- `image-credential-management`: 图片 Provider 凭据的 UI 配置闭环（保存/验证/删除/展示）、与文本凭据的分存边界、未配置前置失败语义、环境变量引导路径与 UI 路径的共存规则。

### Modified Capabilities

- `jobrunner-qwen-text-adapter`: 调用超时按阶段化、MODEL_TIMEOUT 纳入受限重试、`deadline_at` 按阶段推导（数值随 D3 拍板落定 delta）；凭据红线条款（safeStorage/末 4 位/删除审计/不回流）不动，仅同能力内扩展重试与超时矩阵。

## Impact

- **产品/验收**：真实用户首次可纯 UI 走通「双 Key 配置 → 六阶段 → 首帧」全链路；SHOT_CONTRACT 单击生成成功率与等待体验显著改善（拍板方案一后一次提交内自动收敛多数超时）。不宣称任何视频、TTS、口型或成片能力；AC-V1-01~06 与 3 名用户试用未完成的事实继续如实登记。
- **Schema**：六份 PRD-owned Schema 字节不变；仅 TECH-internal provider 契约（图片档 workspaceId 可空、configured 判定差异）扩展。
- **数据库**：无新迁移（`ProviderService` 已按任意 profileId 惰性建档 + defaults 注入，图片档 defaults 在组合根注册），迁移 head 维持 9。
- **IPC/兼容性**：provider 五通道不新增频道，输入/输出 strict DTO 需容忍图片档差异（workspaceId 可空、testCredential 分档分发）；Main/Preload/Renderer/Contract/E2E 同步。
- **进程/安全**：凭据边界零放宽。MODEL_TIMEOUT 自动重试的重复计费风险以独立小预算（至多 1 次）+ 调用证据保留 + 幂等键防重复版本控制，风险量级与既有 5xx 重试同级且更低。
- **并行实施**：单线小 Change（契约 → Main/IPC → Renderer → 超时与重试 → 门禁 → 真实复证），无三线并行必要；预估显著小于已归档的任一前置 Change。
