# Tasks: batch-first-frame-generation

> 前置：design 决策点 D1–D6 经产品负责人拍板后方可开始 Apply。

## 1. 契约与 Schema

- [x] 1.1 `packages/contracts/src/image-api.ts` 新增三方法 schema 与 channel 常量：`generateCandidatesForShots({projectId, shotIds(1..20), requestId}) → MediaBatchViewDto`、`cancelBatch({projectId, batchId, requestId}) → MediaBatchViewDto`、`listStoryboardImageStates({projectId}) → StoryboardImageStatesDto`；批次视图含 status/target/skipped/failed 清单与成员任务摘要，shotStates 覆盖全部 READY 镜头徽标字段；requestId 前缀 `image-batch_` 纳入校验 → verify: contracts 单测过
- [x] 1.2 四层白名单测试同步六→九：`image-api.contract.test.ts` 通道一一对应、`jingxu-api.contract.test.ts` 冻结方法集、`image-ipc.contract.test.ts` handler 集合与 READY 前阻断矩阵、`register-image-features.test.ts` 频道集 → verify: 四文件契约测试过

## 2. 迁移与持久化

- [x] 2.1 迁移 0010：`media_generation_batches` 表（status CHECK、UNIQUE(project_id, idempotency_key)、三个 shot_ids JSON 列）+ `media_generation_tasks.batch_id TEXT NULL` 列与索引；head 9→10 → verify: 迁移单测 + 旧库升级 smoke（NULL batch_id 行为不变）
- [x] 2.2 `MediaRepository` 端口与 SQLite 实现：批次 CRUD、同幂等键查找、队首消费（事务内 pop pending）、收尾状态落库、按项目列活跃/近期批次、成员任务按 batch_id 聚合 → verify: 持久化单测过

## 3. 应用层与调度

- [x] 3.1 `MediaBatchService.createBatch`：凭据闸 + 整集 READY + 镜头在 READY 集合校验（沿用 `MediaGenerationService` 同源前置）；服务端当前世代跳过过滤（`resolveGenerationInput` 哈希 × SUCCEEDED 候选比对）；有效目标空 → `MEDIA_BATCH_NO_PENDING_SHOTS`；幂等重放返回既有批次视图 → verify: 单测覆盖跳过/空目标/重放
- [x] 3.2 批次推进钩子：drainProject 循环内「无未终态任务且存在 RUNNING 批次 → 事务消费队首并按派生 requestId `image-generate_<batchUuid>_<shotId>` 复用单镜头建档 → kick」；停滞护栏覆盖钩子路径；批次收尾（队列空+成员全终态 → COMPLETED/PARTIAL_COMPLETED）与成员终态转移同事务判定 → verify: 集成测试过（含失败隔离、至多一个在飞任务断言）
- [x] 3.3 启动批次恢复：组合根启动序列在既有 recover+kick 之外，为 RUNNING 批次的 pending 镜头继续建档（全新提交语义，在飞任务不动）→ verify: 集成测试模拟重启（含「在飞无证据 → INTERRUPTED 待人工 + pending 继续」组合场景）
- [x] 3.4 `cancelBatch`：标 CANCELLED、剩余队列不消费、终态保留、幂等（已收尾批次取消无副作用）→ verify: 单测过

## 4. IPC 与接线

- [x] 4.1 `image-ipc.ts` 注册三方法（strict DTO、输出 schema、singleflight、启动写门）；composition facade 与 service 装配 → verify: image-ipc 契约测试过
- [x] 4.2 preload `jingxu-api.ts` 三方法实现（strict Zod 复验）→ verify: preload 契约测试过

## 5. Renderer

- [x] 5.1 `script-api.ts` 客户端封装 + `listStoryboardImageStates` 1s 有界轮询 hook（visibility 守卫、无活跃批次即停）→ verify: 组件测试
- [x] 5.2 StoryboardPanel：镜头卡片首帧徽标（无候选/排队/生成中/N 就绪/失败）、工具栏「为整集生成首帧」（READY 才可用）、批次进度行（n/total、失败数、取消剩余、重试失败镜头）→ verify: E2E 覆盖
- [x] 5.3 FirstFramePanel 与批次视图一致性：单镜头入口照旧；批次徽标点击进面板沿用现交互 → verify: E2E 覆盖

## 6. 门禁与 E2E

- [x] 6.1 单测/契约/集成全量门禁绿（contracts + desktop + application + persistence 各 vitest 套件，用 `node_modules/.bin` 针对性跑法）→ verify: 全绿无跳过（跳过须具名说明）
- [x] 6.2 E2E（mock 档）：整集一键排队 → 徽标流转 → 全 COMPLETED 收尾；失败注入镜头 → PARTIAL_COMPLETED + 重试失败镜头新批；取消剩余 → CANCELLED + 在飞跑完；重启恢复 → 在飞 INTERRUPTED 待人工 + pending 继续 → verify: E2E 全绿
- [x] 6.3 README 同步（新 Active Change 记录 → 归档记录、能力 bullet、门禁数字）+ `openspec validate --strict` 过 + 归档 → verify: validate 零错、README 事实与门禁输出一致
