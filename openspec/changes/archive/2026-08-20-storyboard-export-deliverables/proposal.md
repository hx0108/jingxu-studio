# Proposal: storyboard-export-deliverables（分镜 Markdown 分镜表 + 可生产性报告导出）

## Why

`storyboard-export`（2026-08-20）已交付 EpisodeStoryboardExport 1.1.0 JSON 文件导出，但 PRD V1 交付物清单还要求「可生产性报告、**Markdown** 和 JSON 导出」（PRD v1.4 L381），9.8 分镜编辑节亦列「导出剧本、**分镜表**和结构化 JSON」（L629）。当前缺口：

- 制片/审片等人类读者拿到 JSON 无法直接阅读，缺人读分镜表交付物。
- 可生产性风险（PRD 9.5 明确判定式的正脸长对白镜头 WEAK_LIP_SYNC 风险，L526）与 Σ 偏离、AI 参与度等结构事实无处汇总呈现。

## What Changes

- **复用既有导出骨架**：READY_EXPORT 门禁（基线版本一致 + 整集 READY + 集合校验复跑 + Registry envelope 校验兜底）、Σ 软带 [60,120] 偏离确认重发（D5 单命令）、dialog/E2E 双形态落盘 sink、`STORYBOARD_EXPORTED` 审计留痕、路径红线（文件路径不进回执/Renderer/审计行）——全部不动语义，仅扩展交付物形态。
- **Markdown 分镜表渲染纯函数**：与 JSON envelope 同一组装事实渲染 Markdown 表格（镜头号/景别/运镜/时长/叙事目的/台词/角色/场景/锁定标记），纯函数零 I/O。
- **可生产性报告渲染纯函数**：结构事实段（项目/整集版本/画幅快照/Σ 与目标带/集合校验结论/AI 参与度/镜头清单）+ 可生产性规则段——正脸长对白 WARN（PRD 9.5：`frontal_face=true && mouth_visible=true && 预计对白时长 > 4s`，阈值常量化并随报告输出规则版本）。
- **审计面扩展**：`STORYBOARD_EXPORTED` metadata 增 `format` 字段（`EPISODE_JSON` / `MARKDOWN_TABLE` / `PRODUCIBILITY_REPORT`）。
- **UI**：分镜工作台 READY 态入口扩展。

## 拍板（2026-08-20 已定）

- **D1 命令面 = 复用 `storyboard.exportEpisode` + `format` 枚举入参**（`EPISODE_JSON|MARKDOWN_TABLE|PRODUCIBILITY_REPORT`，默认 `EPISODE_JSON` 向后兼容；回执 5 键格式无关，白名单/IPC 面零扩张）。
- **D2 报告口径 = 结构事实 + 正脸长对白 WARN 单条启发式**（PRD 9.5 已给完整判定式；阈值常量化 + 规则版本随报告输出；9.6 完整引擎留后继 change）。
- **D3 UI 入口 = 三按钮并列**：保留「导出整集」（JSON，name 不动）+「导出分镜表」「导出报告」，偏离确认弹层与成功通知三入口共用。

另随行勘误：既有 spec「组装」requirement 中 contains_ai_assisted_content 口径由「source_type 为 AI_ASSISTED」对齐实施实况「source_type 非 HUMAN_CREATED（AI_ASSISTED/AI_GENERATED 均计）」。

## 非目标

- RETURN_TO_ORIGIN 导入与 ProjectTransferBundle（后继 change）。
- PRD 9.6 完整可生产性引擎：ProviderCapabilitySnapshot 规则、场景切换频率/多人遮挡/群体动作等启发式、LLM Observation 补充——本 change 至多落 PRD 已给完整判定式的**一条**确定性规则，其余进入后续 change。
- 剧本/故事圣经等其他对象的 Markdown 导出（9.8「导出剧本」的非分镜面）。
- 报告交互式浏览 UI（V1 只交付文件）。

## Capabilities

### spec: `storyboard-export`

- **ADDED Requirement: Markdown 分镜表导出**——READY 整集可导出人读 Markdown 表格；门禁/Σ 偏离确认/留痕与 JSON 导出同口径（`format=MARKDOWN_TABLE`）。
- **ADDED Requirement: 可生产性报告导出**——READY 整集可导出含结构事实与可生产性 WARN 规则的 Markdown 报告；规则版本随报告输出并留痕（`format=PRODUCIBILITY_REPORT`）。
- **MODIFIED Requirement: 导出物必须确定性组装并通过 EpisodeStoryboardExport 1.1.0 校验**——勘误 contains_ai_assisted_content 口径为「source_type 非 HUMAN_CREATED」；明确 Markdown 交付物由同一组装事实派生。
- **MODIFIED Requirement: 落盘路径边界与导出留痕**——审计 metadata 增 `format` 字段，三种交付物同一 `STORYBOARD_EXPORTED` 动作；afterSha256 口径放宽为「导出交付物」。
- **MODIFIED Requirement: 分镜工作台必须提供 READY 态导出入口**——单入口扩为三入口并列，偏离确认与成功通知三入口共用。

## Impact

- `packages/contracts`：`storyboardExportEpisodeInputSchema` 增 `format` 枚举（默认 `EPISODE_JSON` 保持向后兼容）；回执 schema 不变。
- `packages/application`：两个 Markdown 渲染纯函数 + 服务 format 分支 + 正脸长对白规则常量（含版本号）。
- `apps/desktop` main：sink 默认名/保存过滤器按 format 分支；renderer：入口与文案；E2E：新 spec（.md 内容形态 + 审计 format 断言）。
- 零迁移、零新 Schema（Markdown 为派生文本，非 PRD-owned 机器契约）。
