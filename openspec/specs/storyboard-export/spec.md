# storyboard-export Specification

## Purpose
TBD - created by archiving change storyboard-export. Update Purpose after archive.
## Requirements
### Requirement: 导出前必须通过 READY_EXPORT 门禁

系统 MUST 仅在整集当前版本 status=READY 时接受导出命令。导出前 MUST 于同一读快照内复跑全量集合校验（sequence 连续、previous_shot_id 回指、bible 键解析、Σ target_duration_sec 硬界 [30,180]）。任一前置不满足时系统 MUST 以稳定错误码（EXPORT_NOT_READY / EXPORT_COLLECTION_INVALID）拒绝，MUST NOT 组装导出物、MUST NOT 落盘、MUST NOT 写留痕。

#### Scenario: 非 READY 整集导出被拒

- **GIVEN** 整集当前版本为 DRAFT（存在未确认编辑）
- **WHEN** 用户发起导出
- **THEN** 系统 MUST 返回 EXPORT_NOT_READY，不产生任何文件与留痕

#### Scenario: READY 但集合校验失败被拒

- **GIVEN** 整集标记 READY 但当前 ACTIVE 镜头集合无法通过集合校验
- **WHEN** 用户发起导出
- **THEN** 系统 MUST 返回 EXPORT_COLLECTION_INVALID，不产生任何文件与留痕

### Requirement: 导出物必须确定性组装并通过 EpisodeStoryboardExport 1.1.0 校验

系统 MUST 以纯函数从当前快照组装导出物：schema_version=1.1.0、export_id 唯一新 id、exported_at ISO 时间、exported_by=LOCAL_USER、lineage_completeness=CURRENT_ONLY、episode_version=整集 versionNo、story_bible_version_id、target_duration_sec、format_profile（FormatProfile 聚合投影，subtitle_safe_area 四键改名 *_pct）、shot_contracts=当前 ACTIVE 镜头文档原样（locked_paths 随文档携带）、export_provenance（app_version 取应用常量、contains_ai_assisted_content=任一镜头 provenance.source_type 非 HUMAN_CREATED，即 AI_ASSISTED 与 AI_GENERATED 均计入）。组装产物 MUST 通过 Registry EpisodeStoryboardExport 1.1.0 校验（含 ShotContract $ref 离线解析）方可进入渲染与落盘；Markdown 交付物 MUST 由同一组装事实派生。

#### Scenario: READY 整集组装出合法导出物

- **GIVEN** 整集 READY 且镜头数为 1–20、字段齐备
- **WHEN** 导出组装并过 Registry 校验
- **THEN** 产物 SHALL 满足 envelope 1.1.0 全部必填键与 const 约束，且 Registry 校验通过

#### Scenario: FormatProfile 投影键名对齐

- **GIVEN** 项目 FormatProfile 当前聚合含 subtitleSafeArea {top,right,bottom,left}
- **WHEN** 组装导出物
- **THEN** format_profile.subtitle_safe_area SHALL 以 top_pct/right_pct/bottom_pct/left_pct 键呈现，数值不变

### Requirement: Σ 时长偏离软带必须经用户确认并留痕原因

系统 MUST 于导出时计算 Σ（当前 ACTIVE 镜头 target_duration_sec 之和）。Σ∈[60,120] 时直接放行；Σ∉[60,120] 时命令 MUST 携带 warnConfirmed=true 与非空 deviationReason，否则系统 MUST 返回稳定错误码 EXPORT_DURATION_DEVIATION（details 携带实际 Σ）。deviationReason MUST 随留痕 metadata 落库。

#### Scenario: 软带内直接导出

- **GIVEN** Σ=90 秒
- **WHEN** 导出命令未携带确认字段
- **THEN** 系统 SHALL 正常导出，不要求原因

#### Scenario: 软带外缺原因被拒后携原因重发成功

- **GIVEN** Σ=45 秒
- **WHEN** 首次导出命令缺 warnConfirmed/deviationReason
- **THEN** 系统 MUST 返回 EXPORT_DURATION_DEVIATION 且 details 携带 Σ=45
- **WHEN** 用户确认并填写原因后重发
- **THEN** 系统 SHALL 导出成功，原因 SHALL 出现在留痕 metadata

### Requirement: 落盘路径边界与导出留痕

文件落盘 MUST 全程于 main 进程完成（save dialog、写文件、哈希计算）；文件绝对路径 MUST NOT 进入 Renderer 或任何回执 DTO。导出成功 MUST 以轻量审计事件留痕（ScriptAuditRepositoryPort）：actor=USER、action=STORYBOARD_EXPORTED、objectType=episode_version、objectVersionId=整集版本、afterSha256=导出交付物 sha256、metadata 含 format（EPISODE_JSON/MARKDOWN_TABLE/PRODUCIBILITY_REPORT 之一）/fileSha256/byteSize/totalDurationSec 与可选 deviationReason；metadata MUST NOT 含源内容。文件路径 MUST NOT 入库。用户取消对话框 SHALL 得到 EXPORT_CANCELLED 平回执（非错误、不留痕）；写文件失败 MUST 返回 EXPORT_FILE_WRITE_FAILED 且不留痕；审计写失败 MUST 返回 EXPORT_AUDIT_FAILED 并携带文件哈希（不静默）。

#### Scenario: 成功导出的留痕完整性

- **GIVEN** READY 整集导出成功
- **WHEN** 查询 audit_events
- **THEN** SHALL 存在 STORYBOARD_EXPORTED 行：after_sha256=文件内容哈希，metadata 含 format/fileSha256/byteSize/totalDurationSec，且不含镜头源内容

#### Scenario: 路径红线

- **WHEN** 导出命令返回回执
- **THEN** 回执 DTO 与 Renderer 可达日志 MUST NOT 出现文件绝对路径

#### Scenario: 取消与写失败

- **GIVEN** 用户在 save dialog 取消，或目标路径不可写
- **WHEN** 导出流程分别到达对应分支
- **THEN** 系统 SHALL 分别返回 EXPORT_CANCELLED（不留痕）与 EXPORT_FILE_WRITE_FAILED（不留痕）

### Requirement: 分镜工作台必须提供 READY 态导出入口

分镜工作台 MUST 在整集当前版本 status=READY 时提供三个并列导出入口：「导出整集」（EPISODE_JSON）、「导出分镜表」（MARKDOWN_TABLE）、「导出报告」（PRODUCIBILITY_REPORT）；非 READY 时 MUST 不渲染任何导出入口。任一 format 的 Σ 软带外首次导出被拒时 UI MUST 呈现同一确认对话（展示实际 Σ）与原因输入，用户确认后 MUST 以同命令同 format 携带 warnConfirmed 与 deviationReason 重发。任一 format 导出成功 MUST 向用户呈现成功反馈（无路径）；失败 MUST 呈现稳定错误码对应的人话提示。

#### Scenario: READY 出现入口、导出往返成功

- **GIVEN** 整集 READY
- **WHEN** 用户进入分镜工作台
- **THEN** SHALL 同时出现「导出整集」「导出分镜表」「导出报告」三个入口；点击任一完成落盘后 UI SHALL 呈现导出成功反馈（含 export_id 或文件哈希末四位等非路径标识）

#### Scenario: 非 READY 无入口

- **GIVEN** 整集当前版本 DRAFT
- **WHEN** 用户进入分镜工作台
- **THEN** 三个导出入口 SHALL 均不存在

### Requirement: Markdown 分镜表导出

系统 MUST 支持以 `format=MARKDOWN_TABLE` 导出 READY 整集：复用与 JSON 导出完全相同的 READY_EXPORT 门禁、Σ 软带偏离确认与留痕口径；组装事实 MUST 同源于 EpisodeStoryboardExport envelope（组装后先过 Registry 1.1.0 校验，再以纯函数渲染 Markdown）。分镜表 MUST 含表头（镜头号/景别/运镜/时长(s)/叙事目的/台词/旁白/角色/场景/锁定）与逐镜头数据行，单元格 MUST 转义竖线与换行；表头上方 MUST 呈现版本事实（整集版本 versionNo、Σ 时长、export_id、exported_at）。落盘默认名 MUST 为 `storyboard_<projectId>_<episodeId>_v<versionNo>.md`。

#### Scenario: READY 整集导出人读分镜表

- **GIVEN** 整集 READY（6 镜、Σ=90）
- **WHEN** 以 format=MARKDOWN_TABLE 导出
- **THEN** SHALL 产出 Markdown 文件：9 列表头、6 条数据行、Σ=90 事实行，且单元格内竖线被转义

#### Scenario: 分镜表与 JSON 同门禁同留痕

- **GIVEN** 整集 DRAFT（未确认编辑）
- **WHEN** 以 format=MARKDOWN_TABLE 发起导出
- **THEN** 系统 MUST 返回 EXPORT_NOT_READY，不产生文件与留痕，与 JSON 导出行为一致

### Requirement: 可生产性报告导出

系统 MUST 支持以 `format=PRODUCIBILITY_REPORT` 导出 READY 整集的 Markdown 可生产性报告，复用同一门禁与 Σ 偏离确认口径。报告 MUST 包含：头部事实（项目/整集版本/画幅快照/export_id/exported_at）、时长事实（Σ、目标带 60–120、偏离原因如有）、集合校验结论、AI 参与度（contains_ai_assisted_content 派生值）、可生产性规则段、镜头清单摘要。可生产性规则段 MUST 实现正脸长对白 WARN（PRD 9.5）：镜头 `frontal_face=true && mouth_visible=true && estimated_speech_duration_sec > 阈值` 时输出 WARN 行（含镜头号与时长）；阈值 MUST 以常量配置并随报告输出规则版本标识。WARN 属风险提示，MUST NOT 阻断导出、MUST NOT 引入新错误码。落盘默认名 MUST 为 `report_<projectId>_<episodeId>_v<versionNo>.md`。

#### Scenario: 无命中如实输出

- **GIVEN** 整集全部镜头 estimated_speech_duration_sec ≤ 4 秒
- **WHEN** 导出可生产性报告
- **THEN** 报告规则段 SHALL 输出「无 WARN」与规则版本标识，导出成功

#### Scenario: 正脸长对白命中 WARN

- **GIVEN** 镜头 #1 frontal_face=true、mouth_visible=true、estimated_speech_duration_sec=5
- **WHEN** 导出可生产性报告
- **THEN** 报告规则段 SHALL 含镜头 #1 的 WARN 行（含时长），导出仍成功（非阻断）

