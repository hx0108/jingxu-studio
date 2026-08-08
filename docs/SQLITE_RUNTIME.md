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

本 Change 只建立 SQLite 运行时、migration、备份、自检和恢复。它不实现 Project、Repository、UnitOfWork、Schema Registry、Provider、剧本或分镜业务用例。

## 启动写入门

`StartupService` 通过 `PersistenceRuntimePort` 串行执行以下阶段：

1. `DATABASE_OPEN`
2. `CONNECTION_BASELINE`
3. `MIGRATION`
4. `DATABASE_AUDIT`
5. `RECOVERY_GATE`

只有五个阶段全部通过才进入 `READY` 并开放全局写入。任一失败都会关闭连接、返回稳定错误码和脱敏摘要，并保持 `READ_ONLY_FAULT`；原始 SQLite 错误、SQL、绝对路径和堆栈不会进入公开 DTO。

## 升级备份

- 全新 version 0 数据库直接执行初始 migration，不创建无内容备份。
- 已有数据库存在待执行 migration 时，先使用 SQLite online backup 写入临时文件；完成可打开性、`integrity_check`、schema version、字节数和 SHA-256 验证并 flush/sync 后，再原子发布数据库文件和 manifest。
- 备份目录、API 或验证任一失败时返回 `DATABASE_BACKUP_FAILED`，不开始 migration。
- 备份清单只返回通过 opaque id、受管理根、普通文件、hash、版本和完整性复检的条目。

## 自检与恢复

- 当前构建执行 `integrity_check`、`foreign_key_check`、Shot/Episode current pointer 所有权检查；依赖后续 Schema Registry 或业务服务的规则明确标记为 `NOT_IMPLEMENTED_BY_CURRENT_BUILD`，不冒充已验证。
- 恢复只接受 Main 已登记的 opaque backup id，不接受 Renderer 提交的文件路径。
- 替换前优先生成当前库的 online diagnostic snapshot，并在关闭连接后保留数据库、WAL、SHM 原始证据和 operation manifest。
- 备份通过临时文件与可回退 rename 替换；随后从数据库打开阶段重跑完整自检。重新打开或任一自检失败统一返回 `DATABASE_RESTORE_FAILED`，继续保持只读故障。
- 当前 Change 不自动删除或覆盖备份、诊断目录，也不把 V1 JSON 交换文件当作数据库备份。
