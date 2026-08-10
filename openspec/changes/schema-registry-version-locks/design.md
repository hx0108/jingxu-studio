## Context

见 `proposal.md` 的 Why。当前启动链由 `StartupService` 调用 `PersistenceRuntimePort.prepare()` 完成数据库、migration、审计与恢复门，随后直接进入 `READY`；`schema_registry_manifest` 已存在于不可变 `0001_initial.sql`，但没有 Repository、静态锁清单或 Registry 实现。四份 PRD-owned Schema 位于仓库根目录，包含两个跨文件引用链；Forge 目前只复制 migration 资源。

当前锁定事实如下，实施时必须通过测试从文件重新计算，不允许只相信本文：

| Schema ID                                                       |  版本 | SHA-256                                                            |
| --------------------------------------------------------------- | ----: | ------------------------------------------------------------------ |
| `https://jingxu.studio/schemas/script-stage-output/1.0.0`       | 1.0.0 | `128e7a49e1d5829c4b0c9cf89fc5e6fd883746f022e9759c157f70176309971f` |
| `https://jingxu.studio/schemas/shot-contract/1.1.0`             | 1.1.0 | `3fa77aa85152ad2500fcc1c07da5bec697da8810c572d1c378b0bf432f437e4b` |
| `https://jingxu.studio/schemas/episode-storyboard-export/1.1.0` | 1.1.0 | `55238d1958aae25341d137192cf544946b9d8b8767648a98a3956e01798fcb13` |
| `https://jingxu.studio/schemas/project-transfer-bundle/1.0.0`   | 1.0.0 | `9736ee2421fa8b8febe683c6e41e3cae47665df5d7afe85592a25e4fa4fbabbb` |

## Goals / Non-Goals

**Goals:**

- 建立单一静态锁清单、纯离线引用闭包和不可变的四校验器 Registry。
- 让 Application 启动编排显式拥有 `SCHEMA_REGISTRY` 阶段，并把资源读取、业务校验和证据持久化分层。
- 在开发态、Contract Test、Integration、E2E 和打包态复用同一逻辑资源名与锁记录。
- 保持错误码稳定、输出有界且不泄漏路径、Schema 原文或用户内容。

**Non-Goals:**

- 不修改四份正式 Schema 的任何字节，不生成 TypeScript 领域类型替代 Schema。
- 不实现 EpisodeValidator 的集合级 sequence、previous_shot、时长或父链业务不变量；JSON Schema 能覆盖的引用校验除外。
- 不实现导入导出、JobRunner、模型候选 Schema、锁编辑或 Provider。
- 不新增 migration，不把 Registry 做成插件系统、在线更新器或多版本路由器。

## Decisions

### 1. 静态锁是期望事实源，SQLite manifest 是成功核验证据

在 `packages/validation` 的公开入口维护只读 `V1_SCHEMA_LOCKS`，每项包含完整 ID、Draft、版本、ASCII 逻辑资源名和小写 SHA-256。四份资源全部验证和编译成功后，Application 通过 `SchemaManifestUnitOfWorkPort` 开启一个短 `BEGIN IMMEDIATE` 事务，令事务内 Repository 执行精确替换并读回对账；Schema 阶段的提交后审计要求启用行恰好等于静态清单。现有前置数据库审计只检查表结构和行级合法性，不得因旧构建 manifest 与新静态锁不同而提前阻断替换。

数据库旧值不能批准新资源，也不能覆盖静态 hash。这样可避免用户数据库被篡改后放行包内漂移，同时保留“当前数据库最后由哪个构建成功核验”的本地证据。

被否决方案：只用数据库 manifest（可被旧数据或本地修改错误放行）；只用代码常量且不落证据（无法执行 TECH_DESIGN v1.1 §8.4 的本地审计）；为此新增 `0003`（现有表足够，增加 migration 没有收益）。

### 2. 根目录 Schema 保持权威，构建生成固定资源目录

根目录四份中文文件名继续是 PRD-owned 源文件。新增确定性资源同步脚本，把它们按锁清单映射到 `packages/validation/resources/schemas/v1/` 的四个 ASCII 文件名；脚本只允许字节复制并在复制前后计算 hash。CI/Contract Test 证明资源副本等字节，任何漂移均失败。Forge `extraResource` 同时包含 migrations 和 `schemas/v1`，打包后固定为 `process.resourcesPath/schemas/v1`。

被否决方案：运行时直接读取仓库根目录（打包态不可用）；在 TypeScript 中内嵌 JSON（破坏资源 hash 与可审计性）；人工维护无对账的第二份 Schema（高漂移风险）。

### 3. Application 编排，Main 文件 Adapter，Validation 纯校验

新增 Application Ports：

- `SchemaResourcePort.readAllLocked()`：返回逻辑资源名和不可变字节，不暴露绝对路径。
- `SchemaManifestUnitOfWorkPort.run()`：由 Application 拥有 Schema 证据事务边界，并向回调提供事务内 Repository。
- `SchemaManifestRepositoryPort.replaceAll()/findEnabled()`：只在所属 UnitOfWork 内替换和读回四条证据，不自行提交。
- `SchemaRegistryPort.verifyAndCompile()`：接受锁记录与字节，返回不可变 Registry 或归一化失败；接口不暴露 Ajv 类型。

Main Adapter 负责受管理资源目录、文件存在性、普通文件/符号链接边界和读取字节；`packages/validation` 实现纯 hash/JSON/身份/引用/Ajv 编译；`packages/persistence` 实现 manifest UnitOfWork 与事务内 Repository。Application 的 `SchemaRegistryStartupService` 按“读四份资源 → 验证/编译 → UnitOfWork 内替换并读回证据 → 原子发布 Registry”编排。业务调用方只依赖 Application/Validation 公开的 `validate(schemaId, unknown)` 能力。

事务内不读取文件、不计算 hash、不编译 Ajv；失败时不会发布半个 Registry。Provider/网络不参与任何阶段。

### 4. Ajv 2020 预注册后同步编译，禁止异步网络加载

实施前核验并精确锁定支持当前 Node 22/TypeScript 6 的 Ajv 8 版本，使用 `Ajv2020`。先解析并验证全部原始文档，再按完整 `$id` 全量 `addSchema`，最后编译四个根 ID；不配置 `loadSchema`，不使用 `compileAsync`。format checker 只注册 TECH_DESIGN v1.1 要求的日期时间等确定性格式，不把 Zod DTO 校验混入。

Ajv 原始错误在 validation 边界映射为 `{instancePath, keyword, messageCode}`，按路径、关键字、消息码稳定排序并设置数量上限；日志只记录 schema ID、错误数和 traceId。

被否决方案：按需编译（可能在业务写入中首次暴露坏资源）；相对文件 `$ref`（与正式 `$id` 语义不一致）；Ajv 异步 loader（可能联网且结果依赖环境）。

### 5. 启动状态扩展而不新增通用 IPC

公开 Contract 新增 `StartupPhase='SCHEMA_REGISTRY'` 以及最小稳定错误码集合：

- `SCHEMA_RESOURCE_MISSING`
- `SCHEMA_RESOURCE_INVALID_JSON`
- `SCHEMA_HASH_MISMATCH`
- `SCHEMA_ID_MISMATCH`
- `SCHEMA_DRAFT_MISMATCH`
- `SCHEMA_VERSION_MISMATCH`
- `SCHEMA_MANIFEST_INVALID`
- `SCHEMA_REFERENCE_UNRESOLVED`
- `SCHEMA_COMPILE_FAILED`
- `SCHEMA_EVIDENCE_WRITE_FAILED`

`StartupService` 在 `PersistenceRuntimePort.prepare()` 成功后、转为 `READY` 前调用新的 Schema 启动 Port。失败沿用 `READ_ONLY_FAULT`、revision、singleflight retry 和 Project gate-only facade；`runtime.getStartupStatus/retryStartup/restoreBackup` 方法不变。Retry 从完整数据库检查重新开始，再运行完整四 Schema 核验；Schema 故障只允许 `RETRY`，数据库备份恢复仍只用于数据库故障。

被否决方案：新增 `schema.*` Renderer IPC（扩大攻击面且业务暂不需要）；Schema 失败仍进入 READY 并按功能降级（违反 P0 启动门）；让 Persistence Adapter 读取 Schema 文件（跨越基础设施职责）。

### 6. Fixture 与测试证据按层隔离

`packages/test-fixtures` 保存八份最小、虚构 Fixture 及元数据。每个非法 Fixture 只改变一个约束，并断言唯一 messageCode。Contract Test 将所有网络 API 替换为“调用即失败”，覆盖四个根 ID、两条外部引用链和未知 ID；Integration 覆盖资源 Adapter、hash/身份/引用故障、manifest 原子替换与启动重试；E2E 覆盖故障页和 Project 写门；packaged smoke 从产物读取四份资源并对账 hash。

### 7. 数据流、错误与安全边界

```text
StartupService
  -> PersistenceRuntimePort.prepare()
  -> SchemaRegistryStartupService
       -> SchemaResourcePort (Main, 文件读取，事务外)
       -> SchemaRegistryPort (Validation, hash/parse/Ajv，纯本地)
       -> SchemaManifestUnitOfWorkPort (Persistence, 短事务)
            -> SchemaManifestRepositoryPort (事务内替换与读回)
  -> READY / READ_ONLY_FAULT
```

Renderer 只接收现有 `StartupStatusDto` 的阶段、错误码、可重试性和脱敏摘要。Schema 原文、文件名之外的路径、Ajv errors、实例值和 manifest SQL 不跨 IPC。所有资源路径由 Main 从构建配置派生，Renderer 和用户输入均不能指定。

## Risks / Trade-offs

- [根 Schema 与资源副本形成双位置] → 同步脚本、字节 hash Contract Test 和 packaged smoke 三重对账；禁止手改资源副本。
- [Ajv/format 插件升级改变错误文本或行为] → 精确锁版本，只对稳定自定义 messageCode 做契约断言，升级必须单独 Change。
- [Schema 校验启动耗时增加] → 四份文件总量很小，单次启动预编译并记录耗时；不以墙钟阈值制造 flaky 门禁。
- [manifest 替换失败使已验证 Registry 不可用] → 发布 Registry 必须晚于证据事务成功，失败保持只读并允许重试。
- [错误码数量扩大公开 Contract] → 只增加资源自检所需稳定类别，内部 Ajv 细节不进入 IPC。
- [未来增加 Schema 版本时清单不再恰好四条] → V1 明确锁定四条；新增版本必须新 Change 并评估兼容、Fixture、导入导出和历史数据。

## Migration Plan

1. 不修改 `0001_initial.sql` 和 `0002_project_command_receipts.sql`，先用现有 v2 临时库验证 `schema_registry_manifest` 空表与旧行两种状态。
2. 引入锁清单、资源同步与 Validation/Contract 测试；在接入启动门前保持运行行为不变。
3. 实现 manifest Repository 和 Application 启动编排，加入 phase/error DTO，再接入 Main Composition Root 与故障页。
4. 从干净资源目录生成并验证四份副本，执行完整门禁、断网 Contract/E2E、Windows x64 package 和 packaged smoke。
5. 发布回滚仅回退二进制；数据库无 schema 版本变化。旧二进制忽略 manifest 行，新二进制重新核验包内静态锁，不需要 down migration。

## Open Questions

无。Ajv 精确补丁版本在 Apply 的依赖核验任务中确定；该选择不改变规范、分层或任务拆分。
