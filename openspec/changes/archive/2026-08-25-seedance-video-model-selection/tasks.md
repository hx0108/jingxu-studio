## 1. 模型注册与请求安全

- [x] 1.1 为三个 Seedance 选项建立版本化受限模型注册表，并先以单元测试覆盖合法模型、非法模型与各模型安全参数子集。
- [x] 1.2 让 Seedance Adapter 校验并提交任务冻结的 modelId，覆盖模型不可用 HTTP 404 的稳定脱敏错误映射。

## 2. Provider Profile 与任务冻结

- [x] 2.1 扩展视频 Provider Profile 命令与 Application Service：只允许视频 Profile 保存受限模型选择，并保持 requestId、expectedVersionId、凭据安全和旧 Profile 兼容。
- [x] 2.2 在新视频任务建档时解析当前模型、冻结 modelId/快照并覆盖切换设置后历史任务不变、新任务使用新模型的测试。
- [x] 2.3 复核现有 `provider_profiles.model_id`、`model_snapshot_date` 与媒体候选模型字段可承载选择和冻结；无需新增 migration，既有迁移保持不可变。

## 3. 桌面配置体验

- [x] 3.1 打通 Main、Preload 和 strict DTO，确保 Renderer 只能保存三项固定视频模型选择。
- [x] 3.2 更新视频 Provider 卡片为模型下拉选择与清晰权限提示，API Key 仍只经既有安全保存入口输入；补 Renderer/IPC Contract 测试。

## 4. 验证与文档

- [x] 4.1 更新相关技术设计/Provider 快照说明，标注该视频扩展不计入 V1 发布验收。
- [x] 4.2 运行 format:check、lint、typecheck、相关 unit/contract/integration/E2E 与 Windows 打包，记录实际结果。
  - 2026-08-25（main=c5828ff）实测：format:check 通过；lint（--max-warnings=0）通过；typecheck（tsc -b）通过；test:collection 通过（e2e 19 / contract 22 / integration 44 / unit 107 文件，范围互斥）；unit 954/954（111 文件）；contract 162/162（22 文件）；integration 249/249（44 文件）。
  - E2E 与 Windows 打包未于当日重跑，沿用 2026-08-24 全量门禁日志（docs/V2_VIDEO_COMPOSITION_GATE_LOG_2026-08-24.md：e2e 40 过+3 跳过、V2 定向 7/7、package:win 通过）——自该日志后运行时代码零改动（仅 openspec 规范文本与 .gitignore 变更），引用成立。
