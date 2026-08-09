## Context

参见 `proposal.md` 的 Why。当前 `main` 已具备 Electron 安全壳、启动写入门、SQLite migration/备份/audit/恢复和完整 `0001_initial.sql`，但 Application 只有启动服务，Persistence 尚无业务 Repository，READY 后 Renderer 也没有真实项目页面。

本设计受以下现有事实约束：

- PRD v1.4 §9.1、§9.2、§9.5、§13 和 §15.1 已固定 Project/FormatProfile 的 V1 可见语义；`镜序Studio_V1_EpisodeStoryboardExport.schema.json` 进一步固定可导出 FormatProfile 只能为 9:16 或 16:9、30fps、`zh-CN`，字幕安全区单边为 0–30%。
- TECH_DESIGN v1.1 §3.3、§4.3.3–§4.3.4、§8.4.2、§11 和 §15 要求 Application 拥有 Port、Application Service 控制事务、Command 幂等、修改命令乐观并发、Renderer 只走类型化 IPC、列表分页且单次本地保存目标 P95 ≤1 秒。
- `0001_initial.sql` 已发布且不可改写。它已有 `projects`、`format_profiles`、`audit_events`、`analytics_events` 和下游引用表，但没有通用 Command 回执表；数据库 CHECK 刻意宽于 V1 产品边界，V1 严格值必须由 Contract/Domain/Application 校验。
- 本 Change 发生在 Schema Registry、版本/锁和 Storyboard Change 之前，不能伪造后续能力，也不能在缺少正式 Schema/失效传播器时直接改写下游 ShotContract JSON。

## Goals / Non-Goals

**Goals:**

- 建立纯领域 Project/FormatProfile 值、Application `ProjectService`、Application-owned Ports 和 SQLite Adapter，保持既定依赖方向。
- 让六个 `project` IPC 具备双端 Zod 校验、稳定错误、幂等回执、乐观并发和安全响应。
- 原子创建 Project、首个 FormatProfile、审计、本地事件与命令回执；FormatProfile 更新保留父链和唯一 current。
- 在 READY 后提供可实际操作的项目列表、创作设定、回收站和 dirty 离开保护。
- 通过新 migration、Unit/Contract/Integration/Renderer/E2E 测试和打包态验证形成可回归基线。

**Non-Goals:**

- 不实现 SourceInput、Consent、Episode、Schema Registry、StoryBible/Script/Shot Repository、JobRunner、Provider、导入导出或永久删除。
- 不实现 TECH_DESIGN v1.1 §9.3 的 ShotContract `STALE_INPUT` 复制传播；在传播器落地前对有下游依赖的 FormatProfile 变更稳定阻断。
- 不修改四份业务 Schema、不重写 `0001_initial.sql`、不开放任意文件路径或 deployment mode UI。
- 不建立账号、远程 API、云同步、遥测上传或 V2/V3 模块。

## Decisions

### 1. 新增纯 Domain 包，Application 负责用例与事务

本 Change 首次创建 `packages/domain` 的最小公开入口，仅包含：

- `Project`/`FormatProfile` 领域类型和枚举。
- 项目名称规范化、V1 FormatProfile preset/字幕安全区、语义相等比较等纯函数。
- 不导入 Electron、React、Zod、SQLite、文件系统或 Contract DTO。

`packages/application/src/services/project-service.ts` 编排 list/get/create/update/delete/restore；它依赖以下 Application-owned Port：

- `ProjectUnitOfWorkPort`：在单一 `BEGIN IMMEDIATE` 中提供 Project、FormatProfile、CommandReceipt、Audit、Analytics Repository。
- `ProjectDirectoryPort`：只接收系统生成的 `projectId`，准备受管理目录并在数据库失败时尝试清理本次新建且仍为空的目录。
- 可注入的 `Clock`、`IdGenerator` 与稳定序列化/hash 函数，保证测试可重复。

Persistence 实现 Port；Electron Main Composition Root 注入实现。Repository 不提交事务、不返回 SQLite Row/Statement/连接，Application/Domain 不导入 `@jingxu/persistence` 或 `node:sqlite`。

**被否决方案：** Main IPC 直接写 Repository 会丢失领域/事务边界；把 Repository 接口放 persistence 会造成 Application 反向依赖；一次性创建 Source/Consent/Episode 空模块会扩大当前 Change。

### 2. Project Contract 使用严格 DTO 与显式 Result Envelope

`packages/contracts` 新增并导出：

- `ProjectSummaryDto`、`ProjectDetailDto`、`FormatProfileDto`、分页结果和稳定 `AppErrorDto`。
- `project.list/get/create/update/delete/restore` 的输入/输出 Zod Schema 与 channel 常量。
- `ProjectApi` 并合入冻结的 `JingxuApi`。

Project IPC 返回 `AppResultDto<T> = { ok: true, data } | { ok: false, error }`，避免依赖 Electron 对 thrown Error 的不稳定序列化。受信 sender 的字段/业务错误使用 Result；非受信 sender 仍在 Main 边界直接拒绝，不向攻击调用方泄漏 details。Preload 对返回值再次校验并逐方法暴露。

Create DTO 只接受用户可控字段：`requestId`、name、可选 genre/style、creationMode、dialogueRenderMode、aspectRatio 和 subtitleSafeArea。width/height/fps/language/deploymentMode/dataRootRel/ID/时间均由系统派生。Update/Delete/Restore 额外要求 `projectId` 与 `expectedUpdatedAt`。List 使用 `limit`（1–100）、不透明 cursor、scope（`ACTIVE`/`DELETED`）和可选搜索文本；Get 明确 scope。

稳定错误至少包括：

- `PROJECT_NOT_FOUND`
- `PROJECT_NAME_CONFLICT`
- `PROJECT_DIRECTORY_UNAVAILABLE`
- `PROJECT_VERSION_CONFLICT`
- `PROJECT_ALREADY_DELETED`
- `PROJECT_NOT_DELETED`
- `FORMAT_PROFILE_INVALID`
- `FORMAT_PROFILE_DEPENDENCY_BLOCKED`
- `REQUEST_ID_REUSED`
- `STARTUP_WRITE_BLOCKED`
- `IPC_INVALID_REQUEST` / `IPC_SENDER_NOT_ALLOWED`
- `PROJECT_PERSISTENCE_FAILED`

用户可见 `AppErrorDto` 遵循 TECH_DESIGN v1.1 §11，只含 code、脱敏 message、retryable、可选 userAction/fieldErrors 和 traceId。

**被否决方案：** 暴露一个通用 `project.command` 或通用 invoke 会破坏白名单；让 Renderer 提交完整 FormatProfile 会允许伪造机器字段；仅 throw 原始 Error 无法稳定保留 fieldErrors 且可能泄漏内部信息。

### 3. Project 名称和 FormatProfile 使用唯一的领域规范化规则

名称处理规则固定为：

1. 输入必须已经没有首尾 Unicode 空白；系统拒绝而不静默 trim。
2. 以 Unicode code point 计数 1–100。
3. 冲突键使用 `name.normalize('NFC').toLocaleLowerCase('zh-CN')`。
4. 在 `BEGIN IMMEDIATE` 内查询活动项目名称并用同一纯函数比对；单一写连接保证检查与写入之间没有并发插入。

不新增数据库 `name_key`：SQLite 内建 `lower()` 不能可靠复现 Unicode/JS NFC 规则，错误的 DB unique 比应用层确定性检查风险更高。当前 V1 项目规模小，事务内有界扫描可接受；Repository 只读取 id/name，后续若规模门槛变化再通过独立 migration 引入已回填验证的 key 列。

FormatProfile 使用两个不可变 preset：

| aspectRatio | width | height | fps | language |
|---|---:|---:|---:|---|
| `9:16` | 1080 | 1920 | 30 | `zh-CN` |
| `16:9` | 1920 | 1080 | 30 | `zh-CN` |

默认字幕安全区来自当前正式示例：top/right/left 5%，bottom 12%；用户可逐边修改到 0–30%。所有数值必须有限。Domain 派生机器字段并用语义对象比较，避免 UI 格式或 JSON 属性顺序制造空版本。

**被否决方案：** 接受 DDL 允许的 `1:1`/任意 fps 会扩大 PRD；把示例默认值复制到 Renderer 会形成第二套真相。

### 4. `0002_project_command_receipts.sql` 提供跨重启幂等证据

追加不可变 migration，建立：

```text
command_receipts(
  request_id PK,
  command_name,
  payload_sha256,
  project_id NULL FK projects,
  result_ref_json,
  trace_id,
  committed_at
)
```

约束包括合法 command 枚举、64 位小写 hex hash、`json_valid(result_ref_json)` 和必要索引。`result_ref_json` 只保存 Project/FormatProfile ID、提交 revision/时间等安全引用，不保存名称、genre/style、目录或完整命令载荷。TECH_DESIGN v1.1 §8.4.1 与 DDL 追踪表在 Apply 时同步。

Application 对 Command 计算 `v1` 稳定序列化载荷 SHA-256。事务首先按 requestId 查询回执：

- 同 command/hash：按安全引用重建结果，不再写业务/审计/事件。
- 不同 command/hash：返回 `REQUEST_ID_REUSED`。
- 不存在：执行领域写入，并把回执与业务、审计、Analytics 在同一事务提交。

Main 内的轻量 requestId 协调器让同进程同时到达的相同 Command 共享一个执行 Promise；数据库回执处理进程重启和响应丢失。失败事务不留回执，允许用户用同一 requestId 安全重试。

**被否决方案：** 只用内存 Map 无法跨重启；把请求正文放 audit metadata 会保存不必要用户内容且缺少唯一约束；复用 `script_stage_jobs.idempotency_key` 会错误耦合未实现的 JobRunner。

### 5. 目录准备在事务外，数据库提交保持短事务

`ProjectDirectoryPort.prepare(projectId)` 从 `%LOCALAPPDATA%/JingxuStudio/projects/<project_id>` 派生路径，执行规范化、受管理根/符号链接检查、目录创建和同根临时文件写入/flush/delete 探测；返回 opaque handle，只告诉 Application 目录是新建还是已存在，不返回路径给 Renderer。

顺序为：

```text
DTO/Domain 校验
→ requestId 同进程协调与已提交回执预查
→ 系统生成 projectId/formatProfileId
→ 事务外 prepare 受管理目录
→ BEGIN IMMEDIATE
→ 再查回执/名称/状态/expectedUpdatedAt
→ 写 Project、FormatProfile、Audit、Analytics、Receipt
→ COMMIT
→ 返回 DTO
```

数据库失败时仅尝试删除“本次创建且仍为空”的目录；预先存在、非空或清理失败的目录绝不递归删除，记录不含绝对路径的 WARN 证据。应用崩溃可能留下空的无主目录，但不会留下半个数据库项目或删除用户内容；本 Change 不自动清扫它们。

**被否决方案：** 在 SQLite 事务内做文件 I/O 违反短事务规则；先提交 DB 再建目录可能产生可见 Project 却无可写目录；将任意路径交给 Renderer 违反 Electron 边界。

### 6. Project 与 FormatProfile 写入采用单事务和单调 revision

Create：插入 Project、FormatProfile v1/current、`PROJECT_CREATED` audit、`project_created` 与 `dialogue_mode_selected` 本地事件、CommandReceipt。

Update：

- 先比较 `expectedUpdatedAt`；不匹配返回 `PROJECT_VERSION_CONFLICT`。
- 项目字段变化更新聚合；`updated_at = max(clock.now, previous + 1ms)`，避免固定/低分辨率时钟产生相同 revision。
- FormatProfile 语义变化时先查询 current 是否被 `shot_contract_versions.format_profile_id` 引用。有引用返回 `FORMAT_PROFILE_DEPENDENCY_BLOCKED`；无引用时把旧行 `is_current` 置 0、插入 `version_no + 1`/parent=current 的新行并更新 Project revision。
- 完全无变化返回 current DTO，不写 audit/event/receipt 之外的业务变更；为保持 requestId 语义仍提交 NO_OP receipt，其 result ref 标记 `changed=false`，但不写成功“变更”事件。
- DialogueRenderMode 变化才写 `dialogue_mode_selected`，properties 只含枚举和 source=`PROJECT_SETTINGS`。

Delete/Restore：只更新 Project 的 `deleted_at`/`updated_at`，不级联文件或子表。Restore 在事务内重新运行活动名称冲突检查。每次成功写对应 audit；Analytics 不保存项目名称或用户内容。

FormatProfile 版本规格字段不可 UPDATE；唯一允许的旧行 UPDATE 是 current 投影 `is_current=1→0`。新 current 插入与旧 current 切换受 partial unique 和事务保护。

### 7. Query 使用有界 keyset pagination，不读取大 JSON

Project list 只选择列表需要的 Project 列和 current FormatProfile 摘要，按 `updated_at DESC, id DESC`。Cursor 是带版本的 base64url JSON `{v:1, updatedAt, id, scope, searchHash}`，Main 解码后严格校验；search/scope 改变时旧 cursor 返回 `IPC_INVALID_REQUEST`。Query limit 最大 100，不使用 OFFSET。

搜索先限制为项目名称 contains，按规范化名称在 Application 对当前有界候选执行；为避免全表无限读取，Repository 设内部扫描硬上限并在 V1 容量基线内测试。若未来项目数超过门槛，再通过独立索引/FTS Change 调整，不在此处预建。

Get 根据 scope 区分 ACTIVE/DELETED，返回 current profile 和 FormatProfile 历史摘要（id/versionNo/parentId/spec/createdAt）；不返回 `data_root_rel`、SQL、审计 metadata 或内部 command receipt。

### 8. Renderer 采用 React Query + React Hook Form + Zustand 的最小职责划分

- React Query：project list/get 的服务端事实缓存、mutation 和成功后的精确 invalidation。
- React Hook Form：创作设定字段、字段错误和提交状态。
- Zustand：仅保存选中 projectId、列表 scope/filter 和 dirty 离开协调，不复制 Project/FormatProfile 事实。

首次 Apply 时按当前 React 19/TypeScript 6/Electron 工程核验官方 peer 范围并精确锁定依赖；不使用漂移 `latest`。页面组件拆为 ProjectList、ProjectForm、ProjectDetail、RecycleBin 和 DirtyLeaveDialog，保持一个文件一个主组件。

StartupGate 只有在 `READY` 时挂载项目 Query；READ_ONLY_FAULT 仍只显示故障页。无项目、筛选无结果、加载、Command 运行、字段错误、冲突、软删除和恢复都有独立可测试状态。未实现剧本/分镜入口保持可见禁用并解释后续前置能力，不渲染伪造数据。

窗口关闭由 Renderer dirty 状态通过白名单通知 Main；Main 仅阻止本次关闭并等待明确选择。保存并离开必须等待 Main 成功；放弃恢复最近 Query 数据；取消停留。

### 9. IPC、安全与日志边界沿用现有安全策略

`registerProjectIpc` 复用统一 sender 校验，但每个 channel 独立注册、输入 strict parse、输出 strict parse、错误归一化。Main Composition Root 在成功取得 single-instance lock、Persistence READY 后构造 Adapter/Service；数据库连接继续只有一条。

Renderer/Preload 不导入 Node、`node:sqlite`、Persistence、文件 Port 或路径类型。日志只记录 requestId/traceId/projectId、operation、耗时、结果 code 和 hash；不记录 name、genre/style、表单、路径、SQL 或 result_ref_json 全文。Project 删除文案明确镜序 Studio 不会替用户删除 Provider 侧内容。

公开 IPC 是 TECH_DESIGN v1.1 §11 已登记方法的落地，不改变进程依赖方向，因此无需新 ADR；若 Apply 发现必须增加通用 IPC、改变 Composition Root 所有权或修改数据库事实源，必须暂停并先更新 Design/ADR。

### 10. 测试与性能证据分层

- Unit：名称/FormatProfile 领域规则、稳定 hash、cursor、ProjectService 幂等/冲突/no-op/版本链/错误归一化、dirty 状态。
- Contract：六个 IPC DTO/Result、sender、unknown fields、Preload 白名单和错误脱敏。
- Integration：`0001→0002` migration/backup、Repository SQL、事务回滚、receipt、活动名称冲突、current profile、软删除/恢复、下游依赖阻断和 invariant audit。
- Renderer：加载/空/筛选无结果/保存/失败保留/dirty 三选项/回收站。
- Electron E2E：首次启动创建 9:16 项目、重启持久化、16:9 创建、陈旧更新、删除/恢复、只读故障写门和 Renderer 隔离。
- Package Smoke：Windows x64 打包产物包含 0002 migration，临时数据根完成空库升级、创建/重启/恢复且不访问真实用户数据。

本地保存 P95 只在固定测试机/临时库记录分布，不用容易波动的 1 秒断言制造 flaky；门禁断言采用确定性“事务内无文件 I/O、语句数有界、列表 keyset/limit”，并在验证报告记录实测 P50/P95 与环境。

## Risks / Trade-offs

- **[目录与 SQLite 无法形成同一 ACID 事务]** → 目录先准备、DB 后短事务，失败只清理本次新建空目录；接受崩溃留下无用户内容空目录，绝不自动递归清理。
- **[名称唯一由 Application Unicode 规则维护]** → 单一写连接和 `BEGIN IMMEDIATE` 内检查避免竞争；新增 invariant audit 检测活动名称键重复，容量门槛变化后再设计持久化 name_key。
- **[`command_receipts` 增加通用表]** → 只存 hash/安全引用并同步 TECH/DDL trace；不复用业务 Job 表，也不保存用户输入。
- **[FormatProfile 有下游依赖时暂时不可改]** → 明确 `FORMAT_PROFILE_DEPENDENCY_BLOCKED`，保留全部数据；后续版本/Storyboard Change 必须修改本 Requirement 并实现 TECH_DESIGN v1.1 §9.3 原子 STALE_INPUT 传播后才能解除。
- **[旧 FormatProfile 的 `is_current` 需要 UPDATE]** → 仅将 current 投影从 1 置 0，规格/父链/创建时间不可改；集成测试和 audit 证明历史内容未覆盖。
- **[Result Envelope 与现有 Runtime API 风格不同]** → Runtime 状态查询继续原样；所有新增业务 IPC统一使用 AppResult，并在后续业务 Change 复用，避免一次性重构已验证 Runtime API。
- **[新增 Renderer 状态依赖]** → 按 TECH 锁定的职责分别使用 React Query/RHF/Zustand，精确版本和 peer 检查进入 Apply 任务，禁止把同一事实复制进多个 store。
- **[`node:sqlite` 仍为 Active development]** → 继续执行 Node 22 与 Electron 43 双运行时、源码态与打包态集成测试；本 Change 不引入外部 native addon。

## Migration Plan

1. 新增 `0002_project_command_receipts.sql`，不得修改 `0001_initial.sql`；更新 migration trace、TECH_DESIGN v1.1 §8.4.1 和集成 Fixture。
2. 在空库、仅 0001 的上一版本库、100+ 历史对象压力库上演练：升级前在线备份先成功，0002 单事务应用，checksum/foreign key/invariant audit 通过。
3. 当前数据库已是版本 2 时重复启动跳过 migration；漂移、高版本和 0002 中途失败沿用 `sqlite-migration-runtime` 的只读故障语义。
4. 发布回滚不执行 down migration。旧二进制遇到 schema version 2 必须 `DATABASE_VERSION_TOO_NEW` 阻断；需要回滚时使用升级前受管理备份恢复，不能删除 `command_receipts` 或手改 `schema_migrations`。
5. Windows 打包验证 migration resource、Node/Electron SQLite 行为、临时数据根与用户目录隔离后才可归档。

## Open Questions

无。项目名称规范化、默认字幕安全区、FormatProfile 下游阻断、Command 回执和目录补偿已在本 Design 中锁定；改变其中任一项都需先更新 Proposal/Specs/Design，再进入 Apply。
