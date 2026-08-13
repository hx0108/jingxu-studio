## 1. 公共契约与并行冻结点

- [x] 1.1 测试先行定义 Script stable error codes、五阶段/版本状态 DTO、`script.initializeOriginal/getWorkspace/saveDraft/confirmVersion/restoreVersion` strict Zod Contract，并覆盖未知字段、跨项目 ID、机器字段和脱敏失败输出。（Staged Script：全部 Requirement；Design §8–§9）
- [x] 1.2 将 `job.create` strict DTO 冻结为 projectId、episodeId、stage、`operationType=GENERATE`、expectedInputVersionId、idempotencyKey、requestId；覆盖项目级/集级 episode 规则、延期 operation/stage 拒绝和同 requestId 异 payload 冲突。（JobRunner Modified Requirement）
- [x] 1.3 冻结 Application Script types/Ports：SourceInput、Consent、Episode、StoryBible/Script Version、StageHead、Dependency、Audit、CommandReceipt、只读 Workspace Query 与 `ScriptJobRepositories/ScriptUnitOfWorkPort`；不暴露 Row、SQL、路径或连接。（Design §2–§4）
- [x] 1.4 泛型化 JobRunner 的 UnitOfWork/JobCommitHandler，使默认 Job 基线保持类型兼容，而 Script commit 可在同一事务访问业务与 Job Repository；先补类型/回滚测试证明不得嵌套 UoW。（Design §2）
- [x] 1.5 建立三线 checkpoint：提交冻结的 Contract/Port/错误码与 Fake builders；A/B/C 线分别只写 Design §10 指定目录，共享 index/package/Composition 由主线统一处理。

## 2. A 线：Migration、Repository 与事务

- [ ] 2.1 测试先行新增 `0003_script_version_receipts.sql`：项目级 ScriptVersion partial unique，安全重建 command_receipts 扩展四个 Script 命令，保留旧 Project 回执、约束和索引。（Design §1）
- [ ] 2.2 验证 0003 的空库、v2 升级库、100+版本压力库、旧回执逐行对账、checksum 漂移、备份与注入失败回滚；更新 migration/Schema 追踪，禁止修改 0001/0002。
- [ ] 2.3 实现 SourceInput/Consent/Episode Repository 与坏 Row 测试，证明原始 UTF-8 字节、Unicode code-point 计数、20/2,000 边界、SHA-256 和显式列映射，不 trim、不截断。（原创初始化 Requirement）
- [ ] 2.4 实现 StoryBibleVersion/ScriptVersion/StageHead 读写与 keyset/有界历史；验证项目级/集级 scope、父链、version_no、current ownership、DRAFT/READY/STALE_INPUT 和 immutable trigger。（阶段确认/历史 Requirement）
- [ ] 2.5 实现 Dependency/Audit/CommandReceipt Repository，覆盖固定排序、重复边去重、安全 result ref、requestId 同载荷回放及异载荷拒绝，普通记录不含原文/Prompt/响应。（失效传播 Requirement）
- [ ] 2.6 建立 runtime 级唯一异步 transaction coordinator，并让 Project/Schema/Job/Provider/Script UoW 共享；测试并发写不会嵌套 BEGIN、事务内不等待目录/网络且失败释放队列。（Design §2）
- [ ] 2.7 实现 ScriptJobUnitOfWork 与最终提交故障矩阵：响应证据、DRAFT/READY/STALE版本、stage heads、dependencies、audit、receipt、Job SUCCEEDED 任一点失败均零部分写入。（两层契约/确认/传播 Requirement）
- [ ] 2.8 扩展 database invariant audit：项目级版本唯一、stage head 可解析且归属匹配、父链同聚合、JSON元数据/关系列一致、receipt result ref 安全可解析；合法旧库放行，坏库进入只读故障。

## 3. B 线：Application、Prompt 与 Job 生产接线

- [ ] 3.1 测试先行实现 OriginalInitializationService：19/20/2,000/2,001、空白原样语义、DATA_PROCESSING confirmation、单 Episode、requestId 幂等和初始化任一点失败全回滚。（原创初始化 Requirement）
- [ ] 3.2 实现 ScriptService workspace Query、全文 saveDraft、confirmVersion、restoreVersion；覆盖 expectedVersion 冲突、正式 Schema 错误、历史不可变、恢复 parent=恢复前 current 与 source/audit。（确认/历史 Requirement）
- [ ] 3.3 实现五阶段 prerequisite resolver 与稳定输入冻结；测试 READY-only、project/episode ownership、主 expected input、完整 `{objectType,objectId,versionId,sha256}` 集合稳定排序/hash及阶段依赖矩阵。（五阶段 Requirement）
- [ ] 3.4 实现依赖 DAG 与 `STALE_INPUT` 传播计划；覆盖各上游影响范围、内容/hash 保持、SYSTEM_INVALIDATION 来源、无下游、重复依赖去重与传播失败回滚。（传播 Requirement）
- [ ] 3.5 创建 `packages/prompts` 五个 `*/v1` 模板和 manifest/hash；测试用户内容边界、显式版本、固定 Candidate ID、无隐含“最新”、无 API Key、64K 超限阻断与 Prompt 可重复。（Design §5）
- [ ] 3.6 新增 TECH-internal ModelScriptStageCandidate 五阶段 strict Contract、每阶段 valid/single-error invalid Fixture 与模型伪造系统字段负例；不得进入四 Schema Registry manifest/Forge resources。（两层契约 Requirement）
- [ ] 3.7 调整 Qwen Adapter 只保证 message.content 为 string，把候选 JSON parse 留给 Candidate Pipeline；保持 Provider envelope JSON、401/429/5xx/timeout 脱敏映射，并证明 invalid candidate 能进入一次结构修复。（Design §5）
- [ ] 3.8 实现 Script JobSubmissionPort：同事务复检 prerequisites、冻结输入/Prompt/write_set、创建 QUEUED Job并支持 FAILED 人工 retry；延期模式/operation/SHOT_CONTRACT 在建 Job 前拒绝。（JobRunner Modified Requirement）
- [ ] 3.9 实现五阶段 buildRequest/buildContract/system injection/ScriptCommitHandler；修正 PRE_COMMIT `STALE_INPUT` 透传、commit 异常终态化及取消竞态，验证任何失败零业务版本且不会卡在 VALIDATING。（两层契约 Requirement）
- [ ] 3.10 实现序列化 scheduler 与恢复 revalidate：READY 后 kick、全局/项目并发门、完整响应 hash 校验后确定性幂等提交、未知结果不重发、页面切换不取消。（Desktop Modified Requirement）

## 4. C 线：Main IPC、Preload 与 Renderer

- [ ] 4.1 测试先行实现 Script Main IPC：可信 sender、strict input/output、启动写门、project scope、requestId singleflight/持久回放、稳定 AppError 与零路径/SQL/原文/Key/响应泄漏。（Staged Script UI Requirement）
- [ ] 4.2 扩展冻结的 `window.jingxu.script` 五方法与更新后的 job.create，Preload 双端 Zod 校验；证明无通用 send/on/invoke、Node、路径、SQL、Credential 或 Provider DTO。（Desktop Modified Requirement）
- [ ] 4.3 实现原创初始化页：原始字符计数、19/20/2,000/2,001、数据处理确认、错误保留和成功进入 Workspace；只开放 AI 原创，不显示已支持文件导入/授权改编/优化。（原创初始化 Requirement）
- [ ] 4.4 实现 Provider 设置页：凭据保存/测试/删除与 Workspace 保存为两个明确操作并分别反馈；占位 Workspace 或未验证凭据时阻断阶段生成，configured/last4 可见但完整 Key 不进 React Query/Zustand 长期状态、日志、截图或回显。（Design §8）
- [ ] 4.5 实现五阶段导航和 prerequisite 空态：项目级/集级阶段、生成入口、非 READY 禁用原因、DRAFT/READY/STALE_INPUT 文字+图标、分镜入口可见禁用。（五阶段/UI Requirement）
- [ ] 4.6 实现阶段编辑器：结构化全文表单/JSON Pointer 错误、保存 DRAFT、确认 READY、历史分页/查看/恢复、影响确认和成功以 Main commit 为准。（确认/历史/传播 Requirement）
- [ ] 4.7 实现 Job 状态与恢复：1 秒有界轮询非终态 job.get/list、页面不可见降频/停止、终态停止、刷新重查事实源、cancel/retry反馈；不得把 events 占位当实时推送。（Design §7–§8）
- [ ] 4.8 扩展 dirty 离开保护覆盖阶段/项目切换、刷新和关窗的保存/放弃/取消；保存失败停留且不取消持久化 Job，补键盘、焦点、ARIA和非颜色状态测试。（UI Requirement）

## 5. 主线集成、E2E 与交付

- [ ] 5.1 汇合 A/B/C 后统一修改公开 index、workspace references/package、PersistenceRuntime Script getter 和 Main Composition Root；READY 前保持 STARTUP_WRITE_BLOCKED，依赖不全时不激活半成品服务。（Desktop Modified Requirement）
- [ ] 5.2 用真实 ScriptService/Submission/Runner/Scheduler/Recovery 替换 `UNAVAILABLE_*` seam；覆盖幂等注册、启动恢复顺序、Provider 调用事务外、关闭生命周期与无 pending Job。（JobRunner/Desktop Modified Requirements）
- [ ] 5.3 E2E 使用 Mock 完成原创初始化→五阶段逐一生成DRAFT→确认READY→全文编辑→历史恢复→上游重新确认触发下游STALE_INPUT；同时覆盖失败保留、刷新Job继续、取消、dirty三选项和只读故障写门。
- [ ] 5.4 E2E/Integration 覆盖 401、429、5xx、120秒注入超时、非法JSON、一次结构修复失败、提交前STALE_INPUT、取消迟到响应、完整响应恢复和未知结果不重发；不使用真实网络或凭据。
- [ ] 5.5 clean Windows x64 package 并运行 packaged smoke：0001–0003、五 Prompt/hash、四公开 Schema且零第五公开Schema、冻结 script/job/provider 白名单、五阶段 Mock 闭环、零明文Key/原文普通日志、零真实用户目录访问。
- [ ] 5.6 同步 README、TECH 实现快照、SQLite/Prompt/测试文档：准确登记已实现的 AI 原创五阶段闭环，继续列明授权改编、局部改写/锁、分镜、导入导出、评测及真实用户验收未完成。
- [ ] 5.7 运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test:collection`、Unit、Contract、Integration、E2E、`pnpm package:win`，记录通过/失败数量、跳过项及真实 Qwen 人工检查未执行状态。
- [ ] 5.8 运行 `openspec validate staged-script-generation --strict`，建立全部 Requirement/Scenario→代码/Fixture/测试映射，定向证明四根 Schema 与 0001/0002 字节未变、无延期/V2/V3 泄漏；Verify 无阻断后才 Sync/Archive。
