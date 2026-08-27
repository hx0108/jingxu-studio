# voice-audio-timeline Specification

## Purpose
TBD - created by archiving change v2-voice-audio-timeline. Update Purpose after archive.
## Requirements
### Requirement: TTS Provider 必须单一接入且模型与音色受注册表冻结

V2 SHALL 仅接入 DashScope Qwen3-TTS 一个语音 Provider，以新的 `QWEN_TTS` 档位复用既有凭据安全通路（与 QWEN 文本档共用同一把 DashScope Key；2026-08-26 修订，原 Ark 方案被探测证伪）。TTS 模型与音色 SHALL 由受版本控制的本地受限注册表枚举；Renderer MUST 只提交注册表内的模型与音色值，MUST NOT 接收任意模型 ID、任意音色 ID、Provider URL 或本地路径。模型/音色选择与 API Key 分开保存，切换选择 MUST NOT 读取、回显或替换 API Key；凭据 MUST NOT 以明文落盘，safeStorage 不可用时保存 MUST 失败而非降级。

#### Scenario: 用户保存受限的 TTS 模型与音色映射

- **GIVEN** 应用已进入可写状态，TTS Provider 档位可用
- **WHEN** 用户在 TTS 设置中选择注册表内的模型，并在音色映射中选择注册表内的音色后保存
- **THEN** 系统 SHALL 保存模型与音色选择及对应快照日期，重新读取时展示一致
- **THEN** 系统 MUST NOT 在返回 DTO、SQLite 明文字段、日志或 Renderer 状态中暴露 API Key

#### Scenario: 非法模型或音色值被拒绝

- **GIVEN** Renderer 或其他调用方提交不在注册表内的模型或音色值
- **WHEN** Main 校验 TTS 设置或音色映射命令
- **THEN** 系统 SHALL 返回稳定请求错误且不得修改 Provider 档位、凭据、映射或任何配音任务

#### Scenario: 实施前完成 Schema Probe 并回写快照

- **GIVEN** TTS 适配器尚未对真实 DashScope TTS 端点完成探测
- **WHEN** 执行受限预算的 Schema Probe（验证请求/响应形状与音频格式，不做质量评估）
- **THEN** 探测结论 SHALL 回写注册表快照与技术设计；探测不通过时 MUST NOT 将该 Provider 投入真实生成

### Requirement: 配音生成必须由台词驱动且任务证据完整

配音生成 SHALL 仅针对 `dialogue.audio_required` 为真且 `content.spoken_text` 非空的镜头建档；`SUBTITLE_ONLY` 或无台词镜头 MUST NOT 建档，且批量请求包含这类镜头时 SHALL 在回执中列出跳过清单。生成任务 SHALL 支持 requestId 幂等重试、取消（先落库再中止在飞请求）、应用重启后恢复；恢复 MUST 只信已持久化的调用证据，无证据的未完结候选 SHALL 标记中断失败且 MUST NOT 自动重发。每次生成 SHALL 保留多候选且不覆盖旧结果；镜头 `spoken_text` 或其版本变更后，旧候选 MUST 标记 STALE_INPUT。

#### Scenario: 整集批量建档跳过无台词镜头

- **GIVEN** 一集内存在 NARRATION_FIRST、WEAK_LIP_SYNC 与 SUBTITLE_ONLY 三种镜头
- **WHEN** 用户对整集发起配音批量生成
- **THEN** 系统 SHALL 仅为前两类且有台词的镜头建立生成任务
- **THEN** 回执 SHALL 列出被跳过的镜头及原因，且不产生任何失败记录

#### Scenario: 同 requestId 重试返回一致回执

- **GIVEN** 一次批量配音请求已建档且响应丢失
- **WHEN** 相同 requestId 的请求重发
- **THEN** 系统 SHALL 返回与原请求一致的幂等回执，MUST NOT 重复建档或重复调用 Provider

#### Scenario: 重启后无证据候选标记中断且不自动重发

- **GIVEN** 应用在配音请求在飞时异常退出，该候选无已持久化的调用证据
- **WHEN** 应用重启并执行恢复
- **THEN** 系统 SHALL 将该候选标记为中断失败并提示人工重试
- **THEN** 系统 MUST NOT 自动向 Provider 重发该请求

#### Scenario: 镜头改文后旧候选失效

- **GIVEN** 镜头 L 已有一条 SUCCEEDED 配音候选
- **WHEN** 用户修改 L 的 `spoken_text` 并保存为新镜头版本
- **THEN** L 的旧候选 SHALL 标记 STALE_INPUT 且不再可被选入时间线
- **THEN** 旧候选的音频文件与调用证据 MUST 保留不删除

#### Scenario: 多候选保留且人工选择当前候选

- **GIVEN** 镜头 L 已有一条候选且用户再次生成
- **WHEN** 新候选成功返回
- **THEN** 系统 SHALL 新增候选行且不覆盖旧候选
- **THEN** 用户选择新候选后，L 至多有一条当前候选指向新结果

### Requirement: 角色音色映射必须可追溯且缺口阻断生成

`narrator` SHALL 固定映射到注册表中的旁白默认音色；`char_*` 说话人 SHALL 映射到注册表音色且 MUST 引用当前 STORY_BIBLE 中存在的角色。批量生成前系统 SHALL 校验整集映射完整性：存在未映射或引用失效的说话人时 MUST 以稳定错误阻断并列出缺口清单，MUST NOT 静默使用默认音色替代。映射变更 MUST NOT 改写已建档候选冻结的音色；导出时 SHALL 将映射快照冻结进导出记录。

#### Scenario: narrator 固定使用旁白音色

- **GIVEN** 镜头为 NARRATION_FIRST 且 `speaker_id` 为 `narrator`
- **WHEN** 系统为该镜头建立配音任务
- **THEN** 系统 SHALL 使用注册表中冻结的旁白默认音色且不需要用户配置

#### Scenario: 缺失映射阻断并报告清单

- **GIVEN** 集内存在 `char_hero` 与 `char_side` 两个说话人，`char_side` 尚未配置音色映射
- **WHEN** 用户发起整集配音批量生成
- **THEN** 系统 SHALL 返回稳定错误并列出 `char_side` 等全部缺口说话人
- **THEN** 系统 MUST NOT 为任何镜头发出 Provider 请求

#### Scenario: 映射变更不改写历史候选

- **GIVEN** 镜头 L 的候选已按音色 A 冻结建档
- **WHEN** 用户将 L 说话人的音色映射改为音色 B
- **THEN** L 既有候选的音色与输入哈希 MUST 保持 A 不变
- **THEN** 此后新生成的候选 SHALL 冻结音色 B

### Requirement: 配音产物必须内容寻址登记并探测时长

配音音频字节 SHALL 写入既有内容寻址存储的 `audio` 命名空间；登记前 MUST 以 ffprobe 探测且 `durationMs > 0`、MIME 在音频白名单内，探测失败 MUST NOT 登记为成功候选。相同内容哈希的产物 SHALL 去重复用存储；删除候选 SHALL 仅删除登记行，MUST NOT 删除可能被其他候选引用的共享存储文件。

#### Scenario: 产物登记携带时长与哈希

- **GIVEN** Provider 返回一段可解码的配音音频
- **WHEN** 系统完成内容寻址写入与 ffprobe 探测
- **THEN** 候选行 SHALL 记录 file_sha256、byte_size、mime_type、duration_ms 与 storage_rel_path
- **THEN** Renderer 只能通过受限媒体 URL 访问该音频，MUST NOT 接收文件系统路径

#### Scenario: 相同内容重生成去重

- **GIVEN** 同一镜头以相同文本、音色与模型再次生成且返回字节一致
- **WHEN** 系统写入内容寻址存储
- **THEN** 存储 SHALL 复用既有文件且新候选行引用同一 storage_rel_path

#### Scenario: 删除候选不影响其他引用

- **GIVEN** 两个候选因内容一致共享同一存储文件
- **WHEN** 用户删除其中一个候选
- **THEN** 系统 SHALL 仅删除该候选登记行，共享文件 MUST 保留且另一候选仍可访问

### Requirement: 时长对齐策略必须显式且结果可追溯

系统 SHALL 按版本化阈值将每镜头音频时长与镜头时长的偏差确定性分类为基本相等、音频略长、音频远长、音频短于四类，并执行 PRD §10.7.1 的默认策略：基本相等直接合成；略长优先静帧延展镜头至音频结束，其次按语速上限重新生成；远长阻断导出并指引回分镜层拆分或缩减对白；短于镜头尾部静音。用户显式覆盖（裁剪音频尾部、强制裁剪标记对白不完整、提前切入下一镜头）SHALL 被记录。对齐结果 MUST 记录音频实际时长、镜头实际时长、采用的对齐方式与是否触发分镜层回退，并随时间线版本冻结。

#### Scenario: 偏差分类确定性

- **GIVEN** 相同的音频时长与镜头时长输入
- **WHEN** 对齐引擎执行分类
- **THEN** 分类结果 SHALL 唯一且仅由版本化阈值决定，阈值变更 MUST 体现在导出报告的规则版本中

#### Scenario: 音频略长默认静帧延展

- **GIVEN** 镜头配音时长略长于镜头时长且用户未覆盖
- **WHEN** 系统执行默认对齐
- **THEN** 合成 SHALL 以静帧延展该镜头至音频结束，且时间线版本记录延展毫秒数
- **THEN** 系统 MUST NOT 裁剪音频尾部导致对白不完整

#### Scenario: 音频远长阻断导出

- **GIVEN** 镜头配音时长超出远长阈值
- **WHEN** 用户请求导出且未做任何人工处置
- **THEN** 系统 SHALL 以稳定错误阻断导出并指引回分镜层拆分镜头或缩减对白
- **THEN** 系统 MUST NOT 生成部分成功的 MP4

#### Scenario: 人工强制裁剪记录对白不完整

- **GIVEN** 镜头配音时长远长于镜头时长
- **WHEN** 用户选择强制裁剪音频
- **THEN** 导出 SHALL 按用户处置执行，且对齐记录 SHALL 标记对白不完整与人工覆盖方式

#### Scenario: 对齐记录四要素冻结

- **GIVEN** 一次包含配音的导出成功
- **WHEN** 导出完成
- **THEN** 每个含配音镜头的对齐记录 SHALL 包含音频实际时长、镜头实际时长、对齐方式与是否分镜层回退，并随版本不可变

### Requirement: 时间线版本必须以不可变方式扩展配音轨与字幕轨

时间线版本 SHALL 并行承载配音轨（voiceItems）与基础字幕轨（subtitleItems）：编辑任一轨道 SHALL 插入新版本行并保留父版本；inputHash MUST 纳入两轨数据与音色映射快照。配音项绑定的候选三元组（candidateId/fileSha256/generationInputHash）或音色映射漂移时 MUST 以稳定错误拒绝。字幕片段 SHALL 从镜头 `spoken_text` 派生并默认启用，样式为随版本冻结的默认安全区快照。BGM 音量 SHALL 数据化且默认值与现状一致；既有时间线版本 MUST 可继续读取且语义不变。

#### Scenario: 编辑配音轨产生新版本

- **GIVEN** 时间线存在当前版本 V1
- **WHEN** 用户调整某镜头配音项的偏移或音量并保存
- **THEN** 系统 SHALL 创建子版本 V2，V1 保持不可变且可回溯
- **THEN** V2 的 inputHash SHALL 包含配音轨、字幕轨与音色映射快照

#### Scenario: 配音候选漂移被拒绝

- **GIVEN** 时间线版本引用镜头 L 的配音候选 C
- **WHEN** C 因镜头改文标记 STALE 后用户提交时间线编辑
- **THEN** 系统 SHALL 以稳定错误拒绝该提交并提示重新选择候选
- **THEN** 时间线当前版本 MUST 保持不变

#### Scenario: 既有时间线版本兼容读取

- **GIVEN** 数据库中存在本变更之前创建的时间线版本
- **WHEN** 用户打开工作台并读取该版本
- **THEN** 系统 SHALL 正常展示既有片段与 BGM，配音轨与字幕轨为空且 BGM 音量等效于既有硬编码行为

#### Scenario: BGM 音量数据化且默认一致

- **GIVEN** 用户未调整 BGM 音量
- **WHEN** 导出执行
- **THEN** 合成 SHALL 使用与既有硬编码一致的默认音量与淡出；调整后 MUST 按版本记录的数值生效

### Requirement: 导出混音与字幕烧录必须数据驱动且失败无部分产物

导出合成的音频滤镜图 SHALL 由时间线版本数据构建：配音按各自偏移插入、BGM 音量与淡出参数化、字幕按片段区间与默认安全区烧录。不含配音与字幕的导出 SHALL 与既有行为一致。任一来源失效、对齐阻断、字幕数据非法、FFmpeg 失败、用户取消或重启未知结果时 MUST 无成功导出记录、无部分 MP4、无残留临时文件；终态 MUST NOT 被迟到回调覆盖。

#### Scenario: 含配音与字幕的导出成功

- **GIVEN** 时间线版本包含有效配音候选与默认字幕轨且对齐全部通过
- **WHEN** 用户执行导出
- **THEN** 输出 MP4 SHALL 通过 ffprobe 校验（视频流事实与音轨存在），配音按偏移混入、字幕按安全区烧录
- **THEN** 导出记录 SHALL 关联时间线版本、对齐记录与映射快照

#### Scenario: 无配音字幕时导出与现状一致

- **GIVEN** 时间线版本不含配音项与字幕项
- **WHEN** 用户执行导出
- **THEN** 输出 MUST 与既有合成行为一致（回归锁定），不得引入额外音轨或滤镜差异

#### Scenario: 对齐阻断时失败无部分产物

- **GIVEN** 存在远长偏差镜头且未人工处置
- **WHEN** 用户执行导出
- **THEN** 系统 SHALL 以稳定错误失败，无成功导出记录、无部分 MP4、无残留临时文件

#### Scenario: 取消后迟到回调不覆盖终态

- **GIVEN** 用户在 FFmpeg 运行中取消导出且终态已落库为 CANCELLED
- **WHEN** 迟到的完成回调到达
- **THEN** 系统 SHALL 保持 CANCELLED 终态且 MUST NOT 登记成功导出

