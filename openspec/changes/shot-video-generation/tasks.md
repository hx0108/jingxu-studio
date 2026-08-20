# Tasks: shot-video-generation

## 1. contracts + Port + 适配器

- [x] 1.1 Provider 枚举增 `VOLCARK_SEEDANCE`（contracts job-provider-api）；video.* 七方法通道白名单 `VIDEO_IPC_CHANNELS`（generateVideoCandidates/listVideoCandidates/selectVideoCandidate/getVideoTask/generateVideosForShots/cancelVideoBatch/listStoryboardVideoStates）+ DTO schema；contract 测试（7 排序、枚举、脱敏面）
- [x] 1.2 `ports/video-model/video-model-port.ts` + 类型（submit SYNC/ASYNC 判别联合、poll PENDING|SUCCEEDED|FAILED、usage/raw evidence）；调度器依赖 `imageModel` 泛化为 `MediaModelPort` 结构别名、`fileStore.writeImage` 参数化命名空间（images|videos）——图片实例行为零变化（既有 807 行调度器测试全绿为证）
- [x] 1.3 `SeedanceVideoModelAdapter`（model-adapters/volcark/）：create task→poll→download 真 ASYNC；错误归一矩阵（401/403/429/5xx/超时/Abort/URL 失效）；mp4 字节魔数嗅探（ftyp）；前置校验（时长档位/分辨率/首帧字节上限）按能力快照；raw/evidenceOf main-only；单测矩阵
- [x] 1.4 `MockVideoModelAdapter`（声明式步骤 ASYNC pendingPolls/失败/慢异步）；`JINGXU_E2E_VIDEO_STEPS` 令牌解析（组合根，非法令牌启动期抛，缺省预算熔断）

## 2. persistence（迁移 0012，head 11→12）

- [x] 2.1 迁移 0012：`video_candidates`（镜像约束族 + requested/actual_duration_sec + first_frame_candidate_id + first_frame_file_sha256 + mime CHECK video/mp4）、`video_generation_tasks`（镜像 + UNIQUE(shot,round_no) + batch FK）、`video_batches`（镜像）、能力快照 `volcark-seedance-video/v1` 行（canonical JSON + sha256 三处锁死；model id 以官方核验为准）
- [x] 2.2 旧迁移硬编码版本断言 4 文件 9 处同步（initial-schema/project-command-receipts×3/script-migration/persistence-runtime-adapter）
- [x] 2.3 `VideoMediaRepository` SQLite + 内存实现（implements 提取出的 `MediaGenerationRepository` 生成域子接口）；`MediaRepositories` 聚合扩 `{ media, invocations, video }`（同一 UnitOfWork/FIFO）；集成测试（约束族/selected 部分唯一/STALE 双触发/世代聚合）
- [ ] 2.4 ContentAddressedStore：MIME 白名单增 video/mp4 + videos 命名空间；集成测试（复算校验/原子 rename/路径防逃逸）

## 3. application（服务与调度器二次实例化）

- [ ] 3.1 视频参数指纹与提示词纯函数（`seedance-v1:{modelId}:{WxH}:{duration}:{firstFrameSha256 前 12}`；generationInputHash=sha256(JSON{firstFrameFileSha256,modelId,parametersFingerprint,shotContentHash,shotVersionId})；时长档位就近映射含超上限如实标注）；单测金样
- [ ] 3.2 `VideoGenerationService`：已选首帧门禁（`MEDIA_FIRST_FRAME_NOT_SELECTED`）+ 凭据闸 + 幂等建档（candidateCount=2 注入）+ STALE 双传播（shotVersionId / markVideoStaleByFirstFrameChange 按 first_frame_file_sha256 判定）+ 选择指针；单测
- [ ] 3.3 调度器 video 实例（createMediaTaskScheduler 二次实例化：video 仓/video 端口/videos 存储/独立 pollDeadlineMs 分钟级预算与 segmentTimeoutMs）；单测（ASYNC 轮询窗口/候选级超时/取消迟到复核/恢复零重发——复用既有调度器测试模式）
- [ ] 3.4 `VideoBatchService` 二次实例化：目标=已选首帧且当前世代无 SUCCEEDED 视频候选；跳过清单（无首帧/已有）；空目标 `MEDIA_BATCH_NO_PENDING_SHOTS`；惰性逐镜头/失败口径复用/取消/收尾派生/重试新批；单测
- [ ] 3.5 `VideoApiService`（IPC 编排 + jingxu://media/video-candidate URL 输出 + 输出脱敏面）；单测

## 4. main：组合根 + IPC + 协议/CSP + 凭据

- [ ] 4.1 `register-video-features.ts` 组合根：调度器/服务/批量装配、VIDEO_CANDIDATE_COUNT=2、轮询参数、E2E 步骤注入、恢复接线、凭据闸（`VIDEO_CREDENTIAL_ID='profile-video-primary'` + env 后门 JINGXU_VIDEO_CREDENTIAL_FILE）；组合根集成测试（注册/装配/恢复）
- [ ] 4.2 `video-ipc.ts` 注册（singleflight 同 requestId 同签名复用/zod 输出脱敏/STARTUP_WRITE_BLOCKED）；preload `jingxu-api` 白名单 + 两契约测试同步
- [ ] 4.3 media-protocol 增 `/video-candidate/{id}` 段类型 + Range/206 基本支持（越界 416、异常回退 200）；CSP 增 `media-src jingxu:`；registerSchemesAsPrivileged stream 复核；协议单测
- [ ] 4.4 `VideoProviderCard`（复用 ImageProviderCard 模式：保存即清空/末 4 位回显/model id 只读/删除确认）接入 ProviderSettings

## 5. renderer：视频面板与批量 UI

- [ ] 5.1 `VideoPanel`（镜头卡视频徽标 + 已选首帧缩略发起 + `<video>` 候选播放比较 + 人工选择 + 世代分组 STALE 呈现）+ 视图测试
- [ ] 5.2 StoryboardPanel「为整集生成视频」批次发起 + 进度行 + 取消；`use-storyboard-video-states` 1s 有界轮询（有活跃才持续）；徽标优先级 policy + 测试
- [ ] 5.3 三 bundle 重建（vite.main/preload/renderer）

## 6. E2E 离线与全量门禁

- [ ] 6.1 T1 单镜头闭环 E2E（发起→轮询→下载→面板 `<video>`→选择→首帧改选 STALE→镜头编辑 STALE）；T2 整集批量 E2E（排队/跳过回告/失败隔离 PARTIAL/重试新批/取消/重启恢复零重发）
- [ ] 6.2 T3 证据三段 node:sqlite 断言脚本；T4 协议/CSP E2E（media-src、Range/206、路径不进 Renderer）；T5 白名单三处（preload 契约 + bootstrap E2E §9.1 apiKeys 含 video）
- [ ] 6.3 全量门禁零回归：tsc -b / eslint --max-warnings=0 / prettier / unit / contract / integration / 全量 E2E（基线 763/125/204/19+3skip 之上只增不减）/ openspec validate --all --strict

## 7. 真实联调 + 文档 + 归档

- [ ] 7.1 联调前置：账户开通 seedance 模型、model id 官方核验（qwen 先例）、时长档位与分辨率上限实测（与快照声明不符则快照升版留勘误）
- [ ] 7.2 `real-seedance-video-probe.e2e.spec.ts`（JINGXU_REAL_* 门控 + --no-proxy-server）：已选首帧→真实视频段→下载 mp4→UI `<video>` 解码→STALE 实证；`scripts/verify-real-video-evidence.mjs` SQL 断言（三段齐/POLL 实录/字节不入库/usage/ref 无悬空）
- [ ] 7.3 README（当前已实现 + 最近验证证据新计数 + 尚未实现收窄）→ validate --strict → archive → merge main → 代理推送 → 记忆更新
