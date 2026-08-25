# AC-V1-01～06 Electron E2E 证据包

- 执行日期：2026-08-22
- 运行环境：Windows x64，Node 22.16.0，pnpm 11.16.0
- 执行命令：

  ```powershell
  $env:JINGXU_E2E_EVIDENCE_DIR = "docs/v1-acceptance/evidence/2026-08-22"
  pnpm test:e2e --grep "E2E-AC0[1-6]"
  ```

- 结果：6 passed，0 failed
- 证据范围：仅包含 Electron 主进程、Preload、Renderer 通过公开 IPC 生成的白名单 JSON；不含完整剧本、凭据或原始模型响应。
- 说明：该证据是开发者自动化验收，不等同于三名目标用户真实试用。
