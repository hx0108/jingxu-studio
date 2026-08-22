## 1. Contracts and application ports

- [x] 1.1 新增评测集 strict DTO（样本信封/期望结论/标注/六方法入参出参）、九类问题 issue code 常量表与 `EVALUATION_*` 错误码，补 Contract 负例测试。→ Requirement: 样本入库与去重、安全 IPC
- [x] 1.2 冻结 Evaluation Application Ports：规则引擎、样本/标注 Repository、UnitOfWork、文件导入 Port；禁止暴露 Row/路径/连接。→ Requirement: 确定性规则命中、安全 IPC

## 2. Validation and service

- [x] 2.1 测试先行实现样本信封校验与规则命中引擎（Registry Schema + `collectProducibilityWarns` + 集合派生规则），每类非法输入单一错误 Fixture，`rule_version` 固定。→ Requirement: 确定性规则命中
- [x] 2.2 实现 EvaluationService：createSample（去重/授权/单事务+审计）、createFromEpisode（READY 门禁 + 快照冻结 + 逐样本入库）、deleteSample（确认语义 + 审计 + 标注级联）。→ Requirement: 样本入库与去重、项目派生样本
- [x] 2.3 实现 addAnnotation（追加式、guideline_version 校验、历史不可变）与 importBatch（事务外解析 + 逐样本短事务 + 聚合回执）。→ Requirement: 人工标注追加式留痕、JSON 批量导入

## 3. Persistence and migration

- [x] 3.1 实现 Evaluation Repository/UnitOfWork（list/insert/delete/find-by-dedup + annotations），复用 0001 两表，行映射错误归一化。→ Requirement: 样本入库与去重
- [x] 3.2 迁移 0017：`rule_hits_json`/`rule_version` 列 + 24 个 SYNTHETIC 种子样本与首批标注（规则命中预计算写死、dedup_key 唯一、九类全覆盖）；同步 4 文件 9 处版本断言。→ Requirement: 种子样本与标注指南
- [x] 3.3 集成矩阵：空库/0016 库迁移无损、去重冲突、非法信封零残留、删除级联与审计、种子幂等核对（≥10 正 ≥10 反九类齐）。→ Requirement: 种子样本与标注指南、样本入库与去重

## 4. Main, Preload and Renderer

- [x] 4.1 实现 Main `evaluation` IPC（sender/READY gate/singleflight/输出脱敏复验）与导入文件 sink（系统 Open Dialog，路径不进 Renderer），组合根接线。→ Requirement: 安全 IPC 与评测集页面
- [x] 4.2 实现 Preload 冻结 `evaluation` 白名单与双端 strict DTO 校验，补未授权/未知字段/异常脱敏 Contract 测试；同步 apiKeys 白名单断言三处。→ Requirement: 安全 IPC 与评测集页面
- [x] 4.3 实现评测集页面：全局主导航 + 项目菜单双入口、「全部/全局/当前项目」筛选、样本详情（规则命中/标注历史）、创建/派生/导入/删除确认/标注表单、空态正反例说明与标注指南版本展示。→ Requirement: 安全 IPC 与评测集页面

## 5. Verification and documentation

- [x] 5.1 Electron E2E：种子库首屏与九类统计、筛选切换、手工创建（成功 + dedup 拒绝）、项目派生（READY 门禁 + 非 READY 拒绝）、批量导入（混合批次逐样本结果 + 损坏文件零入库 + 路径红线）、标注追加历史不变、删除确认与审计；关进程子进程查库断言样本/标注/审计/零残留。
- [x] 5.2 更新 README（功能清单 + 实施记录 + 尚未实现收窄）与 TECH_DESIGN（§3.4 快照 + §8.4.5 拆分映射与 0017 说明 + §19 Sprint 5 勾稽）及 packaged smoke。
- [x] 5.3 运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:contract`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm package:win` 与 `openspec validate storyboard-evaluation-set --strict`。
- [x] 5.4 执行 OpenSpec Verify；通过后 Sync Specs、Archive Change，并记录实际验证证据。
