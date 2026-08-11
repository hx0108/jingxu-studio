# Schema Registry 发布验证记录（2026-08-11）

## 范围

本记录对应 OpenSpec Change `schema-registry-version-locks`。它证明离线四 Schema 启动门、SQLite manifest 成功证据、Electron 故障页和 Windows x64 资源随包发布；不证明 EpisodeValidator、JobRunner、Qwen、剧本、分镜、导入导出或 AC-V1-01 至 AC-V1-06 已完成。

## 锁定资源

| 资源                                  | `$id`                                                           | SHA-256                                                            |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ScriptStageOutput.schema.json`       | `https://jingxu.studio/schemas/script-stage-output/1.0.0`       | `128e7a49e1d5829c4b0c9cf89fc5e6fd883746f022e9759c157f70176309971f` |
| `ShotContract.schema.json`            | `https://jingxu.studio/schemas/shot-contract/1.1.0`             | `3fa77aa85152ad2500fcc1c07da5bec697da8810c572d1c378b0bf432f437e4b` |
| `EpisodeStoryboardExport.schema.json` | `https://jingxu.studio/schemas/episode-storyboard-export/1.1.0` | `55238d1958aae25341d137192cf544946b9d8b8767648a98a3956e01798fcb13` |
| `ProjectTransferBundle.schema.json`   | `https://jingxu.studio/schemas/project-transfer-bundle/1.0.0`   | `9736ee2421fa8b8febe683c6e41e3cae47665df5d7afe85592a25e4fa4fbabbb` |

## 已取得证据

- 定向 Unit：7 个文件，49/49 通过。
- 定向 Contract：4 个文件，21/21 通过。
- 定向 Integration 首轮 28/29；旧恢复断言补入 `SCHEMA_REGISTRY` 后，失败文件 5/5 通过，Composition Schema 写门 2/2 通过。
- 全仓 `pnpm format:check`、`pnpm lint` 和 `pnpm typecheck` 均通过。
- 全量 Unit：27 个文件，294/294 通过；全量 Contract：7 个文件，60/60 通过；全量 Integration：21 个文件，106/106 通过。
- `pnpm test:collection` 通过，互斥收集结果为 Unit 23、Contract 7、Integration 21、E2E 1 个测试文件。
- `pnpm test:e2e`：4/4 通过。新增场景在单 worker 下临时移走受控 Schema 副本，确认 `SCHEMA_RESOURCE_MISSING`、四个 Project Command 均为 `STARTUP_WRITE_BLOCKED`，恢复原文件后同一窗口重试进入 `READY`；`finally` 负责恢复遗留资源。
- Windows x64 Forge package 使用 Electron 43.3.0 本地 ZIP 目录成功完成。增强的 `scripts/verify-packaged-project-smoke.mjs` 验证：四资源与四 hash、Episode→Shot、Transfer→Script、manifest 四行、migration 1/2、项目 create/update/delete/restart/restore、外部 `.node` 为 0、真实用户数据根未访问。

## 离线 Electron 构建说明

直接联网下载 Electron ZIP 在本机失败；三份临时下载残片的 SHA-256 均不匹配官方 `18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9`，未被使用。打包改用此前由官方安装脚本校验并解压的 `node_modules/electron/dist` 生成本地忽略缓存 ZIP，再通过 Electron Packager 的 `electronZipDir` 选项注入：

```powershell
$env:JINGXU_ELECTRON_ZIP_DIR = "C:\path\to\electron-zip-directory"
pnpm package:win
node scripts/verify-packaged-project-smoke.mjs
```

该环境变量只影响构建，不进入 Main、Preload、Renderer 或产品运行时配置。若可获得官方 ZIP，应优先校验官方 SHA-256 后直接放入该目录。

## 收口状态

`openspec validate schema-registry-version-locks --strict` 已通过。OpenSpec Verify 已把 7 条 Requirement 与 22 个 Scenario 映射到实现、Fixture 和 Unit/Contract/Integration/E2E/packaged smoke 证据，未发现阻断项或规范漂移。

最终 Git diff 未修改四份根 Schema、`0001_initial.sql` 或 `0002_project_command_receipts.sql`；根 Schema 当前 SHA-256 与静态锁一致。本 Change 未引入 EpisodeValidator 集合规则、导入导出、JobRunner、Qwen、剧本、分镜或 V2/V3 能力。OpenSpec 39/39 任务完成，可进入 Sync/Archive 审批。
