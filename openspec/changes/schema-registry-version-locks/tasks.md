## 1. 依赖、锁清单与资源基线

- [x] 1.1 在安装前核验 Ajv 8 与 ajv-formats 对 Node 22.16.0、TypeScript 6.0.3 和 Draft 2020-12 的当前兼容范围，精确锁定版本并记录核验日期；不得使用 `latest`、`compileAsync` 或第二个锁文件。（Design §4）
- [x] 1.2 先添加锁清单 Unit 测试，断言恰好四条、完整 `$id` 唯一、ASCII 逻辑资源名唯一、Draft/版本匹配、SHA-256 为 64 位小写，并覆盖重复/缺字段/未知 ID 的 `SCHEMA_MANIFEST_INVALID` 与 `SCHEMA_ID_NOT_REGISTERED`。（R: Registry 必须以固定清单离线解析四份正式 Schema / 全部 Scenario）
- [x] 1.3 实现只读 `V1_SCHEMA_LOCKS` 与公开 Schema ID 类型，写入 Design 锁定的四组实时文件 hash；公开入口不得暴露绝对路径、Ajv 类型或可变集合。（Design §1、§3）
- [x] 1.4 先添加资源同步测试，再实现确定性同步脚本，把根目录四份 PRD-owned Schema 按锁清单字节复制到 `packages/validation/resources/schemas/v1/`；断言源/副本 hash 相等、无额外启用文件且四份源文件字节未被改写。（R: 开发态与打包态资源一致；Proposal Impact）
- [x] 1.5 创建最小 `@jingxu/validation` package、strict tsconfig、公开入口和 workspace references，并扩展架构测试：Validation 可依赖公开 Contract/纯领域值，不得导入 Electron、Renderer、Persistence、文件系统或网络模块。（AGENTS.md §7.1、TECH_DESIGN v1.1 §4.2）

## 2. Registry 核验与 Ajv 2020 内核

- [x] 2.1 先添加 Unit 测试覆盖四资源完整成功、缺失、非法 UTF-8/JSON、截断、hash 漂移、`$id`/Draft/版本不一致和重复 ID；断言失败不发布部分 Registry、错误码稳定且零路径/原文/堆栈泄漏。（R: 启动自检必须核对资源字节、身份、版本和引用闭包 / 前三个 Scenario）
- [x] 2.2 先添加引用闭包 Unit 测试，覆盖合法本地/内部 `$ref`、未知 ID、错误版本、非登记外部目标和注册顺序变化；通过网络 API 调用即抛错的守卫证明零 HTTP/DNS/动态加载。（R: 外部引用不在闭包中；R: 跨 Schema 引用必须在断网环境完成闭包校验）
- [x] 2.3 实现字节 hash、严格 JSON 文档身份解析、外部 `$ref` 收集和清单闭包核验；任一失败返回有界内部结果，不修改输入文档或清单。（Design §1、§4）
- [x] 2.4 先添加校验结果 Unit 测试，覆盖合法对象、非法对象、输入不变、问题数量上限，以及按 `instancePath/keyword/messageCode` 稳定排序的重复执行一致性。（R: 正式业务 JSON 必须通过 Draft 2020-12 校验并返回确定性结果 / 全部 Scenario）
- [x] 2.5 实现 Ajv 2020 全量预注册和同步编译四根 ID，接入确定性 format checker 与安全错误映射；禁止 `loadSchema`、`compileAsync`、`removeAdditional`、类型强制和默认值注入。（Design §4）
- [x] 2.6 添加 Registry 生命周期测试：成功前不可查询、四个编译器全部成功后一次发布、未知/漂移 ID 稳定拒绝、失败后重试不会复用污染的 Ajv/部分缓存。（R: Registry 必须以固定清单离线解析；R: 四份资源完整通过）

## 3. 正式 Fixture 与断网 Contract

- [ ] 3.1 为 ScriptStageOutput 创建一个最小合法 Fixture 和一个只违反单一约束的非法 Fixture，并添加目标 ID、预期结果和唯一 messageCode 元数据。（R: Fixture 必须覆盖每份正式 Schema）
- [ ] 3.2 为 ShotContract 创建一个最小合法 Fixture 和一个只违反单一约束的非法 Fixture，覆盖当前 1.1.0 DialogueRenderMode 条件而不伪造系统 ID。（R: Fixture 必须覆盖每份正式 Schema；AGENTS.md §15.4）
- [ ] 3.3 为 EpisodeStoryboardExport 创建一个最小合法 Fixture 和一个只违反被引用 ShotContract 单一约束的非法 Fixture，证明问题路径落在根对象中的 shot 实例位置。（R: Episode 导出离线解析 ShotContract；R: 被引用对象违反下游 Schema）
- [ ] 3.4 为 ProjectTransferBundle 创建一个最小合法 Fixture 和一个只违反被引用 ScriptStageOutput 单一约束的非法 Fixture，覆盖 Script→Episode→Shot 的传递引用闭包。（R: Transfer Bundle 离线解析完整引用链）
- [ ] 3.5 添加互斥 `*.contract.test.ts` 全量执行八份 Fixture，网络访问守卫为零调用；合法样本 4/4 通过，非法样本各只命中声明的一个 messageCode，不使用模糊快照。（R: Fixture 合法/单错误 Scenario；AGENTS.md §15.3）

## 4. Application Ports 与启动编排

- [ ] 4.1 先扩展 Startup Contract 测试：新增 `SCHEMA_REGISTRY` phase 和 Design §5 的十个稳定错误码，保持 `runtime.getStartupStatus/retryStartup/restoreBackup` 方法兼容并拒绝未知字段。（R: 启动门必须包含 Schema 与关键资源自检阶段）
- [ ] 4.2 在 Application 定义带 TSDoc 的 `SchemaResourcePort`、`SchemaRegistryPort`、`SchemaManifestUnitOfWorkPort`、事务内 `SchemaManifestRepositoryPort` 和 Schema 校验结果类型；接口不得泄漏 Buffer 可变引用、绝对路径、Ajv、Row、Statement、连接或 SQL。（Design §3、§7）
- [ ] 4.3 先用 Fake Ports 添加 `SchemaRegistryStartupService` Unit 测试：读资源→验证/编译→UnitOfWork 内替换并读回证据→发布顺序、任一阶段失败零发布、四条证据精确提交、错误归一化和相同输入确定性。（R: 四份资源完整通过；R: 证据写入失败）
- [ ] 4.4 实现 `SchemaRegistryStartupService`，确保文件读取/hash/编译均在事务外，证据事务成功后才原子发布 Registry；Application 不实例化 Main/Persistence Adapter。（Design §3、§7）
- [ ] 4.5 先扩展 `StartupService` Unit 测试：Persistence 成功后执行 Schema 阶段、成功才 READY、十类失败进入 `READ_ONLY_FAULT`、Schema 故障只允许 RETRY、revision 冲突和同 requestId singleflight。（R: Schema 阶段成功/失败；R: 修复资源后幂等重试）
- [ ] 4.6 将 Schema 启动 Port 注入 `StartupService`，保留数据库 restore 语义；Retry 从完整 Persistence 检查重新开始并重验四份 Schema，不新增通用或 `schema.*` IPC。（Design §5）

## 5. SQLite manifest 证据

- [ ] 5.1 先添加 `schema_registry_manifest` Row mapper/Repository 集成测试：空表、四条读取、坏 hash/版本/enabled 值归一化、参数绑定 SQL、无 `SELECT *`，且 Repository 外不见 Row/连接。（Design §1、§3）
- [ ] 5.2 先添加原子替换集成测试：空表写四条、旧四条替换、额外/缺失行清理，delete/每一条 insert/读回各故障点回滚保持旧集合，无部分新证据。（R: 数据库存在旧 manifest；R: 证据写入失败）
- [ ] 5.3 实现 `SqliteSchemaManifestUnitOfWork` 与事务内 `SqliteSchemaManifestRepository`，复用既有单写连接并由 Application 回调拥有短事务；Repository 不嵌套 commit，且不得修改 `0001_initial.sql`、`0002_project_command_receipts.sql` 或新增 migration。（Design §1、Migration Plan）
- [ ] 5.4 添加 Schema 阶段提交后审计：事务读回的启用 manifest 必须恰好匹配当前静态清单；现有前置数据库 audit 只验证表/行结构，不得用旧 manifest 反向批准资源或在新构建替换证据前阻断启动。（Design §1；AGENTS.md §12.2）

## 6. Main 资源 Adapter、Composition 与故障页

- [ ] 6.1 先添加 Main `SchemaResourceAdapter` 测试：只从注入的固定目录读四个逻辑资源名，拒绝缺失、目录项、符号链接、额外文件和路径逃逸；返回值与错误不含绝对路径且 Renderer 零路径输入。（R: Registry 离线解析；Design §2、§7）
- [ ] 6.2 实现开发态/打包态 Schema 资源目录派生和 Adapter；开发态指向受控资源副本，打包态固定 `process.resourcesPath/schemas/v1`，不接受环境变量、Renderer 或用户提供的任意路径。（Design §2、§7）
- [ ] 6.3 扩展 Composition Root 集成测试：single-instance lock 后复用单一数据库连接，依次执行 Persistence 与 Schema 自检，成功注入唯一 Registry；Schema 故障不构造真实 ProjectService/Job/导入导出入口。（R: Schema 阶段成功/失败）
- [ ] 6.4 把 Validation、Resource Adapter、manifest Repository 和 StartupService 在 Main Composition Root 组装；关闭应用释放资源，retry 重用安全边界但重新构建干净 Registry。（Design §3、§5）
- [ ] 6.5 扩展 Runtime IPC/Preload Contract 与故障页组件测试：显示 `SCHEMA_REGISTRY`、稳定错误码和脱敏摘要，保留冻结逐方法 API；故障状态四个 Project Command 返回 `STARTUP_WRITE_BLOCKED`，无通用 IPC/路径/Schema 原文。（R: Schema 阶段失败；R: 故障态尝试业务写入）

## 7. Forge 资源与发布证据

- [ ] 7.1 先扩展 Forge 资源测试，再配置 migrations 与 `schemas/v1` 两组 `extraResource`；断言产物路径固定、四文件 hash 匹配且零第五个启用 Schema。（R: 开发态与打包态资源一致）
- [ ] 7.2 扩展 Electron E2E：正常临时根显示 READY；缺失、hash 漂移或引用失败显示 Schema 只读故障；四个 Project 写命令稳定阻断；修复测试资源后同一窗口幂等 retry 恢复 READY。（R: desktop-workspace-foundation 全部新增 Scenario）
- [ ] 7.3 扩展 packaged smoke：从 Windows x64 产物读取四资源并对账 ID/版本/hash，在断网下验证 Episode 与 Transfer Bundle 引用链，确认零网络、零外部 SQLite `.node` 和真实用户目录零访问。（R: 开发态与打包态资源一致；R: 跨 Schema 引用）
- [ ] 7.4 更新 README、TECH_DESIGN v1.1 §3.4/§7.2/§8.4/§11/§15、Schema/SQLite trace 与发布清单，登记真实实现、十个错误码、四组 hash、manifest 证据和未实现边界；不改 PRD 或四份正式 Schema。（Proposal Impact；AGENTS.md §17）

## 8. 完整验证与 OpenSpec 收口

- [ ] 8.1 运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:contract`、`pnpm test:integration`、`pnpm test:collection` 和 `pnpm test:e2e`，记录实际通过/失败数量及网络守卫证据。（AGENTS.md §15、§18）
- [ ] 8.2 从干净 `.vite/out` 使用已校验 Electron 缓存运行 `pnpm package:win` 与 packaged smoke，记录四 Schema、两个外部引用链、manifest、零网络和用户目录隔离证据。（Design §6、Migration Plan）
- [ ] 8.3 运行 `openspec validate schema-registry-version-locks --strict` 并使用 `$openspec-verify-change` 映射全部 Requirement/Scenario 到代码、Fixture 和测试；阻断问题清零后才可 Sync/Archive。（OpenSpec archive guidance）
- [ ] 8.4 最终 diff 证明四份根 Schema、`0001_initial.sql`、`0002_project_command_receipts.sql` 字节未变，未引入 EpisodeValidator 集合规则、导入导出、JobRunner、Qwen、剧本、分镜或 V2/V3 能力。（Proposal Non-Goals）
