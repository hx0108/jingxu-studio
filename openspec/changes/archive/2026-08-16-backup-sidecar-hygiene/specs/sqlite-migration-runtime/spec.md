# sqlite-migration-runtime Specification（Delta）

## MODIFIED Requirements

### Requirement: 已有数据库升级前必须生成一致备份

系统 MUST 在修改具有已应用 migration 的数据库前创建 SQLite 在线一致备份，并 SHALL 先验证备份可打开且其 schema version 与升级前源库一致；备份验证 MUST NOT 在受管理的 `backups` 目录留下 SQLite sidecar 文件（`-shm`/`-wal`，含临时 `.tmp` 变体）——每份备份 SHALL 恰好由 `.sqlite` 与 `.manifest.json` 两个文件构成。sidecar 清理为 best-effort，清理失败 MUST NOT 改变备份创建/校验的既有错误语义。备份失败时不得开始升级。

#### Scenario: 旧版本数据库升级前备份成功

- **GIVEN** 数据库已有至少一个已应用版本且存在待执行 migration
- **WHEN** 系统准备升级
- **THEN** 系统 SHALL 在受管理的 `backups` 目录生成唯一备份及元数据
- **THEN** 只有备份通过可打开性和版本核对后才 SHALL 开始 migration 事务

#### Scenario: 备份创建或验证失败

- **GIVEN** 已有数据库需要升级但备份目录不可写、备份 API 失败或备份验证不通过
- **WHEN** 系统执行升级前备份
- **THEN** 系统 MUST 以 `DATABASE_BACKUP_FAILED` 阻断启动
- **THEN** 原数据库及其 migration 记录 MUST 保持升级前状态

#### Scenario: 全新空库无需制造升级备份

- **GIVEN** 数据库为本次启动新建且不存在任何用户数据或已应用 migration
- **WHEN** 系统应用首个 migration
- **THEN** 系统 SHALL 允许直接初始化而不创建无内容备份

#### Scenario: 备份校验不残留 sidecar 文件

- **GIVEN** 备份创建流程对临时路径校验、或任一已存在备份被 readOnly 打开校验（含启动时的全量校验）
- **WHEN** 校验连接关闭
- **THEN** 系统 SHALL best-effort 移除该次打开产生或遗留的 `-shm`/`-wal` sidecar
- **THEN** `backups` 目录每份备份 SHALL 只余 `.sqlite` 与 `.manifest.json`
