# Proposal: shot-video-generation（逐镜头视频段生成——首帧图生视频，Seedance）

## Why

V2 图片切片两步（首帧单镜头 2026-08-17 / 整集批量 2026-08-19）已闭环，但镜头目前只能产出静态首帧。PRD §10 V2 的核心承诺是「单集漫剧生产闭环」：一致性首选机制即「关键帧图生视频」（PRD v1.4 L720），10.6 要求图片/视频异步任务、幂等、取消、超时、恢复、多候选、STALE_INPUT。当前缺口：

- 镜头无视频段产物，「漫剧」无法成片；首帧价值止步于关键帧。
- 媒体域 ASYNC 任务形态（Port 契约 + 调度器轮询/恢复路径）已实现但从未被生产使用（Seedream 是 SYNC）——视频是 ASYNC 的第一个真实消费者。

## 现状事实（勘察 2026-08-20）

- **Port 双形态现成**：`ImageModelPort`（packages\application\src\ports\image-model\）submit 判别联合 SYNC/ASYNC；ASYNC 契约「先持久化 providerTaskId 再轮询」与调度器 `drivePolledCandidate`（轮询截止 10min、间隔 2s、候选级 MODEL_TIMEOUT）、恢复零重发规则全部已实现并有测试。
- **证据链可直用**：迁移 0011 `media_model_invocations` 的 segment_kind 枚举 **POLL 已预留**；两段式收尾、64KiB 截断、usage 落列、下载段失败三写修订（2026-08-20）全部复用。
- **存储/协议需小扩**：ContentAddressedStore 的 MIME→扩展名白名单与表约束需增 `video/mp4`；`jingxu://media` 协议管线可复用，CSP 目前只有 `img-src jingxu:`，`<video>` 需增 `media-src jingxu:` 并复核 privileged scheme 流式支持。
- **IPC/UI 模式可镜像**：image.* 九方法白名单（singleflight+输出脱敏+启动写门控）、FirstFramePanel 世代分组/候选比较/人工选择、1s 有界轮询——视频面板照此镜像。
- **E2E Mock 步骤机制可复制**：`JINGXU_E2E_IMAGE_STEPS` 令牌（SYNC/慢 SYNC/失败注入）→ 视频 `JINGXU_E2E_VIDEO_STEPS`（ASYNC+pendingPolls 轮询窗口/失败注入）。
- **能力快照先例**：迁移 0009 播种 `volcark-seedream-image/v1`（canonical JSON + sha256 三处锁死）——Seedance 初始使用 v1；官方停服核验后以新增 `volcark-seedance-video/v2` 锁定 1.5 Pro，不改写历史快照。
- **凭据现状**：图片档 `profile-image-primary` + Provider 枚举 `VOLCARK_SEEDREAM`（火山方舟 ARK Key，safeStorage 加密）；Seedance 同平台同 Key。

## What Changes

- **视频候选生成主链路**：镜头已选首帧（image candidate selected 指针）→ 图生视频异步任务（submit→poll→download mp4）→ N 个视频候选（多候选保留、人工选择、每镜头至多一个 selected）→ 候选记录 requested/actual 时长（PRD 10.3.1：续写段数=0、裁剪区间=null 如实入库）。
- **整集批量（D1=B）**：镜像 batch-first-frame 模式——显式动作建批（requestId 幂等）、当前世代已有 selected 视频候选的镜头服务端跳过并回告、同项目单活跃批次、惰性逐镜头建档（前一成员终态才提交下一镜头）、失败隔离与统一失败口径、取消仅作用未建档镜头、重启恢复续跑 pending 队列零重发。
- **VideoModelPort + SeedanceVideoModelAdapter**：真 ASYNC（create task→poll→download），错误归一化对齐 Seedream 先例（401/403→CREDENTIAL_INVALID、429→RATE_LIMITED、5xx→PROVIDER_ERROR、超时/Abort/URL 失效），raw/evidenceOf 证据通道 main-only。
- **输入哈希与 STALE**：`generationInputHash` 纳入选中首帧内容哈希（CAS sha256）+ 镜头版本 + 请求参数指纹；首帧改选/镜头编辑 → 旧视频候选 STALE_INPUT 传播。
- **迁移 0012**：`video_candidates` 新表（镜像 image_candidates 约束族 + 时长/分辨率列）+ Seedance 能力快照行。实施时发现 0011 的调用证据 FK 只指向图片表、0012 的成功态时长 CHECK 不允许保留失效视频的真实时长；为保持历史 migration 不可变，追加 0013 统一图片/视频调用证据引用校验与 0014 `STALE_INPUT` 时长保留修正，而非改写 0011/0012。
- **IPC/UI**：`video.*` 新通道组（生成/列表/选择/任务查询/批量/取消/面板状态列表）；分镜工作台视频面板（由已选首帧发起、`<video>` 候选播放比较、人工选择、批次进度行与有界轮询）；CSP `media-src jingxu:`。白名单三处同步纪律（preload 两契约 + bootstrap E2E §9.1）。
- **E2E**：离线 Mock ASYNC 步骤脚本化（轮询窗口/失败注入/取消/重启恢复场景）+ node:sqlite 证据断言（SUBMIT/POLL/DOWNLOAD 三段）。真实 Seedance 认证与收费请求拆出为后续独立 Change，本 Change 不发起外部生成请求。

## 拍板（2026-08-20 已定）

- **D1 切片范围 = B：单镜头闭环 + 整集批量**（批次镜像 batch-first-frame 全套；尾帧提取与 CONTINUOUS_ACTION 复用仍留后继——依赖视频帧解码地基）。
- **D2 凭据面 = A：新档 `profile-video-primary` + 新枚举 `VOLCARK_SEEDANCE`**（独立配置卡、失败隔离；同一把 ARK Key 需再粘贴一次）。
- **D3 `VIDEO_CANDIDATE_COUNT` = 2**（常量注入，成本/时长考量下仍保留比较选择）。
- **D4 真实联调 = 后续 Change**：本切片只以 Mock 和离线证据验收；真实模型开通、Endpoint/Model ID 核验、费用预算和真实视频证据由后续 `seedance-provider-certification` Change 独立完成。

**设计层倾向（design.md 定案，不另设拍板）**：任务/调度器复用策略（泛化 media_generation_tasks/batches 加 kind 列 vs 平行 video 全套）——以现有调度器/批次服务与候选表的耦合度定案，红线是不整段复制 712 行调度器；时长映射=单次档位就近（目标 > 最大档取最大档并如实标注，不续写不裁剪）；视频 parametersFingerprint 含时长/分辨率/首帧引用。

## 非目标

- 尾帧提取、CONTINUOUS_ACTION 尾帧复用、首尾帧双锚定、视频续写（PRD 10.3 按能力接入，依赖帧解码地基，后继 change）。
- 裁剪/续写拼接/时间线/FFmpeg 成片合成（PRD 10.9，独立切片）。
- TTS、驱动音频、口型（PRD 10.7，独立切片）。
- 成本账本 estimated_cost/reconciled_billed_cost（PRD 10.8；本切片只沿证据行记 usage）。
- ProviderCapabilityRegistry 动态探测（10.4——静态快照行沿用 V1 口径）。
- 视频 Seed QA Set（10.11，评测资产建设非代码）。

## Capabilities

### spec: `shot-video-generation`（新建）

- **ADDED Requirement: 已选首帧镜头可发起视频段生成**——READY/编辑态镜头在已选首帧前提下发起图生视频；输入哈希绑定选中首帧内容+镜头版本+参数指纹；幂等建档、多候选保留。
- **ADDED Requirement: 视频候选人工选择与 STALE 传播**——每镜头至多一个 selected；首帧改选/镜头编辑触发旧候选 STALE_INPUT；世代分组呈现。
- **ADDED Requirement: 视频异步任务证据与恢复**——SUBMIT/POLL/DOWNLOAD 证据行（raw 64KiB 截断、usage 落列、mp4 字节恒不入库）；重启后凭 providerTaskId 续轮询、无凭证 MEDIA_TASK_INTERRUPTED 待人工、零重发。
- **ADDED Requirement: 整集视频批量生成**——显式动作建批幂等、当前世代已选镜头服务端跳过并回告、惰性逐镜头建档（至多一个在飞成员）、失败隔离与统一失败口径、取消仅作用未建档镜头、重启恢复续跑不重发。
- **ADDED Requirement: 视频产物边界**——mp4 走内容寻址存储（复算校验/原子 rename/路径防逃逸）；Renderer 经 `jingxu://media` 受限协议取流，CSP 增 `media-src jingxu:`；文件路径不进 Renderer。

## Impact

- `packages/contracts`：video.* IPC 通道与 DTO；Provider 枚举增 `VOLCARK_SEEDANCE`（若 D2=A）。
- `packages/model-adapters`：SeedanceVideoModelAdapter + Mock ASYNC 步骤扩展。
- `packages/application`：VideoGenerationService（幂等/STALE/选择）+ 批量编排骨架复用 + 视频指纹组装；任务驱动复用既有调度器（复用策略 design 定案）。
- `packages/persistence`：迁移 0012（video 候选/任务/批次域 + 能力快照行）以及 0013/0014 完整性修正、0015 官方模型快照升版（最终 head 11→15；旧迁移硬编码断言同步）+ CAS mime 扩展。
- `apps/desktop`：video IPC 注册（singleflight/脱敏/写门控）、视频面板与 CSP、E2E Mock 步骤与新 spec；真实探针不属于本 Change。
