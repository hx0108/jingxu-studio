## 1. Contracts and application ports

- [x] 1.1 新增 Transfer strict DTO、结果摘要、导入模式、警告和稳定错误码，并补 Contract 负例测试。
- [x] 1.2 冻结 Transfer Application Ports：Bundle 校验、文件读写、Transfer Repository、Workspace Query 和 runtime 级 UnitOfWork；禁止暴露 Row/路径/连接。

## 2. Bundle assembly and validation

- [x] 2.1 测试先行实现 ProjectTransferBundle CURRENT_ONLY 组装，覆盖四个 Script 阶段、StoryBible、Episode Storyboard、Hash 和媒体缺失警告。
- [x] 2.2 实现离线 Schema、跨对象引用、版本头、项目归属、UTF-8、大小和 Hash staging 校验；为每个非法输入保留单一错误 Fixture。
- [ ] 2.3 实现确定性 ID Mapping 与 NEW_PROJECT 文档引用重写；验证不创建 SourceInput/ConsentRecord 且导入项目进入 IMPORTED_SNAPSHOT。
- [ ] 2.4 实现 RETURN_TO_ORIGIN 基线 Hash/expected head 并发校验，并保证新版本写入不修改历史行。

## 3. Persistence and transaction

- [x] 3.1 实现 Transfer Repository/UnitOfWork，复用 `export_records`/`import_records`，覆盖状态、Hash、mapping、错误证据和 requestId 幂等。
- [x] 3.2 将导入版本、阶段头、依赖、审计、回执和记录写入同一 runtime Transaction Coordinator；补中途故障零残留集成测试。
- [x] 3.3 运行空库、0015 现有库、100+历史版本、重复导入和旧数据无损测试；仅在结构缺口被测试证明后新增 0016 migration。

## 4. Main, Preload and Renderer

- [ ] 4.1 实现 Main Transfer IPC、sender/READY gate/singleflight、系统 Open/Save Dialog 和原子文件 sink；路径不得进入 Renderer 或回执。
- [x] 4.2 实现 Preload 冻结 `transfer` 白名单和双端 strict DTO/result 校验，补未授权/未知字段/异常脱敏 Contract 测试。
- [ ] 4.3 在项目设置/项目列表接入导入导出 UI，展示校验状态、冲突、媒体缺失警告、Hash 和 IMPORTED_SNAPSHOT 门禁。

## 5. Verification and documentation

- [ ] 5.1 补 Unit、Contract、Integration 和 Electron E2E：合法导出、损坏/Hash/引用错误、NEW_PROJECT、RETURN_TO_ORIGIN、冲突、取消、幂等和回滚。
- [ ] 5.2 更新 README、TECH_DESIGN 验收追踪和 packaged smoke，确认 Transfer IPC、Schema、无路径/Key泄漏和不自动重启媒体任务。
- [ ] 5.3 运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:contract`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm package:win` 与 `openspec validate project-transfer-import-export --strict`。
- [ ] 5.4 执行 OpenSpec Verify；通过后 Sync Specs、Archive Change，并记录实际验证证据。
