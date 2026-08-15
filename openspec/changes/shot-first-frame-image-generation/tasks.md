# Tasks: shot-first-frame-image-generation

## 0. 立项核对与选型证据（Apply 前置）

- [x] 0.1 产品负责人确认开放决策点（design.md D6：候选数 N=4、提案先行立即 Apply、Provider=字节火山方舟 Seedream、上传 ≤20MB PNG/JPEG/WebP、候选全保留），2026-08-16 拍板并记入 design.md D6
- [x] 0.2 火山方舟官方文档核对豆包 Seedream 文生图与图生图两条 API 的 model id（doubao-seedream 系列，具体版本以官方为准）、参数、限制与同步/异步语义，写入 `provider_capability_snapshots` 静态快照草稿（source_url + sha256）
      — 验证：快照行可被启动路径读取，model id 无伪造（引用官方 URL）
  - 2026-08-16 完成：两份官方页面 webReader 直接抓取（API 参考 `docs/82379/1541523` + 模型列表 `docs/82379/1330310`，非搜索摘要）；锁定 `doubao-seedream-5-0-lite-260128`（官方表格备选 `doubao-seedream-5-0-260128`/`-4-5-251128`/`-4-0-250828`，均 500 IPM）；同步语义证实（该 API 无图片任务轮询接口）；无 `n` 参数 → D6-1 修正为 4 次独立请求；canonical capabilities_json（1381 字节）定稿于 design.md 0.2 小节，sha256=`801333f3…e3269`。快照行种子归 2.1（0009 迁移 INSERT），启动路径读取在 3.2/4.1 接线——「可被启动路径读取」的完整验证随 2.1/3.2 集成测试闭环

## 1. 公共契约（contracts）

- [ ] 1.1 定义 ImageModelPort 类型（submit/poll/download、ImageGenerationRequest、ImageTaskSubmission/Status、ImageResultRef/ImageDownload）与 NormalizedModelError 图片错误码扩展
- [ ] 1.2 定义媒体任务与候选 DTO（MediaTaskView、ImageCandidateView、AssetView/AssetVersionView、生成输入哈希输入集）
      — 验证：contract 测试通过；Renderer/Main/Preload 共享类型单一来源

## 2. 持久化（A 线）

- [ ] 2.1 迁移 `0009_media_assets_images.sql`：assets、asset_versions（不可变 trigger）、image_candidates、media_generation_tasks 及索引；head 8→9
      — 验证：迁移集成测试（含 v8 库升级路径 + 备份）；initial-schema-trace 更新
- [ ] 2.2 内容寻址存储读写器：临时文件→哈希校验→原子 rename；projects 根防逃逸断言
      — 验证：unit/integration（含校验失败清理、符号链接拒绝）
- [ ] 2.3 资产与候选事务：资产建档/升版、候选批量落库、选择指针原子切换、STALE_INPUT 传播与受影响镜头查询
      — 验证：integration（含部分失败回滚、不可变约束拒绝改写）

## 3. 适配器（B 线）

- [ ] 3.1 MockImageModelAdapter：确定性 PNG 字节（种子可断言）+ 失败矩阵（网络/限流/审核拒绝/任务超时/部分候选失败）+ poll 抖动注入
      — 验证：unit 全矩阵；不触网断言
- [ ] 3.2 SeedreamImageModelAdapter（火山方舟）：submit/poll/download 三段（容忍同步返回与异步任务两种形态）、错误归一化、凭据经 safeStorage credential_ref（ARK Key）；model id 从 profile 配置读取（0.2 锁定值）
      — 验证：contract（Port 契约测试）；真实调用仅限联调探针门控

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
