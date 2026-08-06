# AGENTS.md

## 1. 文件用途

本文件是镜序 Studio 项目根目录的 AI 编码 Agent 执行护栏，适用于本目录及其全部子目录。

它用于约束 Agent 如何阅读需求、修改代码、维护契约、处理数据、运行测试和报告结果，不替代产品需求、技术设计或机器契约。Agent 必须以当前磁盘中的实际文件和代码为准，不得把方案、计划或文档基线描述成已经实现、上线或通过用户验证的产品能力。

## 2. 事实源与冲突处理

### 2.1 当前事实源

| 事实类型 | 权威文件 |
|---|---|
| 产品定位、版本范围、用户流程、功能语义和发布验收 | `镜序Studio_AI漫剧工作台_产品需求文档_PRD_v1.4.md` |
| V1 机器字段、枚举、必填项和 JSON 跨字段约束 | 四份 `镜序Studio_V1_*.schema.json` |
| 架构、接口、数据库、事务、安全、测试和工程规范 | `TECH_DESIGN.md`（v1.1） |
| AI 编码 Agent 的执行方式和交付纪律 | 本 `AGENTS.md` |

四份 PRD-owned V1 Schema 为：

- `镜序Studio_V1_ScriptStageOutput.schema.json`
- `镜序Studio_V1_ShotContract.schema.json`
- `镜序Studio_V1_EpisodeStoryboardExport.schema.json`
- `镜序Studio_V1_ProjectTransferBundle.schema.json`

### 2.2 冲突规则

1. 产品范围和产品语义以 PRD v1.4 为准。
2. 可机器执行的字段、枚举、必填项和 Schema 跨字段条件以对应 JSON Schema 为准。
3. 实现方式以 TECH_DESIGN v1.1 为准，但不得扩大 PRD 的当前版本范围。
4. 本文件只能提炼执行规则，不能覆盖上述事实源。
5. 若 PRD、TECH、Schema 或当前代码直接冲突，停止相关提交，列出冲突文件、字段或流程及影响范围；不得自行选择一个版本后静默继续。
6. 修改公开机器契约、进程边界、依赖方向或数据库事实源时，必须同步评估 PRD、TECH、Fixture、migration、导入导出和兼容性版本，不允许只改一个文件。
7. 引用规则时必须写明目标文档，例如“PRD v1.4 §9.7”或“TECH_DESIGN v1.1 §4.3.3”，不要只写没有文档名的裸章节号。

## 3. 项目概述与真实状态

镜序 Studio 是面向个人 AI 漫剧创作者的本地优先质量工作台。长期方向包括剧本、结构化分镜、资产生产、质量检查和局部返工，但当前开发目标仅为 V1“AI 剧本与结构化分镜”。

当前状态：

- PRD 和技术设计已形成可开发基线。
- 项目仍处于方案/开发阶段，不得声称已经上线、完成真实用户验证或具备生产级图片/视频生成能力。
- V1 首发为 Windows x64 Electron 本地桌面应用，单用户、无登录、无云同步。
- 结构化数据以 SQLite 为事实源，项目文件和导出文件保存在本地文件系统。
- 用户自备 API Key；V1 只接一个文本模型 Adapter。

## 4. V1 范围

### 4.1 必须支持

- 创意输入或已有 `.txt`/`.md` 内容输入。
- CONCEPT、STORY_BIBLE、EPISODE_OUTLINE、BEAT_SHEET、SCENE_SCRIPT、SHOT_CONTRACT 分阶段工作流。
- Project、FormatProfile、StoryBible、ScriptVersion、ScriptStageJob、ModelInvocation、ShotContractVersion、EpisodeVersion 和 LockRecord。
- 可编辑、可锁定、可恢复、可追溯的版本链。
- 首次模型候选固定生成 6–10 个 ShotContract；6–10 镜头和总时长 60–120 秒是正常产品目标，允许用户编辑或覆盖并记录 WARN。EpisodeStoryboardExport 的机器硬边界为 1–20 个镜头、30–180 秒，单项目最多 20 个 READY ShotContract；不得把正常目标误写成导出硬限制。
- DialogueRenderMode、静态能力快照、可生产性风险提示和版本化参考价格区间。
- 分镜编辑、拆分、合并、复制、排序、软删除和恢复。
- Markdown 展示导出、JSON 导入导出、ProjectTransferBundle 和离线 Schema Registry。
- 20–40 个结构化分镜评测样本及标注指南。
- AC-V1-01 至 AC-V1-06 的自动化验收证据。

### 4.2 V1 明确不做

- 图片、视频、TTS、口型和成片合成。
- 视觉 Provider 调用、实时 Provider Probe、多模型路由和真实视频成本对账。
- PDF、DOCX、OCR、超长小说自动拆书和批量多集生成。
- 云端账号、组织权限、协作、跨设备同步、订阅、积分和商业账单。
- 自动承诺分镜一定能被视觉模型成功生成。
- 语义质检替代人工终审。
- 仅通过配置把 V1 切换为公开在线服务。

Agent 不得以“为未来扩展”为由预建上述能力。V2/V3 代码只有在用户明确扩大任务范围且对应进入条件成立后才能开始。

## 5. 技术栈

- Electron、React、TypeScript、Vite。
- React Query 处理 IPC 异步状态，Zustand 处理局部编辑和跨组件 UI 状态。
- React Hook Form 处理表单；最终领域校验仍在主进程应用层。
- SQLite + `better-sqlite3`。
- Ajv 2020 校验正式 JSON Schema；Zod 校验 IPC DTO，二者不能互相替代。
- 阿里云百炼 OpenAI 兼容接口封装在 `QwenTextModelAdapter` 中。
- Vitest、SQLite 临时库和 Playwright Electron。
- Electron Forge 打包；pnpm workspace，仓库只保留 `pnpm-lock.yaml`。

依赖或模型快照可能变化。涉及 Provider、版本、地域、价格或数据政策的修改必须重新核验当前官方资料和本地快照，不得凭记忆更新。

## 6. 目标工程结构

```text
jingxu-studio/
├── apps/desktop/src/
│   ├── main/
│   │   ├── ipc/
│   │   ├── composition/
│   │   ├── scheduler/
│   │   └── adapters/
│   ├── preload/
│   └── renderer/
├── packages/
│   ├── domain/
│   ├── application/src/
│   │   ├── services/
│   │   ├── jobs/
│   │   └── ports/
│   │       ├── persistence/
│   │       ├── text-model/
│   │       ├── file-system/
│   │       └── credential/
│   ├── persistence/
│   ├── model-adapters/
│   ├── validation/
│   ├── prompts/
│   ├── contracts/
│   └── test-fixtures/
├── schemas/
└── docs/
```

如果代码仓库尚未完成脚手架，只按当前 Sprint 和 TECH_DESIGN v1.1 §4.2 创建需要的最小目录，不要一次性生成空的 V2/V3 模块。

## 7. 架构红线

### 7.1 依赖方向

```text
Renderer -> Preload / IPC Contracts
         -> Main IPC Host / Composition Root
         -> Application Services / JobRunner
         -> Domain + Application Ports

Application Services / JobRunner -> Validation
Infrastructure Adapters --implements--> Application Ports
```

必须遵守：

1. `domain` 不依赖 React、Electron、SQLite、文件系统、Provider SDK、Zustand、React Query 或 IPC。
2. Application 层拥有全部出站 Port；Repository 和 UnitOfWork 是持久化 Port。
3. JobRunner 的业务实现位于 `packages/application/src/jobs/`。
4. Electron Main 只承载 IPC Host、Composition Root、调度、启动恢复和生命周期。
5. Persistence、Model、File、Credential Adapter 实现 Application Ports，并由 Composition Root 注入。
6. Renderer 只通过 `window.jingxu` 调用逐方法 IPC，不得直接导入 Repository、Node 内置模块、`better-sqlite3` 或 Provider SDK。
7. Provider 专有 DTO、字段和错误仅存在于对应 Adapter。
8. Validation 可以依赖公开 Contract 和纯领域值对象，不得写数据库或调用 Provider。
9. 跨包只使用公开入口，不深层导入其他包的 `src/` 私有文件，不用关闭 lint 规则掩盖循环依赖。

### 7.2 AI 与确定性工作流边界

- LLM 只生成候选内容，不决定系统 ID、版本号、状态、锁、权限、重试策略或事务结果。
- JobRunner 注入系统字段，再执行正式 Schema、锁复检和 EpisodeValidator。
- LLM finding 只能补充 Observation 和 Recommended Action，不能伪造 Provider 能力或独立产生 `BLOCK`。
- `READY` 仅表示结构有效且无未处理 BLOCK，不代表视觉生成成功或质量合格。
- 可生产性检查是启发式风险提示，不是失败率预测或平台合规保证。
- Agent 负责理解、规划和建议；确定性代码负责执行、状态和审计。

## 8. Agent 工作流程

### 8.1 开工前

1. 读取本文件和与任务直接相关的 PRD、TECH、Schema、代码及测试。
2. 使用 `rg`/`rg --files` 定位事实，不依赖旧对话或历史记忆代替当前文件。
3. 检查工作树状态，区分用户已有修改和本次修改；不得覆盖无关改动。
4. 明确本次任务属于哪个 Sprint、PRD 验收项和测试层级。
5. 识别是否会修改公开契约、migration、进程边界、Provider 配置或安全边界。
6. 若需求缺少会显著改变产品语义的选择，先报告缺口并请求确认。

### 8.2 修改时

- 保持最小、聚焦的变更范围，不顺手重写无关模块。
- 新行为先补可失败的测试或 Fixture，再完成最小实现。
- 修改业务行为时同步更新相关测试、错误码、审计和文档。
- 不静默截断输入、吞掉异常、自动降低安全设置或跳过校验。
- 不把失败写成成功，不把 Mock 结果写成真实 Provider 验收结果。
- 不修改或删除用户数据来让测试通过。
- 不使用破坏性 Git 或文件命令处理不属于本任务的内容。

### 8.3 交付时

1. 运行与变更风险匹配的完整验证命令。
2. 检查 diff，确认没有密钥、用户内容、临时文件、错误锁文件或无关格式化。
3. 报告实际运行的命令、通过/失败数量和未验证项。
4. 只有获得当前运行证据后才能声称测试、构建或验收通过。
5. 若仓库尚无可执行代码或脚本，明确写“仅完成文档/脚手架，未运行代码测试”。

## 9. TypeScript 与代码风格

### 9.1 强制基线

- 开启 `strict`、`noImplicitAny`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- 未说明原因不得使用 `any`、`@ts-ignore` 或非空断言逃避类型检查。
- ESLint 使用 Flat Config；未处理 Promise、循环依赖和跨层非法 import 为 error。
- Prettier 是唯一格式化器；EditorConfig 使用 UTF-8、LF、文件末尾换行并删除无意义行尾空格。
- 注释解释约束、风险和原因，不复述代码。
- 公开 IPC、Application Ports 和复杂领域不变量必须提供简短 TSDoc。

### 9.2 命名

| 对象 | 规则 |
|---|---|
| React 组件、类、类型 | `PascalCase` |
| 函数、变量、Hook | `camelCase`，Hook 以 `use` 开头 |
| 真正常量 | `UPPER_SNAKE_CASE` |
| 普通 TypeScript 文件 | `kebab-case.ts` |
| React 组件文件 | `PascalCase.tsx`，一个文件一个主组件 |
| 包和目录 | `kebab-case` |
| 数据库对象 | `snake_case`，索引使用 `ix_`/`ux_` 前缀 |
| IPC 方法 | `namespace.method`；Command 用动词，Query 用 `get/list` |

单文件只承担一个主要职责。文件变大或出现多种变化原因时按领域责任拆分，不按“工具类大杂烩”集中代码。

## 10. 契约、版本和锁

### 10.1 Schema

- 正式业务结果必须通过对应 PRD-owned Schema；Episode 还必须通过集合校验器。
- Schema Registry 离线解析 `$ref`，运行时不得访问 `jingxu.studio` 获取 Schema。
- 启动时校验 `$id`、Draft、版本、文件 SHA-256 和相互 `$ref`；失败进入只读故障页。
- 模型候选 DTO 与正式业务契约分离；模型不得生成系统元数据。
- 每个公开阶段至少保留一个合法 Fixture 和一个仅含单一错误的非法 Fixture。
- 修改 Schema 时必须评估 `$id`/版本兼容、Fixture、派生类型、导入导出及历史数据；不得直接改生成物造成分叉。

### 10.2 不可变版本

- AI 生成、人工保存、拆分、合并、复制和恢复都创建新版本，不覆盖历史版本。
- 恢复等价于基于历史内容创建新的当前版本。
- 写入新版本、更新 current pointer、审计、依赖边和 EpisodeVersion 快照属于同一事务。
- 上游版本变化后，不得 UPDATE 下游原版本；必须创建业务内容相同、状态为 `STALE_INPUT` 的新当前版本，父版本指向原当前版并记录失效原因，再在同一事务更新 current pointer。StoryBible/Script 在版本关系行写 `source=SYSTEM_INVALIDATION`；ShotContractVersion 没有 `source` 列，不得把该值写入契约 `provenance`，而是在 `audit_events.metadata_json` 记录系统失效来源、上游对象和原因，同时保证 JSON `status` 与关系列 `version_status` 均为 `STALE_INPUT`。原 READY/DRAFT 版本保持不可变且可查看，不静默拼接旧版本，也不自动重生成。
- EpisodeVersion 必须绑定明确的 ShotVersion、StoryBibleVersion 和 FormatProfile，导出不得读取之后仍会变化的 current pointer。
- Shot 复制创建新 `shot_id` 和 COPY 血缘；拆分/合并/排序/删除/恢复均遵守 TECH_DESIGN v1.1 §10 的原子语义。

### 10.3 锁

- 锁路径使用 RFC 6901 JSON Pointer。
- 生成前检查锁，提交前按最新版本再次复检。
- 锁路径与 write_set 相同或互为父子路径时阻断整次提交。
- 不存在路径、非法转义、数组下标或不可锁元数据路径不得保存。
- ShotContract 的 `locked_paths` 与有效 LockRecord 集合必须完全一致，不建立两个锁定事实源。

## 11. Job、Provider 与事务

### 11.1 Job 规则

- Job 的主路径和合法分支固定为：

```text
DRAFT -> QUEUED -> RUNNING -> VALIDATING -> SUCCEEDED
RUNNING -> RUNNING                 # 仅允许的 transport retry
VALIDATING -> RUNNING              # 最多一次 STRUCTURE_REPAIR
QUEUED/RUNNING/VALIDATING -> CANCELLED
RUNNING/VALIDATING -> FAILED        # 超时、不可重试错误或修复失败
任意非终态 -> FAILED               # input_version_changed，error_code=STALE_INPUT
```

- 不得把该状态机实现成只能单向前进的线性链；每个回环都必须同时满足次数、错误类型和证据记录条件。
- 终态不可回退；CANCELLED 的迟到响应只能记录证据，不能创建版本或触发重试。
- 每次真实 Provider 请求创建独立 ModelInvocation。
- 网络错误、429、5xx 最多自动重试 2 次；401、内容拒绝、上下文超限和业务校验失败不盲目重试。
- 结构修复最多一次，并且只修候选 JSON 结构。
- 请求已经发出但结果未知时不得自动重发，避免重复计费和重复版本。
- 页面切换或 Renderer 刷新不得取消已持久化 Job。

### 11.2 事务边界

- Application Service/JobRunner 通过 UnitOfWork 开启和提交事务。
- Provider 网络请求必须发生在事务外。
- 最终响应证据、业务新版本、指针和审计在短事务中原子提交。
- 事务内不得等待网络或执行长时间文件操作。
- Repository 不自行嵌套提交，JobRunner 不直接执行 SQL 或导入 `better-sqlite3`。
- Command 携带 `requestId`；修改命令携带 `expectedVersionId` 或 `expectedUpdatedAt`。

### 11.3 Provider 边界

- 真实 Provider 配置以 TECH_DESIGN 当前锁定快照为准，不使用漂移别名。
- Provider Host、地域和 Workspace 由受校验配置派生，UI 不接受任意 Base URL。
- 内容安全拒绝不得绕过，也不得自动篡改用户原文后重试。
- 静态能力 UNKNOWN 必须显示为 UNKNOWN/WARN，不能推断为支持。
- ReferencePriceSnapshot 仅为 `SHOT_PACKAGE + PER_SHOT` 整镜参考区间，不代表真实扣费。

## 12. SQLite、Migration 与文件

### 12.1 Repository 和 SQL

- SQL 只允许位于 `packages/persistence` 的 Repository 或 migration。
- 所有变量使用参数绑定；禁止拼接 SQL。
- 生产查询明确列字段，不使用 `SELECT *`；列表查询有稳定排序和分页/上限。
- Repository 不向外泄漏 Row、Statement 或数据库连接对象。
- 数据库异常在 persistence 边界归一化。

### 12.2 Migration

- migration 使用 `NNNN_short_description.sql`，按编号前进并保存不可变 checksum。
- 已发布 migration 不得改写；结构调整通过新 migration 完成。
- 升级前创建 SQLite 在线备份，migration 在事务中执行。
- 失败时回滚并保持旧库可打开，不启动 JobRunner。
- 迁移至少验证空库、上一版本样本库和包含 100+ 历史版本的压力库。
- 不使用 `integrity_check` 代替 `foreign_key_check` 和应用级 invariant audit。
- 任何恢复操作先保留当前损坏库用于诊断，不覆盖唯一副本。

### 12.3 文件和导入导出

- Renderer 不提交任意本地路径；Main 通过系统 Open/Save Dialog 读取或写入。
- 所有路径规范化并验证项目目录范围、扩展名、文件类型和符号链接。
- JSON 导入先进入 staging，完成 Schema、引用、hash、冲突和集合校验后再一次提交。
- 导出先写同目录临时文件、flush/sync 后原子 rename；失败不得留下成功记录。
- Markdown 是面向人的展示格式，不承诺无损回导。
- V1 JSON 为 CURRENT_ONLY 交换格式，不等同于完整数据库备份。

## 13. 安全、隐私与日志

### 13.1 Electron

- `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`、`webSecurity=true`。
- Renderer 仅加载本地受信资源；禁止任意导航、新窗口、`webview` 和未校验外链。
- 每个 IPC 校验 sender、DTO、项目范围和频道；Preload 不暴露通用 `send/on/invoke`。
- Provider 网络只允许 Main 中受限 Adapter 访问 HTTPS allowlist。

### 13.2 密钥

- API Key 使用 Electron `safeStorage`；不可用时阻断保存，不降级为明文。
- SQLite 只保存 `credential_ref` 和验证元数据，密文独立保存。
- Key 不得进入 `.env` 示例值、SQLite 明文字段、Renderer 状态、日志、埋点、诊断包、Fixture、截图或导出包。
- UI 只能显示已配置状态和可选末 4 位，不回显完整 Key。
- 删除凭据时同步删除密文并写审计事件。

### 13.3 用户内容和可观测性

- 剧本、完整 Prompt 和原始模型响应属于项目数据，不属于普通日志。
- 日志只记录必要的 ID、状态、耗时、错误码、Token、版本和哈希。
- 诊断包使用白名单字段，先展示内容并由用户确认后导出。
- V1 不发送远程产品分析或崩溃遥测。
- 不承诺第三方 Provider 绝不保存或训练用户内容；界面展示当前数据处理说明。

## 14. UI 与页面状态

- 页面实现必须覆盖 PRD v1.4 §15.1 的加载、运行、空、错误、成功、离开和只读故障状态。
- 异步命令 1 秒内给出已接收、排队、加载或运行反馈。
- 禁用操作保持可见并解释前置条件；不能通过隐藏按钮掩盖错误。
- 筛选无结果和数据真正为空使用不同文案。
- 错误展示稳定错误码、影响对象和可执行下一步，不显示 SQL、堆栈、Key 或未脱敏 Provider 响应。
- 保存成功以主进程事务提交为准；前端乐观状态不能单独构成成功。
- StoryBible、剧本、分镜、Provider 设置和评测标注的未提交修改都属于 dirty 状态。
- 已持久化 Job 的运行状态不属于 dirty；离开页面不得取消 Job。
- 删除、覆盖、解锁、恢复和放弃编辑需要说明影响范围并二次确认。
- 拖动操作提供键盘/按钮替代；错误和状态不能只靠颜色表达。
- 启动自检失败时进入独立只读故障页，故障未解除不能绕过进入可写模式。

## 15. 测试要求

### 15.1 文件后缀与 Runner

| 命令 | 文件范围 |
|---|---|
| `pnpm test` | 单元测试 `*.test.ts`、`*.test.tsx`；排除 Contract、Integration、E2E |
| `pnpm test:contract` | `*.contract.test.ts` |
| `pnpm test:integration` | `*.integration.test.ts` |
| `pnpm test:e2e` | Playwright Electron `*.e2e.spec.ts` |

`vitest.config.ts`、`vitest.contract.config.ts`、`vitest.integration.config.ts` 和 `playwright.config.ts` 必须显式配置互斥收集范围，同一测试文件不得被多个脚本重复执行。

### 15.2 最小合并门禁

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:integration
```

修改 Renderer 关键流程、IPC、导入导出或 P0 验收路径时还必须运行相关 `pnpm test:e2e`。发布候选运行 AC-V1-01 至 AC-V1-06 全量 E2E。

### 15.3 测试纪律

- 单元测试不得访问真实网络、用户目录或生产凭据。
- 时间、ID、随机数和 Provider 响应可注入或固定。
- 一个非法 Contract Fixture 只表达一个预期错误。
- 成功与失败路径同时覆盖状态机、锁、幂等、父链、编辑事务、staging、价格和数据库不变量。
- 修复 Bad Case 时先添加可复现 Fixture。
- 测试名称使用“条件—动作—结果”，禁止 `works`、`test1` 等无诊断价值名称。
- 不删除、跳过或放宽失败测试来制造通过结果。
- 不存在临时 PR 门禁豁免；隔离 flaky test 必须记录 issue、负责人、影响范围和不超过 14 天的到期时间，隔离期间不得发布受影响能力。

### 15.4 必测边界

- 输入字符数：原创 19/20/2,000/2,001；已有内容 0/1/30,000/30,001。
- Job：401、429、5xx、120 秒超时、非法 JSON、结构修复失败、STALE_INPUT、取消、迟到响应和崩溃恢复。
- ShotContract：四种 DialogueRenderMode、无台词、锁路径、连续模式、参考价已知/未知。
- Episode：sequence、previous_shot、StoryBible 引用、FormatProfile、时长 WARN 和外部父链。
- 编辑：拆分、合并、复制、排序、删除、恢复及每一步中途失败回滚。
- 导入导出：RETURN_TO_ORIGIN、NEW_PROJECT、重复重导、缺失对象、断网 Registry 和 hash 对账。

## 16. 禁止事项

Agent 不得：

- 将 V2/V3 能力塞入 V1 任务或声称已经实现。
- 接受未经 Schema 校验的 LLM 原始文本作为正式业务版本。
- 让 LLM 决定 ID、状态、权限、锁、事务或 BLOCK 规则。
- 在 Renderer 访问 Node、SQLite、文件系统、密钥或 Provider。
- 在 JobRunner 或 Application Service 中直接写 SQL、读取密文文件或实例化基础设施 Adapter。
- 静默覆盖历史版本、修改已发布 migration 或绕过 checksum。
- 静默截断用户输入、丢弃失败证据或自动重发结果未知的收费请求。
- 把 UNKNOWN Provider 能力显示为支持，把估算成本显示为真实扣费。
- 将 API Key、完整剧本、Prompt 或原始模型响应写入普通日志和诊断包。
- 通过关闭类型、lint、安全、Schema 或测试门禁解决失败。
- 使用破坏性命令清理整个仓库或覆盖用户未提交修改。
- 在没有当前验证证据时宣称测试、构建、验收或用户试用通过。

## 17. 文档同步矩阵

| 变更类型 | 至少检查 |
|---|---|
| 产品范围、用户流程、验收 | PRD、TECH 验收追踪、E2E、AGENTS |
| Schema 字段、枚举、跨字段规则 | Schema、PRD 字段语义、TECH Registry/DDL、Fixture、导入导出 |
| 数据表或不变量 | TECH、migration、Repository 集成测试、备份恢复、invariant audit |
| IPC 方法或错误 DTO | TECH IPC 清单、Preload 类型、Zod DTO、Renderer 调用、Contract/E2E |
| Job 状态、重试或幂等 | PRD 异常矩阵、TECH 状态恢复、Mock Fixture、审计与成本证据 |
| Provider/模型/地域/价格 | TECH 快照、配置种子、数据提示、Contract Test、有效期 |
| 安全或部署模式 | PRD 合规门槛、TECH 安全实现、E2E、发布清单 |

## 18. Agent 完成定义

提交结果前逐项确认：

- [ ] 修改范围与用户请求一致，没有提前开发 V2/V3。
- [ ] 当前 PRD、TECH、Schema 和代码之间没有新增冲突。
- [ ] 分层依赖、Application Ports 和进程安全边界未被破坏。
- [ ] 新行为具有失败路径、错误码、审计和必要的回滚语义。
- [ ] Schema、版本、锁、Job、Episode 和数据库不变量得到对应测试。
- [ ] migration 可升级、可回滚失败且未改写历史文件。
- [ ] 日志、Fixture、截图和导出中不存在密钥或非必要用户内容。
- [ ] 已运行适用的格式化、lint、类型、单元、Contract、Integration 和 E2E 命令。
- [ ] 已检查最终 diff，并保留用户无关修改。
- [ ] 最终说明列出实际完成项、验证证据、剩余风险和未执行项。

任何勾选项无法满足时，Agent 必须如实报告原因和影响，不得用“应当通过”“基本完成”代替证据。

## 19. OpenSpec SDD 工作流

### 19.1 适用边界

- 功能、用户流程、架构、Schema、数据库、migration、IPC、Provider 或安全边界变更必须先建立 Active OpenSpec Change。
- 仅错别字、链接或不改变语义的格式修正可直接修改，但仍要遵守本文件的验证和交付纪律。
- OpenSpec 只管理增量规范；不得复制整份 PRD、TECH 或 JSON Schema 形成第二事实源。

### 19.2 Change 规则

- Change ID 使用英文 `kebab-case`，一个 Change 只承载一个可独立验收和回滚的能力。
- Proposal 必须映射 PRD v1.4 验收项、TECH_DESIGN v1.1 章节、适用测试层级和明确非目标。
- Specs 使用中文 Requirement、`MUST/SHALL` 和 GIVEN/WHEN/THEN Scenario，覆盖与风险相匹配的正常、边界、失败和恢复路径。
- Proposal、Specs、Design 和 Tasks 未完成审查前不得 Apply；Verify 存在未处理阻断项时不得 Sync 或 Archive。
- 开发分支使用 `codex/<change-id>`；分支不得代替 Active Change。

### 19.3 工作流与工具

```text
Explore -> Propose -> 人工审查 -> Apply -> Verify -> Sync -> Archive
```

- 项目使用 OpenSpec 内置 `spec-driven` Schema，项目规则位于 `openspec/config.yaml`。
- Codex 工作流以当前 CLI 生成的 `.agents/skills/openspec-*` 为准，不得凭历史命令名称猜测调用方式。
- OpenSpec 安装或更新后必须重启 Codex，并用 CLI 输出核对实际生成的技能数量和路径。
- 详细的人类操作手册以 `docs/SDD_WORKFLOW.md` 为准；该文档不得覆盖本文件、PRD、TECH 或 Schema。
