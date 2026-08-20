# Tasks: storyboard-export-deliverables

## 1. contracts + application（渲染纯函数与服务分支）

- [ ] 1.1 `storyboardExportEpisodeInputSchema` 增 `format` 枚举（`.default('EPISODE_JSON')`）；contract 测试：合法三值 / 非法值拒绝 / 缺省兼容（旧输入不带 format 仍过）
- [ ] 1.2 分镜表渲染纯函数（application）：表头 9 列、逐镜头行、单元格转义（`\|`、换行→空格）、锁定列=locked_paths 数量（0 呈现 —）、头部事实行（versionNo/Σ/export_id/exported_at）；unit 金样（含 6 镜头金样与转义用例）
- [ ] 1.3 可生产性报告渲染纯函数：常量 `PRODUCIBILITY_RULES_VERSION='jingxu-producibility-rules/1'`、`SPEECH_DURATION_WARN_SEC=4`；六章节（头部事实/时长事实/集合校验结论/AI 参与度/规则段/镜头清单摘要）；unit：WARN 命中与无命中、偏离原因行、规则版本行
- [ ] 1.4 服务 format 分支：三种 format 共用 prepare（envelope 组装+Registry 校验）与 Σ 判定，仅分叉渲染/默认名（export_/storyboard_/report_ 前缀与 .json/.md 扩展名）/审计 metadata.format；既有 13 个 unit 零回归 + 新增分支断言

## 2. main + renderer

- [ ] 2.1 sink 按 format 分支默认扩展名与 save dialog 过滤器（json→JSON、md→Markdown）；组合根注册测试同步
- [ ] 2.2 StoryboardPanel READY 态新增「导出分镜表」「导出报告」按钮（name=export-episode-markdown / export-episode-report，同 pending 禁用）；ScriptWorkspace `performStoryboardExport` 增 format 入参，偏离弹层与成功通知三入口共用；script-view 测试：READY 三入口、DRAFT 三入口全无
- [ ] 2.3 重建三个 vite bundle（main/preload/renderer）

## 3. E2E 与门禁

- [ ] 3.1 新 E2E `storyboard-export-deliverables.e2e.spec.ts`：seed READY → 数据通路导出分镜表/报告 → .md 内容断言（9 列表头/6 数据行/Σ=90/报告无 WARN 段+规则版本行）；editShot 镜头 1 对白时长 3→5 → confirmVersion 后报告 WARN 命中行含 #1；UI 两按钮点击成功通知（无路径）；审计 metadata.format 断言（node:sqlite 子进程脚本）
- [ ] 3.2 全量门禁零回归：tsc -b / eslint --max-warnings=0 / prettier / unit / contract / integration / 全量 E2E（新基线 752/124/204/18+3skip 之上只增不减）/ openspec validate --all --strict

## 4. 文档与归档

- [ ] 4.1 README：当前已实现 + 最近验证证据（新计数基线）+ 尚未实现清单收窄
- [ ] 4.2 openspec validate 本 change --strict → archive → merge main → 代理推送
