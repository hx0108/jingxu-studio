## Why

镜序 Studio 已能生成、编辑、导出结构化分镜，但 V1 发布门槛（PRD v1.4 §9.11「完成 20 至 40 个结构化分镜评测样本和第一版标注指南」）所要求的评测集业务用例尚不存在：`evaluation_samples`/`evaluation_annotations` 表自 0001 建表后无 Repository、无 IPC、无页面。补齐该能力后，V1 可以验证自身结构化输出与可生产性规则的判例积累，且「分镜导入导出和评测」roadmap 整体收口。

## What Changes

- 新增结构化分镜评测集能力：样本查看、筛选、创建、项目派生、JSON 批量导入、删除与人工标注（PRD §9.9、§15.1 结构化评测集行）。
- 样本入库时执行确定性校验（离线 Registry Schema + 可生产性规则 `jingxu-producibility-rules/1` + 派生自集合校验的序列规则），规则命中与 `rule_version` 随样本落库。
- `dedup_key` 全局唯一：重复样本拒绝入库并列出样本级原因；授权状态必选（AUTHORIZED/PUBLIC_DOMAIN/SYNTHETIC）；`project_id` 可空（全局样本）。
- 人工标注追加式保存（`guideline_version`/`label_json`/`rationale`/`annotator`），不覆盖历史结论；删除样本需确认并留审计。
- 迁移 0017 播种 24 个 SYNTHETIC 种子样本（≥10 可接受 + ≥10 问题样本，覆盖 PRD §9.9 九类问题）+ 新增列 `rule_hits_json`/`rule_version`；标注指南 v1 以版本化文档进入受控资源目录。
- `dataset_split` 沿用 TRAIN/VALIDATION/TEST 枚举，文档映射 PRD §11.7 四拆分（TRAIN=Development、VALIDATION=Validation、TEST=Holdout）；Regression Set 显式为 V2+ 非目标，零枚举迁移。

### 非目标

- 不做视频质量评测（黑屏/冻结/音画样本属 V2 §10.11）。
- 不做能力晋升/降级机制与 P/R/F1 指标计算（V3 §11.6 范畴）；V1 只积累判例。
- 不做评测集云同步或跨机交换文件格式（复用 JSON 文件导入即可，不新增公开 Schema 契约）。
- 不修改 `evaluation_samples`/`evaluation_annotations` 既有列与 CHECK 约束（仅新增列）。

## Capabilities

### New Capabilities

- `storyboard-evaluation-set`: 结构化分镜评测集的样本维护、项目派生、规则命中、批量导入、人工标注、种子样本与白名单 IPC/UI。

### Modified Capabilities

- 无。

## Impact

- Application：新增 Evaluation Service、样本信封校验、规则命中引擎（复用 `collectProducibilityWarns`、离线 Registry、`validateShotSetCollection` 派生规则）、Evaluation Ports。
- Persistence：新增 Evaluation Repository/UnitOfWork；迁移 0017（`rule_hits_json`/`rule_version` 列 + 种子样本，沿用 0008 播种惯例与四文件九处版本断言约定）。
- Contracts/Main/Preload/Renderer：新增 `evaluation` 冻结 namespace（listSamples/createSample/createFromEpisode/importBatch/deleteSample/addAnnotation），strict DTO 与脱敏 AppResult；工作台主导航全局入口 + 项目菜单筛选入口。
- 审计：样本创建/导入/删除与标注写入 `audit_events`（actor=USER）。
- 安全：导入文件路径不进 Renderer/回执/审计（沿用 transfer 路径红线）；样本不含凭据/媒体字节。
- 事实源映射：PRD v1.4 §9.9（V1 结构化分镜评测集）、§9.11（发布门槛）、§11.7（数据拆分）、§15.1（结构化评测集交互行）、§15.1.1（全局交互状态）；TECH_DESIGN v1.1 §8.4.5（evaluation_samples/evaluation_annotations 表）、§19（验收追踪 Sprint 5）。
