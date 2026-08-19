# Design: batch-first-frame-generation

## 0. 背景与证据（Apply 前置事实，不需要拍板）

管线侦察结论（2026-08-19，行号以当前工作区为准）：

1. **任务粒度与幂等**：`media_generation_tasks` 以镜头单轮为粒度，`UNIQUE(project_id, idempotency_key)` + `UNIQUE(shot_id, round_no)`（migration 0009:108-109）；同 requestId 重放返回既有任务行（任意 phase），FAILED 不复活、重提=新 requestId 新轮（`media-generation-service.ts:154-179`）。批次天然是「N 个单镜头任务 + 一个排队骨架」，不改任务粒度。
2. **调度模型**：`drainProject` 循环 `listUnfinishedTasks(projectId)` 严格取 `tasks[0]` 驱动至终态（`media-task-scheduler.ts:465-483`）——同项目串行、跨项目并行，无 DB 级锁。启动时组合根对全部活跃项目 recover + kick（`register-image-features.ts:258-269`）。
3. **恢复不变式**（本 Change 的红线）：`recover` 仅续「POLLING/DOWNLOADING 且全部候选留证」的任务；其余未终态（含 SUBMITTED 无证据）一律 `MEDIA_TASK_INTERRUPTED` 待人工，绝不自动重发（`media-task-scheduler.ts:504-524`）。防重复计费的语义针对**已建档但不知是否发出**的任务。
4. **推送通道不存在**：`events.subscribeJobUpdates` 是占位，全仓库无 `webContents.send`；现状 1 秒有界轮询（FirstFramePanel + ScriptWorkspace 同模式），TECH_DESIGN.md:1108 标 events 未实现。
5. **UI 结构**：镜头列表 `ul.shot-card-list`（StoryboardPanel.tsx:148-173）无首帧状态聚合；`FirstFramePanel key={shotId}` 切换即重挂载。已知缺口：面板挂载时只 `listCandidates` 不查在飞任务（FirstFramePanel.tsx:233-250）——批次徽标属列表层，顺带覆盖该缺口的展示面。
6. **契约面**：六方法白名单被四层测试钉死（contracts / preload / main-ipc / composition），扩展=显式契约演遍。
7. **规模**：典型 6–10 镜头（硬界 1–20，单项目 ≤20 READY），每镜头 4 候选，Seedream `max_images_per_minute=500`、同步 submit 段超时 120s——整集 ≤80 次请求，串行无速率压力；真实联调单镜头一轮约 1–2 分钟，整集批量预计 5–15 分钟量级。
8. **产品红线**：PRD v1.4 :806 资产变更不自动批量重生成；:892 单镜头失败不重做整集；:294/:307 跨集/批量任务编排属 V4 不排期。本 Change 定位「单集内用户显式发起的顺序排队」，全部设计服从这三条。

## D1 批次编排与数据模型（核心拍板点）

- **A（无批次表，一次全量建档 N 行）**：批量入口事务内为全部目标镜头建任务行，`drainProject` 自然串行排空，零迁移零调度改动。致命伤：重启后「从未被驱动」的排队任务与「崩溃在飞」任务同样呈现 SUBMITTED 无证据，被 `recover` 一律判 `MEDIA_TASK_INTERRUPTED`——9 镜头批量在第 3 镜头崩溃，重启后 6 个从未提交的镜头被标「失败待人工」，语义误导且违背 PRD §10.6 队列继续的精神。
- **B（批次表 + 全量建档 + 顺序推理恢复）**：建 N 行后，恢复期用「驱动顺序=建档顺序」推理出「排在最后留证任务之后的 SUBMITTED 无证据任务必未驱动」从而自动续提。与单镜头任务在队尾交错时推理仍成立但证明负担重；「聪明恢复」不符合本仓库确定性风格，审计面说不清哪行为什么被续提。
- **C（推荐：批次表 + 惰性逐镜头建档）**：批次行持久化 pending 队列；前一成员任务终态后才在事务内「消费队首 → 为该镜头建档（复用 `MediaGenerationService.generateCandidates` 全部前置/冻结/幂等逻辑，确定性派生 requestId）→ kick」。任意时刻每批次至多一个在飞任务。重启恢复零歧义：pending 镜头从未建档 → 建档即全新提交（不碰不变式 3，它只管已建档任务）；唯一在飞任务沿用既有 recover。取消=不消费剩余队列。代价：迁移 0010 + 调度循环加一个批次推进钩子（无未终态任务且存在 RUNNING 批次 → 消费队首再入循环）+ 批次收尾检测（队列空且成员全终态 → 落 COMPLETED/PARTIAL_COMPLETED）。
- **数据模型（随 C）**：新表 `media_generation_batches(id, project_id, idempotency_key, status CHECK IN RUNNING/COMPLETED/PARTIAL_COMPLETED/CANCELLED, target_shot_ids_json, pending_shot_ids_json, skipped_shot_ids_json, error_code, created_at, updated_at, UNIQUE(project_id, idempotency_key))`；`media_generation_tasks` 加 `batch_id TEXT NULL` 列（追溯成员归属，旧行 NULL 语义不变）。批次幂等：同 batch requestId 重放返回既有批次视图（任意 status）；任务级派生键 `image-generate_<batchUuid>_<shotId>` 确定性生成，恢复重放天然幂等。

## D2 失败语义与重提边界

沿用两层既有失败语义，批次层只做汇总不做重试：候选级失败不拖垮任务（兄弟候选继续，任务可 COMPLETED）；任务级 FAILED 不阻断批次（串行队列继续下一镜头）；批次收尾按成员终态派生 `COMPLETED` / `PARTIAL_COMPLETED`，失败清单=FAILED 成员。「重试失败镜头」=以失败镜头集合+新 requestId 发起新批次（等价 `generateCandidatesForShots` 显式调用，无独立重试通道）。批次不做自动重试、不做轮空重提——与「单镜头失败不重做整集」对齐。

## D3 跳过策略

- **推荐（服务端计算，无 force）**：建档时服务端对每个目标镜头用 `resolveGenerationInput` 现算当前哈希，与该镜头 SUCCEEDED 候选的 `generation_input_hash` 比对——已有当前世代成功候选则跳过并进 `skipped_shot_ids`。跳过判定与「选择只允许当前世代 SUCCEEDED」（first-frame-policy.ts:56-57）同一世代定义，不会出现「跳过了却无可选候选」。不做 force 参数（覆盖式重生成列为非目标，用户对单镜头重生成走既有 FirstFramePanel 入口）。有效目标为空 → `MEDIA_BATCH_NO_PENDING_SHOTS` 稳定失败。
- 备选（客户端过滤）：UI 端按候选展示过滤——判定逻辑进了渲染层，服务端不再兜底，非确定性来源，不采纳。

## D4 并发模型

不改：同项目严格串行（drainProject 单飞行），跨项目并行，无全局并发上限、无限速/退避。理由：串行即「每批次至多一个在飞任务」的天然实现；Seedream 500 图/分钟下整集 ≤80 请求无压力；引入并发提升属性能优化，无实测瓶颈支撑（YAGNI）。多项目同时批量会叠加 Provider 并发（现状即如此），如实记入风险不改行为。

## D5 进度通道

- **推荐（列表级查询 + 1 秒有界轮询）**：新方法 `image.listStoryboardImageStates({projectId})` 一次返回 `{batches: [...], shotStates: [...]}`——shotStates 覆盖全部 READY 镜头（徽标底座：无候选/排队/生成中/N 就绪/失败），batches 含活跃与近期批次（进度、跳过/失败清单、取消入口）。批次活跃期间轮询，沿用 `document.visibilityState` 守卫与终态即停（FirstFramePanel.tsx:254-281 同模式）。
- 备选（落地 events 推送）：根治轮询，但牵 Main→Renderer 安全通道与 CSP 面，是独立基础设施 Change——维持既有 defer 决策，本 Change 不碰。

## D6 取消范围

- **A（推荐：仅未建档镜头）**：`image.cancelBatch` 标批次 `CANCELLED`、剩余 pending 不再消费；已终态结果保留；在飞任务跑完自然终态（其候选照常落盘可选）。语义干净：取消的语义是「不再开始新镜头」，不是「丢弃进行中的计费请求」。
- **B（含在飞中断）**：暴露 `scheduler.cancel`+abort 到批次取消。中断后的 SUBMITTED 无证据任务仍要走 `MEDIA_TASK_INTERRUPTED` 待人工——「用户主动取消」与「崩溃待人工」在数据面无法区分，审计纠缠；且中断已发出的同步 submit 不能撤回计费。不推荐，若未来需要随独立 Change 论证。

## 决策点汇总

| # | 决策点 | 拍板（2026-08-19，产品负责人「D1–D6 全按推荐」） | 备选（未采纳理由） |
|---|---|---|---|
| D1 | 批次编排与数据模型 | **C：批次表 + 惰性逐镜头建档（迁移 0010，每批次至多一个在飞任务）** | A：重启后未驱动镜头被误标失败；B：顺序推理恢复太脆 |
| D2 | 失败语义与重提 | **批次只汇总不重试；重试失败镜头=新批次** | 批次内自动重试（放大计费风险，无必要） |
| D3 | 跳过策略 | **服务端当前世代比对跳过，无 force** | 客户端过滤（判定进渲染层）；force 参数（非目标） |
| D4 | 并发模型 | **沿用同项目串行、跨项目并行** | 并发提升（无瓶颈证据，YAGNI） |
| D5 | 进度通道 | **listStoryboardImageStates + 1s 有界轮询** | events 推送（独立基础设施 Change，维持 defer） |
| D6 | 取消范围 | **A：仅未建档镜头，在飞跑完自然终态** | B：含在飞中断（取消与崩溃待人工在数据面不可区分） |

## 风险与不变式保护

1. **重复计费风险不高于现状**：惰性建档保证每批次至多一个在飞任务；pending 镜头的重启建档是全新提交（请求从未发出），与「未知是否发出绝不重发」零冲突；派生 requestId 确定性保证恢复重放不双建档。
2. **批次推进钩子的死循环防护**：钩子挂入 drainProject 循环，沿用既有停滞护栏思路——「消费队首失败/批次已终态」必须让循环退出或抛 `MEDIA_SCHEDULER_STALLED` 同类护栏，不允许空转。
3. **批次收尾竞态**：收尾判定（队列空 + 成员全终态）放在成员任务终态转移的同一事务边界内检查并落状态，避免「最后一个任务终态但批次永 RUNNING」。
4. **STALE 中途传播**：批次运行中用户升版资产 → 已建档任务按既有 STALE 规则传播，pending 镜头按建档时点的新输入冻结——「每镜头以自己建档时点冻结输入」与单镜头语义一致，不额外收敛（收敛=变相批次级重算，超出本 Change）。
5. **契约面演遍**：六→九方法的四层白名单、启动写门矩阵、`JINGXU_IMAGE_CREDENTIAL_FILE` 引导路径语义全部不动，新增方法同受 READY 前置与凭据闸约束。
