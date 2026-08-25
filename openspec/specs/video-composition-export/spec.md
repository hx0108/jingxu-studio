# video-composition-export Specification

## Purpose

让创作者把一个 READY 单集中的已选视频候选安全地编排、混音并导出为可播放 MP4，同时保留输入版本、文件哈希、任务状态和失败证据，避免把未验证的部分成片当作成功结果。

## Requirements

### Requirement: 单集时间线必须绑定不可变输入快照

系统 MUST 仅允许从 READY EpisodeVersion 创建单集时间线，并为每个时间线项目保存 shot_id、candidate_id、file_sha256、generation_input_hash、position、enabled、trim_in_ms 和 trim_out_ms。时间线编辑 MUST 创建新版本，不得修改历史版本。

#### Scenario: READY 单集创建默认时间线

- **WHEN** 用户对 READY 单集执行“生成时间线”
- **THEN** 系统按 ACTIVE 镜头 sequence 创建一个新时间线版本，并只纳入当前输入世代的 SUCCEEDED 视频候选

#### Scenario: 非 READY 单集被拒绝

- **WHEN** 用户对 DRAFT、STALE_INPUT 或不存在的单集创建时间线
- **THEN** 系统返回 `VIDEO_COMPOSITION_NOT_READY`，不创建时间线版本

#### Scenario: 时间线编辑保持历史

- **WHEN** 用户改变顺序、启停或裁剪并保存
- **THEN** 系统创建新的时间线版本，旧版本内容和哈希保持不变

### Requirement: 时间线编辑必须执行确定性约束

系统 MUST 支持排序、启用/跳过和入点/出点裁剪；至少一个项目 MUST enabled，且每个启用项目 MUST 满足 `0 <= trimInMs < trimOutMs <= actualDurationMs`。系统 MUST 拒绝重复镜头、非法下标、未知候选、未回报实际时长或越界裁剪。

#### Scenario: 合法裁剪与排序保存

- **WHEN** 用户提交唯一镜头集合、连续 position、合法裁剪范围的时间线
- **THEN** 系统保存新版本并返回排序后的完整摘要

#### Scenario: 非法裁剪不产生部分写入

- **WHEN** 任一项目 trimInMs 等于或大于 trimOutMs，或超过实际时长
- **THEN** 系统返回 `VIDEO_TRIM_INVALID`，时间线版本和当前指针均不变化

### Requirement: 背景音乐必须通过 Main 文件边界导入

系统 MUST 通过 Main 系统 Open Dialog 读取 MP3、WAV 或 M4A 背景音乐，校验大小、扩展名、哈希和可解码性后保存为内容寻址资产。Renderer MUST NOT 提交任意本地路径或接收完整路径。

#### Scenario: 合法背景音乐导入

- **WHEN** 用户在 Main Dialog 选择可解码且不超过 512 MiB 的 MP3/WAV/M4A
- **THEN** 系统保存音频资产并返回 asset id、mime、字节数和 sha256，不返回路径

#### Scenario: 非法背景音乐被拒绝

- **WHEN** 用户选择不支持扩展名、空文件、超过大小上限或 FFprobe 无法解码的文件
- **THEN** 系统返回 `VIDEO_AUDIO_INVALID`，不留下资产或临时文件

### Requirement: 导出必须在执行前后复检输入并原子产出

系统 MUST 在创建导出 Job、启动 FFmpeg 前和提交成功前复检时间线版本、候选状态、候选文件哈希、音频资产和 FormatProfile。任一输入过期、缺失、损坏或裁剪非法时，整单 MUST FAILED，不得跳过坏镜头、回退历史候选或产生成功 MP4。

#### Scenario: 全部输入有效时导出

- **WHEN** 时间线、视频文件、可选音频和 FormatProfile 均通过复检
- **THEN** 系统运行合成并在 FFprobe、哈希和字节校验通过后登记 SUCCEEDED 导出

#### Scenario: 候选在导出前变为 STALE

- **WHEN** 时间线保存后候选输入世代或文件哈希变化
- **THEN** 系统返回 `VIDEO_SOURCE_STALE`，导出失败且不登记成功产物

### Requirement: 输出必须符合固定媒体质量规则

系统 MUST 输出 MP4、单视频流、H.264、yuv420p、faststart，分辨率和 FPS 绑定当前 FormatProfile。片段原声 MUST 保留；有背景音乐时 MUST 以固定低音量混入并按整集时长裁切、淡出；无音轨时允许静音 MP4。

#### Scenario: 输出质量校验通过

- **WHEN** FFmpeg 完成且 FFprobe 能解析输出
- **THEN** 系统确认容器、视频流数量、分辨率、FPS、时长、可解码性、sha256 和 byteSize 后才返回成功

#### Scenario: 输出损坏或规格不符

- **WHEN** 输出无法解码、缺少视频流、规格不符或时长不在允许误差内
- **THEN** 系统返回 `VIDEO_OUTPUT_INVALID`，清理临时文件且不产生成功记录

### Requirement: 导出 Job 必须可取消、可恢复且不自动重发未知结果

系统 MUST 实现 `PREPARING -> RUNNING -> VALIDATING -> SUCCEEDED`，并允许任一非终态进入 FAILED 或 CANCELLED。取消 MUST 终止本地合成并清理临时文件；启动恢复 MUST 将未完成 Job 标记为 `VIDEO_EXPORT_INTERRUPTED_UNKNOWN_OUTCOME`，不得自动重跑。

#### Scenario: 用户取消运行中的导出

- **WHEN** 用户在 FFmpeg 运行期间取消
- **THEN** 系统终止子进程、删除临时文件并将 Job 标记为 `VIDEO_EXPORT_CANCELLED`

#### Scenario: 应用崩溃后恢复

- **WHEN** 应用重启时发现 PREPARING、RUNNING 或 VALIDATING Job
- **THEN** 系统将其标记为 `VIDEO_EXPORT_INTERRUPTED_UNKNOWN_OUTCOME`，保留输入和调用证据且不创建新版本或自动重发

### Requirement: IPC 和安全边界必须保持本地优先约束

系统 MUST 通过固定 `video.*` IPC 方法暴露时间线、导入和导出操作。修改命令 MUST 携带 projectId 和 requestId，并按受影响对象携带明确的并发令牌：创建时间线使用 episodeId 与 expectedEpisodeVersionId，编辑使用 episodeId 与 expectedVersionId，启动导出使用 episodeId 与 timelineVersionId，取消使用 exportJobId。FFmpeg/FFprobe MUST 仅由 Main 通过受信路径和参数数组调用，Renderer、日志、审计和回执不得泄露本地路径、命令行、密钥或 Provider 原始响应。

#### Scenario: 重复 requestId 载荷一致

- **WHEN** 同一 requestId 以相同输入重复提交
- **THEN** 系统返回原操作摘要且不创建第二个时间线或导出 Job

#### Scenario: 重复 requestId 载荷变化

- **WHEN** 同一 requestId 携带不同时间线或导出输入再次提交
- **THEN** 系统返回 `REQUEST_ID_REUSED`，不执行新操作

### Requirement: 合成界面必须以时间线和导出检查器组织操作

合成界面 SHALL 将预览、时间线编辑与背景音乐/输出/任务设置分区展示，运行、取消、失败、恢复和成功预览状态 MUST 保持可区分。

#### Scenario: 用户开始合成导出

- **GIVEN** 当前时间线和媒体输入通过导出前校验
- **WHEN** 用户开始导出 MP4
- **THEN** 页面 SHALL 显示中文进度、取消入口和当前阶段
- **THEN** 成功前 MUST NOT 显示可播放的假输出
