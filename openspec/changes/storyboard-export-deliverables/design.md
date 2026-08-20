# Design: storyboard-export-deliverables

## 背景事实（勘察 2026-08-20，head=1476c43）

- PRD v1.4：L381 V1 交付物含「可生产性报告、Markdown 和 JSON 导出」；L629（9.8 分镜编辑）「导出剧本、分镜表和结构化 JSON」；L526（9.5）正脸长对白 WARN 判定式——`frontal_face=true`、`mouth_visible=true` 且预计对白时长 > 4 秒，阈值必须配置化并记录规则版本；L537 起（9.6）启发式只输出 WARN/INFO，属风险提示非阻断。
- 导出服务骨架 `packages/application/src/script/storyboard-export-service.ts`：三段式（unitOfWork.run 内门禁+组装+envelope Registry 校验 → `sink.write(defaultFileName, content)` → 第二短事务审计 `STORYBOARD_EXPORTED`，metadata `{byteSize, deviationReason, fileSha256, totalDurationSec}`）。`format` 只需影响三处：渲染函数、sink 默认名、审计 metadata。
- 契约 `packages/contracts/src/storyboard-api.ts`：`storyboardExportEpisodeInputSchema` strict object；回执 `storyboardExportResultSchema` 5 键（byteSize/episodeVersionId/exportId/fileSha256/totalDurationSec）**格式无关**——加 format 不动回执。
- sink `apps/desktop/src/main/composition/storyboard-export-file-sink.ts`：E2E 分支 `join(exportDir, defaultFileName)`；生产 `filters: [{extensions:['json'], name:'JSON'}]` → 按 format 分支 `.md`。
- 渲染输入字段（镜头文档，mock 实测 `e2e-script-text-model-adapter.ts` L98-137）：`cinematography.shot_size/camera_motion/frontal_face(恒 true)/mouth_visible(index%3!==2)`、`content.spoken_text/character_ids/scene_id`、`dialogue.estimated_speech_duration_sec(非空镜 3s)/dialogue_render_mode/speaker_id`、`narrative_purpose`、`target_duration_sec(15)`、`locked_paths`、`provenance.source_type`。E2E Mock 全集无 WARN 命中（3s < 4s）；将镜头 1 `estimated_speech_duration_sec` 3→5 即命中（该镜 frontal+mouth 均 true，editShot 已支持 dialogue 字段编辑——shot-edit-lock E2E 同款改法）。
- Renderer：`StoryboardPanel.tsx` script-actions READY 条件渲染块（现「导出整集」`name="export-episode"`）；`ScriptWorkspace.tsx` `performStoryboardExport(options)` 已集中处理 EXPORT_DURATION_DEVIATION 弹层/EXPORT_CANCELLED 静默/成功通知。
- 审计表 `audit_events.metadata_json`（`sqlite-script-repositories.ts` L430）；`verify-storyboard-export.mjs` 红线检查子串不含 'path'——format 值 `EPISODE_JSON/MARKDOWN_TABLE/PRODUCIBILITY_REPORT` 不触发。

## D1 已拍板（2026-08-20）：复用 `storyboard.exportEpisode` + format 枚举

- `storyboardExportEpisodeInputSchema` 增 `format: z.enum(['EPISODE_JSON','MARKDOWN_TABLE','PRODUCIBILITY_REPORT']).default('EPISODE_JSON')`——既有调用（E2E/探针/已发布面）不带 format 仍为 JSON 导出，**向后兼容零破坏**。
- 白名单/IPC/preload 命令面零变化（D4 前例的反面：本次不加方法）。
- 三种 format 共用同一 prepare 流水线与 Σ 软带判定；Markdown 交付物同样先组装 envelope 过 Registry 校验（事实同源一致性免费兜底），再以纯函数渲染文本。

## D2 已拍板：报告 = 结构事实 + 单条正脸长对白 WARN

- 规则常量（application 层，配 PRD「配置化+规则版本」）：`PRODUCIBILITY_RULES_VERSION = 'jingxu-producibility-rules/1'`、`SPEECH_DURATION_WARN_SEC = 4`。
- 判定式（确定性纯函数，无 LLM）：任一镜头 `frontal_face===true && mouth_visible===true && estimated_speech_duration_sec > 4` → WARN 行（镜头号/shot_id/时长）；无命中输出「无 WARN」如实行。WARN 属风险提示**不阻断、不新增错误码**（PRD 9.6 口径）。
- 报告章节（Markdown）：①头部事实（项目/整集版本 versionNo/storyBibleVersionId/画幅快照 aspect+分辨率+fps+language/export_id/exported_at/规则版本）②时长事实（Σ、目标带 60–120、是否偏离+原因）③集合校验结论（READY_EXPORT 复跑通过）④AI 参与度（contains_ai_assisted_content 派生值）⑤可生产性规则段（判定式原文+逐镜头 WARN 或无命中）⑥镜头清单摘要。

## D3 已拍板：三按钮并列

- 保留「导出整集」（JSON，`name="export-episode"` 不动——既有 E2E/文案零破坏）+ 新增「导出分镜表」（`name="export-episode-markdown"`）「导出报告」（`name="export-episode-report"`），同 READY 条件渲染、同 `pending` 禁用。
- `performStoryboardExport` 增 `format` 入参；EXPORT_DURATION_DEVIATION 弹层、成功通知（含哈希末四位、无路径）三入口共用；`exportNotice` 复用同一状态行。

## 定案事实

- **默认文件名**：`EPISODE_JSON → export_<p>_<e>_v<N>.json`（不变）；`MARKDOWN_TABLE → storyboard_<p>_<e>_v<N>.md`；`PRODUCIBILITY_REPORT → report_<p>_<e>_v<N>.md`。save dialog 过滤器 json → `JSON`、md → `Markdown`。
- **分镜表列**：`| 镜头号 | 景别 | 运镜 | 时长(s) | 叙事目的 | 台词/旁白 | 角色 | 场景 | 锁定 |`；单元格转义 `\|`→`\|`、换行→空格；锁定列 = `locked_paths.length`（0 呈现 `—`）；表头上方两行事实（标题+版本/Σ/export_id/exported_at）。
- **审计**：metadata 增 `format`；其余键与红线（无源内容、无路径）不变；`STORYBOARD_EXPORTED` 单动作三形态。
- **勘误随行**：既有 spec「组装」requirement 中 `contains_ai_assisted_content=source_type 为 AI_ASSISTED` 与实施（`!== 'HUMAN_CREATED'`，AI_GENERATED 亦计）不符，本 change MODIFIED 一并对齐。
- **回滚**：纯增量（schema 加可选枚举、渲染纯函数、UI 两按钮），无迁移无数据改写。

## 测试策略

- **unit（application）**：分镜表渲染金样（表头/6 行/转义/锁定列/Σ 行）；报告渲染（WARN 命中与无命中/规则版本行/偏离原因行）；format 缺省=EPISODE_JSON；服务分支（默认名/审计 metadata.format 三值）；既有 13 测试零回归。
- **contract**：format 枚举合法值/非法值拒绝/缺省兼容（不带 format 的旧输入仍过）。
- **E2E（新 spec `storyboard-export-deliverables.e2e.spec.ts`，复用 seedStoryboardReady + JINGXU_E2E_EXPORT_DIR）**：READY → 数据通路导出分镜表/报告 → 读 `.md` 断言（表头恰 9 列、6 数据行、Σ=90 行、报告无 WARN 段+规则版本行）；editShot 镜头 1 时长 3→5 → 重确认 → 报告 WARN 命中行含 #1；审计 `format` 断言（node:sqlite 扩展脚本或新脚本）；UI 两按钮点击→成功通知（无路径）。
- **门禁**：新基线 752/124/204/18+3skip 之上只增不减。
