# Proposal: storyboard-export

## Why

PRD 9.7.1/9.8 要求「导出剧本、分镜表和结构化 JSON」，AC-V1-03 明确断网环境导出且导出物通过 EpisodeStoryboardExport 校验；`EpisodeStoryboardExport/1.1.0` schema 连同 valid/invalid fixtures 早已锁版（sha256 三处锁死），离线 Registry 对其引用 ShotContract 的解析已是 P0 契约测试，但**导出业务能力为零**——READY 整集在应用内无任何出口，创作闭环「生成→编辑→锁定→确认」之后断头。shot-edit-lock 落地后用户已能人工修稿定稿，导出是下一个自然闭环件。

## What Changes

- **READY_EXPORT 集合校验 Profile**：既有集合校验器（生成/EDIT_INVARIANT 已用）新增导出档——全部当前 ACTIVE 镜头 version status=READY 且无未处理 BLOCK，其余规则（sequence 连续、previous_shot_id 回指、bible 键解析、Σ target_duration_sec 界内）复用；导出前必跑。
- **导出组装服务**：episode READY 当前快照（versionNo、storyBibleVersionId、链接镜头完整文档）+ FormatProfile 投影（subtitle_safe_area 键改 `*_pct`，宽高/fps/language 直映射）+ `export_provenance` 确定性派生（`contains_ai_assisted_content` = 任一镜头 `source_type=AI_ASSISTED`，`app_version` 取应用常量）+ `export_id`/`exported_at` 生成 → 组装后过 Registry 双保险校验（envelope 1.1.0，含 ShotContract $ref 离线解析）→ 产出 JSON 文本。
- **Σ 时长偏离 WARN 门**：Σ∉[60,120]（PRD 软带；[30,180] 为 schema/集合硬界）时导出命令必须携带用户确认与偏离原因，无原因拒绝（交互形态按拍板）。
- **文件落盘与留痕**：main 侧 Electron save dialog（默认名 `export_<projectId>_<episodeId>_v<versionNo>.json`）+ main 写文件 + sha256 落审计留痕；**路径绝不进 Renderer**（红线，不设拍板）。留痕形态按拍板。
- **IPC**：导出命令入 storyboard 域（形态按拍板），复用 sender 校验/启动写门控/singleflight/输出脱敏复验基建。
- **UI**：分镜工作台 READY 态「导出整集」入口 + WARN 确认与原因输入。

## 拍板（2026-08-20，全按推荐项）

- **D1 切片范围 = 仅 JSON 导出**：本刀只做 EpisodeStoryboardExport/1.1.0 结构化 JSON 文件导出；Markdown 分镜表、可生产性报告、导入（RETURN_TO_ORIGIN/ProjectTransferBundle）各自后继 change。
- **D2 留痕形态 = 轻量审计事件**：复用既有审计/事件通路记一条导出事件（episode version 引用 + 文件 sha256 + 字节大小 + 可选偏离原因）；零迁移零状态机，ExportJob 表留给 V2 成片合成。
- **D4 IPC 归属 = storyboard.exportEpisode**：并入既有 `storyboard.*` 第 4 方法，复用 sender 校验/写门控/singleflight/脱敏复验基建；三处白名单断言同步扩展（preload 两契约 + bootstrap E2E §9.1）。
- **D5 WARN 交互 = 单命令+确认重发**：导出命令带 `warnConfirmed`+`deviationReason`；服务端算 Σ，越带且缺原因 → 稳定错误码 `EXPORT_DURATION_DEVIATION`（携带实际 Σ），UI 弹确认+原因输入后重发。无中间态、天然幂等。

## 非目标

- 导入（独立 EpisodeStoryboardExport 的 RETURN_TO_ORIGIN 导回与 ProjectTransferBundle 空项目导入，PRD 9.7.1 尾段，后继 change）。
- Markdown/可生产性报告导出（V1 交付物清单项，后继 change）。
- ExportJob 状态机 ASSEMBLING/PREVIEW_READY/EXPORTING 与成片合成（12.4 全量属 V2；本刀按 D2 拍板留最小痕）。
- 已导出 Episode 再编辑回 DRAFT 的联动（既有编辑语义天然满足：编辑即新 DRAFT 整集，历史导出留痕可追溯）。
- 跨项目分支导入、完整历史版本导出（PRD 明确非 V1）。

## Capabilities

### 新增 `storyboard-export`

- Requirement: READY_EXPORT 导出门禁（全 ACTIVE READY + 集合规则 + schema 硬界）
- Requirement: 导出组装与离线 Schema 校验（envelope 1.1.0 全字段确定性派生，含 FormatProfile 投影与 provenance）
- Requirement: Σ 时长偏离 WARN 与用户原因留痕
- Requirement: 文件落盘路径边界与导出留痕（路径不进 Renderer；sha256/episode version/原因落痕）
- Requirement: 分镜工作台导出入口与确认交互

## Impact

- **代码**：`packages/application`（ExportService 组装 + READY_EXPORT Profile 接入集合校验器）、`packages/contracts`（导出命令 DTO + 通道/白名单扩展）、`packages/persistence`（审计留痕写入，按 D2 定形）、`apps/desktop` main/preload/renderer（save dialog + 写文件 + 导出按钮/WARN 确认）。
- **Schema**：四份 PRD-owned Schema 零改动（envelope 1.1.0 已锁版直用）；迁移按 D2 定（审计事件路线则零迁移）。
- **兼容与回滚**：纯增量（新命令、新留痕、新 UI 入口）；不触碰生成/确认/编辑/锁定路径行为；回滚 = 移除通道与服务注册，落盘文件与留痕行对旧代码惰性无害。
- **验收映射**：PRD AC-V1-03（导出侧）、9.7.1 规则 8/9 与 READY_EXPORT Profile、9.8「导出结构化 JSON」；V1-SCR「结构化分镜独立完成率」的导出末端。
- **测试层级**：unit（组装投影/派生/READY_EXPORT）、contract（DTO/白名单/错误形态）、integration（留痕原子性按 D2）、E2E（READY 导出往返——生成→确认→导出→文件内容 schema 复验；WARN 带确认；非 READY 阻断）。
