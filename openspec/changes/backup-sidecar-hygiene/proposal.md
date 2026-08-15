## Why

备份校验路径以 readOnly 连接打开 SQLite 备份文件；WAL 模式下即使只读打开也会生成 `-shm`/`-wal` sidecar，且 readOnly 连接 close 时无法清理它们。两条路径都在受管理的 `backups` 目录留下持续累积的残留：

1. `createOnlineBackup` 在 rename 前对 `backup_*.sqlite.tmp` 做打开校验，产生的 `*.tmp-shm`/`*.tmp-wal` 在主文件 rename 后成为永久孤儿（开发机 2 天即积累 8 组）；
2. 每次启动 `listVerifiedBackups` 逐份 readOnly 校验最终备份，`backup_*.sqlite-shm` 被反复触碰并永久残留（mtime 晚于备份创建时间即每次启动重开）。

残留破坏了「每份备份恰好由 `.sqlite` 与 `.manifest.json` 构成」的目录布局不变量，且随启动次数与升级次数无界增长。属 `备份/诊断空间治理` 立项前必须先修的卫生缺陷（保留策略本身仍搁置，见 README 遗留登记）。

## What Changes

- `verifyBackupDatabase` 关闭校验连接后 best-effort 清理 `${path}-shm`/`${path}-wal`（对 `.tmp` 校验路径与最终备份路径通用）；清理失败不影响既有 `DATABASE_BACKUP_FAILED` / `BACKUP_NOT_ALLOWED` 错误语义。
- 存量残留无需清扫逻辑：启动即逐份校验全部备份，下一次启动自愈。
- Integration 钉死目录布局不变量：备份创建与校验后 `backups` 目录每份备份只余 `.sqlite` 与 `.manifest.json`，预置的存量 sidecar 在校验后消失。

## Capabilities

### Modified Capabilities

- `sqlite-migration-runtime`: 「已有数据库升级前必须生成一致备份」补 sidecar 不残留约束与新 Scenario（原有三 Scenario 不变）。

## Impact

- 代码：`packages/persistence/src/backup/backup-manager.ts`（单点修复）+ `backup-manager.integration.test.ts`。
- 不动：恢复路径在取证目录内产生的临时 sidecar（取证目录本身有意保留，记为观察项）；备份保留/清扫策略、诊断包与项目资产目录治理（待产品决策的独立 Change）。
- 风险：极低——清理为 best-effort，失败时行为等同现状（文件残留）。
