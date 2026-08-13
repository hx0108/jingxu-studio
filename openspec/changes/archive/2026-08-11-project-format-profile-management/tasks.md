## 1. 工程边界与 Domain 基线

- [x] 1.1 在安装 Renderer 状态依赖前核验 React Query、React Hook Form、Zustand 与当前 React 19.2.8/TypeScript 6.0.3 的官方 peer 范围，精确锁定兼容版本并记录核验日期；不得使用 `latest` 或引入第二个锁文件。（Design §8）— 已核验 2026-08-09：`@tanstack/react-query@5.101.4`、`react-hook-form@7.85.0`、`zustand@5.0.14`，三者 peer 均含 React 19；按 saveExact 锁定，安装推迟至 §9 renderer 段。
- [x] 1.2 先扩展 `scripts/architecture-boundaries.test.ts` 使其在 `packages/domain` 导入 React/Electron/Zod/Node/SQLite、Application 导入 persistence、Renderer 导入 Node/Domain/persistence 时失败，再创建最小 `@jingxu/domain` package/tsconfig/public entry 并接入 workspace/TS project references。（Design §1）
- [x] 1.3 先添加名称值对象 Unit 测试：Unicode code point 0/1/100/101、首尾 Unicode 空白、NFC 等价、`zh-CN` 大小写冲突键和不静默 trim，再实现唯一规范化函数。（R: 创建项目必须原子保存 Project 与首个 FormatProfile / 项目字段非法或名称冲突；Design §3）
- [x] 1.4 先添加 FormatProfile Unit 测试：9:16/16:9 派生、默认 5/5/12/5、安全区 0/30/越界/NaN/Infinity、拒绝 1:1/fps/language/target_platform 伪造和语义相等，再实现纯 Domain preset/比较函数。（R: V1 FormatProfile 必须遵守正式规格边界 / 全部 Scenario；Design §3）
- [x] 1.5 添加 Project/FormatProfile 领域类型和枚举，证明 Domain 不含 DTO、路径、数据库 Row、审计或基础设施对象，并从公开入口导出所需符号。（Design §1）

## 2. Project Contract、错误与 Application Ports

- [x] 2.1 先添加 Contract 测试覆盖 Project/FormatProfile DTO、1–100 limit、ACTIVE/DELETED scope、opaque cursor、strict unknown-field rejection、ID/requestId/ISO datetime、两种画幅和四种 DialogueRenderMode。（R: 项目查询必须稳定且区分活动与已删除状态；R: Project IPC 必须是类型化白名单并服从启动写入门）
- [x] 2.2 先添加 Contract 测试覆盖 `AppResultDto<T>` 与稳定 AppError：fieldErrors、traceId、脱敏 message、全部 Project error code，并断言 SQL、堆栈、绝对路径、name/genre/style 和内部对象不能出现在错误 Fixture。（Design §2、§9）
- [x] 2.3 在 `packages/contracts` 实现 Project schemas/types、六个 channel 常量、`ProjectApi` 和扩展后的 `JingxuApi`，使 2.1–2.2 通过；RuntimeApi 行为保持兼容。（Design §2）
- [x] 2.4 在 `packages/application/src/ports/` 定义带 TSDoc 的 `ProjectUnitOfWorkPort`、事务内 Repository 集合、`ProjectDirectoryPort`、Clock/Id/hash 依赖；接口不得泄漏 Row、Statement、连接、SQL 或绝对路径。（Design §1、§5）
- [x] 2.5 添加稳定序列化/hash、单调 `updatedAt` 和 versioned cursor Unit 测试，覆盖属性顺序、scope/searchHash 不匹配、非法 base64/版本/时间和同毫秒连续写入。（R: 活动项目按稳定游标分页；R: 项目更新必须使用乐观并发并保留 FormatProfile 版本链；Design §6–§7）

## 3. ProjectService 测试先行与最小实现

- [x] 3.1 先用内存 Fake Ports 添加 list/get Unit 测试：真实空、筛选无结果、ACTIVE/DELETED 隔离、`updatedAt DESC,id DESC` keyset、limit/cursor、详情 current+history 和 `PROJECT_NOT_FOUND`。（R: 项目查询必须稳定且区分活动与已删除状态 / 全部 Scenario）
- [x] 3.2 先添加 create Unit 测试：9:16/NARRATION_FIRST 默认、16:9/四种对白模式、LOCAL_DEMO、系统字段派生、目录先于事务、名称冲突/字段错误/目录失败及任一写入故障的零部分结果。（R: 创建项目必须原子保存 Project 与首个 FormatProfile / 全部 Scenario）
- [x] 3.3 先添加 update Unit 测试：仅元数据更新、Dialogue event 仅变化时写、FormatProfile v2 parent/current、no-op 不制造版本/变更事件、单调 revision、陈旧 expectedUpdatedAt 和下游依赖阻断。（R: 项目更新必须使用乐观并发并保留 FormatProfile 版本链 / 全部 Scenario）
- [x] 3.4 先添加 delete/restore Unit 测试：二次确认后的软删除、陈旧版本、重复删除、恢复、重复恢复、恢复名称冲突、Project 目录零删除调用和审计证据。（R: 项目删除与恢复必须可审计且不静默删除文件 / 全部 Scenario）
- [x] 3.5 先添加幂等 Unit 测试：响应丢失后同 requestId/hash 返回原安全引用、不同 hash/command 返回 `REQUEST_ID_REUSED`、失败不留回执、同时重复调用共享执行、no-op receipt 和失败零成功事件。（R: Project Command 必须幂等且提交证据一致 / 全部 Scenario；Design §4）

  > ✅ §3.5 完成于本 commit：4 命令 receipt replay（同 requestId+command/hash → 重读当前态重建完整 `ProjectDetailDto`）/ 不同 command/hash → `REQUEST_ID_REUSED` / 失败不留回执 → 同 requestId 可安全重试 / no-op receipt replay（project-service.test 65 passed）。「同时重复调用共享执行」按 Design §4「Main 内的轻量 requestId 协调器」拆至 §3.6（task 3.6 owns 请求协调器）；DB `request_id` PK 真并发兜底留 §5（§4.2 已建表）。

- [x] 3.6 实现 `ProjectService`、错误归一化和请求协调器，使 3.1–3.5 通过；所有业务写入仅通过 UnitOfWork，事务内不得调用目录/网络/长文件操作。（Design §1、§4–§7）

  > ✅ §3.6 完成于本 commit：application 错误归一化——抽 `persistenceFailed(traceId,message)` 集中 4 命令 catch-all（create try/catch + update/delete/restore `.catch`），transient 类 `retryable` 修正（PROJECT_PERSISTENCE_FAILED / PROJECT_DIRECTORY_UNAVAILABLE 由 false→true，对齐「请重试」文案），binding-free catch 保证 SQL/堆栈/路径不泄漏；4 形状测试（create/update/directory/delete）断言 retryable+固定 message+对抗载荷不泄漏，project-service.test 合计 69 passed（65+4）。ProjectService 主体 +「写入仅走 UnitOfWork/事务内无文件 I/O」已于 §3.1–3.5 落实并通过。**请求协调器**按 Design §4 line 126「Main 内的轻量 requestId 协调器」属 Main 层（singleflight 共享执行 Promise），随 §7 Main IPC/Composition Root 实装——延续 §3.5 协调器拆分链条（§3.5→§3.6→§7）；§3.6 不写协调器代码。

- [x] 3.7 添加 AppError 安全 Unit 测试，注入 SQLite/文件异常、SQL、路径和堆栈，断言 Application 输出只保留稳定 code、userAction、fieldErrors 和 traceId。（Design §2、§9）

  > ✅ §3.7 完成于本 commit：扩展 §3.6 的 4 形状测试为「载荷类型 × 注入点」对抗矩阵——7 类对抗载荷（SQLite 约束/忙锁、文件 ENOENT、SQL 注入串、绝对路径堆栈、用户内容 name/genre/style、多帧堆栈）× 3 注入点（create insertProject / directory prepare / update updateProject），每格断言 AppError 字段集 = 稳定 {code,message,retryable,userAction,fieldErrors,traceId} 且 JSON 序列化后无任何载荷标记；补「非 Error 值（字符串/裸对象）」对抗锁定 binding-free catch 不变量（将来改 `catch(e)` 读 e.message/.stack 即红）。project-service.test 合计 **91 passed**（69+22）。门禁全绿：eslint 0、prettier、全量 tsc -b exit0。

## 4. `0002` Migration 与回滚证据

> ✅ §4.1–4.6 完成于 worktree commit `353da58`，经 merge `19e2b4c` 合回主干；勾选依据：`git show --stat`（7 文件）+ grep 核验 4.1 资源集合连续性 / 4.4 受管理备份与回滚 4 场景 / 4.5 压力库演练 + foreign_key_check。

- [x] 4.1 先添加 migration 集成测试，要求新资源集合为连续 `0001`/`0002`、`0001_initial.sql` 的已发布字节/checksum 不变、空库最终版本 2、重复启动跳过且 Forge 资源清单包含 0002。（Design Migration Plan）
- [x] 4.2 先添加 `command_receipts` DDL 负例：非法 command、非 64 位小写 hash、非法 JSON、重复 requestId、缺失 project FK；正例证明 result_ref 只需安全 ID/revision 且不要求用户内容。（R: Project Command 必须幂等且提交证据一致；Design §4）
- [x] 4.3 新增不可变 `0002_project_command_receipts.sql` 和必要索引，使 4.1–4.2 通过；不得修改 `0001_initial.sql` 或使用 `PRAGMA user_version`。（Design §4、Migration Plan）
- [x] 4.4 添加仅 0001 上一版本库的在线备份先行/manifest source=1 target=2/升级成功测试，以及 0002 中途失败、checksum 漂移、高版本库和备份失败的回滚/只读故障测试。（Design Migration Plan；复用 sqlite-migration-runtime Requirements）
- [x] 4.5 在 100+ 历史对象压力库执行 0001→0002 演练，对账历史行数/hash/父链、command_receipts 初始为空、`integrity_check`/`foreign_key_check`/当前 invariant audit，并记录耗时。（TECH_DESIGN v1.1 §17；Design §10）
- [x] 4.6 更新 `docs/SQLITE_SCHEMA_TRACE.md`、初始 schema trace/测试和 TECH_DESIGN v1.1 §8.4.1/§8.5，登记 `command_receipts`、约束、索引、回滚方式和“不保存用户内容”；不改 PRD 或四份业务 Schema。（Proposal Impact；Design §4）

## 5. SQLite Repository、UnitOfWork 与 invariant audit

- [x] 5.1 先添加 Row mapper 集成测试，覆盖 Project nullable 字段、软删除状态、FormatProfile JSON 安全区、current/history、坏 JSON/无 current/多 current 的错误归一化，且 Repository 外部不可见 Row/Statement/连接。（Design §1、§6）— 已完成 2026-08-10：新增 row-mapper.ts（Project/FormatProfile Row→聚合，越界安全区(>30)/坏JSON/缺字段/非数字归一化为 PersistenceRuntimeError，data_root_rel 不进聚合）+ sqlite-project-repository（findById 带 ACTIVE/DELETED scope 过滤、findActiveNameRefs）+ sqlite-format-profile-repository（findCurrent 多 current 抛错、findAllByProject 升序、findMaxVersionNo COALESCE→0）；syncToPromise 把同步 throw 桥接为 reject 以满足 Port 契约又避开 require-await；导出 SqliteOutputValue、persistence 新增 @jingxu/domain 依赖；9 集成测试全过。listPage/scanForSearch/insert/update/isCurrentReferencedByShotContract/unsetCurrent 留 Promise.reject 占位，待 §5.2–5.6。
- [x] 5.2 先添加 list/get 集成测试，覆盖稳定 keyset、同更新时间 tie-break、ACTIVE/DELETED、limit 1/100/101、名称搜索有界扫描与显式截断标志、cursor mismatch 和生产 SQL 不使用 `SELECT *`/OFFSET。（R: 项目查询必须稳定且区分活动与已删除状态 / 全部 Scenario；Design §7）— 已完成 2026-08-10：listPage（`updated_at DESC, id DESC` keyset，取 limit+1 判截断、丢弃多余，LEFT JOIN current FormatProfile 取 aspect_ratio 进 ProjectListItem）+ scanForSearch（取 hardLimit+1 判截断、不做名称过滤交 Application normalizeNameKey）；稳定列投影 PROJECT_LIST_COLUMNS 无 SELECT *、KEYSET_AFTER_CLAUSE 无 OFFSET。7 集成测试覆盖稳定排序/tie-break/scope 隔离/翻页+nextAfter/JOIN 画幅/扫描截断三态/续扫。cursor mismatch（scope/search 变旧 cursor）属 Main 解码层职责（IPC_INVALID_REQUEST），待 §7。
- [x] 5.3 先添加 create 集成测试，在单一 `BEGIN IMMEDIATE` 中断言 Project、FormatProfile v1/current、Audit、两个 Analytics、Receipt 同时提交；从 FormatProfile/Audit/Analytics/Receipt 各故障点回滚零残留。（R: 创建项目必须原子保存 Project 与首个 FormatProfile / 创建事务中途失败）
- [x] 5.4 先添加活动名称冲突集成测试，覆盖 NFC/大小写等价、软删除后可复用、恢复冲突和单写事务内检查；不得通过关闭外键或部分 unique 规则制造通过。（R: 项目字段非法或名称冲突；R: 恢复时名称发生冲突）
- [x] 5.5 先添加 update 集成测试，覆盖 expectedUpdatedAt 条件更新、单调 revision、metadata-only、FormatProfile 旧 current→0/新 v2→1/parent/versionNo、no-op 和每一步故障回滚。（R: 项目更新必须使用乐观并发并保留 FormatProfile 版本链 / 前四个 Scenario）
- [x] 5.6 先添加 ShotContractVersion 引用 current FormatProfile 的 Fixture，断言画幅更新返回 `FORMAT_PROFILE_DEPENDENCY_BLOCKED` 且所有 Project/Profile/Shot/Audit/Event/Receipt 均不变。（R: 已存在下游分镜依赖时修改 FormatProfile）
- [x] 5.7 先添加 delete/restore 集成测试，断言仅 Project 聚合 `deleted_at/updated_at` 变化、FormatProfile/子表/目录不删除、审计原子提交、状态/并发/名称冲突错误正确。（R: 项目删除与恢复必须可审计且不静默删除文件）
- [x] 5.8 先添加 CommandReceipt 集成测试，覆盖跨 adapter 重建的响应丢失重试、同 requestId 不同 hash/command、失败无 receipt、安全 result_ref 和无重复 Audit/Analytics。（R: Project Command 必须幂等且提交证据一致）
- [x] 5.9 实现 SQLite Project UnitOfWork/Repositories、参数绑定 SQL、Row mapper 和错误归一化，使 5.1–5.8 通过；事务所有权保持在 Application 回调边界，Repository 不嵌套 commit。（Design §1、§4、§6–§7）
- [x] 5.10 扩展启动 invariant audit：每个活动/删除 Project 都恰有一个 current FormatProfile、父链/版本号合法、活动名称冲突键唯一、receipt 引用可解析；依赖后续 Schema/StoryBible 的规则继续标记 `NOT_IMPLEMENTED_BY_CURRENT_BUILD`。（Design Risks；AGENTS.md §12.2）

## 6. 受管理项目目录 Adapter

> ✅ §6.1–6.3 完成于 worktree commit `64b58cb`，经 merge `ed0614b` 合回主干；勾选依据：`git show --stat`（4 文件）+ grep 核验 prepare（§6.1）9 用例 + cleanup（§6.2）6 用例（含符号链接/路径逃逸/非空不递归/rmdir 失败脱敏 WARN）。

- [x] 6.1 先添加 Unit/Integration 测试，覆盖 `projects/<project_id>` 系统派生、非法 ID、路径逃逸、符号链接、父目录不可写、临时写入/flush/delete 探测、Renderer 零路径输入及返回 handle 不含路径。（R: 项目目录不可用；Design §5、§9）
- [x] 6.2 先添加补偿测试：仅删除本次创建且仍为空的目录；预存目录、非空目录、清理失败和崩溃遗留目录不递归删除、不覆盖、不写成功记录，并只产生脱敏 WARN。（Design §5；Risk: 目录与 SQLite 无同一 ACID）
- [x] 6.3 在 Main 平台 Adapter 实现 `ProjectDirectoryPort` 并由 Composition Root 注入；所有文件 I/O 发生在事务外，不把绝对路径、FileHandle 或 fs 异常返回 Renderer。（Design §1、§5、§9）

## 7. Main IPC、Preload 与 Composition Root

- [x] 7.1 先添加 Project IPC Contract 测试，覆盖六个固定 channel、trusted main frame、子 frame/外部 URL 拒绝、参数个数、strict DTO、Result 输出校验、错误脱敏和 STARTUP 非 READY 写门。（R: Project IPC 必须是类型化白名单并服从启动写入门 / 全部 Scenario）
- [x] 7.2 实现 `registerProjectIpc`、共享但不通用化的 sender/error helper，并将 ProjectService 注入 Main；非受信 sender 直接拒绝，受信业务失败返回 AppResult。（Design §2、§9）
- [x] 7.3 先扩展 Preload Contract 测试，断言冻结的 `window.jingxu.project.list/get/create/update/delete/restore` 逐方法调用和双端 Zod 校验，且不存在通用 `send/on/invoke`、路径、SQL、Node 或 persistence 能力。（R: 合法 Renderer 创建项目；R: 非法 sender 或 DTO）
- [x] 7.4 更新 `JingxuApi`/Preload 实现并保持 RuntimeApi 回归通过；Renderer 只能从 `@jingxu/contracts` 获取 DTO，不深层导入其他包 `src/`。（Design §2、§9）
- [x] 7.5 扩展 Composition Root 集成测试：single-instance lock 后只有一个 SQLite 写连接，Project Adapter/Service/IPC 注册一次，关闭应用释放资源，启动故障时不构造可写 Project 入口。（R: 只读故障状态尝试写入；Design §1、§9）

## 8. Renderer 项目列表与创作设定

- [x] 8.1 添加并锁定 React Query、React Hook Form、Zustand 后，配置 QueryClient 和最小 store；测试证明 Query 是 Project 事实源、RHF 是表单源、Zustand 不复制 Project/FormatProfile 数据。（Design §8）

  > ✅ §8.1 完成于本 commit（worktree `codex/pfpm-8-renderer`）：精确锁定并安装 `@tanstack/react-query@5.101.4` / `react-hook-form@7.85.0` / `zustand@5.0.14`（saveExact，peer 含 React 19，§1.1 已核验 2026-08-09）。新增 `lib/query-client.ts`（projectKeys list/detail + `createQueryClient`：关 window-focus refetch、queries retry 1、staleTime 0、mutations retry 0）+ `store/project-ui-store.ts`（仅 `selectedProjectId`/`listScope`/`listFilter`/`isDirty` 四个 UI 协调字段，绝不复制 Project/FormatProfile 事实，Design §8 line 180/215）+ `main.tsx` 包 `QueryClientProvider`。`state-separation.test.tsx` 三测试（node 环境 + `renderToStaticMarkup`）：React Query 缓存命中即同步渲染 Project 名（事实源）/ RHF `getValues` 即读出 defaultValues（表单源）/ Zustand 键集恰为 4 协调字段且编译期 `@ts-expect-error` 拒绝 Project 事实。门禁：全量 `tsc -b` exit 0、renderer vitest 6/6、eslint 0、prettier clean。注：§1.1 所注「安装推迟至 §9 renderer 段」中的 renderer 段即 §8（§9 为文档/打包），本节按 §8.1 任务文落地安装；§3.6/§3.7 在主干 `codex/project-format-profile-management` 追踪（本 worktree 自 §3.5 `021bd9a` 分出，tasks.md §3.6 行 26 与 §8.1 行 71 不相邻，合回主干无冲突）。

- [x] 8.2 先添加 ProjectList 组件测试：启动加载、真实空、活动列表、筛选无结果、分页加载、回收站、Query 错误和“创建第一个项目”唯一主操作。（R: 项目查询必须稳定且区分活动与已删除状态；R: 项目页面必须覆盖完整交互状态并保护未提交编辑）
- [x] 8.3 先添加 ProjectForm 测试：默认 9:16/NARRATION_FIRST/5-5-12-5、横屏、四种 DialogueRenderMode、名称/安全区字段错误、1 秒内保存反馈、失败保留输入和成功才清 dirty。（R: 创建项目必须原子保存 Project 与首个 FormatProfile；R: 保存成功以后端提交为准；R: 保存失败保留输入）
- [x] 8.4 实现 ProjectList/ProjectForm、React Query hooks 和错误映射，使 8.2–8.3 通过；UI 不提交 width/height/fps/language/deployment/path，禁用操作保持可见并说明原因。（Design §2–§3、§8）
- [x] 8.5 先添加 ProjectDetail/设置测试：current+history、元数据更新、FormatProfile 新版本/no-op、陈旧冲突刷新、依赖阻断说明，以及未实现剧本/分镜入口可见禁用且无伪造数据。（R: 项目更新必须使用乐观并发并保留 FormatProfile 版本链；R: 后续能力尚未实现）
- [x] 8.6 先添加删除/回收站/恢复测试：影响范围二次确认、取消零 IPC、软删除列表迁移、恢复、恢复名称冲突和“不会删除 Provider 侧数据”边界文案。（R: 项目删除与恢复必须可审计且不静默删除文件 / 全部 Scenario）
- [x] 8.7 先添加 DirtyLeaveDialog 测试，覆盖项目切换、刷新、窗口关闭的“保存并离开/放弃修改/取消”，保存失败停留、放弃恢复最后提交值、取消保留编辑；再实现统一 dirty 协调。（R: dirty 表单离开；PRD v1.4 §15.1.1）
- [x] 8.8 完成键盘/焦点/ARIA/非颜色状态测试，确保分页、画幅选择、确认框、错误汇总和禁用原因均可无鼠标操作。（AGENTS.md §14）

## 9. E2E、打包、文档与最终验证

- [x] 9.1 扩展 Playwright Electron E2E：临时根首次创建默认 9:16 项目、创建 16:9 项目、重启后稳定列表/详情、Renderer 无 Node/路径/通用 IPC。（R: 使用 V1 默认值创建项目；R: 创建横屏项目；R: 合法 Renderer 创建项目）
- [x] 9.2 添加 E2E：字段失败保留、陈旧 update、软删除/回收站/恢复、恢复冲突、dirty 三选项和后续能力禁用说明；每个失败断言数据库无部分写入。（Specs 全部页面/并发/删除 Scenario）
- [x] 9.3 添加只读故障 E2E，证明故障页仍阻断项目页面和 create/update/delete/restore，伪造 sender/路径/机器字段不能进入 Application；原 runtime 恢复 E2E 继续通过。（R: 只读故障状态尝试写入；R: 非法 sender 或 DTO）
- [x] 9.4 从干净 `.vite/out` 使用已校验 Electron 缓存执行 Windows x64 package，确认 0001/0002 resources、零外部 SQLite `.node`、临时数据根升级/创建/重启/删除恢复、真实用户目录零访问。（Design §10、Migration Plan）
- [x] 9.5 在固定环境记录 Project create/update 的 P50/P95、事务语句数和目录准备耗时；断言事务内无文件 I/O、列表 limit/keyset 有界，不用波动的墙钟阈值删除或隔离测试。（TECH_DESIGN v1.1 §15；Design §10）
- [x] 9.6 同步 README、TECH_DESIGN v1.1 §3.3/§8.4.1/§11/§15、SQLite runtime/trace 文档和必要 AGENTS 架构示例；明确 SourceInput/Consent/Episode/Schema Registry/JobRunner 尚未实现，本 Change 不修改 PRD 和四份业务 Schema。（Proposal Impact）
- [x] 9.7 运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:contract`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm test:collection`、`pnpm package:win` 和 `openspec validate project-format-profile-management`，记录实际通过/失败数量、性能环境和未验证项。（AGENTS.md §15、§18）
- [x] 9.8 使用 `$openspec-verify-change` 核对 8 条 Requirement、32 个 Scenario、0002/备份/回滚、IPC/安全、页面状态和打包证据；阻断问题清零后才可 Sync/Archive，且不得声称 SourceInput、Episode、Schema Registry、剧本、分镜或 AC-V1-01 已完成。（OpenSpec archive guidance）
