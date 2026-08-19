# Design: shot-speaker-id-repair

## 背景事实（2026-08-20 实录 + 代码勘察）

- 漂移形态：Qwen 对 WEAK_LIP_SYNC 有台词镜头输出 `speaker_id: null`；同题材昨日 5/5 过、当日 3/3 败，整代 SHOT_CONTRACT 生成失败（errorCode `CONTRACT_VALIDATION_FAILED`，FINAL 层）。
- 分层链：CANDIDATE 只查键存在（`model-shot-set-candidate.ts`，speaker_id 键在值 null 放行）→ SYSTEM_FIELDS 透传（`shot-system-fields.ts:188-192`：spoken 非旁白分支用模型值；narrator/无台词两分支已系统推导）→ COLLECTION 对非 string speaker 跳过（`shot-collection-validator.ts:139-145`）→ FINAL ShotContract 1.1.0 allOf 拒绝 → `isRepairable = JSON_PARSE|CANDIDATE_SCHEMA`，无修复轮。
- 修复回路现成：`job-runner.ts` repair 回调以 STRUCTURE_REPAIR 携 `{failure, rawText}` 重调模型（失败明细含 details 进修复 prompt）；SHOT_CONTRACT deadline 960s 覆盖 initial+repair（`stage-invocation-limits.ts`）。

## D1: 主方案——候选层跨字段值校验（A）是否叠加单角色系统派生（B）【待拍板】

**方案 A（单独）**：`validateModelShotSetCandidate` 增跨字段值校验（规则见 D2）。null 漂移 → CANDIDATE 层失败 → 一轮修复 → 模型多数情况下可自纠；若漂移顽固（如 08-20 当日 3/3），修复后仍 null → `STRUCTURE_REPAIR_FAILED` 如实失败。
- 优：最小改动、单点实现、与「创意值=模型责任」边界一致；修复轮给模型显式反馈（教育性信号）。
- 劣：修复轮多一次调用（延迟+成本）；provider 漂移顽固日仍可能整代失败。

**方案 B（单独）**：仅在 `injectShotSystemFields` 派生——spoken 非旁白 + speaker 非 string + `character_ids` 恰一员 → 派生该角色。单角色镜头静默救回，零额外调用；**多角色镜头完全不受影响（仍 FINAL 终态）**，08-20 实录的对白镜头若为多角色则 B 无效。
- 优：零模型往返。
- 劣：单独使用覆盖不全；且掩盖漂移（无修复反馈）。

**A+B 组合（推荐）**：一条产品规则两半实现——「spoken 非旁白镜头的 speaker：多角色（或 character_ids 异形）→ 模型必须给出，违例进修复轮；单角色 → 系统确定性派生，豁免校验」。豁免判定读候选自身的 `content.character_ids`（长度恰 1 的 string 数组），无需 bible 上下文，`validateModelShotSetCandidate` 签名不变。
- 一致性论证：与既有 narrator（NARRATION_FIRST spoken 恒推）/无台词（恒 null）同族——系统只派生**逻辑唯一**的值；单角色有台词镜头说话人逻辑唯一（WEAK/PRECISE_LIP_SYNC 语义=画面内角色开口）。
- 顺序自洽：单角色 null 在 CANDIDATE 被豁免 → 注入时派生 → FINAL 通过；多角色 null 在 CANDIDATE 被拦 → 修复轮；修复后 string 但非 bible 键 → COLLECTION 如实终态（D3）。

**拍板项**：A+B（推荐）／仅 A（最简）／仅 B（不推荐，覆盖不全）。

## D2: 候选层校验的强度【待拍板】

- **推荐：非空 string + pattern `^(narrator|char_[A-Za-z0-9_-]+)$`**（与 ShotContract 1.1.0 speaker_id 同正则）。修复提示可直接指明合法形态；number/array/空串/乱码 string 一律进修复轮。
- 备选：仅非空 string（pattern 留 FINAL）。实现更少一行，修复提示弱一点。

## D3: 残余缺口显式接受【待拍板（推荐：接受，不扩）】

修复轮后模型返回 string 但非冻结 STORY_BIBLE 角色键 → COLLECTION `SHOT_SET_CHARACTER_UNKNOWN`，不可修复 → `STRUCTURE_REPAIR_FAILED` 终态。不扩 `isRepairable` 至 COLLECTION 的理由：COLLECTION 失败含集合语义（sequence/连续性/时长预算），将其全部纳入修复轮会改变所有阶段的管线行为；该形态在 08-20 实录未出现（漂移形态是 null 不是乱编键）。若未来实录出现，再立独立 change 做白名单式扩层。

## D4: 测试策略

- 单测（packages/validation）：`model-shot-set-candidate.test` + fixtures——多角色镜头 spoken WEAK/PRECISE null/number/乱码 speaker → 层失败与 details 定位；单角色镜头 null → 豁免；NARRATION_FIRST spoken null → 放行（系统推 narrator）；无台词 null → 放行（系统注 null）；SUBTITLE_ONLY → 放行。
- 单测（packages/application）：`shot-system-fields.test`——单角色 spoken WEAK null speaker → 派生 `char_x` 且过 FINAL 形态；多角色 null → 透传 null（校验层责任）；NARRATION_FIRST/无台词既有断言不回归。
- 管线级（packages/application 候选契约测试）： spoken 非旁白 null speaker 经 `executeCandidateContract` 走 repair 分支的层判定（现有 repair 测试形态补 SHOT 场景断言 `failure.layer === 'CANDIDATE_SCHEMA'`）。
- E2E/DB：无接口无迁移，不新增；全量门禁回归。

## D5: 验证与收尾口径

- 全量门禁（tsc/eslint/format/unit/contract/integration/e2e）+ README 最近验证证据补记。
- 真实复测**可选**：Qwen 漂移为当日性现象，无法按需复现；离线以等价注入形态覆盖即认为闭环。若拍板要求真实复测，须另择时机跑 SHOT_CONTRACT 真实探针并复盘 speaker 违规率。
