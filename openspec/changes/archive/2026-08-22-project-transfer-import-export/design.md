## Context

当前仓库已有 `ProjectTransferBundle 1.0.0`、离线 Schema Registry、不可变脚本/分镜版本链、`export_records`/`import_records` 表和单连接 Transaction Coordinator，但没有 Transfer Application Service、Transfer IPC 或导入导出页面。实现需遵守 PRD v1.4 §9.8、§13 与 TECH_DESIGN v1.1 §12、§16、§17、§19、§20。

## Goals / Non-Goals

**Goals:**

- 提供 CURRENT_ONLY JSON 快照的安全导出、staging 校验和双模式导入。
- 保持版本不可变、事务原子、路径隔离、错误脱敏和媒体缺失可见。
- 复用现有 Schema、Repository、记录表和事务协调器。

**Non-Goals:**

- 不升级 ProjectTransferBundle Schema。
- 不导出历史版本、SQLite/WAL/SHM 备份或媒体二进制。
- 不伪造 SourceInput/ConsentRecord，不自动恢复 Provider、图片、视频或 Job。
- 不执行网络请求，不实现云同步、合并编辑或跨设备协作。

## Decisions

### 1. Bundle contract

以 Registry 中的 `project-transfer-bundle/1.0.0` 为唯一公开交换契约。Bundle 只包含当前 Project Snapshot、StoryBible、四个 ScriptStage 输出和 EpisodeStoryboard；内部 Transfer DTO 不进入公开 Schema Registry。

### 2. Application boundaries

新增 Application-owned Transfer Service 和 Ports：只暴露 Bundle DTO、文件读写 Port、Schema/引用校验 Port、Transfer Repository/UnitOfWork Port；不暴露 Row、Statement、SQLite 连接或绝对路径。Main Composition Root 注入文件与持久化 Adapter。

### 3. File protocol

导入使用 Main 的 Open Dialog 和受管理文件读取；导出使用 Save Dialog、同目录临时文件、flush 后原子 rename。路径只在 Main/Adapter 内部存在，回执和 Renderer 只得到 Hash、大小、ID 和警告。默认拒绝覆盖，显式确认后使用 `CONFIRMED_OVERWRITE`。

### 4. Transaction protocol

文件选择、读取和写入发生在事务外。导出完成记录使用独立短事务；导入的 ID Mapping、业务版本、阶段头、依赖、审计、回执和 `import_records` 在同一 Transfer UnitOfWork 中提交。Transfer UnitOfWork 必须复用 runtime 级 FIFO coordinator，禁止嵌套 Project/Script/Job 事务。

### 5. Import identity

`NEW_PROJECT` 对 Project、Episode、版本和引用对象生成新 ID，并通过确定性 mapping 重写文档。`RETURN_TO_ORIGIN` 保留目标聚合身份但插入新的不可变当前版本，通过 Bundle 基线 Hash 和 expected head 做并发检查。两种模式都不 UPDATE 历史行。

### 6. Missing source and media

Bundle 不含 SourceInput/ConsentRecord 时，导入项目标记为 `IMPORTED_SNAPSHOT`，允许查看/编辑/导出但在重新生成前要求用户补充原始输入和数据处理确认。媒体只保留结构引用；缺失媒体产生 WARN，不创建替代文件、不重启任务。

### 7. Public IPC

新增 `transfer.exportProject` 与 `transfer.importProject`，Preload 逐方法冻结暴露，双端 Zod strict 校验，Main 校验 sender、READY 写门和 requestId singleflight。输出使用 AppResult，内部异常统一映射为稳定 Transfer 错误码。

### 8. Migration

先复用 0001 已有 `export_records`/`import_records` 和索引；只有真实集成测试证明无法表达 Transfer 幂等、Hash 或记录状态时，才新增不可变 `0016_*` migration。不得改写 0001–0015。

## Risks / Trade-offs

- [风险] CURRENT_ONLY 不包含历史和媒体，用户可能误解为完整备份 → UI、Bundle 元数据和导出警告明确快照边界。
- [风险] Bundle 缺少原始输入导致导入项目无法立即生成 → 使用 `IMPORTED_SNAPSHOT` 状态和重新确认门禁，不伪造原文。
- [风险] 跨对象 ID 重写遗漏引用 → 先建立全量 mapping，再运行正式 Schema、集合校验和引用扫描；任一失败整体回滚。
- [风险] 导入写入与现有 Project/Script UoW 交叉事务 → 仅使用 runtime 级 Transaction Coordinator，并加入并发/回滚集成测试。
- [风险] 文件覆盖或路径逃逸 → 系统对话框、目录范围校验、临时文件原子 rename 和默认拒绝覆盖。

## Migration Plan

1. 先实现无 migration 的 Adapter、Service 和集成测试。
2. 运行空库、现有 0015 库和 100+ 历史版本测试。
3. 若记录表能力不足，新增 `0016_*`，执行 checksum、升级、回滚和旧数据无损验证。
4. 完成全量门禁、OpenSpec Verify、Sync 和 Archive。

## Open Questions

无。所有会改变公开行为或任务拆分的决策已在本设计中锁定。
