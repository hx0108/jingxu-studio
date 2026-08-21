# storyboard-evaluation-set 设计

## 拍板记录（2026-08-22）

- **D1 样本创建入口 = 三入口全量**：项目内从当前 READY 整集版本派生 + 全局手工创建（必须明确项目归属或「全局样本」）+ JSON 文件批量导入。
- **D2 规则命中 = 入库时落库**：创建/派生/导入入库时执行确定性规则，命中列表与 `rule_version` 随样本行保存（migration 0017 新增列）；不做读时现算。
- **D3 种子与指南 = migration 播种 + 受控资源文档**：0017 播种 24 个 SYNTHETIC 样本（10 可接受 + 14 问题，覆盖九类），标注指南 v1 进入 `packages/validation/resources/`（或 application 资源）并以常量 `EVALUATION_GUIDELINE_VERSION='jingxu-annotation-guideline/1'` 版本化；9.11 发布门槛当即可关。
- **D4 dataset_split 漂移 = 文档映射**：TRAIN=Development、VALIDATION=Validation、TEST=Holdout；Regression Set 显式 V2+ 非目标。不改 CHECK 枚举（SQLite 改 CHECK 需重建表，V1 规模用不上）。

## 分层与数据流

```
Renderer 评测集页面（全局主导航 + 项目菜单筛选入口）
  └─ preload `evaluation`（冻结白名单，strict DTO 双端校验）
       └─ Main IPC（sender/READY gate/singleflight/输出脱敏复验）
            └─ Application EvaluationService
                 ├─ 样本信封校验（contracts zod + 纯函数）
                 ├─ 规则命中引擎（Registry Schema + 9.5 可生产性 + 集合派生规则）
                 └─ EvaluationUnitOfWork → SQLite Repository（0001 两表 + 0017 新列）
导入/导出文件 I/O：Main 文件 sink（系统 Open Dialog + 只读解析），路径不进 Renderer。
```

## 样本信封（EvaluationCaseEnvelope，contracts 内 zod）

`input_json` 形状（被检对象 + 最小上下文，足以离线复跑规则）：

```json
{
  "candidate": { "kind": "SHOT_CONTRACT", "document": { ...ShotContract... } },
  "context": {
    "dialogue_render_mode": "NARRATION_FIRST",
    "target_duration_sec": 90,
    "characters": ["char_..."],
    "scenes": ["scene_..."],
    "previous_shot_summary": null
  }
}
```

`expected_json` 形状：

```json
{ "acceptable": false, "expected_issue_codes": ["EVAL_RULE_MISSING_REQUIRED"], "reference_contract": null }
```

- `candidate.kind` ∈ `SCRIPT_STAGE | SHOT_CONTRACT | EPISODE_STORYBOARD`（对齐 0001 `sample_type` CHECK）。
- `context` 按 kind 裁剪：SCRIPT_STAGE 仅需阶段标识；SHOT_CONTRACT 需 dialogue_render_mode/characters/scenes/previous_shot_summary；EPISODE_STORYBOARD 需 target_duration_sec 与角色/场景清单（序列规则）。
- 问题类型常量表（九类 ↔ 稳定 issue code 映射）随 contracts 导出，供种子、标注与 UI 共用。

## Application Ports

- `EvaluationRulesPort`（注入）：`(input) → { hits: RuleHit[], ruleVersion }`；`RuleHit = { code, path?, detail? }`。实现复用：
  - 离线 Registry `ShotContract/ScriptStageOutput/EpisodeStoryboardExport` 校验；
  - `collectProducibilityWarns`（`jingxu-producibility-rules/1`，含 `SPEECH_DURATION_WARN_SEC=4`）；
  - `shot-collection-validator` 派生的单镜/序列规则（必填、枚举、时长、角色过多、DialogueRenderMode 冲突、连续模式、锁定冲突、能力 UNKNOWN/UNAVAILABLE）。
- `EvaluationUnitOfWorkPort.run(repositories => ...)`：`EvaluationRepositories` 含 `samples`（list/insert/delete/find-by-dedup）与 `annotations`（list/insert）。
- 不暴露 Row/连接/SQL；文件 I/O 只在 Main。

## IPC / DTO 面（`evaluation` 六方法）

| 方法 | 入参要点 | 回执 |
|---|---|---|
| `listSamples` | `{ scope: 'ALL'|'GLOBAL'|'PROJECT', projectId?, sampleType?, datasetSplit? }` | 样本摘要列表（id/type/split/authorization/acceptable/hitCount/projectId/createdAt + 最新标注摘要） |
| `createSample` | 样本信封 + dedupKey + authorization + datasetSplit + projectId? | 样本摘要（含规则命中） |
| `createFromEpisode` | `{ projectId, expectedVersionId, shotIndexes?, authorization, datasetSplit, requestId }` | 创建的样本摘要列表 |
| `importBatch` | `{ requestId }`（文件经 Main Open Dialog） | 逐样本结果数组（CREATED/DUPLICATE/REJECTED+原因） |
| `deleteSample` | `{ sampleId, requestId }` | 删除回执 |
| `addAnnotation` | `{ sampleId, guidelineVersion, label, rationale, annotator, requestId }` | 该样本全部标注（时间序） |

- 全部走 AppResultDto 脱敏包装；requestId 幂等仅用于派生/导入/删除/标注写命令（重复同载荷返回原回执——复用命令回执表或 0016 同款模式，按集成测试证明的缺口决定是否新增列）。

## 事务边界

- `createSample`/`createFromEpisode`（每样本）：单事务「dedup 检查 → 信封校验 → 规则命中 → insert samples(+annotations 不涉及) → audit」。
- `importBatch`：staging 读文件/解析在事务外；逐样本独立短事务（合法入库、非法拒绝），结束后聚合回执——满足「样本级原因」且无部分字段写入；整体损坏（非法 JSON/信封）零入库。
- `addAnnotation`：单事务 insert + audit；历史行不可变（无 UPDATE 路径）。
- `deleteSample`：单事务 delete samples + delete annotations（FK）+ audit。
- 派生读取（当前整集版本 + FormatProfile + bible 清单）在只读事务内冻结快照后逐样本走创建事务。

## 错误码（新增，ProjectErrorCode 扩展）

- `EVALUATION_SAMPLE_INVALID`（信封/期望非法，fieldErrors 携带样本级原因）
- `EVALUATION_DEDUP_CONFLICT`（dedup_key 已存在）
- `EVALUATION_NOT_FOUND`（样本不存在）
- `EVALUATION_DERIVE_NOT_READY`（派生要求整集 READY）
- `EVALUATION_IMPORT_INVALID`（文件级损坏）
- 复用：`PROJECT_NOT_FOUND`、`SCRIPT_VERSION_CONFLICT`（派生 expectedVersionId 过期）、`TRANSFER_FILE_CANCELLED`（取消选择）。

## Migration 0017（`0017_evaluation_rule_hits_seed.sql`）

- `ALTER TABLE evaluation_samples ADD COLUMN rule_hits_json TEXT CHECK (rule_hits_json IS NULL OR json_valid(rule_hits_json));`
- `ALTER TABLE evaluation_samples ADD COLUMN rule_version TEXT;`
- 播种 24 行 SYNTHETIC 样本（10 可接受 + 14 问题，覆盖九类；dedup_key 形如 `seed-synthetic-shot-<n>`；dataset_split 三值分布；rule_hits 由离线规则引擎预计算后写死）；对应首批标注行（guideline v1、annotator='SYSTEM_SEED'）标注问题类型与依据。
- 幂等：迁移仅执行一次（schema_migrations 约束），种子里 `dedup_key` UNIQUE 兜底。
- 遵循仓库约定：新迁移同步 4 文件 9 处硬编码版本断言。

## 安全边界

- 路径红线：导入文件路径不进 Renderer/回执/审计（沿用 transfer 规范，E2E 断言）。
- 样本内容红线：不含 API Key、媒体字节、用户绝对路径；input/expected/label 均 `json_valid` 约束。
- 审计：`EVALUATION_SAMPLE_IMPORTED`(种子不审计)/`EVALUATION_SAMPLE_CREATED`/`EVALUATION_BATCH_IMPORTED`/`EVALUATION_SAMPLE_DELETED`/`EVALUATION_ANNOTATION_ADDED`，actor=USER，metadata 不含路径。
- 标注指南文档：随包资源（不联网），版本常量与 `guideline_version` 列互相校验（UI 只允许当前指南版本或显式历史版本）。

## 被否决方案

- **读时现算规则命中**（D2-B）：规则引擎升级后历史命中不可追溯，PRD §9.9「每个样本保存…规则命中」字面不满足。
- **迁移改 dataset_split 枚举加 REGRESSION**（D4-B）：SQLite 改 CHECK 需重建表，V1 20–40 样本规模无 Holdout 之外的拆分需求。
- **样本经 application 启动播种**（非 migration）：启动幂等与审计劣于 migration 播种（0008 先例）。
- **批量导入整批单事务**：一个坏样本拖垮整批，与 PRD「样本级原因」交互冲突；逐样本短事务 + 聚合回执更贴合。

## 不适用项

- 云同步/评测集跨机交换公开 Schema：非目标，JSON 导入信封仅为内部格式，不登记 PRD 公开契约。
- P/R/F1 与晋升门槛：V3 §11.6 范畴，本 change 不实现。
