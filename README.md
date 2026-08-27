# 镜序 Studio

镜序 Studio 是面向个人 AI 漫剧创作者的本地优先质量工作台，当前开发目标为 V1“AI 剧本与结构化分镜”。项目尝试把模型生成转化为可编辑、可锁定、可恢复、可追溯的阶段化工作流，而不是直接承诺生成图片、视频或成片。

截至 2026-08-24，仓库已具备可运行的 Windows x64 Electron/React 工程、SQLite 启动与恢复运行时、Project/FormatProfile 管理、离线 Schema Registry、JobRunner、文本模型 Adapter、凭据安全、剧本五阶段链路、已有剧本 Main Dialog 导入与受锁选区改写、结构化分镜、评测集与标注闭环、首帧图片、视频和单集合成工作流。Renderer 正在通过 `guided-workspace-shell-localization` 与 `storyboard-media-workspace-redesign` 改造为中文引导式三栏工作台；自动化 AC-V1-01～06 和 UI 改造后的发布结论必须以最新门禁日志为准，三名目标用户的新版复测尚未完成，因此不能宣称 V1 已正式发布。

## 支持环境

- Windows x64
- Node.js `22.16.x`（仓库接受 `>=22.16.0 <23`）
- pnpm `11.16.x`（仓库接受 `>=11.16.0 <12`）

仓库只使用 `pnpm-lock.yaml`。不要生成或提交 npm、Yarn 等其他包管理器的锁文件。

## 安装与启动

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

SQLite 使用锁定的 Node.js 与 Electron 内置 `node:sqlite`，不需要 Visual Studio、C++ Build Tools、外部 SQLite `.node` 或 Electron native rebuild。开发 Node 与 Electron 内置 Node 的兼容性分别由 Integration、Electron E2E 和 Windows x64 packaged smoke 验证。

若 Electron 官方二进制无法由安装脚本下载，应先核验官方压缩包的 SHA-256，再放入 Electron 缓存并重新运行官方安装脚本；不要伪造 `path.txt`、关闭 pnpm 供应链门禁或降低安全配置。

使用自定义已校验缓存时，安装脚本和 Packager 的缓存变量不同：

```powershell
$env:electron_config_cache = "C:\path\to\verified-electron-cache"
pnpm exec install-electron --no

$env:ELECTRON_CACHE = "C:\path\to\verified-electron-cache"
pnpm package:win

# Packager 也可直接使用已校验的 Electron ZIP 目录；目录内文件名必须为官方格式。
$env:JINGXU_ELECTRON_ZIP_DIR = "C:\path\to\verified-electron-zip-directory"
pnpm package:win
```

## 工程门禁

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:collection
pnpm test
pnpm test:contract
pnpm test:integration
pnpm test:e2e
pnpm package:win
```

Unit、Contract、Integration 和 E2E 使用互斥文件后缀；`pnpm test:collection` 会审计测试文件的唯一归属。

## 构建与打包

```powershell
pnpm build
pnpm package:win
```

生产 Renderer 只加载随应用发布的 `jingxu://app` 本地资源，并使用禁止外部连接的 CSP。开发期 Vite/HMR 例外不进入生产构建。

## 本地数据库与恢复边界

- 生产数据库：`%LOCALAPPDATA%\JingxuStudio\data\jingxu.sqlite`
- 受管理升级备份：`%LOCALAPPDATA%\JingxuStudio\backups\`
- 恢复诊断证据：`%LOCALAPPDATA%\JingxuStudio\diagnostics\`
- 应用只有在数据库打开、PRAGMA、migration、audit、recovery gate 和离线 Schema Registry 全部通过后才进入 `READY`；否则只显示独立只读故障页。
- Renderer 只能通过 `runtime.getStartupStatus`、`runtime.retryStartup` 和 `runtime.restoreBackup` 使用 opaque backup id，不能提交路径、SQL 或连接。
- Project 页面只通过 `project.list/get/create/update/delete/restore` 六个类型化方法访问 Main；Preload 不暴露通用 `send/on/invoke`。
- V1 JSON 导入导出是 CURRENT_ONLY 交换格式，不是完整 SQLite 备份，不能替代受管理数据库备份。
- 当前版本不会自动删除备份或诊断副本；空间治理需后续独立 Change。

## OpenSpec 开发流程

功能、架构、IPC、数据库、Schema、Provider 或安全边界变更必须先建立 Active Change：

```text
Explore -> Propose -> 人工审查 -> Apply -> Verify -> Sync -> Archive
```

当前 Active Change 包括 `existing-script-selective-rewrite`、`v1-acceptance-evidence` 等收口项；已归档的 `2026-08-22-storyboard-evaluation-set` 完成本地评测闭环，但不等同于真实用户试用或 PRD 全量发布验收。完整规则见 `docs/SDD_WORKFLOW.md` 和 `AGENTS.md`。

## 当前已实现

- `ProjectService` 支持稳定 keyset 列表、活动/回收站隔离、详情、原子创建、乐观并发更新、FormatProfile 不可变版本链、软删除、恢复和 requestId 幂等回放。
- SQLite `ProjectUnitOfWork` 在单一 `BEGIN IMMEDIATE` 中提交 Project、FormatProfile、审计、本地分析事件和 `command_receipts`；失败回滚不留下部分记录。
- `0002_project_command_receipts.sql` 只保存 requestId、命令名、payload SHA-256、traceId 和安全结果引用，不保存名称、题材、风格、目录或完整命令载荷。
- Main Composition Root 只在启动状态 `READY/writeEnabled=true` 后构造 ProjectService 并注册六个 Project IPC；注册幂等且复用唯一 SQLite 写连接。
- Renderer 已接入 React Query、React Hook Form 和最小 Zustand UI 协调状态，覆盖列表、创建设定、详情、回收站、错误反馈和 dirty 离开保护。
- 四份 PRD-owned Schema 使用固定 `$id`、Draft、语义版本和 SHA-256 离线编译；启动时在短事务精确替换 `schema_registry_manifest`，提交成功后才发布完整 Registry。
- Forge 产物固定包含 `resources/schemas/v1` 四文件；Schema 故障只允许重试，不开放 Project 写服务，也不提供路径或通用 IPC。
- Application 层已定义 `TextModelPort`、`CredentialPort` 和确定性 `JobRunner`，覆盖任务领取、调用证据、受限重试、结构修复、取消、迟到响应、崩溃恢复和并发门；Provider 调用发生在事务外，业务提交保持短事务边界。
- `MockTextModelAdapter` 提供可重复的失败矩阵；`QwenTextModelAdapter` 锁定受控配置、JSON Mode 和错误归一化。生产入口已接入真实五阶段剧本生成（ScriptJobSubmission/Runner/Scheduler/Recovery），五阶段闭环经离线 Mock 验证；真实 Qwen 凭据连通性与五阶段生成已于 2026-08-14 通过全流程联调。
- API Key 由 Electron `safeStorage` 加密并独立保存，SQLite 只记录不透明凭据引用和验证元数据；Renderer 不接收完整 Key、Authorization 或原始 Provider 错误。
- Main/Preload 已提供逐方法的 `script`、`job`、`provider` 和 `events` IPC 白名单；`staged-script-generation` 已注入阶段提交器，`job.create` 开放真实剧本生成，不再返回 `JOB_SUBMISSION_UNAVAILABLE`，也不创建假版本或空壳任务。
- `staged-script-generation` 已实现 SourceInput/Consent/Episode 初始化、五阶段 ScriptService、不可变 DRAFT/READY/STALE_INPUT 版本链、版本历史与恢复、五阶段 Prompt（v2/story_bible v3）、Script Job 提交/校验/恢复，以及 `script` 五方法白名单和剧本工作区；已通过 `openspec validate --strict`、全量门禁与 clean packaged smoke（离线 Mock），后续经真实 Qwen 全流程联调于 2026-08-15 归档。
- `shot-contract-generation` 已实现第六阶段 SHOT_CONTRACT：分镜候选契约（ModelShotSetCandidate 键存在性）→ 系统字段注入（含 dialogue allOf 精确值系统派生：audio/lip_sync/speaker/台词时长，不信任模型）→ 集合校验（sequence 连续、previous_shot_id 集合内回指、character/scene ID 源自冻结 STORY_BIBLE、Σ target_duration_sec ∈ [30,180]）→ Registry ShotContract 1.1.0 FINAL → 整集 DRAFT/READY/STALE_INPUT 版本链、历史集合恢复、storyboard 工作区与确认/恢复路径；迁移 0008 种子 `shot_contract/v1` 模板（sha256 三处锁死）。真实 Qwen 六阶段联调于 2026-08-16 全绿。
- `shot-first-frame-image-generation` 已实现 V2 图片切片第一步——逐镜头首帧候选生成：`ImageModelPort`（submit/poll/download，容忍同步与异步双形态）、迁移 0009（assets/asset_versions/image_candidates/media_generation_tasks + Seedream 能力快照播种）、内容寻址存储（写入复算校验 + 原子 rename + 路径三重防逃逸）、`MediaGenerationService`（冻结输入哈希、幂等键、STALE 按输入世代与资产绑定双传播）、同项目串行调度与崩溃恢复（证据三分支零重发）、`image` 六方法 IPC 白名单（singleflight + 输出脱敏复验）、`jingxu://media` 受限协议与 CSP `img-src jingxu:`、分镜工作区首帧面板（世代分组、候选比较、人工选择、历史世代只读）；Mock 与真实 SeedreamImageModelAdapter（model id 快照锁定、错误归一化、结果字节魔数嗅探）。真实火山方舟 Seedream 联调于 2026-08-17 全绿。
- `image-credential-management` 已实现图片 Provider 凭据闭环与 SHOT_CONTRACT 超时稳健化：ProviderSettings 内 ImageProviderCard（保存即清空输入、末 4 位回显、model id 只读、测试仅验证密文可解密的如实文案、删除带确认）、图片档固定凭据 id `profile-image-primary` + UI 覆盖轮换（env 引导语义不变）、`generateCandidates` 未配置前置稳定失败 `MODEL_CREDENTIAL_INVALID`（userAction 指向配置入口，其余五个 image 方法不受影响）；分阶段调用超时（SHOT_CONTRACT 300s、其余 120s，application ports 双 barrel 同源）+ JobRunner MODEL_TIMEOUT 传输重试预算 1 次（重试前复核墙钟）+ 按阶段 `deadline_at` 落库（SHOT_CONTRACT 960s、其余 300s）。真实联调（UI 路径配 ARK Key）于 2026-08-19 全绿。
- `batch-first-frame-generation` 已实现 V2 图片切片第二步——整集批量首帧：迁移 0010（`media_generation_batches` + 任务 `batch_id` 溯源列，head=10）、`MediaBatchService`（显式动作建批、当前世代 SUCCEEDED 服务端跳过并回告、空目标 `MEDIA_BATCH_NO_PENDING_SHOTS`、requestId 幂等重放）、惰性逐镜头建档（前一成员终态才提交下一镜头，任意时刻每批次至多一个在飞任务；成员复用既有单镜头粒度与派生 requestId `image-generate_<batch>_<shot>`）、失败隔离与统一失败口径（任务 FAILED 或 COMPLETED 而同轮零 SUCCEEDED 候选均计失败并携带候选错误码）、收尾 COMPLETED/PARTIAL_COMPLETED 派生、重试失败镜头=仅含失败镜头的新批次（不复活旧任务行）、取消仅作用未建档镜头（在飞自然终态、幂等）、重启恢复（pending 队列继续全新提交、在飞任务沿用既有零重发规则）；`image` 九方法 IPC 白名单（`generateCandidatesForShots`/`cancelBatch`/`listStoryboardImageStates`）+ 分镜工作台镜头首帧徽标、批次进度行与 1s 有界轮询（可见性守卫、无活跃批次即停）；E2E Mock 步骤脚本化（`JINGXU_E2E_IMAGE_STEPS`）支撑失败注入/取消/重启四场景。离线全量门禁于 2026-08-19 全绿。
- `media-invocation-evidence` 已实现媒体域调用证据链：迁移 0011（`media_model_invocations`，head 10→11；SUBMIT/DOWNLOAD 两段、请求快照与响应原文 blob+sha256、usage 落列、64KiB 截断标记、双 FK 与终态 CHECK；图片字节恒不入库）、`MediaInvocationRepository` 端口 + SQLite/内存实现、`MediaUnitOfWorkPort` 回调聚合 `MediaRepositories`（全调用点机械重构）、`ImageModelPort` SYNC `raw` 原始响应通道 + `evidenceOf`（仅主进程证据链消费，MUST NOT 进归一错误/日志/Renderer）、Seedream 适配器错误先读体携证据 + 成功返回原文（Authorization 仍只在请求头）、Mock 确定性 raw/evidenceOf；调度器两段式接线（submit 前短事务插 SUBMIT STARTED、成功一笔事务三写「候选 SUCCEEDED + SUBMIT 收尾含 usage/raw + DOWNLOAD 收尾」、失败同事务两写、下载段失败三写「候选 FAILED + DOWNLOAD FAILED + SUBMIT 按成功收尾 raw/usage 不丢失」（2026-08-20 真实联调修订）、取消/停机不收尾 STARTED 残留如实、恢复不自动重发）；候选 `invocation_evidence_ref` 恒指 SUBMIT 证据行、DOWNLOAD 轻量行只记结果 URL 快照与落盘 sha256（blob 恒 NULL）；E2E Mock 档行数/JOIN/失败原文断言 + `print-real-probe-invocations.mjs` 媒体域联查 + `verify-real-media-evidence.mjs` SQL 断言（provider_request_id 以 Provider 实际返回为准，真实 Seedream 同步响应无顶层 id 记 null 属实）。真实联调于 2026-08-20 全绿。
- `shot-video-generation` 仍维护为 V2 Mock-only 闭环：Seedance-2.0-mini、Seedance-2.0、Seedance-2.5 可受限选择，但不计入 V1 发布验收，也不等同于真实视频 Provider 认证。
- `v2-video-composition-export` 已实现单集时间线、Main Dialog 音乐导入、FFmpeg 合成 Job 与受限 MP4 预览；Windows x64 固定制品为 Gyan.Dev FFmpeg 9.0.1 Essentials Build，随包提供可执行文件、GPLv3 许可证、NOTICE 和 SHA-256 清单。该 Change 的既有自动化和 Windows 打包证据见 `docs/V2_VIDEO_COMPOSITION_ACCEPTANCE.md` 与门禁日志；本轮 UI 改造后仍须重新运行完整门禁，旧日志不能替代当前发布证据。
- `guided-workspace-shell-localization` 与 `storyboard-media-workspace-redesign` 将全局入口、六阶段创作流程、五阶段剧本、镜头列表、媒体候选和合成时间线重组为固定导航与分栏工作区；Provider 凭据只在“设置 → 模型服务”编辑，创作区只展示脱敏就绪状态。底层 IPC、SQLite、版本、锁、Job、READY 和导出事务语义保持不变。
- `shot-speaker-id-repair` 已修复 spoken 非旁白镜头 speaker_id 空值漂移致死（2026-08-20 Qwen 实录：WEAK_LIP_SYNC 有台词镜头 null speaker_id 整代失败）：多角色/异形镜头由 `validateModelShotSetCandidate` 增跨字段值校验（非空 string + ShotContract 1.1.0 同款 pattern，`CANDIDATE_DIALOGUE_SPEAKER_INVALID`）落在可修复候选层接入既有 STRUCTURE_REPAIR 修复轮；单角色镜头候选层豁免、`injectShotSystemFields` 确定性派生唯一角色为说话人（与 narrator/无台词推导同族）；修复后非 bible 键仍走 COLLECTION 如实终态（不扩 isRepairable）。零迁移、零 IPC/UI/组合根改动。
- `shot-edit-lock` 已实现分镜逐镜头编辑与锁定（2026-08-20，D1 JSON 文本编辑器/D2 锁对人 AI 一致/D3 七根级/D4 `storyboard.*` 命名空间/D6 edit 复用回执）：JSON 编辑器提交完整 ShotContract 文档，`editShot` 单事务完成 Registry 校验 → 写集推导 → 锁复检（父/子/相等冲突全阻断，`SHOT_LOCK_CONFLICT` 且 fieldErrors 列冲突路径）→ EDIT_INVARIANT 集合校验 → 新 scv DRAFT（系统字段重写、有效锁复制）→ 新整集快照 + shotSetHash 复算，回执幂等重放（复用 SAVE_SCRIPT_DRAFT，同 requestId 同载荷返回同 shotVersionId）；`lockShot`/`unlockShot` 七类创意根字段级版本化（不变量 13：locked_paths ≡ lock_records 有效集合），无回执、同态重入为幂等 no-op，元数据根拒绝 `SHOT_LOCK_POINTER_INVALID`；`storyboard` 三方法 IPC 白名单（singleflight + 输出脱敏复验 + 启动写门控），分镜工作台提供编辑入口、镜头锁徽标、七根级锁定/逐路径解锁与冲突错误回显。
- `storyboard-export` 已实现分镜整集 JSON 导出（2026-08-20，D1 仅 EpisodeStoryboardExport 1.1.0 文件导出/D2 轻量审计事件/D4 `storyboard.exportEpisode` 第 4 方法/D5 单命令确认重发）：`StoryboardExportService` 三段式用例——读事务内 READY_EXPORT 门禁（stageHeads 基线一致 + 整集 READY + `validateShotSetCollection` 复跑 + Σ 软带 [60,120] 判定 + envelope Registry 校验）、事务外文件落盘（main 侧 dialog/E2E 双形态 sink，默认名 `export_<projectId>_<episodeId>_v<versionNo>.json`）、独立短事务审计留痕（`STORYBOARD_EXPORTED`：actor=USER、afterSha256=文件哈希、metadata 含 byteSize/fileSha256/totalDurationSec/deviationReason；审计失败响亮 `EXPORT_AUDIT_FAILED` 附哈希不回滚文件）；组装纯函数确定性派生 12 键 envelope（format_profile 投影 `*_pct` 键改名、`contains_ai_assisted_content` = 任一镜头 `source_type≠HUMAN_CREATED`、`locked_paths` 随文档原样）；路径红线——文件路径绝不进入回执/Renderer/审计行；越带导出 `EXPORT_DURATION_DEVIATION` 带实际 Σ，工作台弹偏离确认对话填原因后同命令 `warnConfirmed` 重发。
- `storyboard-export-deliverables` 已实现 Markdown 分镜表与可生产性报告导出（2026-08-20，D1 复用 `storyboard.exportEpisode` + `format` 枚举入参/D2 结构事实 + 正脸长对白单条 WARN/D3 三按钮并列）：`storyboardExportEpisodeInputSchema` 增 `format` 三值枚举（`EPISODE_JSON|MARKDOWN_TABLE|PRODUCIBILITY_REPORT`，`.default('EPISODE_JSON')` 向后兼容，回执仍 5 键格式无关、白名单/IPC 面零扩张）；两种 Markdown 交付物由同一 `assembleStoryboardExport` envelope（Registry 1.1.0 校验后）确定性渲染——分镜表 9 列（镜头号/景别/运镜/时长/叙事目的/台词/角色/场景/锁定数）+ 头部事实行，可生产性报告六章节（头部事实/时长事实/集合校验结论/AI 参与度/规则段/镜头清单），单元格 `\|` 转义、换行压空格，渲染零 I/O 零时钟；可生产性规则版本 `jingxu-producibility-rules/1` + 阈值常量 `SPEECH_DURATION_WARN_SEC=4` 随报告输出，PRD 9.5 判定式（`frontal_face=true && mouth_visible=true && estimated_speech_duration_sec > 4`）单条 WARN 非阻断；服务层三 format 共用同一 prepare 门禁仅分叉渲染/默认名（`storyboard_…_v<N>.md` / `report_…_v<N>.md`）/审计 `metadata.format`；sink 按扩展名分支 save dialog 过滤器（JSON/Markdown）；工作台 READY 态三按钮并列（导出整集/导出分镜表/导出报告），偏离弹层与成功通知三入口共用且携带 format 重发。
- `project-transfer-import-export` 已实现项目快照导入导出（2026-08-22，ProjectTransferBundle 1.0.0 / CURRENT_ONLY / NEW_PROJECT + RETURN_TO_ORIGIN 双模式）：`TransferService` 导出三段式——读事务内组装（五阶段当前头 + FormatProfile + 整集 READY 门禁 + envelope/Bundle Registry 双校验）、事务外原子落盘（默认拒覆盖，`overwriteConfirmed` 显式确认后重写，无 .tmp 残留）、独立短事务 export_records 留痕（requestId 幂等事实源：同 requestId 同输入指纹原样重放回执，载荷漂移 `TRANSFER_IDEMPOTENCY_CONFLICT`；refused/门禁拒绝不落行）；导入 staging 校验链（大小→UTF-8 拒 BOM→JSON→形状→Hash→Schema→跨对象引用）逐错误码落 FAILED 证据行，正式导入 ID Mapping / NEW_PROJECT 引用重写 / RTO 基线（`stableTransferJson` 规范化逐字比对 + 行 `document_sha256` 计算集合哈希）/ 阶段头 / 依赖 / 审计 / import_records 同一 UnitOfWork 事务（中途失败整单回滚零残留）；迁移 0016 增 request_id partial 唯一索引（仅约束 SUCCEEDED 行）；`transfer` 两方法冻结 namespace + Main 系统 Open/Save Dialog 与原子文件 sink（路径绝不进入 Renderer/回执/审计）；项目列表与项目设置双入口，回执仅 Hash/字节/警告码，NEW_PROJECT 带 `TRANSFER_IMPORTED_SNAPSHOT_REQUIRES_SOURCE` 警告且不创建 SourceInput/ConsentRecord。
- `v2-voice-audio-timeline` 已实现配音→对齐→含配音字幕导出全链（2026-08-27，D1 修订改道 DashScope qwen3-tts 同 key 双档）：`QWEN_TTS` Provider 档（`profile-voice-primary` 固定凭据引用，testCredential=零计费解密校验，模型+音色双白名单）与音色注册表 Neil/Elias/Mochi/Stella（narrator 钉住 Neil 默认音色）；音色映射服务（`char_*` 引用当前 STORY_BIBLE、先全量校验后整体替换、映射缺口 `VOICE_MAPPING_MISSING` 清单阻断）；`VoiceGenerationService/Scheduler`（整集批量建档 requestId 幂等、跳过清单回执、同项目串行、两段式证据、取消先落库、重启恢复只信证据）；CAS audio 登记（真 ffprobe 实测时长 + mime 白名单 + 同 hash 去重 + 候选删除仅删登记）；迁移 0019–0021（voice_generation_jobs/voice_candidates/voice_mappings、时间线配音字幕两轨+audio_volume 列、video_timeline_alignment_items 对齐记录）；`video-composition-service` 时间线扩展（inputHash 纳入新轨与映射快照、候选三元组漂移稳定拒绝）+ 对齐引擎随版本冻结四要素行（规则版本 `jingxu-voice-alignment-rules/1`：ALIGNED 容差 max(300ms, 5%)、FAR_LONG max(2000ms, 50%) 默认 BLOCK_STORYBOARD_FALLBACK 阻断导出、FORCE_TRIM 为唯一解除出口且对白记不完整）；FFmpeg 导出参数化（tpad 冻末帧延展、adelay/amix 配音混音、BGM 音量数据化、临时 ASS 烧录字幕按冻结 sha256 核对台词明文且失败无残留）；Renderer VoicePanel/VideoCompositionPanel/ExportAlignmentSummary 与逐镜头轨道控制、对齐摘要展示。离线全量门禁于 2026-08-27 全绿；Mock 全链 E2E 揭出并修复导出边界误用视频候选仓储的集成缺陷（详见最近验证证据 2026-08-27 条目）。

## 最近验证证据

2026-08-27 `v2-voice-audio-timeline` 实施记录（配音→对齐→含配音字幕导出全链）：

- 离线门禁：format:check、eslint --max-warnings=0、tsc -b 零错误；collection 审计 e2e 22 / contract 24 / integration 46 / unit 121 文件；unit **1076/1076**、contract **180/180**、integration **262/262**；E2E **42 passed + 4 skipped**（真实探针按凭据门控跳过）；`package:win` 通过。全量首跑揪出并同步 4 处跨切片 stale 断言：bootstrap §9.1 apiKeys 冻结枚举补 `voice`；transfer/evaluation 关进程审计脚本迁移 head 断言 19→21；prototype 原型规格模型服务卡计数 3→4（VoiceProviderCard 入列，该规格文件属未提交原型工作区改动，仅本地门禁同步不入本提交）。
- Mock 全链 E2E `voice-full-chain.e2e.spec.ts`（23.1s 绿，6 镜头/4 台词目标/2 跳过回执；对齐 4 行 SLIGHTLY_LONG/FREEZE_EXTEND/dialogueComplete、第二版本 +1）+ 关进程审计脚本 `verify-voice-timeline-audit.mjs`（VOICE_AUDIT_OK targets/selected/candidates=4、jobs=1、exportJobs=1，台词明文零落痕）。导出产物真 ffprobe 复核：12.4s MP4 双流（物理模型 = 4×(1000ms 镜头+1600ms 冻结延展)+2×1000ms，延展只落在有对齐行的台词镜头）。**E2E 揪出真实集成缺陷**：导出边界候选复验误用视频媒体仓储查 `video_candidates` → 配音 ID 恒 null → 无声卡 `VOICE_CANDIDATE_STALE`；改走 `mediaUnitOfWork.voice.generation.findCandidate` 后修复。
- 真实 DashScope TTS 探针 `real-qwen-tts-probe.e2e.spec.ts`（凭据门控 + `--no-proxy-server` 配方，Key 仅 readFile→IPC→safeStorage 密文全程不回显）：同 key 双档（文本档已配置仅读档跳过 / 配音档解密校验零计费），JINGXU_REAL_TTS_PROJECT_ID 复用 READY 项目免重烧约 7 分钟文本链。实测：7 行映射（narrator=Neil 幂等确认 + 6 个 char_* 角色按注册表音色循环自动填充——首跑实证真实契约角色说话人缺行被 VOICE_MAPPING_MISSING 拒）；MAX_TTS_TARGETS=3 真实计费合成 SUCCEEDED（narrator=Neil 5920ms、char=Mochi 3360/4640ms，modelId `qwen3-tts-instruct-flash`），mediaUrl 受限域 `jingxu://media/` 校验 + selectCandidate selectedAt 回读通过；CAS 实录三段 RIFF/WAVE 24kHz 单声道。
- **真实探针再揪一处归因缺陷**：调度器把 Provider 合成成功后的本地登记故障（ffprobe 不可执行）经 normalizeError 错标 MODEL_UNKNOWN，掩盖"音频其实已在 CAS 落盘且已计费"；修正为登记稳定码（VOICE_AUDIO_INVALID/MIME_INVALID）直取不经模型归一化（单测翻转锁定），并实证 dev electron resourcesPath 无打包 ffmpeg → 探测配方必须显式注入 JINGXU_FFMPEG_PATH/JINGXU_FFPROBE_PATH。

2026-08-22 `project-transfer-import-export` 实施记录（项目快照导入导出）：

- 全量门禁：format:check、eslint --max-warnings=0、tsc -b 零错误；unit **879**/101 文件、contract **147**/20 文件、integration **230**/41 文件；Playwright Electron E2E 离线 **25 passed + 3 skipped**（基线 24+3，+1 为新增 project-transfer 单规格；real-probe 三规格按凭据门控跳过）；Windows x64 离线打包（`node_modules/electron/dist` 重建 zip 经 `JINGXU_ELECTRON_ZIP_DIR` 注入）+ packaged smoke 通过；`openspec validate project-transfer-import-export --strict` 通过。
- E2E 边界钉（`project-transfer.e2e.spec.ts`，`JINGXU_E2E_EXPORT_DIR`/`JINGXU_E2E_IMPORT_FILE` 注入免对话框；关进程后子进程 `verify-transfer-audit.mjs` 只读查库）：导出回执恰 4 键（byteSize/exportId/fileSha256/warningCodes）+ 同 requestId 重放回执一致 + 落盘 sha256/字节逐项复核 + Bundle 顶层恰 7 键 `schema_version=1.0.0` 6 镜；expectedVersionId 过期 `SCRIPT_VERSION_CONFLICT`；默认拒覆盖（userAction 含「覆盖」）→ 确认重写新 exportId 且目录无 .tmp；UI 覆盖 confirm 对话框 + 成功通知不含路径。导入回执恰 5 键；NEW_PROJECT 全新 ID、来源指向原项目、`createdObjectCount>=20`，重放同 importId/projectId；同 requestId 载荷漂移 `TRANSFER_IDEMPOTENCY_CONFLICT`；损坏 JSON `TRANSFER_BUNDLE_INVALID`；跨源引用篡改 `TRANSFER_REFERENCE_INVALID`；RTO 追加 versionNo+1 READY 不改历史；改名后 RTO `TRANSFER_PROJECT_CONFLICT`；UI 导入后列表刷新出新项目。审计断言：export_records 3 行 policy 序 REJECT/CONFIRMED_OVERWRITE×2、import SUCCEEDED 3 + FAILED 4（0016 唯一索引为 partial，FAILED 证据行可与成功行同 request_id 并存）、PROJECT_IMPORTED 2 + PROJECT_RESTORED_FROM_BUNDLE 1（actor=USER、metadata.importMode 对应）、projects 恰 3 行零软删除、schema_migrations=16、任何回执/审计列不含 `.json`/反斜杠/目录片段。
- E2E 揪出并修复三处 fixture/桩层测不出的真实缺陷：NEW_PROJECT 镜头版本行 externalParentVersionId 误置 null 违反 shot_contract_versions 血统 CHECK；首次导入回执携带内部 replay 标记致 preload strict parse 拒绝；RTO 基线对 Bundle 解析文档重哈希因键序分歧误判冲突。
- 白名单面同步：preload 契约测试与 bootstrap §9.1 E2E 的 `window.jingxu` apiKeys 枚举补 `transfer`（4.2 新增 namespace 后两处断言 stale，全量首跑揪出）。

2026-08-20 `storyboard-export-deliverables` 实施记录（Markdown 分镜表 + 可生产性报告导出，D1/D2/D3 全按推荐拍板）：

- 全量门禁（重建三 bundle）：format:check、eslint --max-warnings=0、tsc -b 零错误；unit **763**/86 文件（+11：分镜表金样 7 + 服务 format 分支 4）、contract **125**/16 文件（+1：format 三值枚举缺省回填/非法拒绝）、integration **204**/37 文件零回归；Playwright Electron E2E 离线 **19 passed + 3 skipped**（基线 18+3，+1 为新增 deliverables 单规格）；`openspec validate --all --strict` 12/12。
- E2E 边界钉：数据通路导出分镜表 `.md`（9 列表头/分隔行/6 数据行逐镜断言、镜头 #1 全列、#3 空镜台词列空、头部事实行 v<N>/Σ90/exportId/导出时间、竖线换行转义）；可生产性报告六章节 + 画幅/规则版本行 + 无 WARN 段 + AI 参与度 6/6 + 判定式行；editShot 镜头 1 对白时长 3→5 → confirmVersion（重取 current 版本）后 v2 报告 WARN 命中恰 1 行（`- WARN #1（shot_…）：正脸长对白 5s > 4s（WEAK_LIP_SYNC 风险）`）；UI 三按钮可见、点击「导出分镜表」成功通知含 sha256 且不含 `.md`/导出目录；审计断言（`verify-storyboard-deliverables.mjs` 纯 node 只读查库）4 行 `STORYBOARD_EXPORTED`：format 顺序 [MARKDOWN_TABLE, PRODUCIBILITY_REPORT, PRODUCIBILITY_REPORT, MARKDOWN_TABLE]、totalDurationSec 恒 90、fileSha256=after_sha256 逐行一致、任何列不含 `.md`/`.json`/反斜杠/exports。
- 旧 `storyboard-export` E2E 回归绿（含 `format: 'EPISODE_JSON'` 显式化与默认名/审计断言不变）；contracts/IPC/组合根白名单面零改动（`exportEpisode` 方法数不变，仅入参增枚举）。

2026-08-20 `storyboard-export` 实施记录（分镜整集 JSON 导出，D1/D2/D4/D5 全按推荐拍板）：

- 全量门禁（重建三 bundle）：format:check、eslint --max-warnings=0、tsc -b 零错误；unit **752**/85 文件（+16：服务门禁矩阵 13 + 工作台/偏离对话视图 3）、contract **124**/16 文件（+3）、integration **204**/37 文件；Playwright Electron E2E 离线 **18 passed + 3 skipped**（基线 17+3，+1 为新增 storyboard-export 单规格）。
- E2E 边界钉：READY 门禁（DRAFT 导出 `EXPORT_NOT_READY` 且零文件零审计）；落盘 JSON 顶层恰 12 键、`schema_version=1.1.0`、`subtitle_safe_area` 四键 `*_pct`、shot_contracts 6 镜原样携带 `locked_paths`、文件 sha256/byteSize 与回执逐项复核；Σ 偏离（3 镜 15→1 → Σ=48）无确认导出被拒带实际 Σ、UI 弹层填原因确认重发成功；路径红线——回执恰 5 键无路径、成功通知不含 `.json`/导出目录；审计断言（`verify-storyboard-export.mjs` 纯 node 只读查库）3 行 `STORYBOARD_EXPORTED`：actor/objectType/after_sha256=metadata.fileSha256 逐行一致、totalDurationSec [90,90,48]、deviationReason [null,null,'快闪节奏整集']、任何列不含路径痕迹。
- D4 命名面扩展同步四处断言：contracts 通道白名单（4 排序）、storyboard-ipc 契约、组合根注册测试、shot-edit-lock E2E `storyboardKeys`（3→4，全量首跑揪出后同步）。

2026-08-20 `shot-edit-lock` 实施记录（分镜逐镜头编辑与锁定，D1–D6 全按推荐拍板）：

- 全量门禁（重建三 bundle）：format:check、eslint --max-warnings=0、tsc -b 零错误；unit **736**/84 文件、contract **121**/16 文件、integration **204**/37 文件（已知 keyset-history 全并行磁盘竞争 flaky 本次亦过）；Playwright Electron E2E 离线 **17 passed + 3 skipped**（基线 16+3，+1 为新增 shot-edit-lock 单规格：数据通路 8 步 + UI 通路编辑往返/锁徽标/阻断/解锁/版本变化）。
- 锁语义边界钉（E2E 断言）：编辑往返产生新镜头版本且其余镜头引用不变；同 requestId 同载荷顺序重放命中回执返回同 shotVersionId（不产生第二版本）；锁 /dialogue 后编辑 dialogue → `SHOT_LOCK_CONFLICT` 且 fieldErrors 含冲突路径、无关根编辑通过且锁原样保留；/shot_id 元数据根锁定 → `SHOT_LOCK_POINTER_INVALID`；重复锁定幂等 no-op（整集版本不前进）；解锁后投影清空。
- 命名空间面扩展同步三处白名单断言（D4 预期面，非回归）：preload `jingxu-api`/`job-provider-api` 两契约测试与 bootstrap E2E §9.1 `apiKeys` 均增 `storyboard`（含冻结断言）。

2026-08-20 `shot-speaker-id-repair` 实施记录（spoken 非旁白镜头 speaker_id 空值漂移修复，D1 拍板 A+B）：

- 根因（真实联调实录 + 勘察）：Qwen 对 WEAK_LIP_SYNC 有台词镜头输出 `speaker_id: null`（同题材昨日 5/5 过、当日 3/3 败），经「候选层只查键存在 → 注入透传 → 集合层跳过」三道盲区漏至 FINAL 层不可修复终态，整代生成失败；而空值语义完全由创意字段（spoken_text × 渲染模式）决定，属模型可自纠责任。
- 方案（一条产品规则两半实现）：多角色/异形镜头——`validateModelShotSetCandidate` 增跨字段值校验（非空 string + ShotContract 1.1.0 同款 pattern，稳定错误码 `CANDIDATE_DIALOGUE_SPEAKER_INVALID`，明细定位 `shots[i].dialogue.speaker_id`），落在可修复的 CANDIDATE 层接入既有 STRUCTURE_REPAIR 修复轮（960s 预算已覆盖，零管线改动）；单角色镜头——候选层豁免，`injectShotSystemFields` 确定性派生唯一角色为说话人（与 narrator/无台词推导同族）。
- 边界钉（测试断言）：多角色空值透传不越权派生（候选层责任）；单角色空值候选豁免⇔注入派生同谓词；NARRATION_FIRST/无台词/SUBTITLE_ONLY 不触发；修复后非 bible 键仍走 COLLECTION 如实终态（D3 显式接受，不扩 isRepairable）。
- 全量门禁（重建三 bundle）：format:check、eslint --max-warnings=0、tsc -b 零错误；unit **703**（+10）、contract 109、integration 201；E2E 离线 16 passed + 3 skipped（T5 MEDIA_EVIDENCE_OK 不回归）。真实复测按 D5 不做（Qwen 漂移当日性无法按需复现，离线等价形态已覆盖）。
- `openspec validate shot-speaker-id-repair --strict` 通过后归档为 `2026-08-20-shot-speaker-id-repair`（shot-contract-generation spec 1 条修改：spoken 非旁白 speaker 校验含多角色修复轮与单角色派生两场景）。

2026-08-20 `media-invocation-evidence` 收尾记录（媒体域调用证据链，离线门禁 + 真实 Seedream 续跑联调）：

- 拍板 D1–D6 全按推荐：迁移 0011 `media_model_invocations`（head 10→11）、SUBMIT 行 id=invocationId + 候选 ref 恒指 SUBMIT 行 + DOWNLOAD 轻量行（结果 URL 快照 + 落盘 sha256，blob 恒 NULL）、快照含参数指纹与参考图 sha256 清单（64KiB 截断 + usage 落列，图片字节恒不入库）、两段式 STARTED→候选终态同事务收尾、SYNC raw + `evidenceOf` main-only、探针 + SQL 断言。
- 真实联调（`real-batch-seedream-probe` 续跑复用 project_53ea7371，三轮收敛；前两轮败因均探针侧——重启恢复自动续跑批次时按钮禁用点击超时（改为收养活跃批）、`#1` 子串命中 `#10`（10 镜头题材，词界匹配修复）——第三轮全绿）：finalCounts [4,4,4,4,4,4,4,4,2,4]（真实限流在 cb7e97e4 轮2 留 2 FAILED+2 SUCCEEDED 真实原文取证）、空目标幂等 `MEDIA_BATCH_NO_PENDING_SHOTS`、真实 JPEG 141–608KB 全 1440×2560、非首镜头选择回填、UI 徽标逐镜头断言 + 4 张真实解码。播种题材换失声主角旁白叙事（原题材当日遭 Qwen speaker_id 漂移 3/3 败，昨日 5/5 过——provider 侧输出漂移与本文无关，另立事项）。
- 真实联调揪出并修复设计缺陷（design D4 当日修订）：下载段失败只收 DOWNLOAD 行 → submit 已成功（resultUrl 在手）的响应原文/usage 永久丢失（实录 task 1657de32 候选 4aa14454：SUBMIT 行停 STARTED、blob/usage 全空）。修订为同事务三写：候选 FAILED + DOWNLOAD FAILED + SUBMIT 按 SUCCEEDED 收尾（raw/usage 落列）；新增单测断言三写与「候选级全败任务相位仍 COMPLETED」。
- SQL 证据断言（`scripts/verify-real-media-evidence.mjs` 纯 node 只读查生产库，Playwright runner 不支持 node:sqlite 故独立脚本）：`REAL_MEDIA_EVIDENCE_OK` 零违规——12 任务/48 候选/42 SUBMIT（38 SUCCEEDED 全 blob 非空且 usage=1；1 FAILED MODEL_NETWORK_ERROR 无原文属实——传输级错误无响应体；2 STARTED 崩溃窗口残留：两次探针进程杀死在 submit 在飞，如实保留且恢复不重发）/39 DOWNLOAD（38 SUCCEEDED sha256=落盘全对齐 + 1 FAILED MODEL_RESULT_UNAVAILABLE 真实结果 URL 拉取失败 13.2s 留痕）。
- 两项 Provider 侧实录（探针侧已消化，供后续事项）：① 真实 Seedream 图片同步响应无顶层 id（top keys=model/created/data/usage）→ `provider_request_id` 记 null 属实，证据链路靠 snapshot+sha256+时间戳——已采纳对齐：Mock SYNC raw 改镜像真实结构（去顶层 id、补 model/created）、resultRef 与证据行一致记 null、T5 断言反转为恒 null（`SUBMIT_UNEXPECTED_REQUEST_ID`），离线与真实证据口径统一；② Qwen SHOT_CONTRACT speaker_id 输出漂移（WEAK_LIP_SYNC 对白镜头 null speaker_id，text 域 FINAL 层不可修复）——建议 text 域后续 change 将该类违规纳入可修复层或系统派生。
- Mock 对齐后全量门禁重跑（重建三 bundle）：format:check、eslint --max-warnings=0、tsc -b 零错误；unit 693、contract 109、integration 201；Playwright Electron E2E 离线 16 passed + 3 skipped，T5 MEDIA_EVIDENCE_OK {submitRows:24=candidates, downloadRows:20, failedSubmits:4}（provider_request_id 全 null）。
- 全量门禁（f404641，重建三 bundle 后）：format:check、eslint --max-warnings=0、tsc -b 零错误；unit 693、contract 109、integration 201；Playwright Electron E2E 离线 16 passed + 3 skipped（真实探针凭据门控），T5 证据断言 MEDIA_EVIDENCE_OK {submitRows:24=candidates, downloadRows:20, failedSubmits:4}。script-migration 压力测试超时 15s→60s（全量并行磁盘竞争两轮实录 15.7/18.7s，被测属性是对账正确性非耗时）。

2026-08-19 `batch-first-frame-generation` 收尾记录（整集批量首帧，离线门禁 + 真实 Seedream 联调）：

- 拍板 D1–D6 全按推荐：批次表+惰性逐镜头建档（迁移 0010，head 9→10）、批次只汇总/重试失败镜头=新批次、服务端当前世代跳过无 force、同项目串行沿用、`listStoryboardImageStates` + 1s 有界轮询、取消仅未建档镜头。
- 失败成员统一口径（Apply 期 spec 增补）：任务相位 `FAILED`，或任务 `COMPLETED` 但该镜头同轮零 `SUCCEEDED` 候选（Provider 候选级全败时任务相位仍 COMPLETED）；批次视图按 `FAILED` 呈报并携带候选错误码。SQLite 收尾 SQL、内存仓、服务层 `failureErrorCodeOf` 三处同一口径，`openspec validate --strict` 过后归档。
- E2E Mock 步骤脚本化：`JINGXU_E2E_IMAGE_STEPS` 逗号令牌（`S`=SYNC、`S:800`=慢同步制造在飞窗口、`E:MODEL_TIMEOUT`=候选级失败注入；缺省 80 步全 SYNC 兼作失控熔断，非法令牌启动即抛）。四场景全绿：T1 排队/生成中徽标流转至 COMPLETED 6/6、T2 失败注入→PARTIAL+重试新批次、T3 取消剩余→CANCELLED 且在飞跑完、T4 重启→在飞 INTERRUPTED 待人工且 PENDING 候选原地不动（不重发红线）+ pending 队列继续至 PARTIAL。
- 仓库约定新证：新增迁移须同步旧迁移测试的硬编码版本断言（4 文件 9 处：版本清单/计数/TOO_NEW 假版本/备份基线），本次全量集成首跑揪出 9 处失败后补齐。
- 全量门禁：format:check、eslint --max-warnings=0、tsc -b 零错误；unit 687、contract 109、integration 198；Playwright Electron E2E 离线 15 passed + 2 skipped（真实探针门控跳过）。
- `openspec validate batch-first-frame-generation --strict` 通过后归档为 `2026-08-19-batch-first-frame-generation`（shot-first-frame-image-generation spec +5 能力）。
- 真实 Seedream 整集批量联调完成（`real-batch-seedream-probe.e2e.spec.ts`，`JINGXU_REAL_*` 三 env 门控、`JINGXU_REAL_BATCH_PROJECT_ID` 续跑复用项目；五轮实录，前四轮败因均为探针侧——断言过严/竞态/口径误读/弹窗卡住——产品零缺陷）：
- run-1（19.1m，真实 Qwen 播种 7 镜头）：批次一 UI 取消 → CANCELLED 且在飞首镜头自然跑完 4 张、其余镜头零建档零候选；驱动批服务端跳过清单恰为已就绪镜头；真实限流实录（火山方舟安心体验模式 `SetLimitExceeded` → 候选 `MODEL_RATE_LIMITED`）致 PARTIAL_COMPLETED，失败成员携带候选错误码实证。账号侧恢复：调限额 → 404 `ModelNotOpen` → 控制台开通 doubao-seedream-5-0（直连探针另核验 9:16 最小 3,686,400px = 恰 1440×2560）。
- 续跑收敛：重试新批次 rounds 2–4 全败留痕（~1.2s 快败 = 真实 429 往返）→ round 5 批 6871e46f 干净收敛 COMPLETED。期间揪出探针三缺陷并修复：历史终态批误判新批（改已知集合起判）、批行 PENDING 窗口误判终态（终态收敛为显式 COMPLETED/PARTIAL_COMPLETED）、收敛口径与应用待生成口径不符（当前世代 ≥1 张即「已有首帧」：1/4 镜头被新批跳过、整集按钮空目标不建批为铁证 → 续跑收敛线对齐 ≥1，严格 4 张断言仅全新跑强制）。
- 终轮全绿（14.0s，零新图）：finalCounts [4,4,4,4,4,1,4]；空目标幂等 `MEDIA_BATCH_NO_PENDING_SHOTS`；7 镜头 featured 轮全 `jingxu://` 真实 JPEG 1440×2560、167–637KB、同轮 generationInputHash 一致（f1a38ed1 rounds 1–4 全败 → round 5 干净 4 张留痕；4163dc50 一成三败如实 1 张）；非首镜头选择回填 selectedAt；UI 徽标逐镜头断言 + 镜头 #1 候选 4 张真实解码。另：ARK 凭据末四位一致时复用免删存（删除确认框曾需人工应答卡住一轮，续跑路径不再触发）。
- 真实用户使用验收通过（2026-08-19 实机验收：7 镜头 25 张真实首帧的徽标/进度行/大图质量与风格/候选选中态均确认满意）——本 change 验证项全部闭环。

2026-08-19 `image-credential-management` 收尾记录（图片凭据 UI + SHOT_CONTRACT 超时/重试稳健化）：

- 图片 Provider 凭据走 UI 路径全链路落地：ImageProviderCard（保存即清空输入、末 4 位回显、model id 只读、测试仅验证密文可解密读取的如实文案、删除带确认）；密文按固定 id `profile-image-primary` 落盘，UI 保存支持覆盖轮换（CredentialAdapter `overwriteExisting`；env 引导路径语义不变）；文本/图片两档凭据互不干扰。契约 provider 枚举扩 `VOLCARK_SEEDREAM`，`workspace_id` 保非空 + 图片档惰性占位 `'ark'`（DDL 证实列 NOT NULL，design.md Apply 期修订 #1）。
- 凭据未配置/不可解时 `generateCandidates` 前置稳定失败 `MODEL_CREDENTIAL_INVALID`（userAction 指向配置入口），替代适配器内 `MODEL_UNKNOWN` 兜底；其余五个 image 方法不受影响；首帧面板零改动经 userAction 透传呈现引导。
- SHOT_CONTRACT 超时/重试稳健化（D3 方案一，2026-08-17 拍板）：分阶段调用超时（SHOT_CONTRACT 300s、其余 120s，常量落 application ports 双 barrel 同源防漂移）+ JobRunner `TimeoutRetryBudget`（MODEL_TIMEOUT 纳入 transport retry、独立预算至多 1 次、重试前复核墙钟余量）+ `deadline_at` 按阶段落库（SHOT_CONTRACT 960s、其余 300s）。
- 真实联调复证全绿（2026-08-19，dev 入口 + 生产数据根 + 真实 Qwen/Seedream，探针 1 passed 10.1m）：ARK Key 改走 UI 路径（先删生产档残留配置 → 保存末四位断言 → 解密测试，替代 env 引导）；六阶段全 SUCCEEDED（9 镜头 READY）；轮1 4 候选真实 JPEG（306–382KB、全 1440×2560）；8 资产覆盖圣经全部引用；轮2 generationInputHash 必变（f41b…→f80f…，绑定实证）；升版 v2 → 8/8 候选 STALE_INPUT、选择指针保留；UI 解码 8/8 naturalWidth>0。
- D3 超时/重试留证（`scripts/print-real-probe-invocations.mjs` 纯 node 只读查生产库——Playwright runner loader 不支持 node:sqlite，不走 spec）：六阶段全部 attempt_kind=INITIAL 单次 SUCCEEDED；SHOT_CONTRACT 单次 101.2s（2026-08-17 基线：8 提交 5 超时@120s、2 契约失败、1 过）；`timeout_at`=start+300s、`deadline_at`=start+960s 精确落库；本次网络未触发超时、重试预算未消耗（如实记录：重试路径由 197 项 integration 确定性覆盖）。
- 环境实录（开发机磁盘治理）：三盘同时告急（C: 剩 25MB、E: 0、D: 455MB）→ 页面文件无法扩展 → Node 在 ~140MB 小堆 OOM（`NewSpace::EnsureCurrentCapacity`，exit 134）、bsdtar 写 zip 中途 Write error；清理 npm 缓存 2.4G + pnpm store 678M + 剪映数据 12.4G 后 C: 恢复 22G。另：bash 管道 `| tail` 会吞 playwright 退出码造成假绿，门禁命令不加管道。
- 全量门禁：format:check、eslint --max-warnings=0、tsc -b 零错误；unit 667、contract 107、integration 197；e2e 11 passed + 2 skipped（真实探针门控跳过）。Windows x64 重打包（离线 zip 直供配方，sha256 `d21151bb…0f9d`）后 clean image smoke 通过（迁移 1–9、Mock 图片闭环、凭据哨兵泄漏扫描 offenders=0 含 UI 保存路径）；v8 升级 smoke 未复跑——head-8 旧产物已在此前磁盘治理中删除，且自 8/17 末次绿验证以来 `packages/persistence/src/{migrations,audit,runtime}` 零提交（git log 证明，升级路径代码与已验证二进制一致，重建旧二进制不成比例）。
- `openspec validate image-credential-management --strict` 通过后归档为 `2026-08-19-image-credential-management`。
- 真实用户使用与 AC-V1-01 至 AC-V1-06 验收仍待人工核验。

2026-08-17 `shot-first-frame-image-generation` 收尾记录（V2 图片切片第一步 + 真实 Seedream 联调）：

- 真实火山方舟 Seedream 联调全绿（打包产物 + 生产数据根 + 真实 Qwen/Seedream 适配器，探针 1 passed 10.7m；ARK Key 与 DashScope Key 分设，全程经 safeStorage，不经探针读取或回显）：五阶段 + SHOT_CONTRACT 全 SUCCEEDED（9 镜头 READY）；轮1 文生图 4 候选真实 JPEG（238–291KB、全部 1440×2560、`jingxu://media/` 受限协议）；上传 8 资产覆盖圣经全部 character/scene 引用；轮2 参考图生图 generationInputHash 必变（绑定进入生成输入实证）；人工选择、全部资产升版 v2 → 受影响镜头含本镜头、8/8 候选 STALE_INPUT（含未绑定资产的轮1，与 spec「输入哈希不再匹配的候选」语义一致）、选择指针保留可追溯；UI reload 后 8/8 候选 naturalWidth>0。
- 联调修复：Ark 真实响应 `data[].size` 为 "WxH" 字符串而非实现假设的对象 → 候选宽高落库全 null，违反 spec 尺寸落库要求 → `parseSeedreamSize` 双形态解析 + 单测（合法字符串/畸形降级 null/对象兼容），真实联调复证 8 候选全 1440×2560。
- 环境发现：① Electron safeStorage v10 密钥随 userData 目录隔离（`Local State` os_crypt.encrypted_key），dev 目录加密的密文在打包进程临时 user-data-dir 下不可解，表现为 27ms MODEL_UNKNOWN（CREDENTIAL_NOT_FOUND 兜底）——生产单安装持久 userData 不受影响，判联调环境特性；且 Playwright 不实时转发子进程 stderr，插桩输出假阴性误导排障（需 `app.process().stderr` 直连取证）。② SHOT_CONTRACT 于真实网络高频撞 120s 调用上限（当晚 8 次提交：5 超时、2 speaker_id oneOf 契约校验失败、1 过）且 MODEL_TIMEOUT 不自动重试；失败作业不写版本、输入未变 → 探针内同项目重提交 ≤3 次收敛。
- STALE 语义实证：资产升版后按 generationInputHash 传播，当前世代之外的候选全员失效，已选候选保留文件四元组与 selectedAt 指针。
- 生产库迁移 0009 留证：含审计修复的重打包产物对真实生产根一次启动，库 8→9、升级前备份恰新增 1 份（自身 head=8）、启动审计通过 writeEnabled=true——同时实证 episode_versions 回执解析修复对含 SHOT_CONTRACT 确认回执的真实生产库成立（旧代码下该库下次启动必进只读故障）。
- 全量门禁（HEAD=53db326）：Format、ESLint、TypeScript 零错误；Unit 650、Contract 106、Integration 197；Playwright Electron E2E 离线 10 passed + 1 skipped。Windows x64 打包 clean 与 v8 升级双 smoke 通过（升级冒烟另揪出 episode_versions 审计解析潜伏缺陷并修复）。
- `openspec validate shot-first-frame-image-generation --strict` 通过后归档为 `2026-08-17-shot-first-frame-image-generation`（新建 shot-first-frame-image-generation spec）。
- 真实用户使用与 AC-V1-01 至 AC-V1-06 验收仍待人工核验。

2026-08-16 `backup-sidecar-hygiene` 收尾记录（备份目录 sidecar 卫生修复）：

- 修复：备份校验以 readOnly 连接打开 WAL 备份产生 `-shm`/`-wal` sidecar 且 close 时无法自清理——`createOnlineBackup` 的 `.tmp` 校验 sidecar 随 rename 成为永久孤儿，每次启动的全量备份校验反复触碰最终备份 sidecar 并永久残留（开发机 2 天积累 8 组）。`verifyBackupDatabase` close 后 best-effort 清理 `-shm`/`-wal`/`.tmp-shm`/`.tmp-wal` 四类后缀；启动校验逐份触达备份 → 存量残留下次启动自愈，无需清扫迁移。
- 回归钉：WAL 源库备份创建 + 预置两类存量残留 → `listVerifiedBackups` 校验后 `backups` 目录恰好只余 `.sqlite` 与 `.manifest.json`（backup-manager integration 7/7）。
- Format、ESLint、TypeScript 门禁零错误；Unit 568、Contract 86、Integration 169 全部通过；Playwright Electron E2E 8 通过 + 1 按门控跳过。
- `openspec validate backup-sidecar-hygiene --strict` 通过后归档为 `2026-08-16-backup-sidecar-hygiene`（sqlite-migration-runtime 1 条修改：备份验证不残留 sidecar）。
- 备份保留策略、诊断包与项目资产目录治理仍搁置（待产品决策的独立 Change）。

2026-08-16 `shot-contract-generation` 收尾记录（第六阶段 SHOT_CONTRACT + 真实 Qwen 联调）：

- 真实 Qwen 六阶段联调全绿（开发者环境、生产数据根 + 真实 QwenTextModelAdapter）：CONCEPT→STORY_BIBLE→EPISODE_OUTLINE→BEAT_SHEET→SCENE_SCRIPT→SHOT_CONTRACT 全部 SUCCEEDED；SHOT_CONTRACT 生成 9 镜头、Σ target_duration_sec=61 ∈ [30,180]，确认 READY，shot_set_hash=383bda6f4aa228714bb31012d0b70dafbd08dc4ce0bea79b5a8c03f46526ea4e。
- 联调发现并修复无台词镜头缺陷：模型对 spoken_text 为空镜头输出非空 speaker_id/台词时长，被 FINAL 层 SCHEMA_VALIDATION_CONST/TYPE 拒绝；改为系统按 ShotContract 1.1.0 allOf 条件矩阵派生精确值（无台词→null/0，NARRATION_FIRST+有台词→narrator），附回归钉。
- 环境发现：GUI 主进程 fetch 走 Chromium 网络栈并读系统代理，本机系统代理（127.0.0.1:7897）间歇不可用时表现为可重试 MODEL_NETWORK_ERROR（错误归一化正确性已端到端验证）；联调探针以 `--no-proxy-server` 直连取证；Key 轮换后以 `JINGXU_REAL_REFRESH_CREDENTIAL=1` 强制覆盖已持久化旧凭据。
- Windows x64 产物重打包（含注入器修复）后复跑两个 packaged smoke 均通过：clean smoke（迁移 1–8、六条 prompt 锁含 shot_contract/v1、ShotContract 1.1.0 schema 锁、Mock 六阶段闭环、凭据哨兵泄漏扫描、不访问真实用户目录）；v7 升级 smoke（v7 库启动 READY/writeEnabled=true 并迁移至 head 8）。
- 生产数据库 0008 已通过真实启动路径应用并留证：schema_migrations MAX(version)=8（applied 2026-08-15T15:58Z），active 模板 6 条含 shot_contract/v1。
- `openspec validate shot-contract-generation --strict` 通过后归档为 `2026-08-16-shot-contract-generation`（新建 shot-contract-generation spec 4 条能力；staged-script-generation 4 改 1 重命名；jobrunner-qwen-text-adapter 1 改）。
- Format、ESLint、TypeScript 门禁零错误；Unit 568、Contract 86、Integration 168 全部通过；Playwright Electron E2E 8 通过 + 1 按门控跳过（真实 Qwen 探针，需显式环境变量）。
- 真实用户使用与 AC-V1-01 至 AC-V1-06 验收仍待人工核验。

2026-08-15 `staged-script-generation` 收尾记录（真实 Qwen 联调 + 缺陷修复 + 归档）：

- 真实 Qwen 五阶段生成于 2026-08-14 通过全流程联调：CONCEPT→STORY_BIBLE→EPISODE_OUTLINE→BEAT_SHEET→SCENE_SCRIPT 全部 SUCCEEDED，单次 INITIAL 零修复通过；联调发现的 `model_invocations` 外键删除阻塞经迁移 0006 与 `deleteCredential` 顺序修复后，生产库完成凭据清理并写入审计证据。
- 联调暴露的四项 UX 缺陷已修：STRUCTURE_REPAIR 修复上下文进入 messages（修复重试不再原样重发）、error_json 字段级明细（bounded details，截断 10 条）、testCredential 透传 `MODEL_*` 稳定失败码、凭据变更时 `lastValidatedAt` 归零；迁移 0007 解除两快照表 `provider_profiles` 外键，迁移 head=7。
- Format、ESLint、TypeScript 门禁零错误；Unit 493、Contract 83、Integration 159 全部通过；main/renderer/preload 产物重建。
- `openspec archive staged-script-generation` 完成（specs +7 能力）。
- 生产数据库 0007 已通过真实启动路径应用并留证：启动全阶段通过至 `READY/writeEnabled=true`，schema_migrations 记录 1–7 且 checksum 与源文件一致，`foreign_key_check` 零违例、`integrity_check` ok，业务表行数不变，升级前自动生成「Schema v6」在线备份。
- 真实用户使用、AC-V1-01 至 AC-V1-06 验收仍待人工核验。

2026-08-13 `staged-script-generation` Change 记录（离线 Mock，未含真实 Qwen 联调）：

- Format、ESLint、TypeScript 门禁零错误。
- Unit 487、Contract 83、Integration 159，共 729 项 Vitest 断言通过。
- Playwright Electron E2E 7/7 通过（bootstrap 4 + staged-script 2 + packaged-smoke 1）。
- Windows x64 clean packaged smoke 通过；`openspec validate staged-script-generation --strict` 通过；四根 Schema 与 0001/0002 字节未变。
- 真实 Qwen 凭据连通性和三名目标用户真实试用仍待人工核验；自动化 AC-V1-01 至 AC-V1-06 已由最终 Electron 门禁覆盖。
- `storyboard-evaluation-set` 已归档：评测样本与标注 Repository/UnitOfWork、0017 的 24 个 SYNTHETIC 种子与指南版本、九类规则命中、`evaluation` 冻结 IPC、JSON staging 导入和评测集页面；验证记录见归档 Change。

2026-08-13 归档的 `jobrunner-qwen-text-adapter` Change 记录：

- Format、ESLint 和 TypeScript 门禁零错误。
- Unit 105 文件/920 项、Contract 22 文件/161 项、Integration 43 文件/246 项通过；测试收集审计为 e2e 18、contract 22、integration 43、unit 101。
- Playwright Electron 全量 36 个测试中 33 passed、3 skipped；AC-V1-01～06 和 AC-04 崩溃恢复均有独立证据。
- Windows x64 `package:win` 通过；Mock 失败矩阵不访问真实网络或真实用户目录。

完整映射与边界见 `openspec/changes/archive/2026-08-13-jobrunner-qwen-text-adapter/tasks.md`。真实 Qwen 凭据连通性和真实用户生成链路不包含在上述离线验证中。

## 当前尚未实现

- 评测结果的云端协作、跨机交换和回归集管理；当前评测集只在本地 SQLite 中运行，JSON 导入为内部 staging 格式，不是公开评测交换协议。
- V1 自动化 AC-V1-01～06 已有统一 Electron 入口和固定 Mock 证据；仍需以最终全量门禁日志确认，并组织三名目标用户独立试用，不能用自动化结果替代真人验收。
- 真实用户使用和发布验收（真实 Qwen 六阶段与真实 Seedream 首帧生成连通性已分别于 2026-08-16、2026-08-17 通过开发者环境全流程联调）
- TTS、口型、FFmpeg 成片合成、视频时间线和视频后续真实 Provider 认证（Mock-only 视频工作流已在 `shot-video-generation` 落地；真实 Seedance 认证另立 Change）
- AC-V1-04 已接入主进程固定 Mock 失败矩阵；AC-V1-02/03 已接入 Main Dialog、锁定改写与分镜结构编辑命令，最终发布状态仍以门禁日志和真实试用记录为准。

这些能力将分别进入后续 OpenSpec Change。`0001_initial.sql` 中存在对应表结构不等于业务方法、页面、Schema 校验或验收链路已经实现。
