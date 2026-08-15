# Tasks — backup-sidecar-hygiene

- [ ] 1.1 `backup-manager.ts`：`verifyBackupDatabase` 的 `finally` 在 `close()` 后 best-effort 清理 `${databasePath}-shm`/`${databasePath}-wal`（同步 `rmSync` + `force`，吞清理异常；`.tmp` 校验与最终备份路径同一点位覆盖）→ verify: 单测/集成断言目录无 sidecar
- [ ] 1.2 Integration 回归钉：`createOnlineBackup` 后 `backups` 目录仅含 `.sqlite`+`.manifest.json`（无 `*.tmp-*`）；`getVerifiedBackup` 校验后无 `-shm`/`-wal`；预置存量 sidecar（模拟历史残留）→ `listVerifiedBackups` 后消失（自愈语义）→ verify: integration 套件绿
- [ ] 1.3 全量门禁（format:check/lint/tsc/unit/contract/integration/e2e）+ README 验证证据行 + `openspec validate --strict` + Archive
