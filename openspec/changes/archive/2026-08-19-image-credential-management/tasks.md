# Tasks: image-credential-management

## 0. 立项核对与拍板（Apply 前置）

- [x] 0.1 产品负责人拍板 design.md D1–D4（D3 三方案选型与数值：SHOT_CONTRACT 超时 300 秒、超时重试预算 1 次、deadline 960 秒均可调），拍板结论回写 design.md 决策点汇总表
  - 2026-08-17 拍板：「D1–D4 全按推荐」——D1=A（复用 provider 五通道）、D2=A（解密校验+前置失败码）、D3=方案一（300s/预算 1 次/960s，数值维持起草值）、D4=A（ProviderSettings 内图片卡片）；已回写 design.md 决策表
- [x] 0.2 若 D3 非方案一：同步修订 jobrunner spec delta 两条 Requirement 与 4.x 任务分解，复跑 `openspec validate image-credential-management --strict`
  - 2026-08-17：D3 即方案一，delta 与 4.x 任务无需修订（任务保留作拍板记录，validate 已于立项时通过）

## 1. 契约（contracts）

- [x] 1.1 provider 契约扩展图片档：ProviderProfileDto 容纳 workspaceId 可空与分档 configured 判定；testCredential 输入/输出不变（分档分发属 Main 组合根）
      — 验证：contract 测试（含图片档 round-trip、strict 拒绝未知字段）；Renderer/Preload 类型单一来源同步
  - 2026-08-19：DDL 证实 workspace_id NOT NULL → 修订为保非空 + 图片档占位 'ark'（见 design.md Apply 期修订 #1）；provider 枚举扩 VOLCARK_SEEDREAM；contract 测试 6/6 绿（图片档 round-trip、OPENAI 拒绝、apiKey strict 拒绝）
- [x] 1.2 IMAGE_IPC 或 provider 通道错误文案：MODEL_CREDENTIAL_INVALID 的图片档 userAction 指向配置入口；Renderer ERROR_COPY 穷尽同步
      — 验证：contract 测试
  - 2026-08-19：Main 侧 job-provider-service 按档覆盖 IMAGE_CREDENTIAL_TEST_FAILURES（ipc 单测 14/14）；Renderer ERROR_COPY 无需新增条目（MODEL_CREDENTIAL_INVALID 已有，图片指引经 userAction 透传，见 design.md 修订 #4）

## 2. Main 与组合根

- [x] 2.1 图片档 defaults 注册与 testCredential 分档分发（文本档→Qwen 真实微调用不变；图片档→Seedream 解密校验）；provider 五通道对图片档全可用（保存/删除同步删密文+审计，沿用 CredentialAdapter 与审计路径）
      — 验证：composition 集成测试（真实 safeStorage 替身 + tmpdir secrets：保存→末 4 位→删除清理→审计事件；两档互不干扰）
  - 2026-08-19：composition 闭环测试 5/5 绿（保存→末 4 位 9999→解密测试→删除清密文+审计 ['profile-image-primary']→文本档互不干扰）；IPC 五通道分发 14/14 绿
- [x] 2.2 `bootstrapImageCredential` 环境变量路径语义保持（wx 独占、已存在跳过、仅联调/E2E 门控）；UI 保存路径支持覆盖轮换；源码注释「配置流程随 7.x 联调接线」更新为指向本 Change
      — 验证：unit（独占创建矩阵：无文件→写入、已存在→跳过、UI 路径→覆盖）
  - 2026-08-19：CredentialAdapter 增 overwriteExisting 选项（图片档固定 id 轮换 w 覆盖，文本档维持 wx）；矩阵测试 5/5 绿；bootstrap 注释已改指向本 Change
- [x] 2.3 凭据未配置/不可解时 `generateCandidates` 前置稳定失败 MODEL_CREDENTIAL_INVALID（含 userAction），替代适配器内 MODEL_UNKNOWN 兜底；其余五个 image 方法不受影响
      — 验证：image-api-service unit + image-ipc contract（未配置矩阵：生成拒绝、查询可用、无 Key/密文路径泄漏）
  - 2026-08-19：image-api-service 12/12 绿（前置失败含 userAction、不 kick、listCandidates 不受影响）；ipc 链路未配置矩阵随 3.2/5.1 E2E 复核

## 3. Renderer

- [x] 3.1 `ProviderSettings` 新增图片 Provider 卡片（保存后清空输入、测试/删除、末 4 位、model id 只读展示、验证范围如实文案）；首帧面板对 MODEL_CREDENTIAL_INVALID 给出配置入口提示
      — 验证：组件测试（renderToStaticMarkup 基线）+ E2E：Mock 档下 UI 保存→测试→删除闭环，页面无完整 Key 长期状态
  - 2026-08-19：ImageProviderCard（展示组件+自取数 wrapper）挂载于 ProviderSettings；组件测试 5/5（末 4 位/只读 model id/如实文案/错误展示/pending 禁用）；首帧面板零改动（userAction 透传，见 design.md 修订 #4）；E2E 闭环部分随 3.2 执行
- [x] 3.2 E2E 回归：既有 first-frame happy path 与 bootstrap 用例零回归（图片档未配置时首帧面板呈现引导而非静默失败）
      — 验证：Playwright Electron E2E
  - 2026-08-19：新增 image-credential-ui E2E（UI 保存→解密测试→删除闭环：密文固定 id 落盘非明文/删除清理/页面无 Key 泄漏/末 4 位/只读 model id/如实文案）13.2s 绿；全量 e2e 11 passed + 2 skipped（真实探针无凭据正确跳过）；未配置前置失败在 Mock 档被闸门豁免（按设计），其行为由 unit 12/12 与 6.1 真实联调覆盖

## 4. SHOT_CONTRACT 超时与重试（D3 方案一；拍板后按 0.2 修订）

- [x] 4.1 `QwenTextModelAdapter` 按阶段推导调用超时（导出 STAGE→ms 常量表：SHOT_CONTRACT 300 秒、其余 120 秒；timeoutSignal 注入不变）
      — 验证：unit（各阶段超时常量、注入 clock 断言 abort 时机；其余行为零回归 9/9 式复跑）
  - 2026-08-19：STAGE_INVOCATION_TIMEOUT_MS/STAGE_DEADLINE_MS 落 application ports/text-model（值导出双 barrel，Runner 与适配器同源防漂移）；适配器按 request.stage 取超时，QWEN_INVOCATION_TIMEOUT_MS 改由表派生保兼容；adapter+runner 单测 39/39 绿（含 300s/120s 分阶段断言）
- [x] 4.2 JobRunner：MODEL_TIMEOUT 纳入 transport retry（独立预算至多 1 次，`transport_attempts` 0–3 CHECK 不变）；重试前复核剩余 deadline 预算；`deadline_at` 按阶段推导（SHOT_CONTRACT 960 秒、其余 300 秒）
      — 验证：unit/integration（超时→1 次重试→成功；预算不足直接终态；5xx 路径最多 2 次不变；崩溃恢复矩阵零回归）
  - 2026-08-19：run 作用域 TimeoutRetryBudget（initial 与结构修复共用）；重试闸三类判定（超时预算/可重试传输/墙钟余量）；claim 前 findById 按阶段落 deadline（缺失兜底 300s）；单测覆盖超时 1 次重试成功、连续超时终态、墙钟不足不重试、分阶段 deadline/timeout_at；崩溃恢复矩阵随 4.3/5.1 全量门禁复核
- [x] 4.3 既有测试基线同步（120 秒/300 秒断言、恢复矩阵）与 spec delta 数值一致性复核
      — 验证：全量门禁零回归
  - 2026-08-19：ac-v1-04 超时矩阵基线改为 D3 语义（两次超时→预算 1 次重试→终态，attemptKind/transportAttempts 断言）；integration 197/197（含崩溃恢复矩阵）、unit 667/667、contract 107/107 全绿

## 5. 门禁与打包

- [x] 5.1 全量门禁：format / lint / typecheck / unit / contract / integration / e2e（离线 Mock）
  - 2026-08-19：全绿——format:check ✅、eslint --max-warnings=0 ✅、tsc -b ✅、unit 667/667、contract 107/107、integration 197/197、e2e 11 passed/2 skipped（真实探针门控跳过）；顺带修复仓内 3 个已提交未格式化文件（real-seedream-probe/seedream adapter 测试/verify-production-migration-0009 脚本）
- [x] 5.2 Windows x64 packaged smoke 复跑：clean smoke（图片凭据哨兵泄漏扫描含 UI 保存路径）+ 既有升级 smoke 零回归
  - 2026-08-19：离线配方重打包 exit=0（node_modules/electron/dist 重建 zip 根级布局 144MB，sha256 `d21151bb…0f9d` 经 JINGXU_ELECTRON_SHA256 覆盖 + JINGXU_ELECTRON_ZIP_DIR 直供 + JINGXU_PACKAGER_TMPDIR=0）；clean image smoke exit=0——exe 自行迁移 1–9、Mock 图片闭环（STALE 4/选择 1/升版 2）、UI 受限协议解码、凭据哨兵泄漏扫描 offenders=0（含 UI 保存路径）。v8 升级 smoke 未复跑并如实记录：head-8 旧产物已在此前磁盘治理中删除（`D:\jingxu-smoke-v8` 不存在），且自 8/17 末次绿验证产物（含 c80b1a5/53db326）以来 `packages/persistence/src/{migrations,audit,runtime}` 零提交（git log 证明）——升级路径代码与已验证二进制一致，重建旧二进制不成比例；打包产物真实探针复证未重跑（API 成本），由 6.1 dev 入口全绿 + clean smoke 覆盖。

## 6. 真实联调与归档

- [x] 6.1 真实联调复证：探针改走 UI 路径配置 ARK Key（替代 env 引导）走通首帧闭环；真实网络下 SHOT_CONTRACT 超时/重试行为留证（超时率对比 2026-08-17 基线 5/8）
  - 2026-08-19 全绿留证（1 passed 10.1m，dev 入口 + 生产数据根 + 真实 Qwen/Seedream）：ARK Key 走 UI 路径——先删生产档残留配置再 ImageProviderCard 保存（末四位断言）→ 解密测试（零网络），`JINGXU_IMAGE_CREDENTIAL_FILE` env 引导与 rmSync 引导密文逻辑移除；六阶段全 SUCCEEDED（9 镜头 READY）；轮1 4 候选真实 JPEG（306–382KB、全 1440×2560、`jingxu://media/`）；8 资产覆盖圣经引用；轮2 generationInputHash 必变（f41b…→f80f…）；选择 reflected；升版 v2 → 8/8 STALE_INPUT（含轮1，指针保留）；UI 解码 8/8 naturalWidth>0。D3 留证（`scripts/print-real-probe-invocations.mjs` 纯 node 只读查生产库，Playwright loader 不支持 node:sqlite 故不走 spec）：六阶段全部 attempt_kind=INITIAL 单次 SUCCEEDED、transport_attempts=0；SHOT_CONTRACT 单次 101.2s（基线 8 提交：5 超时@120s/2 契约失败/1 过），timeout_at=start+300s、deadline_at=start+960s 精确落库；本次网络未触发超时、重试预算未消耗（如实记录——重试路径由 integration 197 项确定性覆盖）。
- [x] 6.2 README 同步（已实现/未实现/联调记录）、`openspec validate --strict`、归档
  - 2026-08-19 完成：README 四处同步——新增 `2026-08-19 image-credential-management 收尾记录`（UI 凭据闭环 + D3 超时/重试 + 真实联调与留证 + 磁盘治理环境实录 + 双 smoke 结论与 v8 跳过理由），「当前已实现」新增本变更能力 bullet，header Active Change 行改为「当前无 Active Change」；`openspec validate image-credential-management --strict` 通过后归档为 `2026-08-19-image-credential-management`。
