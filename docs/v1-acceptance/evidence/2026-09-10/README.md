# AC-V1-01～06 Electron E2E 证据包

- 执行日期：2026-09-10
- 运行环境：Windows x64，Node 22.16.0
- 执行命令：

  ```bash
  JINGXU_E2E_EVIDENCE_DIR="docs/v1-acceptance/evidence/2026-09-10" \
    node_modules/.bin/playwright test apps/desktop/e2e/v1-acceptance.e2e.spec.ts --grep "E2E-AC0[1-6]"
  ```

- 结果：7 passed，0 failed（50.5s，逐页对齐收尾树复跑；同日三轮迭代 `d40b40e` 1.3m / `faf9636` 1.0m 均通过，因观感对齐迭代作废）。文件构成与 2026-08-27 包一致（AC01–06 + AC04 九个失败场景拆分 + Bundle 导出回执）。
- 构建状态：对应提交 `f4fd3f2`（七页语义探针比对收尾：容器圆角 6px、按钮 13px、页题 24px；父链 `faf9636` CINE 组件级对齐 → `d40b40e` CINE tokens/字体 → `4330dfa` 2026-08-27 全量门禁树）。同树验证：三段 vite 构建通过、`prototype-aligned-workspace.e2e.spec.ts` 通过、`packaged-smoke` 通过、renderer 单测 114 项通过。**本轮未复跑全量门禁**（unit 1076 / contract 180 / integration 262 / E2E 全量），如需与 2026-08-27 同规格的全量证据请另跑。
- 打包制品：`apps/desktop/out/镜序 Studio-win32-x64/jingxu-studio.exe`，225,441,792 字节，SHA-256 `8C1D7EAA0987BCCF52038BF289FF0DFE7DFEE445136F1D06B870DBA13ACAFB3A`。
- 证据范围：仅包含 Electron 主进程、Preload、Renderer 通过公开 IPC 生成的白名单 JSON；不含完整剧本、凭据或原始模型响应。
- 说明：该证据是开发者自动化验收，不等同于三名目标用户真实试用。真实试用组织单见 [`../../trials/2026-08-27/session-plan.md`](../../trials/2026-08-27/session-plan.md)。
