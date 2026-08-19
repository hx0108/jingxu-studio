# shot-contract-generation Specification

## Purpose
TBD - created by archiving change shot-contract-generation. Update Purpose after archive.
## Requirements
### Requirement: 整集分镜生成必须以冻结 READY 上游为输入

系统 MUST 只在 STORY_BIBLE、EPISODE_OUTLINE、SCENE_SCRIPT 的当前版本均为 READY 且属于当前项目/Episode、客户端 expected input 与服务端一致时，才接受 SHOT_CONTRACT `GENERATE` Job；冻结集合 MUST 额外包含当前 format_profile_id。成功提交 MUST 在单一短事务内原子写入一个 DRAFT `episode_versions`、N 个 ACTIVE `shots`、N 个 `version_no=1` 的 DRAFT `shot_contract_versions` 与 N 行 `episode_version_shots`，并计算 `shot_set_hash`；任一部分失败 MUST 整体回滚，不得留下半个集合。

#### Scenario: 冻结输入齐全时原子落库 DRAFT 集合

- **GIVEN** 三个上游阶段当前版本均为 READY 且 expected input 匹配
- **WHEN** SHOT_CONTRACT Job 校验通过并提交
- **THEN** 系统 SHALL 在同一事务写入 episode_version、shots、shot_contract_versions 与 episode_version_shots
- **THEN** `shot_set_hash` SHALL 覆盖按 sequence 排序的全部镜头版本，阶段头以 EPISODE_VERSION 指向 DRAFT

#### Scenario: 上游未就绪不创建集合

- **GIVEN** 任一上游缺失、为 DRAFT/STALE_INPUT 或 expected input 过期
- **WHEN** 用户请求生成分镜
- **THEN** 系统 MUST 返回稳定前置条件或 STALE_INPUT 错误，MUST NOT 创建 Job、调用 Provider 或写入任何分镜行

### Requirement: 分镜系统字段必须由系统注入而非模型决定

模型 MUST 只返回每镜头的创意字段（narrative_purpose、cinematography、content、dialogue 渲染模式/说话人/预估时长、continuity、generation_constraints 创意部分、acceptance 条目）；shot_id、version_id、contract_version、sequence、status、provenance、format_profile_id、dialogue_mode_source、audio_required、lip_sync_required、asset_version_ids、budget_estimate、locked_paths MUST 由系统注入或按确定性规则推导。最终对象 MUST 通过已发布 Registry 的 ShotContract 1.1.0（含全部跨字段规则）。

有台词（spoken_text 非空）且渲染模式为 WEAK_LIP_SYNC 或 PRECISE_LIP_SYNC 的镜头，speaker_id 的空值违规 MUST 在候选层（可修复层）拦截或由系统确定性派生，MUST NOT 漏至 FINAL 层成为不可修复终态：`content.character_ids` 恰一员的镜头由系统派生该角色为 speaker；其余镜头（多角色或 character_ids 异形）的 speaker_id MUST 为非空 string 且匹配 ShotContract 1.1.0 speaker 形态，违例属候选层失败并进入一次结构修复轮。

#### Scenario: 模型输出系统字段被剥离并由系统重生成

- **GIVEN** Provider 响应中的镜头携带了 shot_id 或 status 等系统字段
- **WHEN** 系统注入系统字段
- **THEN** 系统 SHALL 忽略模型提供的系统字段值并以注入值为准
- **THEN** 注入后的对象 SHALL 通过 ShotContract 1.1.0 正式校验

#### Scenario: 口型派生字段确定性推导

- **GIVEN** spoken_text 非空且 dialogue_render_mode 为 PRECISE_LIP_SYNC
- **WHEN** 系统推导 audio_required 与 lip_sync_required
- **THEN** 两者 SHALL 分别为 true，与 Schema 跨字段规则的精确值一致，不依赖模型自觉

#### Scenario: 多角色有台词镜头 speaker 空值进修复轮而非终态

- **GIVEN** 模型对 WEAK_LIP_SYNC 有台词、character_ids 为两员的镜头输出 speaker_id: null
- **WHEN** 候选层校验
- **THEN** 系统 MUST 以候选层失败列出有界明细（定位到该镜头 dialogue.speaker_id）并触发一次结构修复轮
- **THEN** 修复后仍违例时 SHALL 以 STRUCTURE_REPAIR_FAILED 如实终态，MUST NOT 创建业务版本

#### Scenario: 单角色有台词镜头 speaker 由系统派生

- **GIVEN** 模型对 PRECISE_LIP_SYNC 有台词、character_ids 恰一员的镜头输出 speaker_id: null
- **WHEN** 系统注入派生字段
- **THEN** 系统 SHALL 以该唯一角色为 speaker_id 派生，注入后对象 SHALL 通过 ShotContract 1.1.0 正式校验
- **THEN** 该镜头 SHALL NOT 触发候选层 speaker 违规

### Requirement: 分镜集合必须通过集合级校验才可提交

COLLECTION 层 MUST 对整个 Episode 集合校验：sequence 恰为 1..N 无缺口无重复；previous_shot_id 非空时必须引用集合内 sequence 更小的镜头；character_ids 与 speaker_id 必须源自冻结 STORY_BIBLE 的角色键；scene_id 必须源自冻结 STORY_BIBLE 的场景键；Σ target_duration_sec 必须落在 30–180。失败 MUST 返回带层标识与有界明细的稳定错误码，且集合校验失败 MUST NOT 创建业务版本。

#### Scenario: 悬空引用被集合校验拒绝

- **GIVEN** 候选中某镜头的 previous_shot_id 指向集合外或不存在的镜头
- **WHEN** COLLECTION 层校验
- **THEN** 系统 MUST 以集合层错误码失败并列出有界明细（含该镜头 sequence 与原因）
- **THEN** 系统 MUST NOT 写入任何 episode_version 或 shot 行

#### Scenario: 整集时长越界提前失败

- **GIVEN** 各镜头单独合法但 Σ target_duration_sec 为 25 或 200
- **WHEN** COLLECTION 层校验
- **THEN** 系统 MUST 在提交前失败并返回时长汇总明细，MUST NOT 依赖数据库 CHECK 兜底

### Requirement: 分镜确认与失效必须保持整集快照可追溯

确认 DRAFT 集合时，系统 MUST 为每个镜头创建内容相同、parent 指向 DRAFT 的新 READY 版本（contract_version 递增），再创建引用 READY 镜头集合、重算 `shot_set_hash` 的 READY episode_version 并原子更新阶段头。上游 READY 变化传播失效时，系统 MUST 只创建一个引用同一批镜头版本快照的 STALE_INPUT episode_version 作为新当前版本，MUST NOT 逐镜头创建 STALE 版本，也 MUST NOT UPDATE 任何既有版本行；历史集合 SHALL 保持可查看与可恢复。

#### Scenario: 确认创建 READY 镜头集合与 READY 整集版本

- **GIVEN** 阶段头指向属于当前项目/Episode 的 DRAFT 分镜集合
- **WHEN** 用户以匹配的 expectedVersionId 确认
- **THEN** 系统 SHALL 创建每个镜头的 READY 子版本与重算 shot_set_hash 的 READY episode_version 并更新阶段头
- **THEN** 全部 DRAFT 行 MUST 保持不可变，READY 集合与 DRAFT 集合业务内容一致

#### Scenario: 上游失效只推进整集快照

- **GIVEN** SCENE_SCRIPT 新 READY 替换旧 READY 且分镜已有当前版本
- **WHEN** 失效传播事务提交
- **THEN** 系统 SHALL 只创建一个 STALE_INPUT episode_version，其镜头引用与 shot_set_hash 沿用原快照
- **THEN** 既有镜头版本行 MUST 保持不变，界面 SHALL 展示失效状态与重新生成入口

