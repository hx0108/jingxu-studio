# Proposal

补齐 V2 语音音频时间线：火山方舟 Ark TTS 配音/旁白生成、角色音色映射、配音轨与基础字幕轨进入合成时间线、TTS 时长与镜头时长的显式对齐策略，以及数据驱动的导出混音。对应 PRD v1.4 §10.4（V2 仅接入一家 TTS Provider）、§10.6（TTS 异步任务）、§10.7/§10.7.1（对白生产与时长对齐）、§10.9（时间线配音/旁白/字幕/BGM 轨道）、§10.10（V2 验收要求 NARRATION_FIRST 与 WEAK_LIP_SYNC 跑通）。

## Why

- 现有合成时间线只有一条视频片段轨与一条全局 BGM（音量 0.20、淡出 2s 硬编码在 FFmpeg filter），PRD 要求的配音、旁白、字幕轨道不存在。
- 镜头契约已携带 `content.spoken_text`、`dialogue.speaker_id`、`dialogue.audio_required`、`dialogue.estimated_speech_duration_sec`，TTS 输入源齐备；但 Provider 档位枚举无 TTS、无角色→音色映射、无配音资产登记表、无时长对齐机制。
- V2 发布验收要求 NARRATION_FIRST 与 WEAK_LIP_SYNC 各跑通一集，配音链路是前置依赖。

## What Changes

- 新增 `VOLCARK_TTS` Provider 档位，复用既有 Volcark 凭据安全通路（safeStorage 密文、固定 CREDENTIAL_ID、白名单校验）；模型与音色按受限注册表冻结，实施首任务做 Ark TTS Schema Probe 并回写快照。
- 新增台词驱动的配音生成任务：整集批量建档（仅 `audio_required` 且 `spoken_text` 非空的镜头）、requestId 幂等、取消、重启恢复只信证据、多候选保留不覆盖、镜头改文后旧候选 STALE_INPUT。
- 新增角色音色映射：`narrator` 固定旁白音色；`char_*` 必须映射到注册表音色，缺口在生成前阻断并报告清单；映射快照冻结进导出记录。
- 配音产物写入既有内容寻址存储 `audio` 命名空间，ffprobe 探测时长（durationMs>0）后才登记候选；同 hash 去重。
- 时间线版本不可变扩展配音轨（voiceItems）与基础字幕轨（subtitleItems，从 `spoken_text` 派生、默认安全区样式、随导出烧录）；inputHash 纳入新轨道；BGM 音量数据化（默认 0.20 保持现状兼容）。
- 新增时长对齐引擎：按 PRD §10.7.1 表对偏差确定性分类（阈值版本化），默认策略为静帧延展/尾部静音/远长阻断回分镜层，人工覆盖显式记录且对齐记录四要素随版本冻结。
- FFmpeg 混音参数化：N 路输入、配音按偏移插入、BGM 音量/淡出数据驱动；无配音与字幕时导出结果与现状一致（回归锁定）。

## Impact

- 代码：`packages/contracts`（voice 契约、video-api 时间线扩展）、`packages/application`（provider/media/script 新服务与 Port）、`packages/persistence`（0020 迁移+新仓储）、`packages/model-adapters`（Ark TTS 适配器与注册表）、`apps/desktop`（IPC/composition/renderer/E2E）。
- 规范：新增 `voice-audio-timeline` 能力（7 个 Requirement）。
- 依赖：`apps/desktop/resources/ffmpeg` 既有二进制即可（amix/adelay/tpad/subtitles 均为标准滤镜）；无新外部二进制。
- 非目标：PRECISE_LIP_SYNC 口型驱动或口型后处理（独立 change）；字幕样式编辑器（本 change 仅默认安全区样式）；环境音/音效库；自定义音色克隆上传；多语种配音；BGM 多轨与配音波形编辑器。
