## 1. 契约与注册表

- [x] 1.1 contracts 新增 `voice-api`（映射/批量生成/候选 DTO、`VOICE_*` 错误码、zod schema + contract 测试）；`video-api` 时间线 DTO 扩展 `voiceItems`/`subtitleItems`/`audioVolume`（缺省回填向后兼容）。（c84f84e；schema 已定义，接入 update/summary 的时间线字段原子化并入 5.1，避免中途破坏 TS 调用方）
- [x] 1.2 model-adapters 新增 `volcark/tts-voice-models.ts`：TTS 模型与音色受限注册表（含 narrator 旁白默认音色）、能力快照（语速上限/采样率/输出 mime），单测覆盖合法/非法/快照冻结。（09e3c0e；快照值全部为 PENDING 占位，2.2 探测后回写真实事实并放开 selectable）
- [x] 1.3 application 新增对齐策略纯函数与版本化阈值常量：四类分类、默认策略、人工覆盖归一；单测覆盖 PRD §10.7.1 全表。（46d8ffd，12/12 绿）

## 2. 适配器与探测

- [x] 2.1 实现 Qwen TTS 适配器（`TtsModelPort`：同步合成、参数白名单、错误归一化脱敏、证据留存）+ Mock 适配器镜像对齐。（Port/Mock 于 f47234a；QwenTtsModelAdapter 按 2.2 实测形状实现：POST 原生路由 + OSS url 下载 RIFF 校验 + 600 字符上限本地拒绝 + 证据通道，单测 8 例）
- [x] 2.2 DashScope Qwen3-TTS Schema Probe 实测：记录请求/响应形状、音频格式与时长事实，回写注册表快照与 TECH_DESIGN；探测不通过则回设计评审 D1。（2026-08-26/27：免费探针证伪 Ark 改道 DashScope；实测非流式 OSS url 交付/RIFF 24kHz 单声道 16bit/[0,600] 字符/usage.characters 每汉字 2/音色表支持列即逐模型支持度；注册表 qwen/tts-voice-models.ts VERIFIED（Neil/Elias/Mochi/Stella），TECH_DESIGN §6.5）

## 3. Provider 档位与音色映射

- [x] 3.1 `ProviderProfileKind` 增加 `QWEN_TTS`：ProviderService 模型+音色双白名单、凭据档复用 QWEN 装配（同一把 DashScope Key）、契约与 UI 文案；非法值稳定错误（测试覆盖）。（union/row-mapper/contracts 枚举 + 组合根 `profile-voice-primary` 固定 id 装配（QWEN_TTS_MODELS 白名单、解密校验零计费）+ IPC voice 槣位分发与配音档文案覆盖 + `VoiceProviderCard`；测试：白名单内外稳定拒绝、QWEN_TTS round-trip×3、组合根凭据闭环、卡片 6 例）
- [ ] 3.2 音色映射服务 + `voice_mappings` 持久化：narrator 固定行、`char_*` 校验引用当前 STORY_BIBLE、缺口清单阻断错误；映射快照冻结进导出记录。

## 4. 生成服务与持久化

- [ ] 4.1 persistence 0020 迁移（voice_generation_jobs / voice_candidates / voice_mappings / video_timeline_voice_items / video_timeline_subtitle_items / audio_volume 列）+ 版本断言 4 文件 9 处同步 + 迁移矩阵 0020 用例。
- [ ] 4.2 `VoiceGenerationScheduler`（同项目串行/两段式证据/取消先落库/恢复只信证据）+ `VoiceGenerationService`（整集批量建档、requestId 幂等、STALE_INPUT、跳过清单回执）。
- [ ] 4.3 产物登记：CAS `audio` 写入、ffprobe durationMs>0 与 mime 白名单校验、同 hash 去重、当前候选唯一约束、候选删除仅删登记；integration 测试。

## 5. 时间线与对齐集成

- [ ] 5.1 `video-composition-service` 扩展：updateTimeline 接受配音/字幕轨与 BGM 音量、inputHash 纳入新轨与映射快照、候选三元组漂移拒绝、旧版本兼容读取；unit + integration。
- [ ] 5.2 对齐引擎接入导出链路：逐镜头计算并冻结对齐记录（四要素+extendedMs）、FAR_LONG 阻断、人工覆盖路径；unit 覆盖全部覆盖分支。

## 6. 合成与导出

- [ ] 6.1 FFmpeg 滤镜图参数化：N 路混音、配音 adelay 偏移、BGM 音量/淡出数据化、tpad 静帧延展；"无配音字幕导出与现状一致"回归锁定。
- [ ] 6.2 字幕烧录：subtitle_items → 临时 ASS（默认安全区样式快照）、subtitles 滤镜、导出后清理、失败无残留。
- [ ] 6.3 导出失败/取消/重启恢复分支扩展（VOICE_ALIGNMENT_BLOCKED、配音/字幕来源失效）+ 终态不可覆盖回归。

## 7. Renderer

- [ ] 7.1 `VoicePanel`：音色映射编辑、整集批量生成、逐镜头候选选择与受限 URL 试听、STALE 徽标；职责测试。
- [ ] 7.2 `VideoCompositionPanel`：配音/字幕轨列、对齐状态与人工覆盖入口、BGM 音量调节；视图测试。
- [ ] 7.3 导出面板对齐摘要（分类/策略/规则版本/记录）展示。

## 8. 端到端与门禁

- [ ] 8.1 Mock 全链 E2E：映射 → 整集生成 → 候选选择 → 时间线编辑 → 对齐 → 含配音字幕导出 → 审计验证脚本。
- [ ] 8.2 真实 DashScope TTS 探针 E2E（凭据门控，`--no-proxy-server` 配方）。
- [ ] 8.3 TECH_DESIGN / README / 实现快照同步更新。
- [ ] 8.4 全量门禁：format/lint/typecheck/collection/unit/contract/integration/E2E + `package:win`，记录实际结果。
