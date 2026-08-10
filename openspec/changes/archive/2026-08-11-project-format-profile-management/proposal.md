## Why

`sqlite-migration-runtime` 已提供可写入的本地事实源和启动门，但 READY 后仍没有真实项目入口，用户无法完成 PRD v1.4 §9.1、§9.2、§9.5 和 §15.1 定义的首个 P0 操作。现在需要先落地 Project 与 FormatProfile 的确定性管理边界，为后续 Schema Registry、分阶段剧本和分镜能力提供稳定的项目上下文。

## What Changes

- 新增项目列表、详情、创建、元数据更新、软删除和恢复；创建命令原子保存 Project 与首个 current FormatProfile，并记录审计和本地 `project_created`/`dialogue_mode_selected` 事件。
- 项目创建必须选择创作模式、画幅和 DialogueRenderMode；默认 `9:16`、`NARRATION_FIRST`，V1 仅允许 1080×1920（9:16）或 1920×1080（16:9），帧率固定 30fps、语言固定 `zh-CN`。
- FormatProfile 修改始终插入新版本、保留父链，并在同一短事务切换唯一 current；当前构建发现已存在下游 ShotContractVersion 依赖时先稳定阻断，不提前实现后续 Change 的 STALE_INPUT 传播。
- 新增 Application 层 `ProjectService`、持久化/文件 Port、SQLite Repository/UnitOfWork 实现、受管理项目目录 Adapter，以及 `project.list/get/create/update/delete/restore` 六个类型化 IPC。
- READY 后渲染真实“项目列表与创作设定”页面，覆盖加载、空、字段错误、名称冲突、目录不可写、成功、dirty 离开确认、软删除和恢复状态；所有保存结果以 Main 事务提交为准。
- 所有 Command 使用 `requestId`；更新、删除和恢复使用 `expectedUpdatedAt`，重复请求幂等，陈旧写入返回稳定冲突错误。
- 不修改四份 PRD-owned Schema 或已发布 `0001_initial.sql`；追加 `0002_project_command_receipts.sql` 建立不含用户内容的通用 Command 幂等回执表，并同步 TECH_DESIGN v1.1 的表清单。

### 非目标

- 不实现 SourceInput、Consent、Episode、StoryBible、ScriptVersion、Schema Registry、JobRunner、Qwen/Provider 或 API Key。
- 不实现真实模型调用、剧本/分镜生成、导入导出、跨项目复制或永久删除项目目录。
- 不实现图片、视频、TTS、口型、成片、账号、云同步或其他 V2/V3 能力。
- 不允许通过 UI 将 `deployment_mode` 切到 `CONTROLLED_EXTERNAL_TEST` 或 `PUBLIC_ONLINE`；本 Change 创建的项目固定为 `LOCAL_DEMO`。

## Capabilities

### New Capabilities

- `project-format-profile-management`: 定义本地 Project 与版本化 FormatProfile 的创建、查询、更新、软删除/恢复、并发、IPC、安全和页面状态行为。

### Modified Capabilities

无。

## Impact

- **产品与验收**：映射 PRD v1.4 §9.1（V1 规格与画面配置）、§9.2（创作模式）、§9.5（项目级 DialogueRenderMode）、§13（Project/FormatProfile 数据模型）、§15.1（项目列表与创作设定页面状态）、§16.1（本地事件）、§17.2（删除边界）以及 AC-V1-01 的项目前置步骤；不声称 AC-V1-01 已完成。
- **架构**：落实 TECH_DESIGN v1.1 §3.3 `ProjectService`、§4.3.3 Application Ports、§4.3.4 幂等/乐观并发/短事务、§8.4.2 Project/FormatProfile、§11 `project` IPC、§13.1 Electron 安全和 §15 性能边界。
- **数据库**：使用现有 `projects`、`format_profiles`、`audit_events`、`analytics_events` 表，并通过新 migration 增加 `command_receipts`；版本行内容不覆盖，删除 Project 仅更新聚合 `deleted_at`，不修改 `0001_initial.sql`。
- **IPC 与进程**：Renderer 只获得逐方法、Zod 校验的 Project DTO；Main 校验 sender 并注入 Application Service；路径、SQL、连接和内部错误不进入 Renderer。
- **文件与安全**：项目目录由 Main 从系统管理根和 `project_id` 派生，Renderer 不提交路径；目录不可写时不产生项目记录，删除仅软删除数据库聚合且不静默删除用户文件。
- **兼容性**：新能力仅新增接口和数据；现有 SQLite 数据库和 `sqlite-migration-runtime` 主规范语义保持兼容，PRD 与四份业务 Schema 不变。
