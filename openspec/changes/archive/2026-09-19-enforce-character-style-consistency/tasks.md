## 1. 缺陷复现与契约基线

- [x] 1.1 为正式 `ScriptStageOutput/STORY_BIBLE` 信封新增失败单测，证明当前请求蓝图未注入 `data.characters/scenes`；同时覆盖合法裸 data 兼容、错误 stage、缺 data 与非法 JSON。
- [x] 1.2 在图片公共契约中以测试先行扩展 `assetType=STYLE`、一致性预检 DTO、缺失项有界约束与 `image.getConsistencyPreflight` 方法；验证 strict Zod 对未知字段和非法保留键拒绝。
- [x] 1.3 为单镜头和整集生成新增失败测试：缺 STYLE、缺任一出场 CHARACTER、StoryBible 损坏、必需参考图超限时不创建任务/候选/批次且不触发调度器。

## 2. 数据库与持久化

- [x] 2.1 开工时重新确认 migration head，创建唯一下一编号的前进 migration：安全重建 `assets`/`asset_versions` 以支持 STYLE，保留全部行、parent_id、唯一约束、索引和 immutable trigger，不改写历史 migration。（0022_media_style_assets.sql，head 21→22）
- [x] 2.2 扩展 MediaAssetType、Repository 映射与查询，强制 STYLE 使用 `project-style` 保留键并复用同一逻辑资产升版；新增 Repository 单元/集成测试。
- [x] 2.3 扩展 migration 集成测试，覆盖空库、当前 head 升级、100+ 资产历史版本/父链、重复 STYLE 拒绝、不可变 trigger、checksum 和 `foreign_key_check`，并验证升级失败回滚及备份不被覆盖。（0022 专项矩阵三用例）

## 3. StoryBible 解析与一致性预检

- [x] 3.1 实现 Application 层纯 StoryBible 描述解析器，区分正式信封、兼容裸 data 与稳定失败；让请求蓝图和预检共用该解析器并删除静默 `EMPTY_BIBLE` 降级。
- [x] 3.2 实现只读一致性预检服务：解析当前 READY 镜头，按 STYLE → 去重后的 character_ids → 可选 SCENE 解析资产版本，返回 StoryBible 状态、逐镜头状态和去重缺失项。
- [x] 3.3 将预检接入单镜头和批量生成写入前，映射 `MEDIA_CONSISTENCY_STORY_BIBLE_INVALID`、`MEDIA_CONSISTENCY_STYLE_REQUIRED`、`MEDIA_CONSISTENCY_CHARACTER_REFERENCE_REQUIRED`、`MEDIA_CONSISTENCY_REFERENCE_LIMIT_EXCEEDED`，并验证失败路径零写入、零 Provider 调用。

## 4. Prompt、世代哈希与 STALE 传播

- [x] 4.1 将 Prompt 模板升级为版本化的一致性模板，按画风、镜头、场景、角色身份/外观、机位/首帧、连续性、避免项的固定顺序组装；用金样单测锁定真实信封输出和身份保持文案。
- [x] 4.2 用同一解析结果构建生成输入和请求蓝图，按 STYLE → character_ids 原顺序 → SCENE 读取参考图；移除 `.slice(0, 14)` 静默截断，必需项超限稳定失败，可选 SCENE 超限产生可追溯 warning。
- [x] 4.3 将 Prompt 模板版本纳入参数指纹，把全部实际使用的 AssetVersion ID 纳入 generation_input_hash；扩展调用证据快照保存有序参考图 kind/ref/version/sha256 且不含图片字节或路径。
- [x] 4.4 扩展资产升版失效：STYLE 影响当前 READY 整集，CHARACTER/SCENE 按引用镜头；验证旧候选/选择保留并标 STALE_INPUT，不自动建档、不自动调用 Provider，失败可幂等重试扫描。

## 5. IPC、Preload 与 Renderer

- [x] 5.1 在 Main 注册 `image.getConsistencyPreflight`，完成 sender、DTO、project scope、输出脱敏和启动写门/只读查询边界测试；Preload 只暴露逐方法 API。
- [x] 5.2 扩展资产上传服务和 UI 支持 STYLE：画风入口固定 `project-style`，重复上传创建同资产新版本；CHARACTER 缺失项可预填 bibleRefId/displayName，所有预览继续使用 `jingxu://media`。
- [x] 5.3 在 FirstFramePanel 增加一致性状态卡，展示画风、当前镜头角色和 StoryBible 状态；缺失时生成按钮保持可见但禁用并提供上传/修复入口，服务端提交仍二次复检。
- [x] 5.4 在整集批量入口展示所有目标镜头去重后的缺失角色与画风状态，修复前不创建部分批次；补 Renderer 单测和 Electron E2E 覆盖单镜头/批量状态。（consistency-gate E2E 2026-09-19 复跑全绿 1/1，磁盘阻塞解除，见 6.3 注）

## 6. 文档、回归与门禁

- [x] 6.1 同步 TECH_DESIGN v1.1 的媒体资产枚举、预检 IPC、数据流、错误码、migration 与安全边界；更新 `docs/SQLITE_SCHEMA_TRACE.md`，保持 PRD v1.4 §10.2/§10.5 的“不承诺完全一致”边界。
- [x] 6.2 运行并记录 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:contract`、`pnpm test:integration` 与相关 `pnpm test:e2e`；报告通过/失败/跳过数量，禁止以跳过测试制造通过。（2026-09-18 实录：format:check 0 失败（4 处预先存在的主题遗留已另提交修复；lint 仅剩 low-cost-video-provider-integration 未跟踪文件 1 个 error，不属本 Change）；typecheck 干净；unit 1091/1091；contract 180/180；integration 265/265；E2E first-frame-panel 1/1、batch/image-credential/media-protocol/media-invocation-evidence 7/7、video-generation+composition-success 12/12 全绿后，磁盘降至 29MB（100%）导致内容寻址落盘失败，register-image-features 2/4 与 gate E2E 复跑被阻塞）
- [x] 6.3 使用 Mock 完成固定输入可重复性、零网络与 packaged image smoke；仅在用户凭据和成本授权仍有效时运行一次受控真实 Seedream 探针，证据只证明请求接受与链路成功，不宣称角色/画风质量已保证。（2026-09-19 实录，用户成本授权下执行：干净 main 树 1eab0c4 三段构建 + LOCALAPPDATA 隔离数据根——真实生产库已被未提交 low-cost-video 工作区联调迁移至 head 23，干净树应用按高版本守卫拒开，故以隔离根保全证据纯度与用户数据；Qwen 五阶段 + SHOT_CONTRACT 6/6 作业全部 INITIAL 一次成功（SHOT_CONTRACT 98s，对照 2026-08-17 基线超时 5/8）；Seedream doubao-seedream-5-0-lite-260128 轮1/轮2 各 4 候选：8×SUBMIT 全 HTTP 200 + 8×DOWNLOAD 成功，project-style 轮间升版致 generationInputHash 变化，人工选择指针保留 + 全量 STALE_INPUT 传播断言通过；真实字节经 jingxu://media 受限协议 UI 解码 8/8 naturalWidth>0（补段复用同项目数据）；D3 留证 model_invocations × media_generation_tasks 全 SUCCEEDED。探针 spec 同步适配一致性语义与 CINE 设置页（STYLE project-style 前置上传、details 折叠卡展开、镜头卡 ^#1(?!\d) 精确定位）。Mock 侧磁盘阻塞项本次清零：register-image-features 4/4、consistency-gate E2E 1/1 复跑全绿；packaged image smoke 以 2026-09-18 BD64B6F3 第五代构建实录为准，out/ 复打包留待试用前重建（用户已决先收敛视频 Change）。隔离证据库保留于 %TEMP%\jx-probe-localapp\JingxuStudio（4MB，含全部调用行与媒体证据），不宣称角色/画风质量）
- [x] 6.4 检查最终 diff、migration checksum、无密钥/用户图片/原始 Provider 内容泄漏和无关改动；运行 `openspec validate enforce-character-style-consistency --strict` 并进入 Verify，不在存在阻断项时 Sync/Archive。（validate 通过；6.2/6.3 所列磁盘阻塞项不阻断本 Change 提交，阻断 Sync/Archive）
