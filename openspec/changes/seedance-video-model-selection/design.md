## Context

参见 proposal.md。当前视频生成在 Composition Root、生成服务与 Seedance Adapter 中各自固定 Seedance 1.5 Pro；`video_candidates.model_id` 和调用证据已经能冻结模型，但 Profile 保存接口不允许改变模型，Adapter 也忽略请求中的冻结 modelId。

## Goals / Non-Goals

**Goals:**

- 以固定、版本化的本地模型注册表提供三个用户可选的 Seedance 模型。
- 在主进程完成模型选择校验与读取；每个新任务冻结模型，运行中的任务不受之后设置变更影响。
- 维持现有 safeStorage 凭据边界、异步任务证据、首帧图生视频、内容寻址落盘与 Mock E2E。

**Non-Goals:**

- 不支持任意模型 ID、推理接入点、第三方网关、跨 Provider 路由或自动降级。
- 不增加音频、视频编辑、续写、TTS、时间线或成片能力。
- 不将零计费的“密文可解密”测试伪装成模型权限或付费调用验证。

## Decisions

### 1. 使用受限模型注册表，而非 Renderer 传入模型 ID

在 `model-adapters` 定义冻结的 `SeedanceVideoModelDefinition`：显示名称、方舟 modelId、快照日期、首帧图生视频能力以及当前工作台可用的安全参数子集。首批目标为：

- `SEEDANCE_2_0_MINI` → `doubao-seedance-2-0-mini-260615`
- `SEEDANCE_2_0` → `doubao-seedance-2-0-260128`
- `SEEDANCE_2_5` → `doubao-seedance-2-5-260628`

注册表是 Main/Adapter 的唯一模型事实源；IPC 仅接收上述键。选择“任意 modelId”会扩大可调用面并重新引入本次 404 的不可诊断风险，因此否决。

### 2. 通过 Provider Profile 保存选择，但任务创建时异步解析并冻结

在既有 `provider_profiles` 记录中使用 `model_id`、`model_snapshot_date` 存储模型选择，不新增密钥字段；新增 migration 只把既有视频 Profile 迁移到受支持的默认模型，不触碰任务、候选或 Invocation。Provider 设置命令增加仅视频 Profile 可用的 `videoModel` 枚举，并保留 `expectedVersionId` / `requestId` 的并发和幂等语义。

视频生成服务接收一个 Application Port 解析当前受支持模型；建档时读取该 Port、计算输入哈希并把实际 modelId 落入候选。Adapter 改为验证并提交请求中冻结的 modelId，而不持有可变模型状态。这样设置变化只影响之后的新任务，已建档任务在轮询与下载阶段不重新读取 Profile。

### 3. 保守使用各模型共有的现有视频工作台参数子集

仍只提交单张已选首帧、文本、无音频、5/10 秒时长与 720p 输出；对 Standard 保持现有 1080p 分支仅在已验证支持时启用。这样不为切换模型扩大 V2 能力，并避开不同模型在音频、编辑、长时长和高分辨率上的差异。模型注册表在提交前校验冻结 modelId 与该安全子集。

### 4. 404 模型/接入点错误单列为不可重试的模型不可用

Adapter 解析 HTTP 404 并产生稳定的 `MODEL_MODEL_UNAVAILABLE`，而非笼统 `MODEL_PROVIDER_ERROR`。调用证据仍保存原始响应于 Main-only SQLite blob；Application、IPC 与 Renderer 仅传稳定错误码和“开通模型或配置接入点”的动作建议。

## Risks / Trade-offs

- [模型 ID 或账号权限随 Provider 变化] → 将 ID 与日期置于单一版本化注册表；真实调用仍由用户自行发起，404 不自动回退。
- [三个模型能力不完全一致] → 仅支持经过当前工作台验证的共有首帧图生视频参数子集，按模型限制在提交前阻断。
- [旧 Profile 指向 1.5 Pro] → migration 保留它作为历史兼容值；新设置仅能选择三个新选项，旧任务仍依其候选 modelId 执行。
- [用户误将“测试凭据”理解成模型授权] → UI 明确说明测试只校验密文可解密；模型可用性以真实任务的脱敏结果为准。

## Migration Plan

1. 新增不可变 SQLite migration，为视频 Profile 的合法模型选择和能力快照升级准备数据；不改写既有 migration。
2. 升级时保留当前 Profile 和所有历史视频任务；未选择新模型的旧 Profile 显示为“旧模型”，直到用户主动选择新模型。
3. 回滚只回滚应用程序版本，不回写数据库中的模型选择；旧版本遇到未知新模型时进入安全的配置错误态，不能偷偷调用其他模型。
