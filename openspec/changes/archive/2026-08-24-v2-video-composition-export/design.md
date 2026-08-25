## Context

现有 `shot-video-generation` 已持久化视频候选、首帧锚点、文件哈希、STALE 状态和 `jingxu://media` 受限取流，但没有时间线、音频资产或本地合成 Job。现有 `ContentAddressedStore` 只允许 images/assets/videos，Electron Forge 也未携带 FFmpeg。该 Change 明确扩大到 V2，但不改写 V1 Schema 或既有视频候选语义。

## Goals / Non-Goals

**Goals:**

- 为单个 READY EpisodeVersion 建立不可变时间线版本。
- 通过 Main Dialog 导入内容寻址音频，复检候选和音频后用受信 FFmpeg 合成 MP4。
- 提供可取消、可恢复、可审计的本地导出 Job，以及打包后可复验的 E2E 证据。

**Non-Goals:**

- 多集批处理、转场、TTS、口型、对白重建、云端合成、真实视频 Provider 质量认证。
- 将 FFmpeg 子进程、任意路径或音频字节暴露给 Renderer。

## Decisions

### 1. 新增独立时间线版本链和导出表

在 `0019_video_composition_export.sql` 新增 `video_timelines`、`video_timeline_versions`、`video_timeline_items`、`video_audio_assets`、`video_export_jobs`。时间线项目固化候选文件哈希和 generation input hash；导出 Job 固化 timeline version、FormatProfile、输入快照哈希和输出摘要。这样既不 UPDATE 既有候选，也不把可变化的 current pointer 当作导出输入。

否决方案：把时间线 JSON 塞进 `video_batches` 或 `export_records`。前者会混淆生成批次和编辑快照，后者无法表达 V2 的音频与本地 Job 状态。

### 2. Application Port 隔离 FFmpeg

Application 新增 `VideoComposerPort` 与 `VideoMetadataProbePort`；它们只接受已解析的媒体输入和输出规范，不接受 Renderer 路径。Main Adapter 使用 `execFile` 参数数组调用随包的 FFmpeg/FFprobe，并把受限 stdout/stderr 转换为稳定错误码。导出 JobRunner 在网络/进程操作外完成短事务写入，符合“长操作不在事务内”的工程约束。

否决方案：在 Renderer 使用 wasm 或直接运行 FFmpeg。该方案扩大权限边界、增加内存峰值并违反 Electron 进程红线。

### 3. 内容寻址扩展到 audio/exports

扩展 `ContentAddressedStore` 的 namespace 和路径白名单，增加 `audio` 与 `exports`，仍使用 sha256 文件名、临时文件、fsync、复算和原子 rename。`video_audio_assets` 保存音频元数据；`video_export_jobs` 保存导出产物相对引用。用户 Save Dialog 的目标路径只在 Main 内使用，回执和审计只保留哈希/字节数。

### 4. FormatProfile 是输出规格事实源

FFmpeg 输出宽、高和 FPS 取导出时冻结的 FormatProfile。混合分辨率片段统一 scale/pad 到该规格；视频输出为 H.264/yuv420p/faststart。原声保持，BGM 使用固定低音量混入并按总时长裁切、淡出；没有音频时不强行伪造音轨。

### 5. Main Dialog 与打包资源

新增 Main 的 Open/Save Dialog Port；E2E 通过受控环境变量注入测试文件和输出目录，但生产 Renderer 永远不传路径。Forge 额外资源包含固定版本 `ffmpeg.exe`、`ffprobe.exe` 和 NOTICE，打包前执行存在性/版本/SHA-256 检查；缺失或不匹配直接阻断打包。

### 6. Job 恢复采用未知结果终止

启动时扫描非终态 `video_export_jobs`，统一写入 `VIDEO_EXPORT_INTERRUPTED_UNKNOWN_OUTCOME`，不自动重发。取消由 JobRunner 的 AbortController 传递到 Main 子进程，终态提交只在质量校验完成后发生。

## Risks / Trade-offs

- [FFmpeg 二进制供应] 仓库已固定 Windows x64 FFmpeg/FFprobe 的来源、版本、许可证和 SHA-256；打包钩子在制品缺失、版本或哈希不匹配时阻断 `package:win`。
- [编码耗时] 本地合成可能持续数分钟 → Job 状态、可取消、启动恢复和进度事件；不在 SQLite 事务中等待子进程。
- [混合媒体规格] 候选可能分辨率/FPS 不同 → 统一转码到冻结 FormatProfile，并由 FFprobe 严格验收。
- [音频兼容性] MP3/WAV/M4A 容器差异 → Main 导入阶段和导出前使用 FFprobe 解码校验，失败不建成功资产。
- [历史数据] 既有数据库没有 V2 表 → 新 migration 只前进；空库、上一版本库和历史版本库都运行迁移矩阵。

## Migration Plan

1. 先加入 migration、Repository 和 invariant/integration 测试。
2. 再接入 Application 服务、Main Adapter、IPC/Preload 和 Renderer。
3. 最后加入 FFmpeg 资源校验、E2E 和 packaged smoke。
4. 迁移失败由现有 migration runner 回滚；不修改已发布 migration，不删除既有视频数据。
5. 未配置 FFmpeg 时 V2 导出入口显示明确 `FFMPEG_NOT_AVAILABLE`，不影响 V1 剧本/分镜使用。
