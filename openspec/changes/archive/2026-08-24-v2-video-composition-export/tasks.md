## 1. OpenSpec 与基础契约

- [x] 1.1 固化 proposal/spec/design 并通过 `openspec validate --all --strict`。
- [x] 1.2 新增视频时间线、音频资产、导出 Job 的 contracts DTO、状态枚举和稳定错误码，并补 Contract 测试。

## 2. SQLite 与内容寻址

- [x] 2.1 新增 `0019_video_composition_export.sql`，建立五类 V2 表、索引、外键和状态约束，不修改历史 migration。
- [x] 2.2 扩展 ContentAddressedStore 的 audio/exports namespace、路径白名单、哈希校验和原子写入。
- [x] 2.3 实现时间线、音频资产、导出 Job Repository/UoW，并覆盖版本不可变、幂等和事务回滚 Integration 测试。

## 3. 时间线 Application 能力

- [x] 3.1 先为默认时间线、排序、启停、裁剪、重复镜头和 READY/STALE 门禁补 Unit 测试。
- [x] 3.2 实现 `createTimeline`、`getTimeline`、`updateTimeline`，固化候选哈希、generation input hash 和 FormatProfile 快照。
- [x] 3.3 实现时间线版本冲突、候选变化、非法裁剪和无启用镜头的稳定错误映射。

## 4. 音频导入与 FFmpeg Ports

- [x] 4.1 定义 `VideoComposerPort`、`VideoMetadataProbePort`、Main Dialog/File Sink Port 和测试 Fake。
- [x] 4.2 实现 Main 系统 Dialog 的 MP3/WAV/M4A 导入、512 MiB 限制、FFprobe 解码校验和内容寻址登记。
- [x] 4.3 实现 FFmpeg/FFprobe Main Adapter：参数数组调用、AbortSignal 取消、stderr 截断和稳定错误归一化。
- [x] 4.4 固定并接入受信 Windows FFmpeg/FFprobe 资源、SHA-256/NOTICE 校验；若制品缺失，保留明确 package 阻断。

## 5. 导出 Job 与质量校验

- [x] 5.1 为导出前复检、FFmpeg 参数、原声+BGM 混音、输出质量规则和输入哈希补 Unit 测试。
- [x] 5.2 实现 `startExport`、`getExportJob`、`cancelExport` 及 PREPARING/RUNNING/VALIDATING/终态状态机。
- [x] 5.3 实现临时文件、FFprobe、SHA-256、FormatProfile 规格校验和 Save Dialog 原子复制；失败不得登记成功或留下临时文件。
- [x] 5.4 实现启动恢复，将未完成 Job 标记为 `VIDEO_EXPORT_INTERRUPTED_UNKNOWN_OUTCOME`，不自动重跑。

## 6. Electron 边界与 Renderer

- [x] 6.1 接入 video IPC、Preload 白名单、requestId singleflight、sender/DTO/output 校验和 contract 测试。
- [x] 6.2 在分镜/视频工作区加入时间线创建、排序、启停、裁剪、BGM 导入、导出进度/取消/错误和受限预览。
- [x] 6.3 覆盖 Renderer 加载、空、运行、失败、恢复、FFmpeg 不可用和导出成功状态，不显示路径/命令/密钥。

## 7. Electron E2E 与发布

- [x] 7.1 新增 `E2E-V2-VIDEO-COMPOSE-SUCCESS`，验证 Main Dialog、时间线编辑、BGM、MP4、FFprobe、哈希和可播放性。
- [x] 7.2 新增 `E2E-V2-VIDEO-COMPOSE-FAILURE`，覆盖缺失/STALE/损坏源、非法裁剪/音频、FFmpeg 失败、取消、迟到和崩溃恢复。
- [x] 7.3 新增 `E2E-V2-VIDEO-COMPOSE-PACKAGED`，验证 Windows packaged app 的 FFmpeg/FFprobe 资源和离线 Mock 合成。
- [x] 7.4 更新 README、TECH_DESIGN、V2 验收矩阵和失败案例模板，明确 V2 不改变 V1 发布门槛。
- [x] 7.5 运行并留存 format、lint、typecheck、test:collection、unit、contract、integration、全量 E2E、package:win 和 OpenSpec strict 日志。
