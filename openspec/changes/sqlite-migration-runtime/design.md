## Context

当前仓库只有经过归档验证的 Electron/React/TypeScript 工程基线，`window.jingxu` 仍为空白名单，尚无 Application、Persistence 或数据库运行时。变更动机见 `proposal.md`，可观察行为见 `specs/sqlite-migration-runtime/spec.md`。

设计必须同时满足 PRD v1.4 §9.1 的本地 SQLite 事实源、§15.1 的独立只读故障页，以及 TECH_DESIGN v1.1 §4.3.3、§4.3.5、§8、§16.3、§17 和 §20 Sprint 1。四份 PRD-owned Schema 不属于本 Change；数据库 DDL 可以预建其存储列和关系约束，但不能在 Schema Registry 落地前声称业务 JSON 已可正式写入。

## Goals / Non-Goals

**Goals:**

- 以 Application-owned Port 隔离启动编排与 `better-sqlite3`，保持 Domain 零基础设施依赖。
- 对新库、旧库、漂移库、高版本库和损坏库给出确定、可测试且不静默破坏数据的启动结果。
- 用完整 `0001_initial.sql` 固定 TECH_DESIGN v1.1 §8.4 的数据库事实源，并为后续业务 Change 提供可验证约束。
- 把在线备份、原子 migration、受控恢复和启动写入门组合成一个闭环。
- 在开发态和 Windows x64 打包态都证明 native module、migration 资源和只读故障 UI 可用。

**Non-Goals:**

- 不定义 Project、FormatProfile 或其他业务 Repository/UnitOfWork Port；本 Change 的 Port 只管理持久化运行时生命周期。
- 不实现 Schema Registry、业务 JSON Schema 校验、业务 invariant mutation、JobRunner、Provider、凭据或导入导出。
- 不支持 PostgreSQL、远程数据库、多人并发、网络共享 SQLite、降级写入或自动修复用户数据。
- 不提供任意数据库文件选择器、SQL 控制台、备份自动清理或完整项目备份承诺。

## Decisions

### 1. 分层与 Composition Root

新增以下最小结构：

```text
packages/application/src/
├── ports/persistence/persistence-runtime-port.ts
└── services/startup-service.ts

packages/persistence/src/
├── sqlite-persistence-runtime.ts
├── connection/
├── migrations/
├── backup/
├── recovery/
└── diagnostics/

apps/desktop/src/main/
├── composition/create-application-runtime.ts
└── ipc/runtime-ipc.ts
```

`StartupService` 只依赖 `PersistenceRuntimePort`，负责状态机、并发命令串行化和写入门；SQLite 连接、文件路径、SQL、backup API 和异常归一化全部位于 `packages/persistence`。Main Composition Root 从 Windows `LOCALAPPDATA` 已知目录派生 `%LOCALAPPDATA%/JingxuStudio` 受管理根，严格校验其存在性、绝对路径和平台后再构造 Adapter；测试只能由 Composition Root 显式注入任务临时根。不得使用 Electron 默认位于 `%APPDATA%` 的 `app.getPath('userData')` 代替 TECH_DESIGN v1.1 §8.2 锁定的数据根。Domain 不新增依赖，Renderer 和 Preload 只依赖公开 Contract。

Repository 与 UnitOfWork 虽然同属持久化 Port，但本 Change 不创建没有调用方的业务接口；它们由对应业务 Change 按用例需要增量加入。

**被否决方案：** Main 直接调用 `better-sqlite3` 会让生命周期宿主同时拥有业务基础设施实现；把 Port 放进 persistence 会反转接口所有权；提前创建全部 Repository 会形成无用的未来模块。

### 2. 启动状态机与写入门

Application 层维护单一状态快照和单调递增 `revision`：

```text
BOOTING -> CHECKING -> READY
                    -> READ_ONLY_FAULT
READ_ONLY_FAULT -> CHECKING          # retry
READ_ONLY_FAULT -> RESTORING
RESTORING -> CHECKING -> READY
                     -> READ_ONLY_FAULT
```

检查阶段为 `DATABASE_OPEN`、`CONNECTION_BASELINE`、`MIGRATION`、`DATABASE_AUDIT`、`RECOVERY_GATE`。只有 `READY` 打开全局 `writeEnabled`；任何未识别异常先归一化为内部证据，再向 Renderer 返回稳定码和脱敏摘要。后续 JobRunner 必须依赖同一写入门，不能自行推断数据库可用性。

`retry` 与 `restore` 通过进程内互斥器串行执行。Command 携带 `requestId` 和调用时看到的 `expectedRevision`；重复 `requestId` 返回同一结果，过期 revision 返回 `STARTUP_STATE_CONFLICT`，避免双击触发并行迁移或恢复。

**被否决方案：** 只显示启动异常对话框无法承载恢复和重新自检；每个模块维护自己的数据库可用状态会产生漂移；失败后创建空白新库会掩盖并覆盖用户事实源。

### 3. IPC、DTO 与安全边界

`packages/contracts` 增加 Zod 输入/输出和公开 TypeScript 类型：

```text
runtime.getStartupStatus(): Promise<StartupStatusDto>
runtime.retryStartup({ requestId, expectedRevision }): Promise<StartupStatusDto>
runtime.restoreBackup({ requestId, expectedRevision, backupId }): Promise<StartupStatusDto>
```

`StartupStatusDto` 只包含 `state`、`revision`、当前/已完成阶段、稳定 `errorCode`、`retryable`、允许的恢复动作、备份的 opaque id/创建时间/schema version 及脱敏摘要。绝对路径、SQL、堆栈、SQLite error 原文、连接对象和任意 Provider/用户内容均不进入 DTO。

Main IPC Host 对每个方法验证受信 sender、Zod DTO、状态前置条件和 request id；Preload 逐方法暴露冻结对象，不提供 `send/on/invoke`。Renderer 不能提交文件路径，`backupId` 必须解析到 Main 启动时扫描并验证的受管理清单。

**被否决方案：** 暴露通用 IPC 或恢复路径会扩大 Renderer 权限；仅靠 TypeScript 类型不能保护运行时输入；把原始 SQLite 错误传给 UI 可能泄漏路径、SQL 和内部结构。

### 4. 数据目录、单实例与连接生命周期

生产数据根由 Main 从经校验的 Windows `LOCALAPPDATA` 已知目录派生为 `%LOCALAPPDATA%/JingxuStudio`；缺失、非绝对路径、非 Windows 平台或规范化失败均阻断数据库初始化，不回退到工作目录、`%APPDATA%` 或明文配置。测试显式注入任务临时根，不读取产品受管理目录。应用取得 Electron single-instance lock 后才初始化数据库，Main 持有唯一写连接并在退出时关闭。

打开连接后依次设置并回读验证：

```sql
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;
```

测试或只读诊断连接也必须启用外键并显式声明用途，不能被 Repository 复用为第二写连接。路径解析、目录创建和文件访问均位于 Adapter，任何符号链接或解析后越出受管理根的目标都被拒绝。

**被否决方案：** PostgreSQL 与当前单用户、离线、零服务安装约束不匹配；ORM 会弱化对 SQLite CHECK、partial index、trigger 和 migration 原文的审查；网络共享 SQLite 不在支持范围。

### 5. Migration 发现、版本判定与 checksum

打包资源中的生产 migration 先在内存中完成文件名、版本唯一性、从 1 连续递增和原始字节 SHA-256 校验，再允许数据库写入。migration SQL 使用 UTF-8，无 BOM 要求由测试固定；checksum 对文件原始字节计算，不做换行或空白归一化。

版本判定规则：

1. 无 `schema_migrations` 且无任何用户表：视为 version 0，可执行 `0001_initial.sql`。
2. 无 `schema_migrations` 但存在其他用户表：视为不可识别未版本化库，以 `DATABASE_UNVERSIONED_SCHEMA` 阻断，不猜测或接管。
3. 存在记录：逐行核对已应用版本连续性、名称和 checksum。
4. 数据库最高版本高于包内最高版本：`DATABASE_VERSION_TOO_NEW`，只读阻断。
5. `0001_initial.sql` 自身创建 `schema_migrations`，runner 在同一事务内随后插入版本 1 记录；后续 migration 同样在 SQL 成功后插入记录。

发布后的 migration 永不修改；修正只能新增下一编号文件。migration 资源必须被 Forge 明确包含，打包 Smoke 直接从 packaged executable 创建临时空库证明资源可解析。

**被否决方案：** 用 `PRAGMA user_version` 作为唯一事实源无法保存名称和 checksum；按规范化文本计算 hash 会让磁盘实际字节变化失去审计意义；发现缺口时跳号执行会产生不可重现结构。

### 6. `0001_initial.sql` 的边界

`0001_initial.sql` 按 TECH_DESIGN v1.1 §8.4 建立全部 V1 表，并落实 §8.5 明确要求的 FK、CHECK、partial unique、索引和不可变 UPDATE trigger。表、索引、trigger 使用确定名称；SQL 不依赖运行时字符串拼接，也不包含动态用户值。

DDL 负例测试覆盖非法父链可由 FK 表达的部分、重复 current、项目级/集级重复 stage head、Episode sequence、重复有效锁、枚举/CHECK、历史版本 UPDATE 和 JSON 基础合法性。TECH_DESIGN v1.1 §8.6 中需要当前 StoryBible、Schema 或 Application 事务语义的跨行规则只建立 audit 查询或后续实现接口，不在本 Change 中伪造为完整业务能力。

由于 `0001_initial.sql` 是数据库事实源，Apply 时必须逐项生成“TECH §8.4 表清单 → DDL 对象 → 约束测试”追踪表；若 TECH 示例和完整表语义冲突，停止实现并回报事实源冲突，不能静默选择。

### 7. 在线备份与 migration 事务

仅当源库已有至少一个已应用 migration 且存在待升级版本时创建升级备份。使用 SQLite online backup API 写入受管理 `backups` 目录下的临时文件，完成后打开临时备份、核对 `integrity_check`、`foreign_key_check` 和 schema version，再 flush/sync 并原子 rename 为最终文件；元数据包含 opaque id、源 schema version、目标 schema version、创建时间、数据库 SHA-256 和字节数。

若备份失败，不开启 migration 事务。验证通过后以 `BEGIN IMMEDIATE` 在一个短事务内执行本次全部待应用 SQL和对应 `schema_migrations` INSERT；任一步失败整体回滚。事务内不执行网络、用户文件操作或备份。提交后重新运行数据库 audit，audit 失败仍进入只读故障态并保留升级前备份，不自动反向执行 down migration。

**被否决方案：** 普通文件复制在 WAL 模式下可能得到不一致快照；逐 migration 独立提交会暴露半升级版本；自动执行 down migration 无法普遍保证数据无损。

### 8. 数据库 audit

启动 audit 分两层：

1. SQLite 层运行 `integrity_check` 和 `foreign_key_check`，明确收集全部失败行而非只看命令是否执行。
2. Application invariant audit 通过只读查询检查当前指针归属、父链直接性、Episode sequence、document hash、有效锁唯一性等当前 DDL 可验证项目；依赖 JSON Schema/StoryBible 解析的项目在对应后续 Change 接管前标记为 `NOT_IMPLEMENTED_BY_CURRENT_BUILD`，不得误报已验证。

audit 返回结构化 finding，仅内部日志记录对象 id、规则 id 和 hash；Renderer 只看到失败规则数量、稳定错误码和恢复建议。`integrity_check` 不能替代外键和应用级 audit。

### 9. 受控恢复协议

恢复只在 `READ_ONLY_FAULT` 且数据库连接已关闭时进行：

1. 重新验证 `backupId` 的路径仍位于受管理备份根，文件 hash、可打开性和 schema version 与清单一致。
2. 在 `backups/diagnostics/<operation-id>/` 保存当前数据库状态；可打开时优先使用 online backup，无法打开时关闭句柄后保存数据库、`-wal`、`-shm` 原始文件并生成 manifest。
3. 将验证过的备份复制到目标目录临时文件，flush/sync 后以可回退 rename 替换数据库；替换前原文件保持在诊断目录。
4. 重新打开数据库，从 `DATABASE_OPEN` 开始执行完整启动流程；若失败，保持 `READ_ONLY_FAULT`，保留原文件、备份、诊断副本和操作 manifest。

实现不得自动删除备份和诊断副本；空间治理需后续独立 Change。任何文件移动/替换前都对解析后的绝对路径做受管理根校验，并以操作级互斥防止并发恢复。

### 10. 错误码

| 错误码                        | 阶段                |                可重试 |   允许恢复 |
| ----------------------------- | ------------------- | --------------------: | ---------: |
| `DATABASE_OPEN_FAILED`        | DATABASE_OPEN       |                    是 | 视备份而定 |
| `DATABASE_PRAGMA_FAILED`      | CONNECTION_BASELINE |                    是 |         否 |
| `MIGRATION_SEQUENCE_INVALID`  | MIGRATION           |      否，需修复应用包 |         否 |
| `MIGRATION_CHECKSUM_MISMATCH` | MIGRATION           | 否，需修复应用包/版本 |         否 |
| `DATABASE_UNVERSIONED_SCHEMA` | MIGRATION           |                    否 |         否 |
| `DATABASE_VERSION_TOO_NEW`    | MIGRATION           |        否，需升级应用 |         否 |
| `DATABASE_BACKUP_FAILED`      | MIGRATION           |                    是 |         否 |
| `MIGRATION_APPLY_FAILED`      | MIGRATION           |          是，保留旧库 |       可选 |
| `DATABASE_INVARIANT_FAILED`   | DATABASE_AUDIT      |            视规则而定 |         是 |
| `BACKUP_NOT_ALLOWED`          | RECOVERY_GATE       |                    否 |         否 |
| `DATABASE_RESTORE_FAILED`     | RECOVERY_GATE       |                    是 |         是 |
| `STARTUP_STATE_CONFLICT`      | 任一 Command        |          是，刷新状态 |         否 |

SQLite 原始 code、SQL、路径和堆栈只进入受限内部证据并经过路径及内容脱敏；普通日志不记录完整数据库异常对象。

### 11. 测试分层与打包验证

- **Unit**：migration 文件名/顺序/hash、状态机、错误映射、受管理路径、备份清单和 command 幂等。
- **Contract**：Zod DTO、逐方法 Preload 白名单、禁止任意路径/通用 IPC、错误 DTO 脱敏。
- **Integration**：每个测试使用临时目录和独立 SQLite；覆盖空库、重复启动、全量 DDL、约束负例、上一版本、100+ 历史版本、备份失败、事务回滚、版本过高、checksum 漂移、损坏库及恢复矩阵。
- **E2E**：强制故障 Fixture 启动 Electron，验证独立故障页、正常导航被阻断、重试/恢复状态和 Renderer 隔离；正常 Fixture 验证 READY 后进入基线界面。
- **Package Smoke**：Windows x64 打包产物在临时数据根运行，证明 `better-sqlite3` native binary 可加载、migration SQL 被包含且能创建空库。native `.node` 文件必须位于 asar 可加载位置，具体 Forge 配置由测试锁定，不能用伪造 `path.txt` 绕过。

单元测试不得读取真实 `%LOCALAPPDATA%`，时间、ID、hash 输入、磁盘错误和 backup API 均可注入。测试数据不得包含真实用户内容或凭据。

## Risks / Trade-offs

- **[完整 `0001_initial.sql` 范围大，容易漏约束]** → 建立 TECH §8.4 逐表追踪表、DDL introspection 快照和单一错误负例 Fixture；Verify 对照 TECH §8.5/§8.6。
- **[`better-sqlite3` 与 Electron ABI/Forge alpha 不兼容]** → 依赖精确锁定，安装后执行 native rebuild，并把 packaged executable 空库启动纳入门禁；失败不得退回纯 JS 非等价驱动。
- **[升级备份占用磁盘导致启动失败]** → 预检空间和写权限，失败保持旧库不变并提供可行动错误；本 Change 不自动清理历史证据。
- **[单事务执行多个 migration 可能持锁较久]** → migration 禁止网络和长文件操作，压力库记录时长；V1 单机启动期间不开放业务写入。
- **[损坏库无法通过 SQLite API 生成诊断快照]** → 关闭句柄后保留数据库/WAL/SHM 原始三件套及 manifest，绝不覆盖唯一副本。
- **[只读故障页扩大 IPC 攻击面]** → 仅三个固定方法、sender/Zod/状态/revision 四重校验，Renderer 只能使用 opaque backup id。
- **[Application invariant audit 尚依赖后续业务契约]** → 明确区分已执行、失败和当前构建未实现的规则；不把部分 audit 声称为业务完整性通过。

## Migration Plan

1. 先提交失败测试和临时数据库 Fixture，证明当前仓库缺少持久化运行时。
2. 精确锁定并验证 Electron 43 兼容的 `better-sqlite3`/类型依赖，配置 native rebuild 与打包解包规则。
3. 落地 Application Port、启动状态机、SQLite 连接和 migration runner，再生成并逐表验证 `0001_initial.sql`。
4. 落地在线备份、数据库 audit、受控恢复、错误归一化和 Main 写入门。
5. 最后接入类型化 IPC、Preload 和只读故障页；运行全部工程门禁、数据库矩阵、E2E 和 Windows package Smoke。

当前产品尚未发布，无线上数据库需要迁移。开发回滚通过撤销本 Change 代码并删除测试临时目录完成；不得删除或改写任何人工创建的真实数据库。Change 合并后，`0001_initial.sql` 视为已发布 migration，后续修正只能新增 migration，不能修改原文件。
