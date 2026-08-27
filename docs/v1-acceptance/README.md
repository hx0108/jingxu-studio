# 镜序 Studio V1 验收与试用包

本目录是 AC-V1-01～06 的统一验收入口和目标用户试用模板。它只记录可复验的本地证据，不把 Mock、开发者自测或代码存在描述成真实用户验收。

## 自动化验收分组

| ID                      | 场景                                                 | 当前证据                                     |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------- |
| E2E-AC01-ORIGINAL       | 原创输入建立可追溯工作区                             | `apps/desktop/e2e/v1-acceptance.e2e.spec.ts` |
| E2E-AC02-LOCKED-REWRITE | Main Dialog 导入 `.txt/.md` 并保留原文               | `script-input-file-sink.ts` + Electron spec  |
| E2E-AC03-EDIT-ROUNDTRIP | READY 分镜排序并返回新 EpisodeVersion                | `storyboard.reorderShots` + Electron spec    |
| E2E-AC04-FAILURE        | 主进程固定 Mock 失败矩阵、重试、修复、取消与迟到响应 | Electron spec + Mock Adapter                 |
| E2E-AC05-DIALOGUE       | 报告生成、快照绑定、SQLite 回读                      | Report/Finding/Override Repository           |
| E2E-AC06-LOCK-MATRIX    | 锁定字段写入被整次阻断                               | Electron spec + `shot-lock-policy`           |

执行顺序：

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:collection
pnpm test
pnpm test:contract
pnpm test:integration
pnpm test:e2e
pnpm package:win
```

SQLite Integration 与 Electron E2E 不并行运行。

设置 `JINGXU_E2E_EVIDENCE_DIR` 后，统一 spec 会把白名单 JSON 证据复制到该目录；未设置时证据仅保留在 Playwright 测试报告中。

最近一次 AC 自动化证据包（7 条规格，含崩溃恢复独立场景）：[`evidence/2026-08-27`](./evidence/2026-08-27/)。

## 统一试用任务（≤5 分钟说明）

1. 创建项目，选择原创创意或准备好的 UTF-8 `.txt/.md` 剧本。
2. 输入 1–30,000 个字符，确认数据处理说明；授权改编额外填写授权来源和声明。
3. 运行文本阶段，检查并锁定一个不希望被改写的字段。
4. 对未锁定字段执行一次选区改写，确认产生新版本且原文仍可恢复。
5. 生成/确认结构化分镜，做一次复制或排序，再导出 EpisodeStoryboardExport。

## 试用记录

见 [`trial-runbook.md`](./trial-runbook.md)、[`trial-record-template.md`](./trial-record-template.md) 和 [`trial-roster-template.md`](./trial-roster-template.md)。每位用户独立完成一次；记录开始/结束时间、是否代操作、错误、修改次数和导出结果。

当前试用轮次为 2026-08-27：固定构建（SHA-256 `E60F9075…`）、参与者画像、时间槽和三份独立记录见 [`trials/2026-08-27/session-plan.md`](./trials/2026-08-27/session-plan.md)；2026-08-24 组织单钉的旧构建已被本日新构建取代，不得再用作试用固定包。参与者与时间未确认前，不得勾选真实试用门槛。

## Bad Case 与 V2 决策

见 [`bad-case-template.md`](./bad-case-template.md) 和 [`v2-decision-template.md`](./v2-decision-template.md)。真实用户尚未组织前，模板保持空白。
