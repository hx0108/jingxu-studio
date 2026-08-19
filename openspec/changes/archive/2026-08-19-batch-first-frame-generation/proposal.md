# Proposal: batch-first-frame-generation

## Why

首帧生成链路（2026-08-17 归档）与图片凭据配置闭环（2026-08-19 归档）均已真实联调全绿，但生成入口只存在于单镜头面板：`FirstFramePanel` 一次只跟踪一个任务，切换镜头整面板重挂载（在飞任务句柄丢失、UI 不可见），镜头列表上没有任何首帧状态聚合。典型一集 6–10 个镜头（实测 9 镜头，硬界 1–20），用户需要逐镜头「点生成 → 盯轮询 → 切下一个」，没有任何排队与汇总视图。

底层能力其实已齐备：`MediaTaskScheduler.drainProject` 本就是同项目严格串行排空（`media-task-scheduler.ts:465-483`），任务粒度、幂等、恢复、STALE 语义全部单镜头就绪；缺的只是一个**持久化的批量入口与聚合视图**。渲染层循环逐镜头调用现有 API 的轻方案不可行：应用重启后剩余镜头永不再提交，违背 PRD §10.6「应用重启后继续查询未完成任务」的任务语义精神。

**定位（对齐 PRD 边界）**：本 Change 是「单集内、用户显式发起的逐镜头顺序排队」——复用单镜头任务机制，不新增生成能力。PRD v1.4 将「批量任务/跨集生产」列为 V4 愿景（:294/:307 不进入当前排期），且「资产变更后列出受影响镜头，不自动批量重生成」（:806）、「单镜头失败不要求重做整集」（:892）是硬红线：本 Change 不做跨集编排、不做成本路由、不做任何自动触发，失败逐镜头隔离。

## What Changes

- 新增批量入口（仅显式用户动作）：`image.generateCandidatesForShots({projectId, shotIds, requestId})` 为 READY 集合内指定镜头建立批次；服务端跳过过滤——「当前世代已有 SUCCEEDED 候选」的镜头默认跳过并如实回告，有效目标为空时稳定失败 `MEDIA_BATCH_NO_PENDING_SHOTS`。
- 惰性逐镜头建档（推荐方案，见 design D1）：批次行持久化 pending 队列，前一镜头任务终态后才为下一镜头建档提交，任意时刻每批次至多一个在飞任务；迁移 0010 新增 `media_generation_batches` 表并为 `media_generation_tasks` 加 `batch_id` 可空列（迁移 head 9→10）。
- 崩溃恢复不碰既有不变式：启动批次恢复为「从未建档」的 pending 镜头建档（全新提交，与「未知是否发出的请求绝不自动重发」零冲突——该不变式只针对已建档任务）；在飞任务沿用既有 `recover` 规则（留证续轮询 / 无证据 `MEDIA_TASK_INTERRUPTED` 待人工）。
- 失败隔离与收尾：单镜头失败不阻断后续镜头；全部成员任务终态且队列耗尽后批次收尾 `COMPLETED`（全成功）或 `PARTIAL_COMPLETED`（含失败）；「重试失败镜头」= 以失败镜头集合发起新批次，不复活旧任务。
- 批次取消（范围见 design D6）：`image.cancelBatch` 仅作用于未建档镜头——批次标 `CANCELLED`、剩余队列不再消费；已终态结果保留，在飞任务跑完自然终态。
- 分镜工作台聚合视图：镜头卡片首帧状态徽标（无候选/排队中/生成中/N 候选就绪/失败）、工具栏「为整集生成首帧」、批次进度与汇总（n/total、失败数）、重试失败/取消剩余入口；数据来自新列表级查询 `image.listStoryboardImageStates`，批次进行中沿用 1 秒有界轮询（`document.visibilityState` 守卫），events 推送通道维持 defer。
- 契约扩展：image 六方法 → 九方法（+`generateCandidatesForShots`/`cancelBatch`/`listStoryboardImageStates`），contracts/preload/main-ipc/composition 四层白名单测试与启动写门矩阵同步。

### 明确不做（非目标）

- 跨集/多项目批量编排、成本路由（PRD V4 愿景，不进入当前排期）。
- 资产升版/分镜升版后的自动批量重生成（PRD :806 红线；STALE 传播维持现状「列出受影响镜头」）。
- 并发提升与客户端限速/退避（沿用同项目串行、跨项目并行现状；Seedream `rate_limit 500 图/分钟` 下整集 ≤80 次请求无压力）。
- 在飞任务的强制中断（`scheduler.cancel`+abort 不暴露，见 D6）。
- Main→Renderer events 推送通道落地（维持既有 defer 决策，牵 CSP/安全面，独立 Change）。
- 覆盖式重生成（对已有当前世代候选的镜头 force 重做，不做 force 参数）。
- 后帧、视频、TTS、成片能力。

## Capabilities

### New Capabilities

（无——本 Change 是既有图片能力内的排队编排扩展。）

### Modified Capabilities

- `shot-first-frame-image-generation`: 新增五条 Requirement——显式触发与逐镜头独立建档、惰性提交与崩溃恢复、失败隔离与收尾派生、批次取消范围、镜头列表状态聚合与批次进度。既有六条 Requirement（冻结输入、恢复不重发、多候选保留、STALE 传播、资产不可变、受限媒体通道、适配器屏蔽）全部不动，批次语义显式服从它们。

## Impact

- **产品/验收**：真实用户在整集 READY 后可一键排队生成首帧，逐镜头失败隔离、可取消剩余、可只重试失败镜头；重启后队列继续。不宣称任何跨集、自动重生成、视频能力。
- **Schema**：六份 PRD-owned Schema 字节不变；TECH-internal 媒体域新增批次表与 `batch_id` 列（PRD Schema 未覆盖排队编排骨架，属 TECH 自有域，同 `media_generation_tasks` 先例）。
- **数据库**：迁移 0010（`media_generation_batches` + `media_generation_tasks.batch_id` 可空列 + 唯一约束/索引），head 9→10；既有任务行 `batch_id` 为 NULL 语义不变。
- **IPC/兼容性**：image 频道六→九，四层白名单测试与「READY 前统一 `STARTUP_WRITE_BLOCKED`」矩阵同步扩展；`requestId` 幂等键命名新增 `image-batch_<uuid>` 前缀，任务级派生键确定性生成以保恢复幂等。
- **进程/安全**：批量建档前置沿用凭据闸（`MODEL_CREDENTIAL_INVALID` 先于建档）与整集 READY/镜头在 READY 集合校验；「至多一个在飞任务」保证重复计费风险不高于单镜头现状；pending 镜头重启后建档是全新提交，不放宽「未知是否发出绝不重发」不变式。
- **并行实施**：单线 Change（契约 → 迁移/持久化 → 应用层与调度钩子 → IPC → Renderer → 门禁 → E2E → 归档），预估体量与已归档 `shot-first-frame-image-generation` 同量级或略小。
