# Tasks: shot-speaker-id-repair

## 1. 候选层跨字段值校验（D1 方案 A 部分）

- [x] 1.1 `validateModelShotSetCandidate` 增 spoken 非旁白 speaker_id 值校验（pattern 按 D2 拍板；单角色豁免按 D1 拍板），失败码与 details 定位 `shots[i].dialogue.speaker_id` → 验证：fixtures + `model-shot-set-candidate` 单测全绿（多角色 null/number/乱码、单角色豁免、NARRATION_FIRST/无台词/SUBTITLE_ONLY 放行）——22/22，新增稳定错误码 `CANDIDATE_DIALOGUE_SPEAKER_INVALID`
- [x] 1.2 组合根接线确认零改动（签名不变，`create-script-generation-runtime.ts` 既有映射直接生效）→ 验证：contract 测试 109/109 回归

## 2. 单角色系统派生（D1 方案 B 部分）

- [x] 2.1 `injectShotSystemFields` spoken 非旁白 + speaker 非 string + `character_ids` 恰一员 → 派生该角色 id → 验证：`shot-system-fields` 单测 19/19（null/42/乱码 派生唯一角色；多角色/异形 character_ids 不派生）
- [x] 2.2 与候选层豁免口径一致性测试（同一镜头两种视角：CANDIDATE 豁免 ⇔ 注入派生）→ 验证：两侧用例互指注释 + 同谓词形态（`SPEAKER_ID_PATTERN` 各留一处、注释同源 Schema）

## 3. 管线级与回归

- [x] 3.1 管线级 layer 保证（口径修订：不为未改动的组合胶水新建重型 harness）——「CANDIDATE_SCHEMA 失败→修复轮」「FINAL/COLLECTION 不可修复」「明细随修复上下文透传」由既有 `candidate-contract-pipeline.test` 三组断言钉住；真实校验器行为由 1.1 单测钉；组合根 8 行映射未动 → 验证：三环组合覆盖，unit 全量 703/703 零涟漪
- [x] 3.2 全量门禁（重建三 bundle，application/validation 进主 bundle）→ 验证：tsc/eslint/format 零错误；unit 703（+10）、contract 109、integration 201、E2E 16 passed + 3 skipped（T5 MEDIA_EVIDENCE_OK 不回归）

## 4. 文档与收尾

- [x] 4.1 README 当前已实现 + 最近验证证据补记（2026-08-20 漂移实录 → 修复口径）
- [x] 4.2 `openspec validate shot-speaker-id-repair --strict` + `--all --strict` 通过
- [ ] 4.3 真实复测（可选，按 D5：Qwen 漂移为当日性现象无法按需复现，离线等价形态已覆盖即闭环；若后续真实联调再现 speaker 违规，复盘修复轮触发率）
- [x] 4.4 归档 change、更新 main（2026-08-20 归档为 2026-08-20-shot-speaker-id-repair）
