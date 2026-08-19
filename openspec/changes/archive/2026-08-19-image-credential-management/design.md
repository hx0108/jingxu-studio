# Design: image-credential-management

## 0. 背景与证据（Apply 前置事实，不需要拍板）

- **文本侧既有模式（复用基线）**：`ProviderService` 已按任意 `profileId` 通用化（`findById` 缺档时 `#defaultProfile(profileId)` 惰性建档，defaults 经依赖注入——见 `packages/application/src/provider/provider-service.ts`），provider 五通道（`PROVIDER_IPC_CHANNELS`）与 `ProviderSettings.tsx`（保存后清空输入、末 4 位、删除 confirm、乐观并发 expectedVersionId）均已上线并经真实联调使用。**结论：图片档不需要数据库迁移，defaults 在组合根注册即可。**
- **图片侧现状**：`IMAGE_CREDENTIAL_ID='profile-image-primary'` 固定凭据引用；`bootstrapImageCredential` 仅在 `JINGXU_IMAGE_CREDENTIAL_FILE` 指向明文 Key 文件且非 E2E Mock 时以 wx 独占创建一次性写入（已存在跳过、轮换需手动删密文文件）；`SeedreamImageModelAdapter.validateCredential` 为解密加载校验（零网络）。
- **联调实录证据（2026-08-17）**：
  - SHOT_CONTRACT 当晚 8 次提交：5 次 MODEL_TIMEOUT（120 秒上限）、2 次 speaker_id oneOf 契约校验失败（CONTRACT_VALIDATION_FAILED，不可重试属正确行为）、1 次通过。失败作业不写版本、输入不变，同项目重提交合法且已收敛。
  - safeStorage v10 密钥随 userData 目录隔离（`Local State` os_crypt.encrypted_key）：密文跨 userData 目录不可解 → `CredentialStorageError('CREDENTIAL_NOT_FOUND')` → 适配器 normalizeError 兜底 **MODEL_UNKNOWN**（27ms 失败），对用户无指引价值。
- **既有 spec 约束（本设计不得违反）**：`jobrunner-qwen-text-adapter` spec 重试矩阵（transport retry 仅网络错误/429/5xx、最多 2 次、`transport_attempts` 0–3 CHECK）；崩溃恢复条款（宁可人工重试不自动重复计费——针对**未知结果**场景）；`deadline_at` 创建后 300 秒、Invocation `timeout_at` 120 秒。

## D1 图片凭据配置通道形态

- **A（推荐）：复用 provider 五通道 + 组合根注册图片档 defaults**。图片档 profileId=`profile-image-primary`（与 credential_ref 同名，语义自洽）；provider_profiles 行由服务惰性建档；`testCredential` 在组合根按 profileId 分发（文本档→Qwen 真实微调用；图片档→Seedream 解密校验）。优点：IPC 面零扩张、乐观并发/审计/末 4 位全部免费复用；缺点：契约需容忍图片档 workspaceId 可空与 configured 判定差异（isProviderReadyForGeneration 是文本档语义，图片档 ready=凭据已配置）。
- **B：`image` 通道下新增三方法**（saveImageCredential/testImageCredential/deleteImageCredential）。不动 provider 契约，但 IPC 面扩大、凭据逻辑两套并行，违背「通道无关不变式按既有模式遵守」的既定边界。
- **C：维持环境变量为唯一路径**——否决，这正是本 Change 要消除的可用性缺口。

## D2 图片档 testCredential 语义与失败呈现

- **A（推荐）：解密加载校验 + 前置稳定失败码**。`testCredential`=解密校验（零计费请求；ARK 无免费探测端点已由 0.2 官方核对证实）；真实连通性以首次真实生成留证（候选级 FAILED + 稳定错误码，UI 已有呈现）。同时把「凭据未配置/不可解」从 submit 内部异常提升为 `generateCandidates` 前置校验：稳定 `MODEL_CREDENTIAL_INVALID` + userAction「在图片 Provider 设置中配置 ARK API Key」——直接替代 27ms MODEL_UNKNOWN 教训。UI 文案如实标注「仅验证可解密读取，不发起计费请求」。
- **B：发一次最小真实生成做连通性测试**——否决：每次测试产生真实计费（Seedream 按图计费），且无低成本端点可探测。

## D3 SHOT_CONTRACT 调用超时与重试策略（核心拍板点）

现状问题：`QWEN_INVOCATION_TIMEOUT_MS=120_000` 全阶段统一硬编码；SHOT_CONTRACT（9 镜头重 JSON）真实耗时分布尾部长于 120 秒（8 投 5 超）；MODEL_TIMEOUT 不在受限重试集合 → 一次超时即终态、需人工重提。

- **方案一（推荐）：按阶段超时 + MODEL_TIMEOUT 受限小预算重试 + deadline 按阶段推导**
  - 调用超时：SHOT_CONTRACT 300 秒（2.5×，覆盖实测成功样本的尾部余量），其余阶段维持 120 秒（五个轻阶段实测均远低于上限，不动）。
  - 重试：MODEL_TIMEOUT 纳入 transport retry，但**独立小预算：至多追加 1 次**（网络错误/429/5xx 维持最多 2 次不变；总量仍在 `transport_attempts` 0–3 CHECK 内 → SHOT_CONTRACT 一次提交至多 2 次计费调用）。计费风险：超时请求可能已在服务端完成（结果未知型重复计费），预算 1 次将重复成本上界压到 2×，且每次调用独立留证、幂等键防重复版本——风险量级低于既有 5xx 重试（最多 3×）。
  - deadline：SHOT_CONTRACT `deadline_at` = 创建后 960 秒（300×3+60，覆盖 1+1 次调用与退避仍留余量），其余阶段维持 300 秒。重试前 MUST 复核剩余预算，不足即终态。
  - 依据：120 秒超时率 5/8≈62%；若 300 秒覆盖大多数尾部（成功样本曾在 120 秒内完成，说明分布中位远低于 120 秒，超时样本为长尾），加 1 次重试后单次提交失败率降至长尾条件概率的平方量级。
  - 实现落点：`QwenTextModelAdapter` 内按 `request.stage` 推导超时（导出 STAGE→ms 常量表 + 单测）；Runner 重试类型矩阵与 deadline 推导；spec delta 两条 MODIFIED。
- **方案二（最小改动）：仅按阶段上调超时，不动重试语义**。SHOT_CONTRACT 300 秒 + deadline 960 秒；超时仍人工重提。无重复计费风险、改动约为方案一的一半；代价是慢尾样本仍需用户手动点重试（探针实证可收敛，但真实用户对「失败→重提」的耐受未知）。
- **方案三：SHOT_CONTRACT 分段生成（按镜头分批多调用后聚合）**——否决本期：prompt 语义、集合校验链、幂等与证据模型全部要动，量级等同一个新 Change；留待后续独立提案（若 300 秒仍高频超时再启动）。

数值（300/960/预算 1 次）均为拍板可调项；delta 与任务按方案一起草，拍板后同步修订。

## D4 图片凭据 UI 放置

- **A（推荐）**：`ProviderSettings` 同卡片组内新增「图片 Provider（火山方舟 Seedream）」卡片——仅 API Key 一个输入（无 Workspace/Model 输入；model id 从能力快照只读展示 `doubao-seedream-5-0-lite-260128`），保存/测试/删除三按钮与末 4 位状态行完全沿用文本卡片交互。首帧面板在 `MODEL_CREDENTIAL_INVALID` 错误下给出跳转提示。
- **B**：独立设置路由/弹窗——当前应用无全局设置页，为此引入路由属过度设计。

## 决策点汇总

| # | 决策点 | 拍板（2026-08-17，产品负责人「D1–D4 全按推荐」） | 备选（未采纳） |
|---|---|---|---|
| D1 | 图片凭据配置通道 | **A：复用 provider 五通道 + 图片档 defaults** | B：image 通道三方法；C 已否决 |
| D2 | testCredential 语义 | **A：解密校验 + 前置稳定失败码** | B（计费探测）已否决 |
| D3 | SHOT_CONTRACT 超时/重试 | **方案一：300s + 超时重试预算 1 次 + deadline 960s** | 方案二：仅上调超时；方案三独立 Change |
| D4 | UI 放置 | **A：ProviderSettings 内新增图片卡片** | B：独立设置页 |

D3 数值维持起草值：SHOT_CONTRACT 调用超时 300 秒、MODEL_TIMEOUT 重试预算至多 1 次、`deadline_at` 960 秒；其余阶段 120 秒/300 秒不变。jobrunner spec delta 与 tasks 4.x 即按此实施。

## Apply 期修订记录（2026-08-19）

实施中发现与起草稿的偏差，均已按「保拍板结论、零迁移承诺」处理：

1. **workspaceId 非空（DDL 事实）**：`0001_initial.sql` 的 `provider_profiles.workspace_id` 为 `NOT NULL CHECK (length > 0)`，起草稿「图片档 workspaceId 可空」需表重建迁移才能落地。修订：契约/DTO 保持 workspaceId 非空，图片档 defaults 写入占位 `'ark'`（UI 永不展示该字段；`region='cn-beijing'` 对 ARK 属实）。provider_profiles DDL 本就非枚举约束（TEXT），`VOLCARK_SEEDREAM` 落库无需迁移，「无迁移、head=9」承诺保持。
2. **MODEL_TIMEOUT 归一化不改**：适配器层 `MODEL_TIMEOUT` 的 `retryable=false` 维持原语义（归一化面向 Provider 边界）；「是否重试超时」上移为 Runner 内独立预算判定（`isTimeout ? 预算余量 : retryableTransport`），两层职责不混。
3. **无退避睡眠（既有事实，如实记录）**：既有 jobrunner spec 措辞含「退避」，但实现历来无 backoff sleep（重试立即续跑）。本 Change 不改动该行为；960 秒 deadline 余量按「无退避」口径计算（300×3+60 覆盖 1+1 次满超时调用与余量）。
4. **首帧面板零改动**：`describeProjectError` 优先取 `error.userAction ?? fallbackAction`，Main 侧前置失败携带的图片配置指引自动透传到首帧面板，无需 Renderer 代码变更。
5. **图片 profileId 镜像**：Renderer 不 import Main 侧符号，`IMAGE_PROFILE_ID='profile-image-primary'` 在 `ImageProviderCard.tsx` 本地常量镜像（与 `register-image-features` 同值），避免 renderer→main 依赖。

