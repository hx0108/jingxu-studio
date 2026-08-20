# Tasks: storyboard-export

## 1. 组装与门禁核心（application 层）

- [x] 1.1 组装纯函数 `assembleStoryboardExport`（envelope 1.1.0 全字段确定性派生：ids/时间戳/LOCAL_USER/CURRENT_ONLY/versionNo/format_profile 投影含 *_pct 键改名/shot_contracts 原样携带 locked_paths/provenance 派生 contains_ai_assisted_content/app_version 注入）→ 验证：unit 金样对照 `episode-storyboard-export.valid.json` 字段集 + 投影键名断言
- [x] 1.2 READY_EXPORT 门禁 + 导出服务 `StoryboardExportService`（同一读快照：READY 判定→validateShotSetCollection 复跑→组装→Registry envelope 校验→Σ 软带 [60,120] 判定与 EXPORT_DURATION_DEVIATION 明细；错误码 EXPORT_NOT_READY/EXPORT_COLLECTION_INVALID/EXPORT_SCHEMA_INVALID）→ 验证：unit 门禁矩阵（非 READY/集合失败/越带缺原因/越带有原因放行）
- [x] 1.3 留痕接入（ScriptAuditRepositoryPort 写 STORYBOARD_EXPORTED：actor=USER/afterSha256/metadata{fileSha256,byteSize,totalDurationSec,deviationReason?}；审计失败 EXPORT_AUDIT_FAILED 带哈希）→ 验证：unit 断言 entry 字段完整 + metadata 不含源内容键

## 2. IPC 与 main 落盘

- [x] 2.1 contracts：`storyboard.exportEpisode` 命令/回执 DTO（回执无路径字段；warnConfirmed/deviationReason 可选入参）+ 通道枚举扩展 → 验证：contract zod 校验与错误形态
- [x] 2.2 main：registrar 注册第 4 命令（复用 sender/启动写门/singleflight/输出脱敏复验）+ `dialog.showSaveDialog`（默认名 export_<projectId>_<episodeId>_v<versionNo>.json；JINGXU_E2E 环境注入定名路径跳过真实对话框）+ 写文件 + sha256/byteSize 计算 + EXPORT_CANCELLED/EXPORT_FILE_WRITE_FAILED 分支 → 验证：组合根集成测试（路径不出现在任何回执/日志断言）
- [x] 2.3 preload 白名单 +1 与三处同步（jingxu-api.contract / job-provider-api.contract / bootstrap E2E §9.1 apiKeys）→ 验证：contract 套件绿

## 3. Renderer

- [x] 3.1 分镜工作台 READY 态「导出整集」入口（非 READY 不渲染）+ EXPORT_DURATION_DEVIATION 确认对话（展示实际 Σ + 原因输入 + 同命令重发）+ 成功/失败反馈 → 验证：E2E 导出往返
- [x] 3.2 重建三 bundle（vite.main/preload/renderer）→ 验证：E2E 全量不回归（17+3skip 基线）

## 4. E2E 与门禁收尾

- [x] 4.1 E2E：生成→确认 READY→导出→临时目录文件内容过 Registry 复验+留痕断言；越带 Σ 场景（mock 镜头时长构造）确认重发；非 READY 阻断 → 验证：E2E 新 spec 绿
- [x] 4.2 全量门禁（tsc -b/eslint/prettier/unit/contract/integration/e2e）→ 验证：全绿且基线 736/121/204/17+3skip 不回归（新增用例计入新基线）

## 5. 文档与归档

- [x] 5.1 README 当前已实现/最近验证证据/尚未实现三处更新 → 验证：人工复核
- [x] 5.2 openspec validate --all --strict + archive storyboard-export --yes → 验证：validate 10/10→11/11
