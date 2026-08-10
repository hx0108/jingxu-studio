## Why

Project 与 FormatProfile 已具备可运行基线，但正式业务 JSON 尚没有可执行的离线契约入口；若继续开发 JobRunner、剧本、分镜或导入导出，各模块将自行读取 Schema、解释 `$ref` 和版本，导致机器契约漂移，并可能在断网或打包资源异常时产生不一致结果。根据 PRD v1.4 §9.7.2、§15.1 和 TECH_DESIGN v1.1 §7.2、§16，需要先把四份 PRD-owned Schema 固定为可校验、可审计、启动失败即只读的本地 Registry。

## What Changes

- 新增只读离线 Schema Registry：以四份 PRD-owned Schema 的 `$id` 为唯一查找键，只从随应用发布的 `resources/schemas/v1/` 解析，不访问 `jingxu.studio` 或其他网络地址。
- 固定每份 Schema 的 Draft 2020-12、语义版本、资源路径和 SHA-256；启动时对文件存在性、UTF-8 JSON、`$id`、Draft、`schema_version`、hash、重复 ID 和相互 `$ref` 做全量自检。
- 使用 Ajv 2020 编译正式业务 Schema，并提供统一的校验结果与稳定、脱敏错误；Ajv 负责 JSON Schema，Zod 继续只负责 IPC DTO。
- 为四份正式 Schema 分别提供合法 Fixture 和只含一个预期错误的非法 Fixture；Contract Test 必须在断网条件完成根 Schema 与跨 Schema `$ref` 校验。
- 将 Schema 资源和版本锁清单纳入 Electron Forge 打包及 packaged smoke；开发态与打包态必须使用同一份逻辑清单，并证明资源未被改写。
- 把 Schema Registry 自检接入既有启动状态机：任一资源或锁不一致进入独立 `READ_ONLY_FAULT`，阻断 Project 写入、后续 Job、导入和导出；重试必须重新执行完整 Schema 自检，全部通过后才恢复 `READY`。
- 记录当前 `schema_registry_manifest` 表与静态版本锁的职责：V1 的权威期望值来自随代码发布的不可变清单，SQLite 行仅保存当前应用成功核验的本地证据，不允许用数据库值覆盖包内期望值。
- 明确非目标：不修改四份业务 Schema 正文，不实现 Episode 集合级业务不变量、ProjectTransfer 导入导出、JobRunner、Qwen、剧本/分镜生成、锁编辑或任何图片/视频/TTS 能力。

## Capabilities

### New Capabilities

- `schema-registry-version-locks`: 定义四份 PRD-owned Schema 的离线发现、版本与哈希锁、Ajv 2020 编译校验、跨 Schema 引用、启动故障门、Fixture 和打包一致性行为。

### Modified Capabilities

- `desktop-workspace-foundation`: 启动自检新增 Schema/关键资源阶段；该阶段失败必须复用既有只读故障页、重试和写入门语义。

## Impact

- **Schema**：四份根目录 Schema 保持权威且字节不变；新增静态 manifest、打包副本、Fixture 与 hash 对账，不变更 `$id` 或公开字段。
- **数据库**：不新增 migration；复用 `0001_initial.sql` 已存在的 `schema_registry_manifest`，通过 Repository/启动短事务保存成功核验证据，不把 SQLite 变成版本锁事实源。
- **代码与依赖**：新增或完善 `packages/validation`、Application 启动 Port/Service、Main 资源 Adapter 与 Composition Root；精确锁定兼容的 Ajv 2020 依赖。
- **IPC/UI**：不新增业务 IPC；扩展既有 `runtime.getStartupStatus` 的阶段/稳定错误码，使只读故障页可显示 Schema 资源失败及可执行重试。
- **进程与安全**：文件读取、hash 和 Ajv 编译只在 Main/Adapter 边界；Renderer 不获得路径、Schema 原文、Ajv 实例或文件系统能力；校验过程零网络请求。
- **兼容性**：现有 v2 SQLite 数据库和 Project 数据不迁移；旧包不读取新资源。新包若资源缺失或漂移将安全阻断启动，不静默降级。
- **测试与发布**：增加 Unit、Contract、Integration、Electron E2E 和 Windows x64 packaged smoke；仍不构成 AC-V1-01 完成证据。
