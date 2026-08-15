# Tasks — backup-sidecar-hygiene

- [x] 1.1 `backup-manager.ts`：`verifyBackupDatabase` 的 `finally` 在 `close()` 后 best-effort 清理四个后缀 `-shm`/`-wal`/`.tmp-shm`/`.tmp-wal`（同步 `rmSync` + `force`，吞清理异常；创建期 .tmp 路径与启动校验最终路径同一点位覆盖，历史 `.tmp` 孤儿一并自愈）
- [x] 1.2 Integration 回归钉：WAL 源库备份创建 + 预置两类存量残留 → `listVerifiedBackups` 校验后 `backups` 目录恰好只余 `.sqlite`+`.manifest.json`（自愈语义）→ 7/7 绿
- [x] 1.3 全量门禁（format:check/lint/tsc 零错误；Unit 568/Contract 86/Integration 169/E2E 8+1skip 全绿）+ README 验证证据行 + `openspec validate --strict` + Archive
