# AC-V1-01～06 Electron E2E 证据包

- 执行日期：2026-08-27
- 运行环境：Windows x64，Node 22.16.0，pnpm 11.16.0
- 执行命令：

  ```powershell
  $env:JINGXU_E2E_EVIDENCE_DIR = "docs/v1-acceptance/evidence/2026-08-27"
  pnpm test:e2e --grep "E2E-AC0[1-6]"
  ```

- 结果：7 passed，0 failed（53.1s）。比 2026-08-22 包多一条 `E2E-AC04-FAILURE-CRASH-RECOVERY`（崩溃恢复独立规格），AC04 其余场景证据按文件拆分落盘；`project-transfer-project_*.json` 为 AC03 编辑往返内 Bundle 导出回执证据。
- 构建状态：与同日全量门禁同一棵树（unit 1076 / contract 180 / integration 262 / E2E 全量 42 passed + 4 skipped / package:win 通过），包含 `v2-voice-audio-timeline` 与 `prototype-aligned-workspace-ui` 两项能力。
- 证据范围：仅包含 Electron 主进程、Preload、Renderer 通过公开 IPC 生成的白名单 JSON；不含完整剧本、凭据或原始模型响应。
- 说明：该证据是开发者自动化验收，不等同于三名目标用户真实试用。真实试用组织单见 [`../../trials/2026-08-27/session-plan.md`](../../trials/2026-08-27/session-plan.md)。
