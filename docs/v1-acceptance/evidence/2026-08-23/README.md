# V1 发布候选自动化证据（2026-08-23）

本目录由实际命令生成，不代表真实用户验收已完成。

- `E2E-AC01-ORIGINAL.json` ～ `E2E-AC06-LOCK-MATRIX.json`：统一 Electron AC 证据。
- `E2E-AC04-FAILURE-*.json`：主进程固定 Mock 的 401、429、5xx、超时、非法 JSON、结构修复失败、STALE_INPUT、取消/迟到响应和崩溃恢复分支。
- `gates/`：format、lint、typecheck、test collection、Unit、Contract、Integration、全量 E2E 和 Windows x64 打包实际日志。
- 全量 E2E：33 passed、3 skipped；跳过项为真实 Qwen/Seedream 探针，不作为 V1 自动门禁前置。
- 三名真实目标用户试用尚未组织；在 `docs/v1-acceptance/trial-roster-template.md` 和每人记录填完前，不得宣称 V1 已完成发布验收。
