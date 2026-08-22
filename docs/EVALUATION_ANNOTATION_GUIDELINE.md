# 结构化分镜评测集标注指南 v1

版本标识：`jingxu-annotation-guideline/1`（即 `@jingxu/contracts` 的 `EVALUATION_GUIDELINE_VERSION`）。
适用对象：结构化分镜评测集（`evaluation_samples` / `evaluation_annotations`）的人工标注。
发布门槛：PRD v1.4 §9.11 / §9.9。本文件是受控资源，随仓库版本化；语义变更必须升版本号
（`/2`、`/3` …），历史标注行携带旧版本标识，永不改写。

## 1. 标注什么

每个样本 = 一次「候选文档 + 最小上下文」的评测判例。标注人给出：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `verdict` | `ACCEPTABLE` / `PROBLEM` | 总结论：该候选是否可作为合格产出被接受 |
| `issueCodes` | 九类问题码 + 引擎补充码，≤16 个 | 判定存在的问题类型（见 §3） |
| `severity` | `BLOCK` / `WARN` / `ADVISORY` / `null` | 最严重级别；`ACCEPTABLE` 且无任何关注点时为 `null` |
| `rationale` | 非空文本 | 判定依据，须能独立复核（引用具体字段/阈值） |

标注按追加式留痕：`addAnnotation` 只插入新行，历史行不可修改、不可删除（随样本级联删除除外）。

## 2. 判定规则

1. **verdict 先看阻断性**：候选存在结构性违例（缺必填字段、枚举非法、集合连续性错误、
   能力未登记、锁定冲突）时判 `PROBLEM`；仅可生产性风险（时长偏离、角色过多、复杂动作、
   模式偏离）也判 `PROBLEM`，但 severity 降为 `WARN`。
2. **正脸长对白 WARN 是非阻断项**：`PRODUCIBILITY_WARN`（正脸且口型可见且台词 >4s）
   单独出现时判 `ACCEPTABLE` + `severity: 'WARN'`——样本可用，但复审时需关注口型风险
   （种子 `seed-synthetic-shot-16` 即此形态）。
3. **与引擎命中对齐但不盲从**：`rule_hits_json` 是确定性规则在同一 `rule_version` 下的
   预计算命中。标注结论应与之相互印证；若人工发现引擎未覆盖的问题，仍按九类分类写入
   `issueCodes` 并在 `rationale` 说明「引擎未命中，人工判定」。
4. **SCHEMA_INVALID 共生不算重复问题**：缺必填字段、能力未登记等问题会同时触发引擎
   归因命中与 Registry 收口命中（如 `MISSING_REQUIRED` + `SCHEMA_INVALID`），
   `issueCodes` 如实记录两条（种子 `seed-synthetic-shot-11`、`-21` 先例）。

## 3. 九类问题判定要点

| issueCode | 判定要点 | 种子示例 |
| --- | --- | --- |
| `EVAL_ISSUE_MISSING_REQUIRED` | ShotContract 20 必填键 / Episode 12 键 / ScriptStage 6 键缺一；SCRIPT_STAGE 信封缺 `candidate.stage` | `-11`、`-24` |
| `EVAL_ISSUE_ENUM_INVALID` | 枚举字段值不在规则集镜像内（注意引擎镜像与 Registry 1.1.0 存在已登记差异：`camera_motion` 的 `ZOOM`/`OTHER` 合 Schema 但不在规则集内） | `-12` |
| `EVAL_ISSUE_DURATION_DEVIATION` | 单镜时长越界（1–20s）；台词时长 > 镜头时长；整集 Σ 偏离目标 >50% | `-13`、`-23` |
| `EVAL_ISSUE_CHARACTER_OVERFLOW` | 单镜 `character_ids` > 4 | `-14` |
| `EVAL_ISSUE_COMPLEX_ACTION` | `action` >300 字或 >3 句（按 `。！？!?` 断句） | `-15` |
| `EVAL_ISSUE_DIALOGUE_MODE_CONFLICT` | `PRECISE_LIP_SYNC` 但非正脸/口型不可见；镜头模式偏离项目默认且未声明 `SHOT_OVERRIDE`；`SHOT_OVERRIDE` 缺 `override_reason` | `-17`、`-18` |
| `EVAL_ISSUE_CONTINUITY_INVALID` | 单镜 `CONTINUOUS_ACTION` 缺前镜；整集 sequence 不连续唯一；`previous_shot_id` 引用不存在或非更早镜头 | `-19`、`-20` |
| `EVAL_ISSUE_CAPABILITY_UNKNOWN` | `capability_requirements` 出现六能力登记表（FIRST_FRAME/LAST_FRAME/SUBJECT_REFERENCE/REFERENCE_VIDEO/DRIVING_AUDIO/SEED）之外的值 | `-21` |
| `EVAL_ISSUE_LOCK_CONFLICT` | `locked_paths` 指针无法在当前文档解析（模式合法但路径悬空） | `-22` |

引擎补充码：`EVAL_ISSUE_SCHEMA_INVALID`（Registry 收口）、`EVAL_ISSUE_PRODUCIBILITY_WARN`
（正脸长对白，见 §2.2）。

## 4. 入集前置义务

- **授权**：样本身份均为虚构或已授权内容；SYNTHETIC/PUBLIC_DOMAIN/AUTHORIZED 三态如实填写。
- **去重**：`dedup_key` 全局唯一（`^[\w:.-]{3,96}$`）；同候选不同上下文视为不同样本，键需可读。
- **最小化**：样本只携带复跑确定性规则所需的最小上下文；不得含 API Key、媒体字节、
  用户绝对路径。
- **数据拆分**：TRAIN/VALIDATION/TEST 在创建时指定；TEST（Holdout）样本不得用于规则调参
  （文档映射：TRAIN=Development、VALIDATION=Validation、TEST=Holdout）。

## 5. 版本升级流程

判定语义、阈值口径或分类变化时：新增 `jingxu-annotation-guideline/<n>`（同步
`EVALUATION_GUIDELINE_VERSION`），旧样本历史标注保持旧版本标识；新标注强制使用当前版本
（服务端拒绝不匹配的 `guideline_version`）。规则阈值变化另行体现为 `rule_version`
（`jingxu-producibility-rules/*`）升级，两者独立演进。
