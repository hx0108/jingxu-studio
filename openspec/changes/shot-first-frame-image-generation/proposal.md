# Proposal: shot-first-frame-image-generation

## Why

六个文本阶段（CONCEPT→SHOT_CONTRACT）已于 2026-08-16 经真实 Qwen 全流程联调闭环并归档，READY 的 ShotContract 已提供逐镜头创意字段、ContinuityMode 与时长目标。PRD v1.4 §10 的 V2 主线是单集生产闭环，其图片侧的第一步是「逐镜头首帧」：首帧候选生成、比较与人工选择（§10.5），资产版本绑定与参考图（§10.2/§10.5），图片异步任务与重启恢复（§10.6）。当前仓库没有任何图片能力：`model-adapters` 只有文本 Adapter，`0001_initial.sql` 没有资产或媒体表，Renderer 也无图片通道。本 Change 建立 V2 图片生成的第一块地基：**逐镜头首帧候选生成与选择**，并把能力边界、适配器形态与资产版本语义一次定清楚，避免后续视频/TTS 切片返工。

## What Changes

- 新增逐镜头首帧候选生成：以项目当前 READY ShotContract 的单个镜头为冻结输入，组合镜头创意字段（cinematography/content/generation_constraints）、STORY_BIBLE 角色/场景描述与 FormatProfile 构造图片 Prompt；该镜头绑定的资产版本存在已上传参考图时走参考图生图，否则走文生图（PRD §10.2 两种机制）。
- 新增资产与资产版本（迁移 `0009`）：CHARACTER/SCENE 两类资产按 STORY_BIBLE ID 建档，参考图上传产生不可变 AssetVersion 链；镜头生成时解析 `character_ids`/`scene_id` 对应资产的当前版本并写入生成输入快照。资产参考图本期仅支持上传，不支持生成。
- 每镜头每轮生成 N 张候选（默认 4），全部保留、不覆盖旧结果（PRD §10.6）；用户比较后人工选择一张为当前首帧，可切换，历史选择可追溯（PRD §10.5）。
- 生成输入哈希锁定「镜头版本内容 + 绑定资产版本 + 模型与参数」；ShotContract 确认新 READY 或资产升版后，既有候选与选择标记 STALE_INPUT 并列出受影响镜头，不自动批量重生成（PRD §10.5）。
- 新增媒体异步任务：`ImageModelPort` 采用 submit/poll/download 三段原语，`provider_task_id` 在轮询前持久化；应用重启后按持久化证据恢复轮询、不自动重发未知请求（沿用 jobrunner 崩溃恢复语义）；支持幂等 ID、取消与超时（PRD §10.6）。
- 适配器选型：`MockImageModelAdapter`（离线失败矩阵）+ 火山方舟豆包 Seedream Adapter（产品负责人 2026-08-16 指定字节家族；Seedance 为视频模型，图片切片用 Seedream，V2 仅接入一家图片 Provider，PRD §10.4）；凭据沿用 safeStorage + 独立 provider profile 行模式（方舟 ARK Key 为第二份独立密文），具体 model id 在 Apply 期经官方文档核对后锁死并写入静态能力快照。
- 图片字节存于 `projects/<projectId>/` 受管理目录（内容寻址 sha256 文件名，天然不覆盖）；SQLite 只存哈希、尺寸、格式与相对路径；Renderer 经受限 `jingxu://media` 通道取图，CSP 收紧 `img-src`，不暴露文件系统路径。
- 调用证据记录 `provider_reported_usage`（图片数）；`estimated_cost` 维持 UNKNOWN，价格表与成本对账属后续 Change（PRD §10.8 仅登记边界）。
- 明确不实现：视频、尾帧提取与 CONTINUOUS_ACTION 尾帧复用（视频切片）、TTS/口型、时间线与合成、动态 ProviderCapabilityRegistry（沿用静态快照，PRD §10.4 动态化后续）、资产参考图的生成路径、批量重生成、ShotContract `asset_version_ids` 回写（本切片绑定记录在候选输入快照上，不改写已确认分镜）。

## Capabilities

### New Capabilities

- `shot-first-frame-image-generation`: 逐镜头首帧候选生成、资产版本与参考图绑定、候选保留与人工选择、STALE_INPUT 传播、媒体任务恢复、受限图片通道与 Adapter 隔离。

### Modified Capabilities

- 无。`shot-contract-generation` 只读消费 READY 集合，不改其生成、确认与失效语义；`jobrunner-qwen-text-adapter` 的文本 Runner 不动（媒体任务走独立任务表与调度约束，由新能力自带需求约束）；`desktop-workspace-foundation` 的 Preload 白名单、启动门与隔离规则是通道无关不变式，新 `image` 通道按既有模式遵守即可。

## Impact

- **产品/验收**：覆盖 PRD v1.4 §10.2（文生图/参考图生图两条机制）、§10.3（仅首帧部分）、§10.5（资产版本、候选、人工选择、受影响镜头列举）、§10.6（图片异步任务切片）的可宣称范围；不宣称任何视频、口型或成片能力。V2 进入条件（§10.1.1）中「一家图片 Provider 候选选型与官方核对」由本 Change 任务 0.x 补齐；产品负责人已于 2026-08-16 拍板「提案先行、立即 Apply」，AC-V1-01~06 与 3 名用户试用未完成的事实如实登记，不因本提案隐式放宽。
- **Schema**：六份 PRD-owned Schema 字节不变；ShotContract 1.1.0 作为只读输入被消费；新增 ModelImageRequest/Candidate 等 TECH-internal 契约。
- **数据库**：新增 `0009_media_assets_images.sql`（assets、asset_versions、image_candidates、media_generation_tasks 及索引），迁移 head 8→9；不改写 0001–0008；回执命令复用，command_receipts 不变。
- **IPC/兼容性**：新增方法级 `image` 白名单（生成、候选列表、选择、资产列表、上传参考图、任务状态）与 `jingxu://media` 协议；CSP `img-src` 收紧为该通道；开发期 strict DTO 变更同步 Main、Preload、Renderer、Contract 与 E2E。
- **进程/安全**：凭据边界完全沿用——safeStorage 加密、SQLite 只存 credential_ref、Key 不回流 Renderer、Provider 专有错误仅在 Adapter 内归一化；图片字节不进入 SQLite、日志或诊断包。
- **存储**：`projects/<projectId>/` 首次承载媒体字节，目录增长模型自此确定；空间治理（候选保留、资产清理）按既定决策留待独立后续 Change。
- **并行实施**：公共契约冻结后三线推进：A 线 Persistence/迁移/事务，B 线 Adapter/Mock 矩阵，C 线 IPC/协议/Renderer；Composition Root 与真实联调由集成线统一收口。
