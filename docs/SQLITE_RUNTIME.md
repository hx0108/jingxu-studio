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
