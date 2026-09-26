## MODIFIED Requirements

### Requirement: 单集时间线必须绑定不可变输入快照

系统 MUST 仅允许从 READY EpisodeVersion 创建单集时间线，并为每个画面片段保存稳定 `clipId`、shot_id、candidate_id、file_sha256、generation_input_hash、position、target_start_ms、enabled、trim_in_ms 和 trim_out_ms。多个片段可以引用同一合法候选，但每个 `clipId` 在版本内 MUST 唯一。时间线编辑 MUST 创建新版本，不得修改历史版本。

#### Scenario: READY 单集创建默认时间线
- **WHEN** 用户对 READY 单集执行“生成时间线”
- **THEN** 系统按 ACTIVE 镜头 sequence 创建一个新时间线版本，并只纳入当前输入世代的 SUCCEEDED 视频候选
- **THEN** 默认画面片段 SHALL 连续排列且每个片段具有稳定 `clipId`

#### Scenario: 非 READY 单集被拒绝
- **WHEN** 用户对 DRAFT、STALE_INPUT 或不存在的单集创建时间线
- **THEN** 系统返回 `VIDEO_COMPOSITION_NOT_READY`，不创建时间线版本

#### Scenario: 时间线编辑保持历史
- **WHEN** 用户改变顺序、起点、启停或裁剪并保存
- **THEN** 系统创建新的时间线版本，旧版本内容和哈希保持不变

#### Scenario: 同一候选被分割或复制
- **GIVEN** 一个画面片段引用有效候选
- **WHEN** 用户分割或复制该片段并保存
- **THEN** 新版本 SHALL 创建新的 `clipId` 并继续引用同一不可变候选及其哈希
- **THEN** 系统 MUST NOT 创建伪候选、重复媒体文件或改写候选记录

### Requirement: 时间线编辑必须执行确定性约束

系统 MUST 支持选择、排序、启用/跳过、目标起点、入点/出点裁剪、分割、复制和删除；至少一个画面片段 MUST enabled。每个启用片段 MUST 满足 `0 <= trimInMs < trimOutMs <= actualDurationMs`，`targetStartMs >= 0`，稳定 `clipId` 不重复，且单画面轨启用片段不得重叠。保存时系统 SHALL 以 100ms 精度归一目标起点并拒绝未知候选、未知片段、非法下标、未回报实际时长或越界裁剪；删除片段不得删除源候选或媒体资产。

#### Scenario: 合法裁剪与排序保存
- **WHEN** 用户提交唯一片段标识、合法候选引用、无重叠目标区间和合法裁剪范围
- **THEN** 系统保存新版本并返回按目标起点稳定排序的完整摘要

#### Scenario: 非法裁剪不产生部分写入
- **WHEN** 任一片段 trimInMs 等于或大于 trimOutMs，或超过实际时长
- **THEN** 系统返回 `VIDEO_TRIM_INVALID`，时间线版本和当前指针均不变化

#### Scenario: 画面片段发生重叠
- **WHEN** 用户提交的两个启用画面片段在目标时间上重叠
- **THEN** 系统返回稳定的 `VIDEO_TIMELINE_OVERLAP` 错误
- **THEN** 时间线版本、当前指针和媒体资产 MUST 均不变化

#### Scenario: 用户删除最后一个启用片段
- **WHEN** 编辑结果不再包含任何启用画面片段
- **THEN** 系统返回 `VIDEO_TIMELINE_EMPTY` 且不创建新版本

### Requirement: 合成界面必须以时间线和导出检查器组织操作

合成界面 SHALL 将真实预览、三轨时间线编辑、片段属性、成片检查、导出设置和导出记录分区展示。画面轨 MUST 支持选择、播放头定位、拖动、双端裁剪、分割、复制、删除、撤销和重做；运行、取消、失败、恢复和成功预览状态 MUST 保持可区分。撤销与重做可以在提交前维护本地编辑历史，但刷新或重启后 MUST 从最后一次已提交的不可变时间线版本恢复，不能将本地历史表示为已保存事实。

#### Scenario: 用户开始合成导出
- **GIVEN** 当前已保存时间线和媒体输入通过导出前校验
- **WHEN** 用户开始导出 MP4
- **THEN** 页面 SHALL 显示中文进度、取消入口和当前阶段
- **THEN** 成功前 MUST NOT 显示可播放的假输出

#### Scenario: 用户拖动并裁剪画面片段
- **GIVEN** 当前片段有可验证的实际时长
- **WHEN** 用户拖动片段或片段两端并保存
- **THEN** 预览、播放头、片段属性和总时长 SHALL 使用编辑后的草稿状态联动
- **THEN** 保存成功后系统 SHALL 返回新的不可变时间线版本

#### Scenario: 键盘或按钮替代拖动
- **GIVEN** 用户不能或不愿使用拖动操作
- **WHEN** 用户通过键盘或片段操作按钮调整顺序、起点或裁剪值
- **THEN** 系统 SHALL 产生与拖动相同的校验和保存结果
