# Design: storyboard-export

## 背景事实（勘察实录，file:line 为 2026-08-20 工作区状态）

- `EpisodeStoryboardExport/1.1.0` schema 已锁版（sha256 三处锁死于 `packages/validation/src/schema-locks.ts`），含 `shot_contracts` 对 `ShotContract/1.1.0` 的离线 $ref；valid fixture `episode-storyboard-export.valid.json` 可作单测金样。
- 集合校验器在应用层：`packages/application/src/script/shot-collection-validator.ts` 的 `validateShotSetCollection(documents, bibleKeys)`（shot-edit-lock 的 EDIT_INVARIANT 复检即用它，`shot-edit-lock-service.ts:489`）。
- READY 语义：episode confirm 逐镜头建 READY scv 子版本 + READY 整集版本（`storyboard-version-service.ts`）；`current.status === 'READY'` ⟺ 全部链接镜头当前 scv READY。
- FormatProfile 聚合经 `FormatProfileRepositoryPort`（`packages/application/src/ports/project/format-profile-repository.ts`）可取当前 profile；字段投影仅需 `subtitle_safe_area` 键改名 `top→top_pct` 等四键，宽高/fps/language 直映射（persistence row-mapper 已聚合成 camelCase 对象）。
- 审计通路现成：`ScriptAuditEntry`（`packages/application/src/ports/script/script-types.ts:100`，含 actor/action/objectType/objectId/objectVersionId/before/afterSha256/metadata/traceId）+ `SqliteScriptAuditRepository`（`sqlite-script-repositories.ts:424`，全列写入 audit_events）。metadata 红线：不得含源内容/提示词/响应原文——哈希与数字合规。
- storyboard IPC：`apps/desktop/src/main/ipc/storyboard-ipc.ts` 已有 registrar 模式（sender→DTO→启动写门→Application→输出脱敏复验），`STORYBOARD_IPC_CHANNELS` 枚举三通道；新方法 = 加枚举 + handler + service 委托，三处白名单断言同步（preload `jingxu-api.contract.test.ts`、`job-provider-api.contract.test.ts`、E2E bootstrap §9.1 apiKeys——shot-edit-lock 已踩过此坑）。
- main 尚无 Electron `dialog` 使用；导出将是首个 save dialog 调用点。
- `app_version`：取 `package.json` version 经组合根注入常量（main 侧已有 app 元信息可注入；不新读文件于服务层）。
- 命令幂等回执既有设施 `command_receipts`（project 域）——导出是否复用见 D5 定案。

## D1: 切片范围【已拍板 2026-08-20：仅 JSON 导出】

本刀只交付 EpisodeStoryboardExport/1.1.0 结构化 JSON 文件导出（READY 门禁 + 组装 + Registry 双保险 + 落盘 + 留痕 + UI 入口）。Markdown 分镜表、可生产性报告、导入（RETURN_TO_ORIGIN / ProjectTransferBundle）为后继 change；`ExportJob` 状态机与成片合成属 V2。

## D2: 留痕形态【已拍板 2026-08-20：轻量审计事件】

复用 `ScriptAuditRepositoryPort` 写一条导出事件，零迁移零状态机：

- `actor='USER'`，`action='STORYBOARD_EXPORTED'`，`objectType='episode_version'`，`objectId=episodeId`，`objectVersionId=episodeVersionId`
- `afterSha256` = 导出 JSON 全文 sha256；`metadata = { fileSha256, byteSize, totalDurationSec, deviationReason? }`（全为哈希/数字/短文本，不含源内容，符合 metadata 红线）
- 12.4 ExportJob 表不做；文件路径**不入库**（只入哈希与大小——路径是本机事实，留痕要的是「导出过什么」，不是「存在哪」）。

## D4: IPC 归属【已拍板 2026-08-20：storyboard.exportEpisode 第 4 方法】

- 输入 DTO：`{ projectId, episodeId, expectedVersionId, requestId, warnConfirmed?, deviationReason? }`（zod superRefine：越带重发时 `deviationReason` minLength 校验在服务层做——服务端才是算带事实源）。
- 输出 DTO：`{ exportId, episodeVersionId, totalDurationSec, fileSha256, byteSize }`——**不含路径**（红线：路径绝不进 Renderer；文件由 main 落盘）。
- 复用 storyboard registrar 全链（sender/DTO/启动写门/singleflight/输出脱敏复验）；导出是读+落盘+留痕，启动写门语义与 editShot 同（导出期间禁止再生成）。
- 三处白名单断言同步扩展。

## D5: WARN 偏离确认交互【已拍板 2026-08-20：单命令+确认重发】

- 服务端算 `Σ = 整集当前 ACTIVE 镜头 target_duration_sec 之和`。带位：`[30,180]` 硬界（越界属集合校验失败，本就不可能 READY）；`[60,120]` PRD 软带。
- `Σ ∈ [60,120]` → 直接导出。
- `Σ ∉ [60,120]` 且 `warnConfirmed !== true` 或 `deviationReason` 缺失/空 → 返回稳定错误码 `EXPORT_DURATION_DEVIATION`，`details` 携带实际 `Σ`；UI 弹确认对话（展示 Σ 与带位）+ 原因输入，重发同命令附 `warnConfirmed: true, deviationReason`。
- `deviationReason` 随留痕 metadata 落库。无中间态、无 preview 资源，重放安全。

## 定案事实（不设拍板）

- **READY_EXPORT 门禁**：导出前置三查（同一读事务快照）——① episode current.status === 'READY'（结构性 ⟺ 全镜头 scv READY，不逐一再查镜头表，但集合校验兜底）；② `validateShotSetCollection` 全量复跑（sequence 连续/previous_shot_id 回指/bible 键解析/Σ 硬界）；③ Registry envelope 1.1.0 校验（组装产物双保险，含 ShotContract $ref 离线解析）。任一失败 → `EXPORT_NOT_READY` / `EXPORT_COLLECTION_INVALID` / `EXPORT_SCHEMA_INVALID`，不落盘不留痕。
- **组装纯函数**：`assembleStoryboardExport(snapshot, formatProfile, ids, appVersion)` 置于 application 层，输入为已读快照，输出 JSON 文本与解析后的 envelope 对象；`exported_at` ISO、`export_id = 'export_' + 新 id()`、`exported_by='LOCAL_USER'`（schema const）、`contains_ai_assisted_content` = 任一镜头 `provenance.source_type!=='HUMAN_CREATED'`（枚举含 AI_GENERATED/AI_ASSISTED，两者均属 AI 参与内容；实施时按此口径）、`lineage_completeness='CURRENT_ONLY'`（schema const）、`episode_version` = 整集 versionNo、`shot_contracts` = 当前 ACTIVE 镜头文档原样（`locked_paths` 随文档携带，schema 已容纳）。
- **落盘通路**：main 侧 `dialog.showSaveDialog`（默认名 `export_<projectId>_<episodeId>_v<versionNo>.json`）→ 用户选定路径 → main 写文件（UTF-8，JSON.stringify 2 空格缩进与校验时同文）→ 计算 sha256/byteSize → 经同一命令事务写审计事件 → 回执给 Renderer。取消对话框 = 命令以 `EXPORT_CANCELLED` 平回执（非错误，不留痕）。写文件失败 → `EXPORT_FILE_WRITE_FAILED`，不留痕。
- **事务边界**：读快照（episode+shots+formatProfile）→ 校验 → 组装 → Registry 校验 →（main：对话框+写文件+哈希）→ 审计写。审计写失败不回滚已落盘文件（文件是用户侧事实），回执报 `EXPORT_AUDIT_FAILED` 并携带文件哈希——失败必须响亮，不静默。
- **UI**：分镜工作台 storyboard current READY 时显示「导出整集」按钮；非 READY 隐藏（与既有 READY 语义一致，不做禁用态）；确认对话复用既有弹层样式。
- **回滚**：纯增量——新通道、新服务、新按钮；移除注册即回滚，audit_events 新行对旧代码惰性无害。

## 测试策略

- **unit**（application）：组装纯函数金样对照 valid fixture 字段集；READY_EXPORT 门禁矩阵（非 READY/集合失败/越带缺原因/越带有原因）；provenance 派生；FormatProfile 投影键改名。
- **contract**（contracts/preload）：导出 DTO zod 校验、storyboard 白名单 +1、错误码形态。
- **integration**（persistence）：审计事件落库字段完整性（含 metadata 红线断言：无源内容键）。
- **E2E**（desktop）：生成→确认 READY→导出（E2E 环境对话框须可注入路径——`JINGXU_E2E` 下跳过 showSaveDialog 改用临时目录定名，真实对话框行为由手工验收）→ 读文件过 Registry 复验→留痕断言；越带 Σ 场景用 mock 镜头时长构造；非 READY 阻断。
