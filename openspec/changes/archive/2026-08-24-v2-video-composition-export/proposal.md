## Why

当前视频能力只能生成和选择逐镜头视频候选，用户无法把已生成的镜头可靠地组织成一条可播放的整集 MP4。V1 已明确不包含成片合成，因此需要一个独立的 V2 Change，在不改变既有候选、输入世代和 V1 验收边界的前提下补齐时间线、音频、FFmpeg 合成和导出质量证据。

## What Changes

- 新增单集视频时间线的创建、查询、排序、启停和入点/出点裁剪；每次编辑创建不可变时间线版本。
- 新增 Main 系统 Dialog 导入 MP3/WAV/M4A 背景音乐，内容寻址保存并记录哈希。
- 新增本地视频导出 Job，保留片段原声，按固定低音量混入可选背景音乐，并输出 MP4。
- 将 FFmpeg/FFprobe 作为受校验的 Windows Electron 资源随包发布；Renderer 不接触路径或子进程。
- 新增导出前后双重输入复检、取消、崩溃恢复、失败证据和无部分文件保证。
- 新增 V2 Electron E2E、打包 Smoke 和文档；不改变 V1 Schema，不引入 TTS、口型、转场、多集批处理或真实 Provider 认证。

## Capabilities

### New Capabilities

- `video-composition-export`: 单集视频时间线、背景音乐导入、FFmpeg 合成、导出 Job、质量校验和失败恢复。

### Modified Capabilities

- 无。现有 `shot-video-generation` 的候选、选择、STALE 和批次语义保持不变；本 Change 只消费其成功候选。

## Impact

- Application：新增时间线、音频资产和导出 Job 的端口、服务、状态机和校验器。
- Persistence：新增不可变时间线、音频资产和导出记录 migration/Repository；扩展内容寻址媒体命名空间。
- Contracts/IPC/Preload/Renderer：新增 `video.*` 时间线、导入和导出 DTO/频道及工作区 UI。
- Main：新增系统 Open/Save Dialog、FFmpeg/FFprobe 受信 Adapter、原子导出文件写入和启动恢复接线。
- Packaging：固定版本 FFmpeg/FFprobe、SHA-256 校验和许可证说明。
- 兼容性：既有视频候选表、视频 IPC、V1 JSON Schema 和 V1 发布门禁不变；新表通过 `0019_video_composition_export.sql` 前进。
