# shot-edit-lock Specification

## ADDED Requirements

### Requirement: 逐镜头创意字段编辑必须以原子版本化事务落地

系统 MUST 仅接受对当前 ACTIVE 镜头白名单创意字段（narrative_purpose、cinematography、content、dialogue、continuity、generation_constraints、acceptance、target_duration_sec）的人工编辑。每次编辑 MUST 在单一事务内完成：编辑后文档通过 ShotContract 1.1.0 校验、通过 EDIT_INVARIANT 集合校验（ID、sequence 连续、引用与血缘自洽，允许 DRAFT/STALE_INPUT）、创建新镜头版本（DRAFT、parent_version_id 指向同 shot 直接前一版本）、创建新整集快照（episode_versions + 完整 episode_version_shots、shotSetHash 重算）、写入幂等回执。任一步失败 MUST 整体回滚，MUST NOT 留下部分版本；MUST NOT 修改或删除历史版本。编辑命令 MUST 携带 expectedVersionId 乐观并发与 requestId 幂等语义，冲突与重放复用既有稳定错误码。

#### Scenario: 合法编辑创建新版本与整集快照

- **GIVEN** 项目存在当前 ACTIVE 分镜集合，用户编辑某镜头 dialogue.spoken_text
- **WHEN** 编辑命令通过全部校验并提交
- **THEN** 系统 SHALL 创建该镜头新 DRAFT 版本（contract_version 递增、parent 指向直接前一版本、有效锁集合原样复制进 locked_paths）
- **THEN** 系统 SHALL 创建新 DRAFT 整集快照并重算 shot_set_hash，其余镜头版本引用不变

#### Scenario: 编辑结果违反 Schema 或集合不变量时整体拒绝

- **GIVEN** 用户提交的编辑后文档缺失必填键或使整集 sequence/引用不自洽
- **WHEN** 编辑命令执行
- **THEN** 系统 MUST 拒绝整次编辑并返回带定位明细的稳定错误码，MUST NOT 创建任何新版本、快照或回执以外的写入

#### Scenario: 幂等重放与并发冲突

- **GIVEN** 同一 requestId 已成功提交，或另一客户端已推进镜头当前版本
- **WHEN** 原命令重放，或携带过期 expectedVersionId 的新编辑提交
- **THEN** 系统 SHALL 分别返回既有幂等结果与 STALE 冲突错误，MUST NOT 产生第二个版本

### Requirement: 锁定记录必须是唯一锁事实源且与 locked_paths 投影一致

系统 MUST 以 lock_records 表为 ShotContract 锁定的唯一可写事实源；镜头版本文档内的 locked_paths MUST 为同事务生成的只读投影，两者集合 MUST 完全一致（TECH 不变量 13）。锁定与解锁 MUST 是版本化操作：创建新镜头版本（内容与当前版本一致，仅 locked_paths 集合变化）并同事务更新 lock_records。锁定路径 MUST 为 RFC 6901 合法 JSON Pointer（仅接受 ~0/~1 转义）、MUST 落在七个一级根（/narrative_purpose、/cinematography、/content、/dialogue、/continuity、/generation_constraints、/acceptance）及其已存在子路径内、MUST NOT 含数组下标 token、MUST NOT 指向 ID、版本、状态、provenance 等元数据、且 MUST 能在当前版本文档中解析。解锁 MUST 由用户显式发起；系统 MUST NOT 为完成任何写入而自动解锁。

#### Scenario: 锁定合法根路径产生版本化锁

- **GIVEN** 镜头当前版本存在且 /dialogue 未锁定
- **WHEN** 用户发起锁定 /dialogue
- **THEN** 系统 SHALL 创建仅 locked_paths 变化的新镜头版本，并同事务写入 lock_records 记录（对象版本、路径、时间、来源、可选说明）
- **THEN** 新版本文档内 locked_paths 与 lock_records 有效路径集合 SHALL 完全一致

#### Scenario: 非法锁定路径不保存

- **GIVEN** 用户发起锁定 /shot_id、/content/character_ids/0、/dialogue/speaker~2id 或当前文档不存在的路径
- **WHEN** 锁定命令执行
- **THEN** 系统 MUST 拒绝并返回稳定错误码，MUST NOT 写入 lock_records 或创建任何新版本

#### Scenario: 显式解锁

- **GIVEN** /dialogue 处于锁定状态
- **WHEN** 用户显式解锁 /dialogue
- **THEN** 系统 SHALL 创建 locked_paths 移除该路径的新版本，并将对应 lock_records 记录置为已解锁

### Requirement: 编辑事务必须复检锁定冲突并完全阻断

编辑命令 MUST 冻结写路径集合（write_set），并与当前有效锁做 token 级前缀比较：锁路径是写路径前缀、写路径是锁路径前缀、或两者相等，均 MUST 判定为冲突。存在冲突时整次编辑 MUST 阻断并返回全部冲突路径明细，MUST NOT 部分写入；人工编辑与 AI 写入遵循同一冲突语义（按 design D2 拍板）。

#### Scenario: 父子与同路径冲突全阻断

- **GIVEN** /dialogue 处于锁定状态
- **WHEN** 用户编辑 /dialogue/speaker_id 或 /dialogue 整体
- **THEN** 系统 MUST 阻断整次编辑并列出冲突路径，MUST NOT 创建新版本

#### Scenario: 无关路径编辑不受影响

- **GIVEN** /dialogue 处于锁定状态
- **WHEN** 用户编辑 /cinematography/composition
- **THEN** 系统 SHALL 正常完成编辑，/dialogue 锁在新版本中原样保留

### Requirement: 分镜工作区必须提供编辑与锁定入口

分镜工作区镜头卡片 MUST 提供编辑入口（形态按 design D1 拍板）与锁定/解锁入口（粒度按 design D3 拍板），入口 MUST 仅对当前 ACTIVE 集合镜头可用；锁定状态 MUST 在镜头卡片可见。IPC 通道 MUST 在独立 storyboard 命名空间白名单注册（按 design D4 拍板），经 sender 校验、DTO 双端校验、requestId 去重与输出脱敏复验；Renderer MUST NOT 直接接触路径、SQL 或原始 Provider 数据。

#### Scenario: 编辑往返与锁阻断可见于 UI

- **GIVEN** 分镜工作区展示当前 ACTIVE 集合
- **WHEN** 用户编辑某镜头字段保存，随后锁定 /dialogue 并再次尝试编辑该字段
- **THEN** UI SHALL 展示编辑成功后的新版本状态与锁定标识，并在锁定冲突时展示阻断错误与冲突路径
