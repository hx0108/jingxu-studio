## Context

当前首页和 `ScriptWorkspace` 已能进入完整链路，但下一步主要由 Renderer 页面状态与用户自行判断共同决定；五阶段编辑直接暴露 JSON，右栏默认展示生成服务、版本和内部标识。已有 Application 服务已经掌握项目/阶段/分镜事实，图片一致性预检已经返回角色与画风阻断，媒体任务和参考价格也有持久化证据；已有 Mock 文本、图片、视频、配音和本地合成适配器可支持零网络 E2E。详见 [proposal.md](./proposal.md) 的动机与范围。

本变更跨 Renderer、typed IPC、Application 聚合服务、Composition Root 和测试，但不应改变四份 PRD-owned Schema，不应让 Renderer 访问 Repository，也不应改变真实 Provider 的任务冻结、凭据、安全或事务规则。当前工作树另有 Agnes 图片 Provider 未提交修改，Apply 前必须重新检查重叠文件。

## Goals / Non-Goals

**Goals:**

- 用一个由服务端事实解析的续作动作驱动首页与工作区，而不是在多个页面复制业务判断。
- 用现有 Mock 能力提供可重复、零网络、清晰标注的首次体验。
- 聚合现有凭据、资产预检、媒体状态、时长和参考价格为一次准备检查。
- 以阶段专用结构化表单替代默认 JSON，同时保持正式 Schema、不可变版本、并发检查和 dirty 保护。
- 保留审计、历史、锁与诊断能力，但从默认创作路径移到按需入口。

**Non-Goals:**

- 不新增或自动选择 Provider，不改变真实请求的价格、重试或回退策略。
- 不将 Mock 数据转为真实能力证据，不承诺用户一定在五分钟内获得真实成片。
- 不实现 P1 质量驾驶舱、自动返工、跨项目模板或版本分支视图。
- 不修改正式业务 Schema 字段，不引入通用 JSON Schema 表单引擎，不重写现有媒体生成服务。
- 不以本变更替代 PRD v1.4 §9.10 的 AC-V1 自动验收或 §9.11 的三名目标用户受控试用。

## Decisions

### 1. 新增 Application 层 `CreatorGuideService` 作为唯一决策源

Application 层新增只读 `getNextAction(projectId?)`、`getPreparation(input)` 与命令 `startDemo(requestId)`。服务通过现有 Repository/Domain Port 读取项目、阶段头、Job、分镜、媒体、资产、凭据状态和价格快照，返回受限 DTO；Renderer 仅渲染动作并导航。

`getNextAction` 使用固定优先级状态机：无项目 → 起始选择；源内容未初始化 → 输入故事；五个阶段依序处理缺失/DRAFT/STALE/READY；分镜缺失或未确认 → 分镜；图片一致性阻断 → 参考资产；图片/视频/配音缺失或失败 → 对应媒体步骤；合成阻断 → 导出准备；均完成 → 查看成片。对每一步只返回业务动作枚举和中文展示键，不返回任意路径。

选择项目规则为：有效显式 `projectId` 优先；否则活动项目按 `updated_at DESC, id ASC` 取首项。执行导航前 Renderer 再调用一次查询，以吸收后台 Job 完成等并发变化。

**备选方案：Renderer 根据多个现有 API 自行判断。** 否决，因为会复制领域规则、制造竞态，也违反 Application 拥有业务编排的分层边界。

### 2. 体验模式使用一次性原子 Seed，而不是模拟点击全部步骤

`startDemo` 在一个受控命令中创建带 `experience_mode=DEMO` 语义的独立项目、SourceInput、Episode、当前阶段/分镜快照与合成参考资产。示例内容来自随应用发布、经 Schema 和 hash 校验的合成 Fixture；媒体使用现有 Mock 产物或按现有 Mock Job 路径生成。命令使用 `requestId` 幂等，同一未完成演示项目再次进入时恢复而非复制。

为了保持演示与真实项目边界，服务不读取 CredentialPort；所有演示任务固定 `is_mock=true`，真实生成解析器不得选择这些任务作为真实候选。若当前数据模型没有可靠的演示项目标记，Apply 时新增最小追加 migration（例如项目级受限 mode），并同步 Project DTO、导入导出策略和 migration 测试；禁止从名称或 UI localStorage 推断。

**备选方案：前端脚本依次调用创建、生成、确认接口。** 否决，因为耗时不稳定、容易产生半成品，并把演示编排与幂等责任放到 Renderer。

**备选方案：体验模式自动使用用户真实低成本模型。** 否决，因为会要求凭据、产生费用和网络不确定性，也无法稳定满足首次体验。

### 3. 准备向导返回规范化检查项，不新建第二套预检规则

`getPreparation` 接收项目、操作类型和明确的 episode/shot scope。它组合而不复制以下事实：

- Credential/Provider 组合层提供的脱敏就绪结果；
- `image.getConsistencyPreflight` 的 STYLE/CHARACTER/引用上限结果；
- 当前分镜/候选/配音/合成服务的可用性与过期检查；
- Shot target duration 汇总及现有参考价格快照；
- 数据处理确认要求。

DTO 仅返回 `READY | WARN | BLOCK` 检查项、稳定业务码、中文参数、修复动作枚举、估算区间/币种/快照时间和服务器计算的 `preparationRevision`。确认命令必须重新检查，而不是信任 Renderer 回传的通过结果；实际生成服务仍执行其原有二次预检。

**备选方案：向导维护独立规则。** 否决，因为会与实际生成阻断漂移并产生“向导通过、提交失败”的双重事实源。

### 4. 使用五个阶段适配器与共享表单壳，不引入通用 Schema UI 生成器

Renderer 新增共享 `ScriptStageFormShell`，提供保存、确认、dirty、错误定位、模式切换和重复项操作；每个阶段使用独立的纯映射适配器：

- CONCEPT：六个文本字段；
- STORY_BIBLE：角色、世界规则、场景、道具的可重复项；
- EPISODE_OUTLINE：目标、开场、中点、高潮、结尾钩子和目标时长；
- BEAT_SHEET：节拍卡片列表；
- SCENE_SCRIPT：场景卡片与对白列表。

草稿状态保存 `{ mode, formValue, jsonText, lastValidData }`。进入高级编辑时由 `formValue` 序列化；返回表单前先解析并用阶段 DTO 做 Renderer 友好校验，失败则留在高级模式。最终保存仍只调用现有 `script.saveDraft`，由主进程正式 Schema 校验；Renderer 校验不能构成成功证据。

字段错误通过一份确定性 JSON Pointer → 控件路径映射定位；无法映射的错误显示在表单顶部并保留原 Pointer 于高级详情。业务键由确定性 UI ID 工厂创建，保存前满足 Schema 格式，不能由 LLM 或数组索引临时决定。

**备选方案：根据 JSON Schema 自动生成全部表单。** 暂不采用，因为复杂对象键、引用选择和对白交互需要明确产品语义，引入通用引擎会扩大范围且降低可控性。

### 5. 默认视图收起工程证据，但不改变底层控制

`WorkspaceLayout` 默认检查器改为“本集下一步/准备状态/创作参考”，右栏可折叠。版本历史与恢复作为独立用户动作；锁、任务、错误码、哈希和内部枚举进入“高级信息”。默认文案使用业务状态映射，不把 `READY`、`STALE_INPUT` 或 Provider 枚举直接显示。

这仅是呈现变化：expectedVersionId、锁复检、任务状态机、审计、Provider 冻结、Schema 和事务仍由现有主进程路径执行。禁用操作继续可见并解释原因，符合 PRD v1.4 §15.1.1。

### 6. IPC、DTO 与错误边界

新增逐方法白名单：

- `creatorGuide.getNextAction`
- `creatorGuide.getPreparation`
- `creatorGuide.startDemo`

输入/输出均在 Contracts 中使用 strict Zod；Preload 只暴露上述方法。建议稳定错误码：`CREATOR_GUIDE_PROJECT_NOT_FOUND`、`CREATOR_GUIDE_SCOPE_STALE`、`DEMO_FIXTURE_INVALID`、`DEMO_INITIALIZATION_FAILED`、`PREPARATION_BLOCKED`。具体 Provider 错误仍由既有域归一化，向导只返回脱敏业务检查项。

### 7. 数据、事务与 migration

`getNextAction` 与 `getPreparation` 只读且不持有网络事务。`startDemo` 的领域记录和命令回执在 UnitOfWork 中原子提交；随包 Fixture/Mock 媒体复制若涉及文件系统，先写 staging/CAS，再在短事务登记，失败清理本次临时引用且不伪造成功。

是否需要 migration 取决于当前 Project 是否已有可靠演示标志：若没有，新增顺序 migration 与不可变 checksum，不改写既有 migration；同时验证空库、上一版本库和 100+ 历史版本库。四份 PRD-owned Schema 预计不变。ProjectTransferBundle 对演示项目默认阻止导出，或显式保留 demo 标志且导入后仍为演示；不得导入成真实项目而丢失标识。

### 8. 测试与验收策略

- Unit：续作决策表全分支、稳定项目选择、准备聚合、成本未知/过期、演示幂等/回滚、五阶段双向映射与 Pointer 错误定位。
- Contract：三个 IPC 方法的 strict DTO、Preload 白名单、错误码和脱敏字段；断言不出现密钥、端点、路径、原始响应或完整 Prompt。
- Integration：SQLite 原子 Seed、恢复已有演示、演示/真实隔离、准备确认前状态漂移、如有 migration 则三类升级测试。
- Renderer：默认无工程术语、结构化表单/高级 JSON dirty 共享、向导阻断修复和窄窗抽屉。
- Electron E2E：全新安装离线完成体验；真实项目从首页自动定位阻断项；补齐参考资产后回到原生成范围；旧项目/失败 Job/无价格状态恢复。
- 发布证据：运行最小合并门禁与相关 `pnpm test:e2e`；本次交互版本完成后重新执行 3 名目标用户受控试用，记录首次完成率、有效操作时间、墙钟时间和求助点。

## Risks / Trade-offs

- **[演示 Seed 与真实流程行为漂移]** → Fixture 必须通过同一正式 Schema/集合校验，并增加从演示关键状态到真实命令契约的回归测试；界面持续标注演示边界。
- **[一个续作解析器覆盖过多状态]** → 用数据驱动决策表和每个动作的独立测试保持可审计；不让 LLM参与路由。
- **[准备向导与提交时状态不一致]** → 返回 revision 仅用于提示，提交前由服务器和原生成服务重新预检；任何变化可见失败，不静默继续。
- **[结构化表单遗漏 Schema 语义]** → 阶段适配器逐字段覆盖正式 Schema 边界，Contract Fixture 和 round-trip 测试验证；高级 JSON 保留但不作为默认逃生路径掩盖缺失字段。
- **[隐藏工程信息降低高级用户效率]** → 历史恢复、高级编辑和诊断仍可一到两次操作进入，不删除证据或能力。
- **[与 Agnes 未提交修改冲突]** → Apply 前检查工作树与最新 Contracts；优先新增独立聚合 API，避免重写 Provider 卡和正在变化的 Adapter/迁移文件。
- **[约 5 分钟承诺受机器性能影响]** → 产品文案定义为体验模式名称和设计目标，不作为硬实时 SLA；自动化记录基准机墙钟时间，超时仍显示确定进度和恢复路径。

## Migration Plan

1. 先落 Contracts、Application 决策表及只读查询，不切换现有 UI；用单元/Contract/Integration 测试固定业务结果。
2. 实现演示 Seed 与演示标识，完成离线 E2E 后再开放首页入口。
3. 实现五阶段结构化表单并逐阶段切换默认视图；高级 JSON 保留回退，期间用 feature flag 仅控制展示，不改变保存契约。
4. 接入准备向导和首页唯一 CTA，完成全量 Renderer/Electron 回归后移除旧首页多主入口。
5. 运行完整门禁、Windows 打包 Smoke 和目标用户受控试用；确认首次成功指标后再立项 P1。

回滚时可恢复旧 Renderer 入口与 JSON 默认视图；新增只读 IPC 可保留。若新增数据库字段，旧二进制按现有 schema-version 规则阻断，使用升级前备份恢复，不执行 destructive down migration。演示项目可继续保留为带标识的只读/可删除数据，不转换成真实项目。

## Open Questions

- 内置示例故事的题材与视觉素材可在 Apply 前从合成 Fixture 候选中选择；该选择不改变契约、架构或任务拆分，但必须确认无第三方版权内容。
