# SQLite Runtime 实施基线

## Native 依赖兼容性

核验日期：2026-08-07。

- 项目锁定 Electron `43.3.0`、开发 Node.js `22.16.x` 和 pnpm `11.16.x`。
- `better-sqlite3 12.11.1` 支持 Node.js 20、22–26，与仓库 Node.js `22.16.x` 基线一致。该版本的官方 Release 提供 Node ABI 127 的 Windows x64 预编译包，但不提供 Electron ABI 148 的预编译包。
- Electron 的 native addon 必须针对 Electron 内置 Node ABI 重建；项目锁定 `@electron/rebuild 4.2.0`，其 Node.js 要求为 `>=22.12.0`。
- Electron 43.3.0 内置 Node.js 24.18.1，native module ABI 为 148；开发 Node.js 22.16.x 的 ABI 为 127。因此开发测试可以使用官方 Node 预编译包，Electron 打包仍必须通过 `@electron/rebuild` 和 Windows C++ 工具链生成 ABI 148 二进制，不能复用 Node ABI 127 的 `.node` 文件。
- Electron Forge 会在打包生命周期重建 native modules；`@electron-forge/plugin-auto-unpack-natives 8.0.0-alpha.10` 与当前 Forge 精确对齐，并将 native module 放入 `app.asar.unpacked`。
- 兼容性最终证据不是包元数据，而是 Windows x64 packaged executable 能真实加载 `better-sqlite3` 并创建空库。
- pnpm 的 `supportedArchitectures` 固定为 `win32/x64`，只安装 V1 发布目标所需的可选 native 包，不下载其他操作系统和 CPU 架构的二进制。

未采用 `better-sqlite3 13.0.3`：其官方 Release 没有预编译资产，在当前未安装 Windows C++ 工具链的环境中，开发依赖安装会退回源码编译并失败。未采用只存在于 GitHub Release、未发布到 npm 的 `12.11.2`，避免引入不能由 npm 注册表复现的依赖版本。

参考资料：

- <https://github.com/WiseLibs/better-sqlite3>
- <https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1>
- <https://packages.electronjs.org/rebuild/v4.2.0/index.html>
- <https://www.electronforge.io/config/plugins>
- <https://js.electronforge.io/modules/_electron_forge_plugin_auto_unpack_natives.html>
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
