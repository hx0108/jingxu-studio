## MODIFIED Requirements

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
