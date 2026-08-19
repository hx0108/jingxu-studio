# Tasks: media-invocation-evidence

> 前置：design 决策点 D1–D6 已拍板（2026-08-19，全按推荐）。

## 1. 迁移与持久化

- [x] 1.1 迁移 0011 `media_model_invocations`（D1 DDL：双 FK、segment/status CHECK、截断标记、usage 两列、两索引）；head 10→11；同步 4 文件 9 处硬编码版本断言（initial-schema / project-command-receipts ×3 / script-migration 清单+计数+TOO_NEW / persistence-runtime-adapter 备份基线）→ verify: 迁移单测 + 旧库升级 smoke 过
- [x] 1.2 `MediaInvocationRepository` 端口（insert STARTED / finishTerminal(id, status, {httpStatus, bodyBlob, truncated, sha256, providerRequestId, usage, errorCode}) / listByTask / findById）+ SQLite 实现（27→新列位参插入沿既有风格）+ 内存实现 → verify: 持久化单测过（含截断标记、终态幂等拒绝）
- [x] 1.3 `MediaUnitOfWorkPort.run` 回调改 `(repos: MediaRepositories)`，`MediaRepositories = { media, invocations }`；SQLite/内存 UoW 与组合根同步；调度器/服务层全部既有调用点机械改解构（行为零变化）→ verify: tsc -b + 既有全量单测/契约绿（证明纯机械）

## 2. 应用层与适配器

- [x] 2.1 `image-model-types.ts`：SYNC 形态加 `raw`（httpStatus+bodyText）；`ImageModelPort` 加 `evidenceOf`；`:21-23` 注释改指 media_model_invocations → verify: application 单测过
- [x] 2.2 Seedream 适配器：错误路径先 `response.text()`（64 KiB 截断）再抛携带 evidence 的 `SeedreamAdapterError`；成功路径以 `response.text()` 原文返回 raw；实现 `evidenceOf`（非 Seedream 错误返回 null）；Authorization 仍只存在于请求头 → verify: 适配器单测过（含 429 原文、截断、无凭据泄漏断言）
- [x] 2.3 MockImageModelAdapter：raw 与 evidenceOf 确定性内容（失败矩阵令牌下的错误原文）→ verify: Mock 单测过
- [x] 2.4 调度器接线（D4）：driveFreshSubmits 每候选 submit 前短事务插 SUBMIT STARTED（快照=D3 口径）；失败归一分支同事务 `completeCandidateFailed` + finishTerminal(FAILED)；settleDownload 与 `markTaskDownloading` 同事务插 DOWNLOAD STARTED，成功一笔事务三写（候选 SUCCEEDED + SUBMIT finish SUCCEEDED 含 usage/raw + DOWNLOAD finish SUCCEEDED）；取消/停机分支不收尾（STARTED 残留如实）→ verify: 调度器集成测试过（三写同事务、失败两写同事务、取消残留 STARTED、ref 逐行指向 SUBMIT 行）

## 3. 门禁与工具

- [x] 3.1 E2E（mock 档）断言：整集批次跑完后 `media_model_invocations` 行数=候选数（SUBMIT+DOWNLOAD）、终态候选 ref 全部可 JOIN、失败矩阵令牌下错误原文落 blob → verify: E2E 全绿
- [x] 3.2 `print-real-probe-invocations.mjs` 增媒体域联查段（model/segment/status/http/error_code/usage/耗时）→ verify: node 直跑 smoke 过
- [x] 3.3 全量门禁绿（unit/contract/integration 各 vitest 套件 `node_modules/.bin` 针对性跑法；tsc -b；eslint --max-warnings=0；prettier）→ verify: 全绿无跳过（跳过须具名说明）

## 4. 真实联调与收尾

- [ ] 4.1 真实 Seedream 探针一次（既有 `real-batch-seedream-probe.e2e.spec.ts`，复用凭据/复用口径）+ SQL 断言（`verify-real-media-evidence.mjs`）：每任务 SUBMIT 行数=候选数（SUCCEEDED 行 generated_images=1、blob 非空；provider_request_id 以 Provider 实际返回为准，真实 Seedream 同步响应无顶层 id → null 属实）、DOWNLOAD 行 sha256=落盘 sha256、候选 ref 非悬空 → verify: 探针绿 + 断言输出留档 README
- [ ] 4.2 spec delta（屏蔽 Requirement 去掉证据句 + 新增「媒体调用证据必须真实落库且与候选终态原子提交」Requirement 含四场景）+ README 同步 + `openspec validate --strict` 过 + 归档 → verify: validate 零错、README 事实与门禁输出一致
