# Tasks: image-credential-management

## 0. 立项核对与拍板（Apply 前置）

- [ ] 0.1 产品负责人拍板 design.md D1–D4（D3 三方案选型与数值：SHOT_CONTRACT 超时 300 秒、超时重试预算 1 次、deadline 960 秒均可调），拍板结论回写 design.md 决策点汇总表
- [ ] 0.2 若 D3 非方案一：同步修订 jobrunner spec delta 两条 Requirement 与 4.x 任务分解，复跑 `openspec validate image-credential-management --strict`

## 1. 契约（contracts）

- [ ] 1.1 provider 契约扩展图片档：ProviderProfileDto 容纳 workspaceId 可空与分档 configured 判定；testCredential 输入/输出不变（分档分发属 Main 组合根）
      — 验证：contract 测试（含图片档 round-trip、strict 拒绝未知字段）；Renderer/Preload 类型单一来源同步
- [ ] 1.2 IMAGE_IPC 或 provider 通道错误文案：MODEL_CREDENTIAL_INVALID 的图片档 userAction 指向配置入口；Renderer ERROR_COPY 穷尽同步
      — 验证：contract 测试

## 2. Main 与组合根

- [ ] 2.1 图片档 defaults 注册与 testCredential 分档分发（文本档→Qwen 真实微调用不变；图片档→Seedream 解密校验）；provider 五通道对图片档全可用（保存/删除同步删密文+审计，沿用 CredentialAdapter 与审计路径）
      — 验证：composition 集成测试（真实 safeStorage 替身 + tmpdir secrets：保存→末 4 位→删除清理→审计事件；两档互不干扰）
- [ ] 2.2 `bootstrapImageCredential` 环境变量路径语义保持（wx 独占、已存在跳过、仅联调/E2E 门控）；UI 保存路径支持覆盖轮换；源码注释「配置流程随 7.x 联调接线」更新为指向本 Change
      — 验证：unit（独占创建矩阵：无文件→写入、已存在→跳过、UI 路径→覆盖）
- [ ] 2.3 凭据未配置/不可解时 `generateCandidates` 前置稳定失败 MODEL_CREDENTIAL_INVALID（含 userAction），替代适配器内 MODEL_UNKNOWN 兜底；其余五个 image 方法不受影响
      — 验证：image-api-service unit + image-ipc contract（未配置矩阵：生成拒绝、查询可用、无 Key/密文路径泄漏）

## 3. Renderer

- [ ] 3.1 `ProviderSettings` 新增图片 Provider 卡片（保存后清空输入、测试/删除、末 4 位、model id 只读展示、验证范围如实文案）；首帧面板对 MODEL_CREDENTIAL_INVALID 给出配置入口提示
      — 验证：组件测试（renderToStaticMarkup 基线）+ E2E：Mock 档下 UI 保存→测试→删除闭环，页面无完整 Key 长期状态
- [ ] 3.2 E2E 回归：既有 first-frame happy path 与 bootstrap 用例零回归（图片档未配置时首帧面板呈现引导而非静默失败）
      — 验证：Playwright Electron E2E

## 4. SHOT_CONTRACT 超时与重试（D3 方案一；拍板后按 0.2 修订）

- [ ] 4.1 `QwenTextModelAdapter` 按阶段推导调用超时（导出 STAGE→ms 常量表：SHOT_CONTRACT 300 秒、其余 120 秒；timeoutSignal 注入不变）
      — 验证：unit（各阶段超时常量、注入 clock 断言 abort 时机；其余行为零回归 9/9 式复跑）
- [ ] 4.2 JobRunner：MODEL_TIMEOUT 纳入 transport retry（独立预算至多 1 次，`transport_attempts` 0–3 CHECK 不变）；重试前复核剩余 deadline 预算；`deadline_at` 按阶段推导（SHOT_CONTRACT 960 秒、其余 300 秒）
      — 验证：unit/integration（超时→1 次重试→成功；预算不足直接终态；5xx 路径最多 2 次不变；崩溃恢复矩阵零回归）
- [ ] 4.3 既有测试基线同步（120 秒/300 秒断言、恢复矩阵）与 spec delta 数值一致性复核
      — 验证：全量门禁零回归

## 5. 门禁与打包

- [ ] 5.1 全量门禁：format / lint / typecheck / unit / contract / integration / e2e（离线 Mock）
- [ ] 5.2 Windows x64 packaged smoke 复跑：clean smoke（图片凭据哨兵泄漏扫描含 UI 保存路径）+ 既有升级 smoke 零回归

## 6. 真实联调与归档

- [ ] 6.1 真实联调复证：探针改走 UI 路径配置 ARK Key（替代 env 引导）走通首帧闭环；真实网络下 SHOT_CONTRACT 超时/重试行为留证（超时率对比 2026-08-17 基线 5/8）
- [ ] 6.2 README 同步（已实现/未实现/联调记录）、`openspec validate --strict`、归档
