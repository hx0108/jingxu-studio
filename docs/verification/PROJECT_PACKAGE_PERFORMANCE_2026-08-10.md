# Project/FormatProfile Package 与性能验证证据

验证日期：2026-08-10（Asia/Shanghai）
适用 Change：`project-format-profile-management`
环境：Windows x64、Node.js 22.16.0、Electron 43.3.0、pnpm 11.16.0、SQLite 使用运行时内置 `node:sqlite`

## Windows x64 Package Smoke

从已清理的 `apps/desktop/.vite` 与 `apps/desktop/out` 开始，使用 SHA-256 为
`18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9` 的官方 Electron
43.3.0 Windows x64 压缩包作为本地缓存，执行：

```text
electron-forge package --platform=win32 --arch=x64
node scripts/verify-packaged-project-smoke.mjs
```

结果：

- Forge Windows x64 package 成功，产物为 `apps/desktop/out/镜序 Studio-win32-x64/jingxu-studio.exe`。
- `resources/migrations` 同时包含真实 `0001_initial.sql` 与 `0002_project_command_receipts.sql`。
- 打包目录中外部 `.node` 文件数量为 0；未引入外部 SQLite native addon。
- Smoke 从临时数据根中的真实 v1 数据库启动，成功应用 0002，最终 migration 版本为 `[1, 2]`。
- 打包进程完成 Project `create → update → delete → restart → restore`；更新生成 FormatProfile v2，三个首轮 Command 各有唯一回执。
- `JINGXU_E2E_DATA_ROOT` 指向系统临时目录，单独设置的 `LOCALAPPDATA/JingxuStudio` trap 未被访问；未读取或写入真实用户项目目录。

Smoke 输出：

```json
{
  "migrationVersions": [1, 2],
  "nativeAddonCount": 0,
  "projectLifecycle": ["create", "update", "delete", "restart", "restore"],
  "userManagedRootAccessed": false
}
```

## Project create/update 性能

`project-performance.integration.test.ts` 在单一临时 SQLite 库和真实受管理项目目录上执行
30 轮 Project create 与 FormatProfile update。墙钟数值仅作为本机证据，不作为 flaky 门禁：

| 指标           |       P50 |       P95 |
| -------------- | --------: | --------: |
| Project create | 18.705 ms | 23.686 ms |
| Project update |  5.744 ms |  7.826 ms |
| 目录 prepare   | 12.879 ms | 15.425 ms |

对应确定性门禁由 `project-statement-budget.integration.test.ts` 提供：

- Create prepared statement 执行数：8，上限 10。
- Update prepared statement 执行数：13，上限 13。
- 目录 `prepare` 调用次数与 create 次数相同，事务深度始终为 0。
- UnitOfWork 结束后事务深度为 0。
- Project list SQL 必须包含参数化 `LIMIT ?`、使用 `updated_at DESC, id DESC` keyset，且不得包含 `OFFSET`。

最终 targeted 结果：2 个测试文件、2 个测试全部通过。性能值可能随硬件、杀毒软件和磁盘状态波动；不得据此删除、放宽或隔离确定性事务/SQL 门禁。
