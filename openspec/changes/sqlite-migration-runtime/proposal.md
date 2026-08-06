## Why

镜序 Studio 已具备可启动的 Electron 工程基线，但 V1 的本地结构化数据尚无可验证、可升级且失败可恢复的 SQLite 事实源。依据 PRD v1.4 §9.1、§15.1 与 TECH_DESIGN v1.1 §8.1、§17、§20 Sprint 1，本 Change 先建立数据库运行时和启动安全门，确保后续 Project、版本链及 Job 能力不会建立在不可追踪或可能破坏用户数据的初始化流程上。

## What Changes

- 引入 `better-sqlite3` 持久化 Adapter、Application-owned Persistence Runtime Port 与启动编排服务；Electron Main 仅在 Composition Root 中注入实现，Renderer 不直接接触数据库。
- 建立唯一写连接及显式连接基线：`foreign_keys=ON`、WAL、`synchronous=FULL`、`busy_timeout=5000`，数据库路径默认位于 `%LOCALAPPDATA%/JingxuStudio/data/jingxu.sqlite`，测试可注入隔离路径。
- 建立按 `NNNN_short_description.sql` 顺序执行的 migration runner、`schema_migrations` 记录和基于原始文件字节的 SHA-256；拒绝编号缺口、重复版本、已应用文件漂移和高于当前应用的数据库版本。
- 按 TECH_DESIGN v1.1 §8.4–§8.6 交付完整 `0001_initial.sql`，覆盖表清单、FK/CHECK、partial unique、必要索引和不可变版本 UPDATE trigger；本 Change 只建立存储结构，不实现对应业务用例。
- 对已有数据库升级前使用 SQLite 在线备份创建一致快照；全部待执行 migration 与记录在同一短事务中提交，任一步失败时整体回滚并保留旧库可打开。
- 建立启动数据库自检、归一化错误码和启动写入门：数据库打开、PRAGMA、migration、checksum、完整性/外键/基础不变量任一失败时禁止进入正常可写模式，也不允许启动未来的 JobRunner。
- 增加独立只读故障页与最小类型化 `runtime` IPC 白名单，只允许读取脱敏启动状态、重试完整自检和按已登记备份执行受控恢复；不向 Renderer 暴露 SQL、堆栈、数据库连接或任意文件路径入口。
- 恢复前先关闭连接并保存当前数据库及 WAL/SHM 的诊断副本，再原子替换选定备份、重新打开并执行完整自检；不自动删除备份或诊断副本。
- 测试先行覆盖空库、重复启动、上一版本升级、100+ 历史版本压力库、checksum 漂移、版本过高、备份失败、migration 中途失败回滚、损坏库、恢复成功/失败、连接基线和 Renderer 隔离。
- 明确非目标：不实现 Project、FormatProfile、SourceInput、业务 Repository/UnitOfWork 用例、Schema Registry、凭据、Provider、JobRunner、剧本、分镜、导入导出或任何 V2/V3 能力；不修改四份 PRD-owned JSON Schema。

## Capabilities

### New Capabilities

- `sqlite-migration-runtime`: 定义 SQLite 连接、全量初始 DDL、顺序 migration、不可变 checksum、在线备份、受控恢复、启动自检和只读故障态的可观察行为。

### Modified Capabilities

无。现有 `desktop-workspace-foundation` 的需求保持不变，本 Change 只在其安全进程与测试基线上增加持久化运行时能力。

## Impact

- **代码与依赖**：新增 `packages/application` 的持久化运行时 Port/启动服务、`packages/persistence` 的 SQLite Adapter 与 migrations，并在 `apps/desktop` Composition Root、Preload、Renderer 故障页和 `packages/contracts` 中增加最小运行时状态接口；新增锁定版本的 `better-sqlite3` 及类型依赖。
- **数据库与兼容性**：新库创建 TECH_DESIGN v1.1 §8.4 的 V1 初始结构；旧库只允许顺序前进并先备份；高版本库只读阻断，不支持降级写入；已应用 migration 内容变化属于启动阻断错误。
- **IPC 与进程**：新增逐方法 `runtime.getStartupStatus`、`runtime.retryStartup` 和 `runtime.restoreBackup`；全部调用校验 sender 与 Zod DTO，数据库对象只存在于 Main/persistence 边界。
- **Schema**：四份 PRD-owned JSON Schema 及其 `$id`、版本和 hash 均不变；Schema Registry 仍由后续 `schema-registry-version-locks` Change 实现。
- **安全与隐私**：故障 DTO 和日志仅包含稳定错误码、阶段、时间及可执行动作，不包含 SQL、堆栈、密钥或用户内容；Renderer 不能提交任意路径，恢复目标只能来自 Main 维护且校验过的备份清单。
- **验收追踪**：直接支撑 PRD v1.4 §15.1“启动与只读故障页”和 TECH_DESIGN v1.1 §4.3.5、§8、§16.3、§17、§20 Sprint 1、§21；不宣称 AC-V1-01 至 AC-V1-06 的业务验收已完成。
