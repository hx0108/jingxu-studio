# Proposal: shot-speaker-id-repair

## Why

2026-08-20 真实联调实录：同题材 Qwen SHOT_CONTRACT 昨日 5/5 过、当日 3/3 败——模型对 WEAK_LIP_SYNC 有台词镜头输出 `speaker_id: null`，整代生成失败（provider 侧输出漂移，与 prompt/参数无关）。

失败之所以是**终态**，是分层校验的一个盲区串联而成：

- CANDIDATE 层（`validateModelShotSetCandidate`）只查**键存在**——`speaker_id` 键在、值为 null 放行（该层注释明言「取值与跨字段语义仍由 FINAL 约束」，即值校验被有意后置）；
- SYSTEM_FIELDS 注入对 spoken 非旁白镜头**透传**模型值（narrator/无台词两种情形已系统推导，恰缺 spoken 非旁白这一分支）；
- COLLECTION 层 speaker 检查 `typeof speaker === 'string'` 才查，null 直接跳过；
- FINAL 层 ShotContract 1.1.0 allOf 拒绝 → 候选契约管线 `isRepairable = JSON_PARSE | CANDIDATE_SCHEMA`，FINAL 失败无修复轮 → `CONTRACT_VALIDATION_FAILED` 终态。

然而 speaker_id 的空值语义**完全由创意字段决定**（`spoken_text` 非空 × `dialogue_render_mode` 非旁白 ⇒ 必须给出说话人）——这是模型可自查自纠的责任，理应落在**可修复的 CANDIDATE 层**，让既有结构修复轮（STRUCTURE_REPAIR 携失败明细重调模型，SHOT_CONTRACT 960s 预算已覆盖两轮）给模型一次明确反馈下的修正机会，而不是直接判死。

## What Changes

- **候选层跨字段值校验（D1 主方案）**：`validateModelShotSetCandidate` 增补——`content.spoken_text` 非空且 `dialogue.dialogue_render_mode ∈ {WEAK_LIP_SYNC, PRECISE_LIP_SYNC}` 的镜头，`speaker_id` MUST 为非空 string 且匹配 ShotContract 1.1.0 同款 `^(narrator|char_[A-Za-z0-9_-]+)$`（D2 拍板）；违例记 `CANDIDATE_SCHEMA` 层失败，details 定位 `shots[i].dialogue.speaker_id` → 触发既有一次结构修复轮。NARRATION_FIRST spoken 不要求（系统恒注 narrator，模型值弃用）。
- **单角色镜头系统派生兜底（D1 可选叠加，与上条组合为一条产品规则）**：`injectShotSystemFields` 对 spoken 非旁白且 speaker_id 非 string 的镜头，若 `content.character_ids` 恰一员则确定性派生该角色为 speaker（单角色有台词镜头说话人逻辑唯一；与 narrator/无台词推导同型）。候选层校验对「单角色镜头」豁免（候选自身携带 character_ids，豁免判定无需 bible 上下文），多角色镜头仍走校验+修复。
- **spec 修订**：`shot-contract-generation` 系统字段 Requirement 的模型/系统责任边界精细化——spoken 非旁白 speaker 空值从 FINAL 终态失败改为「候选层可修复失败（多角色）或单角色确定性派生」，并新增对应 Scenario。

### 明确不做（非目标）

- 不改 `isRepairable` 层集合：FINAL/COLLECTION/PRE_COMMIT 仍不可修复。修复后模型给出 string 但非冻结 STORY_BIBLE 角色键的残余形态仍走 COLLECTION `SHOT_SET_CHARACTER_UNKNOWN` 如实终态（STRUCTURE_REPAIR_FAILED；08-20 实录未见该形态，D3 记录决策）。
- 不做 speaker 枚举校验前移到 CANDIDATE 层（角色键集合在冻结 STORY_BIBLE，候选层静态校验无此上下文；COLLECTION 已查）。
- 不动五阶段（STORY_BIBLE 等）候选校验、JobRunner 管线语义、DB/IPC/UI（纯 packages/validation + packages/application 两文件族）。
- 不处理 provider 漂移根因（Qwen 侧问题，无法在本仓修复；本 change 只保证漂移不再直接判死整代生成）。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `shot-contract-generation`：「分镜系统字段必须由系统注入而非模型决定」Requirement 增补 speaker_id 空值的分层处理口径（候选层可修复失败 + 单角色系统派生），新增 Scenario 两个。

## Impact

- **产品/验收**：UI/IPC/DB 零变化；验收 = 单测/契约测试（null speaker 多角色镜头 → CANDIDATE 层失败进修复轮；单角色镜头 → 派生通过 FINAL）+ 既有全量门禁。真实复测可选（凭据在，Qwen 漂移当日性无法离线复现，以 Mock 注入等价形态覆盖）。
- **Schema**：六份 PRD-owned Schema 字节不变（ShotContract 1.1.0 不动）。
- **接口**：`validateModelShotSetCandidate` 签名不变（新规则读候选自身字段）；`injectShotSystemFields` 签名不变。组合根零改动。
- **并行实施**：单线小体量 Change（validation → application → 测试 → spec/README → 门禁），无迁移无 UI。
