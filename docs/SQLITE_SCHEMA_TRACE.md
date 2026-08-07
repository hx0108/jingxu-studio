# SQLite 初始结构追踪

本追踪表把 TECH_DESIGN v1.1 §8.4 的持久化对象映射到唯一初始 migration 与自动化测试。数据库事实源是 `packages/persistence/resources/migrations/0001_initial.sql`；本文件不复制完整 DDL。

| TECH 表组               | `0001_initial.sql` 表                                                                                                                                                                           | 主要约束证据                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| §8.4.1 系统与配置       | `schema_migrations`、`app_settings`、`schema_registry_manifest`、`provider_profiles`、`provider_capability_snapshots`、`model_price_snapshots`、`reference_price_snapshots`、`prompt_templates` | JSON、FK、枚举、唯一价格版本、`SHOT_PACKAGE + PER_SHOT`、不透明 `credential_ref`     |
| §8.4.2 项目、输入与版本 | `projects`、`format_profiles`、`source_inputs`、`consent_records`、`episodes`、`episode_versions`、`episode_version_shots`、`story_bible_versions`、`script_versions`、`stage_heads`            | FK、版本唯一、单 current、单 active Episode、项目级/集级 stage head、JSON 基础合法性 |
| §8.4.3 任务、锁与依赖   | `script_stage_jobs`、`model_invocations`、`lock_records`、`dependency_edges`、`audit_events`                                                                                                    | 状态枚举、幂等键、重试次数、有效锁唯一、复合边唯一、审计 JSON 与敏感字段缺席         |
| §8.4.4 分镜与可生产性   | `shots`、`shot_contract_versions`、`shot_derivations`、`producibility_reports`、`producibility_findings`、`finding_overrides`                                                                   | lifecycle/版本/血缘枚举、契约镜像字段、Episode sequence、LLM 不得产生 BLOCK          |
| §8.4.5 导入导出与评测   | `export_records`、`import_records`、`evaluation_samples`、`evaluation_annotations`、`analytics_events`                                                                                          | 状态、成功导入幂等、JSON、样本去重和必要查询索引                                     |

确定命名对象由 `packages/persistence/src/migrations/initial-schema-trace.ts` 登记：34 张表、18 个索引和 4 个 immutable UPDATE trigger。`initial-schema.integration.test.ts` 执行空库 introspection、`foreign_key_check` 和分组负例；`migration-runner.integration.test.ts` 覆盖顺序、checksum、重复启动、高版本库、未版本化库、单事务回滚及 101 历史版本升级。

当前 DDL 只建立后续 Change 所需的存储结构，不实现 Project、Schema Registry、JobRunner、导入导出或评测业务方法。
