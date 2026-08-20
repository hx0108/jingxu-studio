# Design: shot-video-generation（逐镜头视频段生成——首帧图生视频，Seedance）

## 背景事实（勘察 2026-08-20）

- **Port/调度器**：`ImageModelPort`（packages\application\src\ports\image-model\）submit 判别联合 SYNC/ASYNC；`createMediaTaskScheduler`（packages\application\src\media\media-task-scheduler.ts，712 行）依赖里图片耦合仅两处——`imageModel: ImageModelPort` 与 `fileStore.writeImage`（images 命名空间）；其余（任务相位机/ASYNC 轮询 drivePolledCandidate/取消迟到复核/证据两段式/恢复零重发/onProjectIdle 批次推进钩子）全部经 `MediaRepository` 通用接口表达。
- **MediaRepository**（ports\media\media-repository.ts）：候选/任务/批次方法族与记录类型（MediaCandidateRecord/MediaTaskRecord/MediaBatchRecord）**无图片专属字段**（width/height 视频同样适用）；图片专属仅资产五方法（findAssetByIdentity/createAsset/appendAssetVersion/listAssets/findCurrentAssetVersion + findAssetVersionMediaById）。
- **持久化**：`image_candidates` 有 UNIQUE(shot,round,index)+selected 部分唯一索引；`media_generation_tasks` 有 UNIQUE(project,idempotency_key)+**UNIQUE(shot,round_no)**——与视频共用同表会撞唯一键；`media_model_invocations` segment_kind 枚举 **POLL 已预留**；`provider_capability_snapshots` 已有 volcark-seedream-image/v1 播种先例（canonical JSON + sha256 三处锁死）。
- **ContentAddressedStore**（persistence\src\media\content-addressed-store.ts）：MIME→扩展白名单 + 路径防逃逸 + 临时文件 fsync 复算原子 rename——需增 `video/mp4` 与 videos 命名空间。
- **协议/CSP**：`jingxu://media` 处理器 main\security\media-protocol.ts（/candidate|asset-version/{id}）；CSP 仅 `img-src jingxu:`（main\security\content-security-policy.ts）；E2E 断言 media-protocol.e2e.spec.ts:102。
- **IPC/组合根**：image-ipc.ts singleflight（同 requestId 同签名复用/异签名 REQUEST_ID_REUSED）+ zod 输出脱敏 + STARTUP_WRITE_BLOCKED；register-image-features.ts 注入 IMAGE_CANDIDATE_COUNT=4、轮询参数、E2E 步骤解析 parseE2eImageSteps、凭据闸。
- **Mock 步骤**：MockImageModelAdapter 声明式 `MockImageSubmitStep`（SYNC/ASYNC(pendingPolls+failureCode)/ERROR/TIMEOUT/afterMs）；E2E 经 `JINGXU_E2E_IMAGE_STEPS` 逗号令牌注入。
- **UI**：FirstFramePanel.tsx（世代分组/候选比较/选择）、storyboard-image-state-policy.ts（徽标优先级）、use-storyboard-image-states.ts（1s 有界轮询）、StoryboardPanel 批次进度行。
- **凭据**：IMAGE_CREDENTIAL_ID='profile-image-primary'；Provider 枚举 `z.enum(['QWEN','VOLCARK_SEEDREAM'])`（contracts\src\job-provider-api.ts:69）；assertCredentialReady 闸在应用服务层。
- **PRD 锚点**：10.2 单镜头稳定=关键帧图生视频；10.3 V2 必须项=首帧生成+尾帧提取+CONTINUOUS_ACTION 复用（本切片只做首帧图生视频）；10.3.1 时长量化（如 5s/10s），Candidate 必须记录单次生成时长/续写段数/裁剪区间；10.6 异步任务/幂等/取消/超时/重试/恢复/多候选/STALE_INPUT；10.9 成片合成与 10.7 TTS/口型均独立切片。

## 定案

### A1 持久化：平行三表（迁移 0012，head 11→12）

不复用 image 三表（UNIQUE(shot,round_no) 冲突；不动生产验证过的图片 schema）：

- `video_candidates`：镜像 image_candidates 约束族（UNIQUE(shot,round,index)、每镜头至多一个 selected 部分唯一索引、SUCCEEDED 必含文件四元组+invocation_evidence_ref）**增列** `requested_duration_sec INTEGER NOT NULL`、`actual_duration_sec INTEGER NULL`（Provider 未回报则 null 如实）、`first_frame_candidate_id TEXT NOT NULL`、`first_frame_file_sha256 TEXT NOT NULL`（STALE 判定依据）；width/height 承视频分辨率；mime CHECK 含 video/mp4。
- `video_generation_tasks`：镜像 media_generation_tasks（相位机 6 值、UNIQUE(project,idempotency_key)、UNIQUE(shot,round_no)、provider_task_id 可空、batch_id 可空 FK→video_batches）。
- `video_batches`：镜像 media_generation_batches（RUNNING/COMPLETED/PARTIAL_COMPLETED/CANCELLED、target/pending/skipped JSON、UNIQUE(project,idempotency_key)）。
- `provider_capability_snapshots` 播种 `volcark-seedance-video/v1`（model id 以官方核验为准记入 canonical JSON；SourceURL 记火山方舟文档；sha256 三处锁死同 Seedream 模式）。
- 旧迁移硬编码版本断言 4 文件 9 处同步（仓库约定）。

### A2 复用策略：类型别名泛化 + 二次实例化（不复制调度器，不动图片行为）

- 从 `MediaRepository` 提取生成域子接口 `MediaGenerationRepository`（候选+任务+批次方法族）；图片 `MediaRepository extends` 之并保留资产五方法；新 `VideoMediaRepository implements MediaGenerationRepository`（video 三表）。
- `MediaRepositories` 聚合扩为 `{ media, invocations, video }`——**共用同一 UnitOfWork（单一 BEGIN IMMEDIATE/FIFO 不变）**，跨域读同事务可见（视频建档读选中首帧引用）。
- 调度器依赖 `imageModel: ImageModelPort` 泛化为 `model: MediaModelPort`（`type MediaModelPort = ImageModelPort` 结构别名，注释声明图片/视频适配器共用此结构契约）；`fileStore.writeImage` 参数化命名空间（images|videos）。`createMediaTaskScheduler` **二次实例化**：image 实例（现状零变化）+ video 实例（video 仓/VideoModelPort/videos 命名空间/独立轮询参数：pollDeadlineMs 视频分钟级预算、segmentTimeoutMs 按官方超时上限）。
- `MediaGenerationService`/`MediaBatchService` 同款二次实例化：视频版 resolveGenerationInput（目标=已选首帧镜头；当前世代 ≥1 SUCCEEDED 视频候选即跳过——对齐图片续跑口径）+ 视频版 failureErrorCodeOf 口径复用。
- `MediaModelInvocationRepository` 零改动（POLL 枚举已预留）；SUBMIT 行 id=invocationId、候选 ref 恒指 SUBMIT 行、DOWNLOAD 轻量行、下载段失败三写修订全部沿用。

### A3 VideoModelPort + SeedanceVideoModelAdapter

- `ports/video-model/video-model-port.ts`：结构对齐 ImageModelPort（validateCredential/submit/poll/download/normalizeError/evidenceOf；submit 判别联合 SYNC/ASYNC；poll PENDING|SUCCEEDED|FAILED）——Seedance 真 ASYNC（create task→poll→download mp4）。
- `packages/model-adapters/src/volcark/seedance-video-model-adapter.ts`：错误归一化对齐 Seedream（401/403→MODEL_CREDENTIAL_INVALID、429→MODEL_RATE_LIMITED、5xx→MODEL_PROVIDER_ERROR、超时→MODEL_TIMEOUT、Abort→MODEL_CANCELLED、URL 失效→MODEL_RESULT_UNAVAILABLE）；raw/evidenceOf main-only（禁入 Renderer/日志/归一错误）；下载 URL 只许 https 无 userinfo、redirect:'error'、字节魔数嗅探 mp4（ftyp box）；请求前置校验（时长档位/分辨率/首帧字节上限）按能力快照 constraints。
- Mock：`mock-video-model-adapter.ts` 声明式步骤（ASYNC pendingPolls 为主形态）；E2E 令牌 `JINGXU_E2E_VIDEO_STEPS`（`A`=ASYNC 2 次轮询、`A:800`=慢异步制在飞窗口、`E:<code>`=失败注入；非法令牌启动期抛；缺省预算熔断同图片模式）。

### A4 输入指纹、STALE 与时长映射

- 视频参数指纹：`seedance-v1:{modelId}:{WxH}:{durationSec}:{firstFrameSha256 前 12 位}`（组合根注入）。
- `generationInputHash` = sha256(canonical JSON{firstFrameFileSha256, modelId, parametersFingerprint, shotContentHash, shotVersionId})——**不含资产绑定**（i2v 输入=首帧+提示词）。
- 视频提示词：镜头文档确定性派生（action/emotion/camera_motion 运镜文本+narrative_purpose），纯函数零 I/O。
- STALE 双触发：①镜头新版本确认 → `markCandidatesStaleByShotVersion`（video 表，与图片同钩子处调用）；②首帧改选 → `markVideoStaleByFirstFrameChange(shotId)`——以 `first_frame_file_sha256 ≠ 当前选中首帧 sha` 判定（确定性 join，无哈希簿记）。
- 时长映射（PRD 10.3.1）：档位以能力快照 constraints 为准（预期 [5,10]s，官方核对）；requested = 最小档 ≥ target_duration_sec，无则最大档并如实标注（不续写不拆镜）；`actual_duration_sec` 取 Provider 响应字段，未回报 null 如实；续写段数恒 0、裁剪区间恒 null 落列（本切片不续写不裁剪）。

### A5 IPC/UI/协议

- `video.*` 七方法白名单：generateVideoCandidates / listVideoCandidates / selectVideoVideoCandidate→selectVideoCandidate / getVideoTask / generateVideosForShots（批量）/ cancelVideoBatch / listStoryboardVideoStates。singleflight+zod 输出脱敏+STARTUP_WRITE_BLOCKED 全沿用；**白名单三处同步纪律**（preload jingxu-api/job-provider 两契约 + bootstrap E2E §9.1 apiKeys）。
- 凭据：`VIDEO_CREDENTIAL_ID='profile-video-primary'` + Provider 枚举增 `VOLCARK_SEEDANCE`；`VideoProviderCard`（复用 ImageProviderCard 模式：保存即清空/末 4 位回显/model id 只读/删除确认）；env 联调后门 `JINGXU_VIDEO_CREDENTIAL_FILE`；视频方法族 assertCredentialReady 前置闸（未配置 → MODEL_CREDENTIAL_INVALID 指向视频配置入口）。
- UI：`VideoPanel`（镜头卡视频徽标 + 已选首帧缩略发起 + `<video>` 候选播放比较 + 人工选择）；StoryboardPanel 增「整集生成视频」批次发起与进度行（复用 1s 有界轮询模式 use-storyboard-video-states）；无已选首帧的镜头在批量回执 skipped 如实回告。
- 协议/CSP：media-protocol 增 `/video-candidate/{id}` 段类型，**实现 Range/206 基本支持**（`<video>` 拖动必需，越界 Range 回 416，异常回退 200 全量）；CSP 增 `media-src jingxu:`；registerSchemesAsPrivileged 确认 stream 支持。

### A6 真实联调（D4=含）

- 探针 `real-seedance-video-probe.e2e.spec.ts`（JINGXU_REAL_* 三 env 门控 + `--no-proxy-server` 直连 + JINGXU_REAL_REFRESH_CREDENTIAL=1 先例）；前置：账户开通 seedance 模型、model id 官方核验（qwen 核验先例）、时长档位与分辨率上限实测入能力快照（若与声明不符，快照升版并留勘误记录）。
- SQL 证据断言 `scripts/verify-real-video-evidence.mjs`（node:sqlite 只读查生产库）：SUBMIT/POLL/DOWNLOAD 三段齐、POLL 行数=轮询次数实录、mp4 字节恒不入库（blob 恒 NULL on DOWNLOAD）、usage 落列、候选 ref 无悬空。

## 非目标（对齐 proposal）

尾帧提取/CONTINUOUS_ACTION 复用/首尾帧双锚定/视频续写；裁剪与时间线/FFmpeg 成片；TTS/口型；成本账本（只记 usage）；动态能力探测；视频 Seed QA Set。

## 测试策略

- **unit**：VideoModelPort 契约（SYNC/ASYNC/poll 状态/证据通道）；Seedance 适配器错误归一矩阵 + mp4 魔数嗅探 + 前置校验；视频指纹/提示词纯函数；VideoGenerationService（幂等建档/STALE 双触发/选择指针）；VideoBatchService（跳过口径/惰性建档/失败隔离/取消/收尾派生）；调度器 video 实例（轮询窗口/超时/取消迟到/恢复零重发——复用既有 807 行测试模式）。
- **integration**：迁移 0012 断言（三表约束族+快照行 sha256+旧迁移 4 文件 9 处同步）；SQLite video 仓储全方法；CAS video/mp4 + videos 命名空间；UnitOfWork 聚合 {media,invocations,video} 事务可见性。
- **contract**：video.* 通道白名单（7 排序）；preload 两契约；IPC zod 脱敏；枚举 VOLCARK_SEEDANCE。
- **E2E 离线**：T1 单镜头闭环（发起→轮询→下载→`<video>` 面板→选择→改选首帧 STALE→镜头编辑 STALE）；T2 整集批量（跳过回告/失败隔离 PARTIAL/重试新批/取消/重启恢复续跑零重发）；T3 证据三段 node:sqlite 断言；T4 协议/CSP（media-src、Range/206、路径不进 Renderer）；T5 白名单三处（apiKeys 含 video）。
- **真实联调**：real-seedance-video-probe（六阶段产物→已选首帧→真实视频段→下载 mp4→证据 SQL 断言）。
