# SQLite Runtime 实施基线

## 内置运行时兼容性

核验日期：2026-08-08。

- 项目锁定 Electron `43.3.0`、开发 Node.js `22.16.x` 和 pnpm `11.16.x`。
- 开发与 Integration 使用 Node.js `22.16.x` 内置 `node:sqlite`；Electron E2E 和 Windows x64 packaged smoke 使用 Electron 43.3.0 内置 Node 的 `node:sqlite`。两类运行时都必须验证 `DatabaseSync`、prepared statement、显式事务、PRAGMA、SQLite JSON 函数和顶层 `backup()`。
- `packages/persistence/src/runtime/sqlite-database.ts` 是唯一生产适配边界。其他生产包不得直接持有 `DatabaseSync`、`StatementSync` 或拼装 PRAGMA；Renderer 仍不能接触 Node 或 SQLite。
- 事务使用显式 `BEGIN IMMEDIATE`、`COMMIT` 和失败 `ROLLBACK`；online backup 使用 `node:sqlite` 顶层 `backup(sourceDb, destination)`，不以数据库/WAL/SHM 的普通文件复制替代一致备份。
- `node:sqlite` 在当前 Node 文档中仍标记为 Active development，因此 Node 与 Electron 版本必须精确锁定，升级任一运行时都要重跑 Integration、Electron E2E 和 packaged smoke，不能仅凭 API 名称相同判定兼容。
- 项目不再依赖外部 SQLite native addon、`@electron/rebuild`、Forge native unpack 插件、Visual Studio 或 C++ Build Tools；产物不得包含手工放置的 SQLite `.node` 文件。
- pnpm 的 `supportedArchitectures` 仍固定为 `win32/x64`，只安装 V1 发布目标需要的其他工具依赖。

参考资料：

- <https://nodejs.org/docs/latest-v22.x/api/sqlite.html>
- <https://www.electronjs.org/docs/latest/api/process>
- <https://pnpm.io/settings/dependency-resolution#supportedarchitectures>

## 范围边界

`sqlite-migration-runtime` Change 建立了 SQLite 运行时、migration、备份、自检和恢复。后续 `project-format-profile-management` 已在该运行时上实现 Project/FormatProfile Repository、ProjectUnitOfWork 和 ProjectService，但没有改变启动写入门、备份或恢复的安全语义。

后续 `schema-registry-version-locks` 已在同一 SQLite 运行时上实现离线 Schema Registry 启动门和 manifest 成功证据。Active Change `staged-script-generation` 已在同一共享事务协调器上接入 SourceInput、Consent、Episode、剧本版本、StageHead、依赖、审计、Job/Invocation 和 Provider 持久化；EpisodeValidator、分镜、导入导出和评测仍未实现。代码存在不等于本 Change 已通过最终 clean package 或真实用户验收。

`0003_script_version_receipts.sql` 只修补项目级 Script versionNo 唯一性和 Script 命令回执枚举，不改写 `0001/0002`。升级仍使用在线备份、连续 checksum 和单事务 migration；打包验收脚本必须从 v1 样本库验证 `0001→0002→0003` 的实际应用集合。

## 启动写入门

`StartupService` 通过 `PersistenceRuntimePort` 串行执行以下阶段：

1. `DATABASE_OPEN`
2. `CONNECTION_BASELINE`
3. `MIGRATION`
4. `DATABASE_AUDIT`
5. `RECOVERY_GATE`
6. `SCHEMA_REGISTRY`

只有六个阶段全部通过才进入 `READY` 并开放全局写入。Persistence 阶段失败会关闭连接；Schema 阶段失败会保持已审计连接供幂等重试复用，但不构造 ProjectService、不发布 Registry且全局写门保持关闭。两类失败都只返回稳定错误码和脱敏摘要；原始 SQLite/Ajv 错误、SQL、绝对路径、Schema 原文和堆栈不会进入公开 DTO。

## 升级备份

- 全新 version 0 数据库直接执行初始 migration，不创建无内容备份。
- 已有数据库存在待执行 migration 时，先使用 SQLite online backup 写入临时文件；完成可打开性、`integrity_check`、schema version、字节数和 SHA-256 验证并 flush/sync 后，再原子发布数据库文件和 manifest。
- 备份目录、API 或验证任一失败时返回 `DATABASE_BACKUP_FAILED`，不开始 migration。
- 备份清单只返回通过 opaque id、受管理根、普通文件、hash、版本和完整性复检的条目。

## 自检与恢复

- 当前构建执行 `integrity_check`、`foreign_key_check`、Shot/Episode current pointer 所有权检查和 manifest 行结构检查；依赖后续业务版本服务的规则明确标记为 `NOT_IMPLEMENTED_BY_CURRENT_BUILD`，不冒充已验证。
- 恢复只接受 Main 已登记的 opaque backup id，不接受 Renderer 提交的文件路径。
- 替换前优先生成当前库的 online diagnostic snapshot，并在关闭连接后保留数据库、WAL、SHM 原始证据和 operation manifest。
- 备份通过临时文件与可回退 rename 替换；随后从数据库打开阶段重跑完整自检。重新打开或任一自检失败统一返回 `DATABASE_RESTORE_FAILED`，继续保持只读故障。
- 当前构建不自动删除或覆盖备份、诊断目录，也不把 V1 JSON 交换文件当作数据库备份。

## Project 持久化扩展

- Persistence Adapter 在数据库阶段通过后可持有 SQLite ProjectUnitOfWork；Main Composition Root 仍只在全局状态 `READY/writeEnabled=true` 后构造 ProjectService。Schema 故障即使连接可用也只注册 gate-only Project IPC，四个写命令返回 `STARTUP_WRITE_BLOCKED`。
- Project 写命令由 Application 层持有事务边界。Project、FormatProfile current/version、审计、本地分析事件和 `command_receipts` 在同一 `BEGIN IMMEDIATE` 中提交，Repository 不自行嵌套 commit。
- 项目目录准备发生在数据库事务外；创建失败时只清理由本次操作创建且仍为空的受管理目录，不递归删除预存或非空目录。
- `command_receipts` 支持 CREATE/UPDATE/DELETE/RESTORE 的安全幂等回放；相同 requestId 绑定不同命令或 payload hash 时返回稳定冲突，不重复审计或业务写入。
- 启动 invariant audit 已检查 Project current FormatProfile、版本父链/版本号、活动名称规范化冲突、receipt 安全引用和 manifest 行结构；依赖 StoryBible 或后续业务服务的规则继续标记为 `NOT_IMPLEMENTED_BY_CURRENT_BUILD`。

## Schema manifest 成功证据

- `V1_SCHEMA_LOCKS` 是四份资源的期望事实源；数据库旧行不能批准包内资源。
- 文件读取、SHA-256、身份、版本、引用闭包和 Ajv 编译发生在事务外。全部成功后，`SqliteSchemaManifestUnitOfWork` 在同一写连接执行短 `BEGIN IMMEDIATE`，精确替换 `schema_registry_manifest` 并读回对账。
- 删除、任一插入或读回故障都会回滚旧集合且保持 Registry 未发布；前置数据库 audit 不因合法旧 manifest 与新构建不同而提前阻断替换。
- Windows x64 packaged smoke 从 `resources/schemas/v1` 读取恰好四个普通文件，验证 Episode→Shot 与 Transfer→Script 引用链、manifest 四行、零外部 `.node` 和真实用户数据根零访问。
