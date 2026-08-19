# Tasks: shot-speaker-id-repair

## 1. 候选层跨字段值校验（D1 方案 A 部分）

- [ ] 1.1 `validateModelShotSetCandidate` 增 spoken 非旁白 speaker_id 值校验（pattern 按 D2 拍板；单角色豁免按 D1 拍板），失败码与 details 定位 `shots[i].dialogue.speaker_id` → 验证：fixtures + `model-shot-set-candidate` 单测全绿（多角色 null/number/乱码、单角色豁免、NARRATION_FIRST/无台词/SUBTITLE_ONLY 放行）
- [ ] 1.2 组合根接线确认零改动（签名不变，`create-script-generation-runtime.ts` 既有映射直接生效）→ 验证：contract 测试回归

## 2. 单角色系统派生（D1 方案 B 部分，若拍板叠加）

- [ ] 2.1 `injectShotSystemFields` spoken 非旁白 + speaker 非 string + `character_ids` 恰一员 → 派生该角色 id → 验证：`shot-system-fields` 单测（派生值过 ShotContract 1.1.0 speaker 形态；多角色/异形 character_ids 不派生）
- [ ] 2.2 与候选层豁免口径一致性测试（同一镜头两种视角：CANDIDATE 豁免 ⇔ 注入派生）→ 验证：成对断言用例

## 3. 管线级与回归

- [ ] 3.1 候选契约管线测试补 SHOT 场景：spoken 非旁白 null speaker 的失败 `layer === 'CANDIDATE_SCHEMA'` 且触发 repair 分支 → 验证：`executeCandidateContract` 相关测试绿
- [ ] 3.2 全量门禁（重建 bundle 如涉及 main 侧源码）→ 验证：tsc/eslint/format/unit/contract/integration/e2e 基线不降（693/109/201/16+3skip 起步，新增用例只增不减）

## 4. 文档与收尾

- [ ] 4.1 README 当前已实现 + 最近验证证据补记（2026-08-20 漂移实录 → 修复口径）
- [ ] 4.2 `openspec validate shot-speaker-id-repair --strict` + `--all --strict` 通过
- [ ] 4.3 真实复测（可选，按 D5 拍板；凭据与探针口径沿用 media-invocation-evidence 联调记录）
- [ ] 4.4 归档 change、更新 main
