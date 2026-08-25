# V2 视频合成与导出验收矩阵

本文件记录 `v2-video-composition-export` 的验收边界。它不改变 V1 的发布门槛，尤其不能替代三名真实目标用户的 V1 试用。

| 场景 | 预期证据 | 当前状态 |
| --- | --- | --- |
| READY 单集默认时间线 | 当前 ACTIVE READY 镜头按 sequence 生成，冻结候选 ID、文件 hash、输入世代 hash 与 FormatProfile | Unit 与 Electron E2E 已验证 |
| 时间线编辑 | 排序、启停、入/出点保存为新的不可变版本；空启用集、重复镜头、裁剪越界阻断 | Unit、Contract 与 SQLite Integration 已验证 |
| 背景音乐 | Main 系统 Dialog 仅选 MP3/WAV/M4A，512 MiB 上限，FFprobe 通过才写入内容寻址存储 | 真实 FFprobe 导入、内容寻址与失败无残留已验证 |
| MP4 导出 | Main 调 FFmpeg 参数数组；H.264/yuv420p/faststart；原声与低音量 BGM 混音；FFprobe/哈希/字节数通过后登记成功 | 源码 E2E 与 packaged app 离线真实合成已验证 |
| 失败与取消 | 任一来源失效、裁剪非法、音频非法、FFmpeg 失败、取消或重启未知结果均无成功记录与假 MP4 | 7 条 V2 Electron E2E 全部通过，终态证据不可覆盖 |
| 打包 | 包内固定 ffmpeg.exe、ffprobe.exe、SHA-256、NOTICE 均存在；缺失即 package 失败 | Windows x64 打包与 packaged app 离线合成已验证 |

## 失败案例记录模板

- 测试日期、构建版本、FFmpeg/FFprobe SHA-256。
- 时间线版本 ID、导出 Job ID、输入快照 hash。
- 注入条件、稳定错误码、临时文件清理结果、是否存在成功导出记录。
- FFprobe 摘要（容器、视频流数、宽高、FPS、时长）与输出 SHA-256。

## 当前发布状态

`v2-video-composition-export` 的自动化与 Windows 打包门禁已于 2026-08-24 通过，详见 `V2_VIDEO_COMPOSITION_GATE_LOG_2026-08-24.md`。随包制品为 Gyan.Dev FFmpeg `9.0.1-essentials_build-www.gyan.dev`，许可证、NOTICE、来源归档 hash 和逐文件 hash 保存在 `apps/desktop/resources/ffmpeg/`。

该结论仅表示 V2 单集合成 Change 的工程门禁通过，不代表 V1 三名真实目标用户试用已完成。
