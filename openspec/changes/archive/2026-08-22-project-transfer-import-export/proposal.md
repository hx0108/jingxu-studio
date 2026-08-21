## Why

镜序 Studio 已能生成和编辑剧本、分镜及媒体引用，但当前项目只能留在本机数据库中，无法安全迁移、备份快照或交付给另一份本地工作区。现在补齐基于既有 `ProjectTransferBundle 1.0.0` 的 CURRENT_ONLY 导入导出，可以在不引入云同步和数据库备份的前提下完成项目级交付闭环。

## What Changes

- 新增 ProjectTransferBundle 1.0.0 的当前快照导出与 staging 导入。
- 支持 `NEW_PROJECT` 和 `RETURN_TO_ORIGIN` 两种导入模式，均采用不可变版本和事务回滚。
- 通过系统 Open/Save Dialog 读写 JSON，Renderer 不接触绝对路径、SQL 或数据库连接。
- 复用 `export_records`、`import_records` 和现有单连接 Transaction Coordinator；只有发现结构缺口时才新增 migration。
- 对跨对象引用、Schema、Hash、项目归属、版本头和媒体引用执行确定性校验。
- 不导出历史版本、SQLite 备份、API Key、图片/视频二进制，不自动重启媒体任务。
- 导入项目不伪造 SourceInput/ConsentRecord；导入后作为 `IMPORTED_SNAPSHOT`，继续 AI 生成前要求用户补充原始输入和数据处理确认。

## Capabilities

### New Capabilities

- `project-transfer-import-export`: 提供 ProjectTransferBundle 快照导出、staging 导入、双模式恢复、冲突校验、媒体缺失警告以及白名单 IPC/UI。

### Modified Capabilities

- 无。

## Impact

- Application：新增 Transfer Service、Bundle 组装/校验、ID Mapping 和 Transfer UnitOfWork。
- Persistence：新增 Transfer Repository/审计适配，优先复用 `export_records`、`import_records`，必要时新增 `0016_*`。
- Contracts/Main/Preload/Renderer：新增 `transfer.exportProject` 和 `transfer.importProject`，使用 strict DTO 与脱敏 AppResult。
- Validation：复用离线 ProjectTransferBundle、ScriptStageOutput、ShotContract 和 EpisodeStoryboardExport Schema。
- 测试：新增 Unit、Contract、Integration、Electron E2E 与 packaged smoke 覆盖。
- 事实源映射：PRD v1.4 §9.8、§13；TECH_DESIGN v1.1 §12、§16、§17、§19、§20；`镜序Studio_V1_ProjectTransferBundle.schema.json`；`E2E-AC03-EDIT-ROUNDTRIP`。
