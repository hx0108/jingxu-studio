## 1. 依赖、边界与测试底座

- [ ] 1.1 依据 Electron 43、Node 22、pnpm 11 和当前 Forge 配置核验 `better-sqlite3` 的官方兼容性与 native rebuild 要求，记录来源后精确锁定运行/类型依赖；不得降低 pnpm 安全策略或伪造 native 安装结果。（Design §11）
- [ ] 1.2 先添加跨包依赖规则测试，再创建 `packages/application` 与 `packages/persistence` 的最小 package/tsconfig/public entry，证明 Application 不依赖 persistence、Domain 不依赖 SQLite、Renderer 不导入基础设施。（Design §1）
- [ ] 1.3 建立只使用任务临时目录的 SQLite 测试工具，注入固定时间、ID、hash 输入和故障点，并添加测试证明任何 Unit/Integration 测试都不会读取真实 `%LOCALAPPDATA%`。（Design §11）
- [ ] 1.4 建立空库、上一版本库、100+ 历史版本压力库、损坏库和单一错误 migration Fixture 的生成/校验入口，保证 Fixture 可重现且不含用户内容或凭据。（R: Migration 失败必须原子回滚 / 压力库升级成功）

## 2. Application Port、状态机与公开契约

- [ ] 2.1 先添加 Unit 测试覆盖 `BOOTING/CHECKING/READY/READ_ONLY_FAULT/RESTORING` 合法转换、revision 单调递增、非 READY 时写入门关闭和非法转换失败。（R: 启动自检必须控制全局写入权限 / 全部数据库启动检查通过）
- [ ] 2.2 先添加 Unit 测试覆盖 `retry`/`restore` 串行化、重复 `requestId` 幂等和过期 `expectedRevision` 返回 `STARTUP_STATE_CONFLICT`，不得并行执行迁移或恢复。（Design §2）
- [ ] 2.3 在 `packages/application/src/ports/persistence/` 定义带简短 TSDoc 的 `PersistenceRuntimePort`，并实现不导入 SQLite 类型的 `StartupService`、状态机和全局写入门，使 2.1–2.2 测试通过。（Design §1–§2）
- [ ] 2.4 先添加 Contract 测试，再在 `packages/contracts` 定义三个 `runtime` 方法的 Zod DTO/类型；验证错误状态可行动且不含 SQL、堆栈、绝对路径、连接、密钥或用户内容。（R: 启动自检必须控制全局写入权限 / 故障信息保持脱敏且可行动）

## 3. 受管理路径与 SQLite 连接基线

- [ ] 3.1 先添加 Unit 测试覆盖生产根派生、测试根注入、父目录创建、符号链接/路径逃逸拒绝和 opaque backup id 解析，确保 Renderer 无法控制任意路径。（R: 数据库恢复必须保留诊断证据并可失败回退 / 恢复源不在受管理清单）
- [ ] 3.2 先添加 Integration 测试验证新安装创建数据库、Main 唯一写连接和 `foreign_keys=ON`、WAL、`synchronous=FULL`、`busy_timeout=5000` 的设置及回读结果。（R: 本地数据库连接必须满足固定安全基线 / 新安装创建本地数据库）
- [ ] 3.3 添加可注入 PRAGMA 失败测试，断言返回 `DATABASE_PRAGMA_FAILED`、数据库不进入可写状态且 migration 未执行。（R: 本地数据库连接必须满足固定安全基线 / 连接基线无法生效）
- [ ] 3.4 实现 persistence 受管理目录、连接工厂、连接生命周期和异常归一化，由 Composition Root 在取得 Electron single-instance lock 后创建唯一写连接，使 3.1–3.3 通过。（Design §4）

## 4. Migration 发现、版本与 checksum

- [ ] 4.1 先添加 Unit 测试覆盖合法文件名、UTF-8/no-BOM、从 1 连续递增、重复版本、编号缺口、非法名称和基于原始字节的 SHA-256；错误集合统一映射 `MIGRATION_SEQUENCE_INVALID`。（R: Migration 必须严格顺序且可重现 / Migration 集合存在缺口或重复版本）
- [ ] 4.2 先添加 Integration 测试覆盖空库应用 migration、记录版本/名称/hash/时间及第二次启动完全跳过已应用 SQL。（R: Migration 必须严格顺序且可重现 / 空库应用初始 migration、重复启动跳过已应用 migration）
- [ ] 4.3 先添加 Integration 测试覆盖已应用文件名称/hash 漂移，断言 `MIGRATION_CHECKSUM_MISMATCH` 且历史记录和 schema 均不变。（R: Migration 必须严格顺序且可重现 / 已应用 migration 发生漂移）
- [ ] 4.4 先添加 Integration 测试覆盖高版本库与存在用户表但缺失 `schema_migrations` 的未版本化库，分别返回 `DATABASE_VERSION_TOO_NEW` 与 `DATABASE_UNVERSIONED_SCHEMA` 且零写入。（R: Migration 必须严格顺序且可重现 / 数据库版本高于当前应用；Design §5）
- [ ] 4.5 实现 migration 资源加载、集合预检、版本判定、已应用记录核对和待执行计划，使 4.1–4.4 通过；不得使用 `PRAGMA user_version` 替代 `schema_migrations`。（Design §5）

## 5. 完整 `0001_initial.sql` 与数据库约束

- [ ] 5.1 根据 TECH_DESIGN v1.1 §8.4 建立“表/索引/trigger → DDL → 测试”追踪清单，并先添加 introspection 测试，要求全部登记表和确定命名对象存在。（R: 初始数据库结构必须落实 V1 持久化约束 / 初始结构在空库完整创建）
- [ ] 5.2 先为系统配置、Provider 快照和 Prompt 表添加 FK/CHECK/unique/json_valid 负例测试，再补 `0001_initial.sql` 对应 DDL；凭据列只允许不透明 `credential_ref`。（Design §6）
- [ ] 5.3 先为 Project、FormatProfile、SourceInput、Consent、Episode、StoryBible/Script/StageHead 表添加外键、版本唯一、current partial unique、项目级/集级 stage head 和 JSON 基础合法性负例，再补对应 DDL。（R: 初始数据库结构必须落实 V1 持久化约束 / 数据库约束拒绝非法关系）
- [ ] 5.4 先为 Job、Invocation、Lock、Dependency、Audit 表添加枚举、幂等键、复合边和有效锁 partial unique 负例，再补对应 DDL；测试证明日志/审计列不要求保存密钥或完整 Prompt。（Design §6）
- [ ] 5.5 先为 Shot、ShotContractVersion、Derivation、Producibility 表添加 sequence、版本唯一、枚举、COPY/SPLIT/MERGE 可由 DDL 表达部分的负例，再补对应 DDL。（R: 初始数据库结构必须落实 V1 持久化约束 / 数据库约束拒绝非法关系）
- [ ] 5.6 先为 Import/Export、Evaluation 和本地 Analytics 表添加状态、唯一键、json_valid 和必要索引负例，再补对应 DDL，且不实现业务导入导出方法。（Design §6 Non-Goals）
- [ ] 5.7 先添加 StoryBible、Script、EpisodeVersion 和 ShotContractVersion 原地 UPDATE 失败测试，再建立不可变 trigger；确认允许通过 INSERT 新版本而非关闭 trigger。（R: 初始数据库结构必须落实 V1 持久化约束 / 历史版本不能原地更新）
- [ ] 5.8 在空库执行完整 `0001_initial.sql`，断言所有追踪项存在、`schema_migrations` 版本 1 正确、`foreign_key_check` 零违规，并让所有单一错误负例保持互相独立。（R: 初始数据库结构必须落实 V1 持久化约束 / 初始结构在空库完整创建）

## 6. 在线备份与原子升级

- [ ] 6.1 先添加 Integration 测试：已有版本且存在待执行 migration 时，在线备份先于任何 DDL，备份位于受管理目录、可打开、schema version 一致且 manifest/hash/字节数完整。（R: 已有数据库升级前必须生成一致备份 / 旧版本数据库升级前备份成功）
- [ ] 6.2 先添加备份目录不可写、backup API 失败和备份验证失败测试，断言 `DATABASE_BACKUP_FAILED` 且源库 schema/数据/migration 记录不变。（R: 已有数据库升级前必须生成一致备份 / 备份创建或验证失败）
- [ ] 6.3 添加全新空库初始化测试，证明 version 0 不生成无内容升级备份，但仍执行完整初始 migration 与 audit。（R: 已有数据库升级前必须生成一致备份 / 全新空库无需制造升级备份）
- [ ] 6.4 实现 SQLite online backup、临时文件验证、flush/sync、原子 rename 和 manifest，使 6.1–6.3 通过；禁止 WAL 模式下用普通复制冒充一致备份。（Design §7）
- [ ] 6.5 先添加多个待执行 migration 的中间失败测试，断言单一 `BEGIN IMMEDIATE` 回滚全部 DDL 和版本记录并返回 `MIGRATION_APPLY_FAILED`。（R: Migration 失败必须原子回滚 / 中间 migration 执行失败）
- [ ] 6.6 实现全部待执行 SQL 与 `schema_migrations` INSERT 的单事务提交，并验证事务内没有备份、网络或长文件操作。（Design §7）
- [ ] 6.7 使用 100+ 历史版本 Fixture 完成升级演练，对账行数、document hash、父链、完整性和外键；记录执行时长但不以删除数据换取性能。（R: Migration 失败必须原子回滚 / 压力库升级成功）

## 7. 启动 audit 与故障归一化

- [ ] 7.1 先添加 Integration 测试覆盖 `integrity_check`、`foreign_key_check` 和可由当前 DDL 查询的 Application invariant audit，证明任一失败都关闭写入门且不会自动创建新库。（R: 启动自检必须控制全局写入权限 / 数据库损坏或检查失败）
- [ ] 7.2 实现结构化 audit finding，明确区分 `PASS/FAIL/NOT_IMPLEMENTED_BY_CURRENT_BUILD`；依赖后续 Schema/StoryBible 的规则不得被记录为已验证。（Design §8）
- [ ] 7.3 实现 `DATABASE_OPEN_FAILED`、`DATABASE_PRAGMA_FAILED`、migration、backup、audit、restore 和 state conflict 错误映射，并添加 Unit 测试证明 SQLite 原始错误、SQL、路径和堆栈不进入公开 DTO/普通日志。（Design §10）
- [ ] 7.4 将数据库打开、连接基线、migration、audit、recovery gate 接入 `StartupService`，添加 Integration 测试证明只有全部阶段通过才进入 `READY`。（R: 启动自检必须控制全局写入权限 / 全部数据库启动检查通过）

## 8. 受控恢复

- [ ] 8.1 先添加 Unit/Integration 测试覆盖备份清单扫描、opaque id、受管理根、hash/版本复检和伪造 id/路径拒绝，断言 `BACKUP_NOT_ALLOWED` 且零文件访问副作用。（R: 数据库恢复必须保留诊断证据并可失败回退 / 恢复源不在受管理清单）
- [ ] 8.2 先添加恢复成功测试，证明连接关闭、当前 DB/WAL/SHM 诊断证据先保存、备份原子替换、完整自检重跑且仅通过后进入 `READY`。（R: 数据库恢复必须保留诊断证据并可失败回退 / 从有效备份恢复成功）
- [ ] 8.3 先添加替换、重新打开和自检失败测试，断言 `DATABASE_RESTORE_FAILED`、保持只读故障，并保留原库、备份、诊断副本和操作 manifest。（R: 数据库恢复必须保留诊断证据并可失败回退 / 恢复过程中失败）
- [ ] 8.4 实现操作级互斥、诊断快照/原始三件套保存、临时恢复文件、可回退 rename 和完整重检，使 8.1–8.3 通过；不得自动删除或覆盖备份/诊断文件。（R: 数据库恢复必须保留诊断证据并可失败回退 / 备份与诊断副本不被静默清理）

## 9. Main IPC、Preload 与只读故障页

- [ ] 9.1 先添加 Contract 测试覆盖 `runtime.getStartupStatus`、`runtime.retryStartup`、`runtime.restoreBackup` 的 sender、Zod、状态、requestId/revision 校验，以及 Preload 无通用 `send/on/invoke`、无路径/SQL/连接暴露。（R: 本地数据库连接必须满足固定安全基线 / Renderer 尝试越过持久化边界）
- [ ] 9.2 在 Main 注册三个固定 IPC 并由 Composition Root 注入 `StartupService`，更新冻结的 `window.jingxu` 类型化白名单，使 9.1 通过。（Design §3）
- [ ] 9.3 先添加 Renderer 组件测试，再实现独立只读故障页：显示检查阶段、稳定错误码、脱敏摘要、重试和受控备份恢复；非 READY 时不渲染正常导航或伪造业务入口。（R: 启动自检必须控制全局写入权限 / 故障信息保持脱敏且可行动）
- [ ] 9.4 添加重试流程测试，证明 `runtime.retryStartup` 从 `DATABASE_OPEN` 开始完整重检，成功才离开故障页，失败保留上次结果和可执行动作。（R: 启动自检必须控制全局写入权限 / 用户在故障页重试）
- [ ] 9.5 添加 Playwright Electron E2E：正常临时根进入 READY 基线；故障 Fixture 进入只读故障页并阻断正常导航；伪造恢复源被拒绝；Renderer 仍无 Node/SQLite/通用 IPC 权限。（R: 启动自检必须控制全局写入权限；R: 数据库恢复必须保留诊断证据并可失败回退）

## 10. 打包、文档与最终验证

- [ ] 10.1 配置 Forge native rebuild、`.node` 可加载位置和 migration SQL 资源包含规则，并添加资源清单测试，禁止通过伪造 Electron `path.txt` 或跳过安装脚本制造成功。（Design §11）
- [ ] 10.2 从干净 `.vite/out` 状态执行 Windows x64 打包，以注入的临时数据根启动 packaged executable，验证 native SQLite 可加载、空库完成 `0001_initial.sql`、故障页资源可用且真实用户目录未被访问。（Design §11 Package Smoke）
- [ ] 10.3 更新 README 的数据库位置、启动状态、备份/恢复边界、开发验证命令和“V1 JSON 不等于完整备份”说明；若实现发现 PRD/TECH/Schema 冲突，停止并记录冲突，不静默修改事实源。（Proposal Impact）
- [ ] 10.4 运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:contract`、`pnpm test:integration`、`pnpm test:e2e` 和 `pnpm package:win`，记录每类实际通过/失败数量及未验证项。（AGENTS.md §15）
- [ ] 10.5 使用 `$openspec-verify-change` 核对全部 Requirement/Scenario、TECH §8.4 DDL 追踪和打包证据；阻断问题清零后才能 Sync/Archive，且不得声称 Project、Schema Registry、JobRunner 或 AC-V1-01 至 AC-V1-06 已完成。（OpenSpec archive guidance）
