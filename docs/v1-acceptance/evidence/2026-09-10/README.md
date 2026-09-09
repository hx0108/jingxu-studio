# AC-V1-01～06 Electron E2E 证据包

- 执行日期：2026-09-10
- 运行环境：Windows x64，Node 22.16.0
- 执行命令：

  ```bash
  JINGXU_E2E_EVIDENCE_DIR="docs/v1-acceptance/evidence/2026-09-10" \
    node_modules/.bin/playwright test apps/desktop/e2e/v1-acceptance.e2e.spec.ts --grep "E2E-AC0[1-6]"
  ```

- 结果：7 passed，0 failed（1.3m）。文件构成与 2026-08-27 包一致（AC01–06 + AC04 九个失败场景拆分 + Bundle 导出回执）。
- 构建状态：对应提交 `d40b40e`（`cine-workspace-theme` 主题落地，父提交 `4330dfa`）。同树验证：`tsc --noEmit` 干净、三段 vite 构建通过、`prototype-aligned-workspace.e2e.spec.ts` 通过（216/264/368 布局断言不变）、`packaged-smoke` 通过、renderer ui 单测 23 项通过。**本轮未复跑全量门禁**（unit 1076 / contract 180 / integration 262 / E2E 全量），如需与 2026-08-27 同规格的全量证据请另跑。
- 打包制品：`apps/desktop/out/镜序 Studio-win32-x64/jingxu-studio.exe`，225,441,792 字节，SHA-256 `20E6B02042776665BC3AD98AC914E0ECA14B2F58774954D743EF543546BAD8AC`。
- 证据范围：仅包含 Electron 主进程、Preload、Renderer 通过公开 IPC 生成的白名单 JSON；不含完整剧本、凭据或原始模型响应。
- 说明：该证据是开发者自动化验收，不等同于三名目标用户真实试用。真实试用组织单见 [`../../trials/2026-08-27/session-plan.md`](../../trials/2026-08-27/session-plan.md)。
