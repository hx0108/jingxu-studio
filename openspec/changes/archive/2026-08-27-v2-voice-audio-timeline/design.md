# Design: v2-voice-audio-timeline

## 0. 事实基础（2026-08-25 代码探索结论）

- 时间线现状：`video_timeline_items` 单条线性视频片段轨 + 版本行单一 `audio_asset_id`（全局 BGM）；无 Track 抽象、无 per-clip 音频、无音量/入出点字段；BGM 音量 0.20 与 2s 淡出硬编码于 `ffmpeg-video-composer.ts` 的 `buildBackgroundMusicFilter`。
- 台词数据齐备：`shot_contract_versions.document_json` 含 `content.spoken_text` 与 `dialogue.{speaker_id, audio_required, estimated_speech_duration_sec}`；`audio_required=true` 即 TTS 目标集合判据；speaker ∈ {`narrator`, `char_*`}。
- Provider 模式：`ProviderProfileKind` 枚举 + `ProviderService` 白名单（`selectableModels` 越权→`PROVIDER_MODEL_NOT_ALLOWED`）+ 桌面档位固定 `CREDENTIAL_ID` 密文装配；`seedance-video-models.ts` 是受限注册表范本。
- CAS：`ContentAddressedStore` 已有 `'audio'` 命名空间与 MIME→扩展映射，BGM 入库即先例；缺 DB 登记层与时长探测边界。
- 调度：`MediaTaskScheduler`（同项目串行/两段式证据/恢复只信证据）面向异步 submit/poll/download；导出 Job 用 requestId 幂等 + AbortController + 恢复标失败。

## D1 Provider 选型：DashScope Qwen3-TTS（2026-08-26 修订）

> **修订记录**：原拍板火山方舟 Ark TTS。2026-08-26 以受限预算免费探测证伪其前提——`POST /api/v3/audio/speech` 路由不存在（裸 404 size=0；同网关已知路由的模型错误均带 JSON 体，二者可区分），`GET /api/v3/models` 130 个模型无任何 TTS 条目，现行 ARK Bearer Key 无法到达 TTS 能力。按本节预留 contingency（探测不通过则回本设计评审）回评审，拍板改道 DashScope Qwen3-TTS，凭据复用现有 QWEN 档同一把 DASHSCOPE_API_KEY。

- `ProviderProfileKind` 增加 `'QWEN_TTS'`；凭据档复用 QWEN 装配范式（固定 CREDENTIAL_ID、safeStorage 密文、`testCredential`=解密加载校验零计费），与 `QWEN` 文本档共用同一把 DashScope Key——同 key 双档先例：`VOLCARK_SEEDREAM`/`VOLCARK_SEEDANCE`。
- 注册表迁移至 `packages/model-adapters/src/qwen/tts-voice-models.ts`（自 `volcark/` 迁移改名，1.2 已落骨架翻写真实事实）：模型（id/label/snapshotDate/能力：输出 mime；语速控制仅 instruct 系经 `instructions` 自然语言，无数值语速参数）+ 音色（含 `narrator` 旁白默认音色与角色可选音色集）。仿 `seedance-video-models.ts` 的 `selectable` 语义。
- **实施首任务为 Schema Probe**（PRD §10.4）不变，对象改为 DashScope qwen3-tts 原生路由（`POST /api/v1/services/aigc/multimodal-generation/generation`，官方文档快照 2026-07-27）：受限预算实测请求/响应形状、音频格式与时长事实，回写注册表快照与 TECH_DESIGN；探测不通过则回本设计评审。

## D2 Port 形态：同步 TtsModelPort 与轻量语音调度器

- DashScope qwen3-tts 为同步 HTTP：单段 POST 合成（2.2 实测：非流式经 OSS `url` 交付 24h 有效 WAV，`audio.data` 恒空）+ 适配器内 GET 下载字节，URL 不出适配器边界 → 新增 application Port `TtsModelPort { validateCredential; synthesize(request, signal); normalizeError; evidenceOf }`，**不复用** `MediaModelPort` 的 submit/poll/download 三段式。
- 新增 `VoiceGenerationScheduler`：复用既有语义（同项目严格串行、两段式证据 STARTED+终态、取消先落库再中止、恢复只信已落库证据、无证据即中断失败），不引入 poll 循环——同步单段调用使 lease/deadline 语义足够。

## D3 数据模型（0020 迁移）

- `voice_generation_jobs`：`UNIQUE(project_id, request_id)`、status CHECK、错误码与证据 JSON（证据边界沿用 media-invocation-evidence）。
- `voice_candidates`：绑定 shot_id、speaker_id、`spoken_text_sha256`、voice_id、model_id、`generation_input_hash`、status、duration_ms、storage_rel_path、file_sha256、byte_size、mime CHECK；每 shot 至多一条当前候选（partial unique 索引）。
- `voice_mappings`：project 级 `speaker_id → voice_id`（含 narrator 固定行），`updated_at` 版本化。
- 时间线扩展：`video_timeline_versions` 增 `audio_volume REAL NOT NULL DEFAULT 0.20`；新表 `video_timeline_voice_items(timeline_version_id, shot_id PK, candidate_id, offset_ms, volume, trim_in_ms, trim_out_ms)` 与 `video_timeline_subtitle_items(timeline_version_id, shot_id PK, enabled, style_snapshot_json, safe_area CHECK)`。
- 仓库约定照旧：新迁移必改 4 文件 9 处版本断言 + 迁移矩阵测试新增 0020 用例；既有版本行缺省读出等效旧行为（audio_volume 默认值即硬编码现状）。

## D4 对齐引擎（纯函数）

- `alignVoiceToShot(audioDurationMs, shotDurationMs, manualOverride|null) → { category, strategy, record }`；category ∈ ALIGNED | SLIGHTLY_LONG | FAR_LONG | SHORTER。
- 阈值常量独立文件版本化（`VOICE_ALIGNMENT_RULES_VERSION`、容忍比、远长比），并随导出报告输出规则版本——对齐判定是可审计规则而非隐式行为。
- 默认策略映射 PRD §10.7.1：略长→合成层 `tpad` 冻末帧静帧延展（不改镜头契约数据，版本行记录 extendedMs）；远长→导出前阻断 `VOICE_ALIGNMENT_BLOCKED`；短于→尾部静音；人工覆盖显式落记录（MANUAL_TRIM_AUDIO / FORCE_TRIM_DIALOGUE_INCOMPLETE / EARLY_CUT_NEXT）。
- 对齐记录四要素（音频实际时长/镜头实际时长/对齐方式/是否分镜层回退）+ 音色映射快照随时间线版本冻结。

## D5 FFmpeg 参数化与字幕烧录

- `buildAudioFilterGraph(version)` 数据驱动：源音轨（如有）+ N 路配音（`adelay=offset`）+ BGM（volume 数据化 + 结尾淡出参数化）`amix inputs=N+2`；配音音量上限与防削波约束在滤镜图内确定性表达。
- 无配音无字幕版本 → 滤镜图退化为现状二路图，回归 E2E 锁定"无配音导出与现状一致"（锁 ffprobe 事实维度，不强求字节级一致）。
- 字幕：`subtitle_items` → 临时 ASS（默认字体、安全区 5%、样式快照随版本冻结）、`subtitles` 滤镜烧录、导出结束清理临时文件（沿用 sink 模式：失败/取消无残留）。

## D6 IPC 面与 Renderer

- 新 `voice` IPC namespace：`getMappings / saveMapping / generateForEpisode / getGenerations / selectCandidate / deleteCandidate`；**白名单四处同步**（contracts 通道白名单、voice-ipc 契约测试、组合根注册测试、preload apiKeys 断言）。
- `video.updateTimeline` 扩展 `voiceItems / subtitleItems / audioVolume` 字段；zod 缺省回填向后兼容（旧调用=空数组+默认音量，注意 `.default()` 使 z.infer 变 REQUIRED 的既有陷阱：旧 TS 调用方需显式传参或走 IPC 边界双兜底）。
- Renderer：新 `VoicePanel`（映射编辑、整集批量生成、候选选择/受限 URL 试听、STALE 徽标）+ `VideoCompositionPanel` 增配音/字幕轨列、对齐状态与人工覆盖入口、BGM 音量调节。

## D7 非目标与边界

- 不做：PRECISE_LIP_SYNC（口型驱动/后处理，独立 change）、字幕样式编辑器、环境音/音效库、音色克隆上传、多语种、BGM 多轨、配音波形编辑器。
- 安全边界沿用：Renderer 永不接收文件系统路径（受限 `jingxu://media/` URL）；`spoken_text` 等用户内容不进日志与审计行；Provider 原始错误仅按调用证据边界留存，Renderer 只见稳定脱敏错误码。
