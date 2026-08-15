# Tasks: shot-first-frame-image-generation

## 0. 立项核对与选型证据（Apply 前置）

- [x] 0.1 产品负责人确认开放决策点（design.md D6：候选数 N=4、提案先行立即 Apply、Provider=字节火山方舟 Seedream、上传 ≤20MB PNG/JPEG/WebP、候选全保留），2026-08-16 拍板并记入 design.md D6
- [x] 0.2 火山方舟官方文档核对豆包 Seedream 文生图与图生图两条 API 的 model id（doubao-seedream 系列，具体版本以官方为准）、参数、限制与同步/异步语义，写入 `provider_capability_snapshots` 静态快照草稿（source_url + sha256）
      — 验证：快照行可被启动路径读取，model id 无伪造（引用官方 URL）
  - 2026-08-16 完成：两份官方页面 webReader 直接抓取（API 参考 `docs/82379/1541523` + 模型列表 `docs/82379/1330310`，非搜索摘要）；锁定 `doubao-seedream-5-0-lite-260128`（官方表格备选 `doubao-seedream-5-0-260128`/`-4-5-251128`/`-4-0-250828`，均 500 IPM）；同步语义证实（该 API 无图片任务轮询接口）；无 `n` 参数 → D6-1 修正为 4 次独立请求；canonical capabilities_json（1381 字节）定稿于 design.md 0.2 小节，sha256=`801333f3…e3269`。快照行种子归 2.1（0009 迁移 INSERT），启动路径读取在 3.2/4.1 接线——「可被启动路径读取」的完整验证随 2.1/3.2 集成测试闭环

## 1. 公共契约（contracts）

- [x] 1.1 定义 ImageModelPort 类型（submit/poll/download、ImageGenerationRequest、ImageTaskSubmission/Status、ImageResultRef/ImageDownload）与 NormalizedModelError 图片错误码扩展
- [x] 1.2 定义媒体任务与候选 DTO（MediaTaskView、ImageCandidateView、AssetView/AssetVersionView、生成输入哈希输入集）
      — 验证：contract 测试通过；Renderer/Main/Preload 共享类型单一来源
  - 2026-08-16 完成：application ports/image-model（Port + 类型 + 类型测试 5 项）；contracts image-api（zod schema + ImageApi 六方法 + IMAGE_IPC_CHANNELS + mediaUrl 限 jingxu://media/ 前缀，contract 9 项）；ModelErrorCode 新增 MODEL_RESULT_UNAVAILABLE（AppError 枚举、Main 凭据文案表、Renderer ERROR_COPY 三处同步穷尽）；全仓 tsc 通过，Unit 573 / Contract 95 零回归

## 2. 持久化（A 线）

- [x] 2.1 迁移 `0009_media_assets_images.sql`：assets、asset_versions（不可变 trigger）、image_candidates、media_generation_tasks 及索引；head 8→9
      — 验证：迁移集成测试（含 v8 库升级路径 + 备份）；initial-schema-trace 更新
  - 2026-08-16 完成：四表 + 四索引 + partial unique `ux_image_candidate_selected`（每镜头至多一个当前选择）+ `trg_asset_versions_immutable`；CHECK 不变式（SUCCEEDED 必须文件四元组+调用证据、error_code 仅 FAILED、世代位唯一、phase 枚举、candidate_count 1–16、UNIQUE(project_id, idempotency_key)）；同迁移播种 `provider_capability_snapshots` 行 `volcark-seedream-image/v1`（SQL 内嵌 JSON 复算 sha256=801333f3…e3269 与 design 0.2 锁定值逐字节一致，集成测试断言 model id 无伪造）。`media-migration.integration.test.ts` 7 项（空库 head 9 / 快照 sha256 复算 / v8 升级保留 / 受管理备份 schemaVersion 8 / 资产·候选·任务三组约束矩阵）。同步更新 initial-schema-trace、既有四个迁移测试的 head 断言（8→9）、runtime 备份基线（currentVersion 9）、docs/SQLITE_SCHEMA_TRACE.md；design.md D3 修正（phase 单字段无冗余 status 列、input_hash→generation_input_hash）。全仓 tsc/eslint/prettier 通过，Unit 573 / Contract 95 / Integration 176 零回归
- [x] 2.2 内容寻址存储读写器：临时文件→哈希校验→原子 rename；projects 根防逃逸断言
      — 验证：unit/integration（含校验失败清理、符号链接拒绝）
  - 2026-08-16 完成：`createContentAddressedStore`（persistence src/media）落 `<root>/projects/<projectId>/{images|assets}/<sha前2>/<sha256>.<ext>`（TECH_DESIGN §8.1 布局）；写入 = 内存哈希→.tmp 落盘+fsync→复算校验→rename，失败清理 .tmp 且保留稳定错误码；同字节去重前先校验现存文件未损坏（防篡改静默通过）；`read`/`resolvePathWithinProjects` 以白名单正则（字符集排除 `..`）+ lstat 拒 symlink + realpath 逃逸 containment 三层防线。集成测试 7 项：回环/去重/损坏注入清理（writeFileImpl 注入模式）/mime 与 projectId 矩阵/非法路径矩阵/符号链接终节点+中间目录逃逸（本机 symlink 权限可用，真实执行非跳过）/磁盘篡改 CHECKSUM_MISMATCH。tsc/eslint/prettier 通过，media 目录 14 项全绿
- [x] 2.3 资产与候选事务：资产建档/升版、候选批量落库、选择指针原子切换、STALE_INPUT 传播与受影响镜头查询
      — 验证：integration（含部分失败回滚、不可变约束拒绝改写）
  - 2026-08-16 完成：Port 先行（application ports/media：MediaRepository 11 方法 + MediaUnitOfWorkPort 单仓储事务边界，records 不带 Row/SQL）；persistence `SqliteMediaRepository` + `SqliteMediaUnitOfWork`（SqliteTransactionCoordinator BEGIN IMMEDIATE，work 抛出即 ROLLBACK）。升版 version_no 事务内 max+1 并挂 parent；候选 round_no 每 shot max+1、index 0..n-1；完成态 UPDATE 带 `status='PENDING'` 守卫；选择切换先清后设（selected_by_context='USER'，FAILED 不可选 MEDIA_CANDIDATE_NOT_SELECTABLE、跨镜头 MEDIA_CANDIDATE_NOT_FOUND）；STALE 双传播（按 shot_version / 按 generation_input_hash）置 `STALE_INPUT, error_code=NULL` 保留文件四元组与选择指针，返回按镜头聚合摘要（ORDER BY shot_id）；坏行归一化 MEDIA_ROW_CORRUPT。集成测试 8 项（建档/冲突、升版链与聚合、批量落库+完成、选择切换矩阵、按哈希跨镜头 STALE+指针保留+幂等、按版本 STALE、work 中途抛出整体回滚、asset_versions UPDATE 被 trigger 拒绝 IMMUTABLE_VERSION_ROW）。门禁全绿：prettier/eslint/tsc，Unit 573 / Contract 95 / Integration 191 零回归

## 3. 适配器（B 线）

- [x] 3.1 MockImageModelAdapter：确定性 PNG 字节（种子可断言）+ 失败矩阵（网络/限流/审核拒绝/任务超时/部分候选失败）+ poll 抖动注入
      — 验证：unit 全矩阵；不触网断言
  - 2026-08-16 完成：`MockImageModelAdapter`（model-adapters/src/mock）实现 ImageModelPort 五方法。确定性 8 位灰度 PNG（像素 = (seedHash+7x+13y)&0xff，seedHash 为 invocationId 的 FNV-1a）；IDAT 为手写 stored-deflate zlib 流（本包约定零 node: 导入，CRC32/adler32 手写）；结果 URL `mock-image://<w>x<h>/<seed>` 本地重放字节，重启后无需内存态即可 download。submit 消费声明式步骤序列（SYNC/ASYNC+pendingPolls 抖动+pollFailure/ERROR/TIMEOUT），N 候选 = N 次 submit 天然表达部分候选失败；abort 归一化 MODEL_CANCELLED；非法 URL 归一化 MODEL_RESULT_UNAVAILABLE。unit 8 项全绿（字节稳定性+PNG 结构、SYNC 往返、失败矩阵、ASYNC 抖动、部分失败、取消、URL 非法、全程零 fetch 调用—沿 text mock 的 fetchSpy 模式）；另以 Node zlib inflateSync + 全 chunk CRC 复核独立验证字节合法性（含 >65535 多 stored 块路径）
- [x] 3.2 SeedreamImageModelAdapter（火山方舟）：submit/poll/download 三段（容忍同步返回与异步任务两种形态）、错误归一化、凭据经 safeStorage credential_ref（ARK Key）；model id 从 profile 配置读取（0.2 锁定值）
      — 验证：contract（Port 契约测试）；真实调用仅限联调探针门控
  - 2026-08-16 完成：`SeedreamImageModelAdapter`（model-adapters/src/volcark）实现 ImageModelPort 五方法。0.2 核对结论为同步形态 → submit 恒返回 SYNC 终态引用（URL+providerRequestId+usage 归一化），poll() 误用归一化 FAILED/MODEL_UNKNOWN 不伪造引用（红线）；构造期校验 modelId ∈ 0.2 锁定四 id 集合否则 MODEL_CONFIGURATION_INVALID。输入前置校验（总像素区间/宽高比/参考图 8 mime·14 张·30MiB，拒则不触网）；参考图手写 base64（零 node: 导入约定）编为 data URI；结果 URL 仅 https 且无 userinfo，下载后魔数嗅探（PNG/JPEG/WebP，不信任 Content-Type）。错误归一化矩阵：401/403→CREDENTIAL_INVALID、429→RATE_LIMITED(可重试)、≥500→PROVIDER_ERROR(可重试)、逐项 data[].error 只传播稳定错误码绝不透传 message（防提示词原文回显）；TimeoutError→MODEL_TIMEOUT、AbortError→MODEL_CANCELLED、SyntaxError→MODEL_INVALID_RESPONSE。validateCredential V1=仅解密加载校验（ARK 无免费探测端点），真实连通性留 7.1 门控。Key 全程经 CredentialPort（safeStorage credential_ref），不入日志/detail/返回值。unit 8 项全绿（含 fetchSpy 断言被拒输入零网络调用、JSON 序列化不含 Key/敏感词回显）；门禁全绿：Unit 589 / Contract 95 / Integration 191 零回归

## 4. 应用服务与恢复

- [ ] 4.1 MediaGenerationService：输入快照与哈希、Prompt 组装（镜头创意字段 + STORY_BIBLE 描述 + FormatProfile；SAME_SCENE_CUT 机位规则）、幂等键、任务状态机
- [ ] 4.2 调度与恢复：同项目媒体任务串行；启动扫描未终态任务（有 taskId 恢复 poll / 无 taskId 标记失败待人工）；取消与超时
      — 验证：integration（重启恢复、不自动重发、取消/迟到下载不落库）

## 5. IPC、协议与 Renderer（C 线）

- [ ] 5.1 Main 注册 `image` 方法级白名单六方法（generateCandidates/listCandidates/selectCandidate/listAssets/uploadAssetReference/getTask），全部受启动写门约束
- [ ] 5.2 `jingxu://media` 受限协议处理器 + CSP `img-src` 收紧；上传字节缓冲上限校验
      — 验证：E2E（越权标识拒绝、CSP 阻止外部图源）
- [ ] 5.3 Renderer：分镜工作区逐镜头首帧面板（按输入世代分组、候选比较、选择与切换、STALE 展示、受影响镜头清单）
      — 验证：组件测试 + E2e happy path（Mock）

## 6. 门禁与打包

- [ ] 6.1 全量门禁：format / lint / typecheck / unit / contract / integration / e2e（离线 Mock）
- [ ] 6.2 Windows x64 packaged smoke：clean（迁移 1–9、Mock 图片闭环、凭据哨兵泄漏扫描含图片通道）+ v8 升级 smoke
      — 验证：两项 smoke 通过

## 7. 真实联调与归档

- [ ] 7.1 真实火山方舟 Seedream 联调探针（门控环境变量，方舟 ARK Key 与 DashScope Key 分设）：上传参考图→文生图与参考图生图各至少一轮→候选落盘→人工选择→资产升版触发 STALE
- [ ] 7.2 生产库迁移 0009 留证（schema_migrations MAX(version)=9、备份生成）
- [ ] 7.3 README 同步（已实现/未实现/联调记录）、`openspec validate --strict`、归档
