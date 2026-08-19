# Design: media-invocation-evidence

> D1–D6 已拍板（2026-08-19，全按推荐）。

## 0. 背景与证据（Apply 前置事实，不需要拍板）

- spec 承诺未兑现：`shot-first-frame-image-generation` spec.md:120 末句「每段真实 Provider 请求 MUST 记一条调用证据并登记 `provider_reported_usage`（图片数）」；`image-model-types.ts:22` 注释「每次各记一条 model_invocations」。现状媒体域证据零留痕。
- 悬空引用：`media-task-scheduler.ts:347` `invocationId: dependencies.newId()` 仅作为字符串写进候选行 `invocation_evidence_ref`（`:204`/`:251`/`:294`），背后无任何证据表行；0009 CHECK 只约束终态候选 ref 非空，不校验指向。
- 结构性不兼容：`model_invocations.job_id TEXT NOT NULL REFERENCES script_stage_jobs`（0001:283 + 0006:17 双约束）；`script_stage_jobs` 的 stage/operation_type CHECK 均限定文本域，伪造 jobs 行不可行；SQLite 不能就地放宽 NOT NULL/FK。
- 适配器信息已到边界即丢：usage 在 `ImageTaskSubmission` SYNC 形态中有值（`seedream-image-model-adapter.ts:233-240`），但 `settleDownload` 签名无 usage 参（`media-task-scheduler.ts:211-217`），拿到即扔；`providerRequestId` 同样只进 `ImageResultRef` 未留档。
- 429 原文根本未读：`seedream-image-model-adapter.ts:206` `#normalizeStatus(response.status)` 只消费状态码，错误响应体连 `response.json()` 都没调——限流复盘原文（`SetLimitExceeded`）在适配器层就丢了。
- `invocationId` 已经在请求对象中流动（`ImageGenerationRequest.invocationId`），是天然证据主键锚点。
- 事务边界现状：`MediaUnitOfWorkPort.run((media) => ...)` 单仓储回调（`media-repository.ts:371-373`）；文本域先例为 `JobRepositories={jobs,invocations}` 同一 `BEGIN IMMEDIATE`。

## D1 表形态（拍板：新表 `media_model_invocations`）

否决表重建合一：既有表 CHECK 枚举（attempt_kind INITIAL/TRANSPORT_RETRY/STRUCTURE_REPAIR、transport_attempt）与媒体形态（无重试段、候选粒度）根本不匹配，同表要么放宽到失去约束价值、要么塞默认值污染语义；0006 十二步重建成本应花在刀刃上。新表零牵动文本域与既有行。

```sql
CREATE TABLE media_model_invocations (
  id TEXT PRIMARY KEY,
  media_task_id TEXT NOT NULL REFERENCES media_generation_tasks(id),
  candidate_id TEXT NOT NULL REFERENCES image_candidates(id),
  segment_kind TEXT NOT NULL CHECK (segment_kind IN ('SUBMIT','POLL','DOWNLOAD')),
  status TEXT NOT NULL CHECK (status IN ('STARTED','SUCCEEDED','FAILED')),
  model_id TEXT NOT NULL,
  request_snapshot_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  provider_request_id TEXT,
  response_http_status INTEGER,
  response_body_blob BLOB,
  response_body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (response_body_truncated IN (0,1)),
  response_sha256 TEXT,
  provider_reported_generated_images INTEGER,
  provider_reported_output_tokens INTEGER,
  error_code TEXT,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_media_invocations_task ON media_model_invocations(media_task_id);
CREATE INDEX idx_media_invocations_created ON media_model_invocations(created_at);
```

- `segment_kind` 预留 `POLL`（Seedream 为 SYNC 形态恒不触发；列 CHECK 现在写入枚举避免日后重建）。
- 无 attempt_kind / duration 列：媒体每段单尝试（重试属上层任务重开，新证据行自然分离）；耗时 = `finished_at - created_at` 可 SQL 派生。
- 不设 `request_sent_at`：适配器本地校验（尺寸/参考图断言）与网络发出在调度器视角不可区分，只有 `created_at`（段开始）与 `finished_at`（段终态）两个诚实时间戳。

## D2 粒度与挂点（拍板：每候选 SUBMIT 行 + DOWNLOAD 轻量行）

- 1 任务 4 候选 = 4 条 SUBMIT 行（对齐 Port 文档「N 候选 = N 次独立 submit 各记一条」）；id = `request.invocationId`（沿用既有 newId 流）。
- 候选行 `invocation_evidence_ref` 一律指向 **SUBMIT 行 id**（spec「调用证据」语义 = 生成调用；消灭悬空引用）。
- DOWNLOAD 段轻量行：`request_snapshot_json` 存 `{resultUrl, providerRequestId}`；`response_sha256` = 落盘图片 sha256、`response_body_blob` 恒 NULL（图片字节已在内容寻址存储，绝不重复入库——沿用「字节不入 SQLite」红线）。
- `media_task_id` + `candidate_id` 双列让任务级聚合与候选级追溯一次 SQL 可达。

## D3 证据内容与脱敏（拍板：全文 blob + 快照不含字节）

- 请求快照：`{modelId, prompt, size, referenceImageSha256s[], responseFormat, watermark}`——参考图只存 sha256 清单，不含字节与 data URI；凭据永不入快照（Authorization 只在适配器内存）。
- SUBMIT 响应：全文 JSON 文本入 `response_body_blob` + `response_sha256`（对齐文本域 raw_response_blob 口径；方舟响应含短期结果 URL，非凭据）。读取上限 64 KiB，超出截断并置 `response_body_truncated=1`（防御性——实际响应远小于此）。
- usage 落列：`provider_reported_generated_images` / `provider_reported_output_tokens`（兑现 spec `provider_reported_usage`（图片数））。
- 失败也留原文：归一 `error_code` 落列，适配器读出的错误响应体同样入 blob（429 复盘靠它）。红线不变：原始内容只进 main 侧 DB，不进 renderer/日志/诊断包；`NormalizedModelError.detail` 保持 null 不透传。

## D4 事务边界（拍板：两段式 + 同事务收尾）

- 两段式（对齐文本域 JobRunner 红线「网络调用在事务外、证据与状态变更同短事务」）：
  1. 段前短事务插 STARTED（含请求快照与 sha256）——submit 段插在 `runSegment` 前；download 段与 `markTaskDownloading` 同事务插。
  2. 网络段在事务外；响应后（成功或归一失败）在**候选终态同一事务**内 `finishTerminal`。
- 成功路径一笔事务三写：`completeCandidateSucceeded` + SUBMIT 行 finishTerminal(SUCCEEDED, 响应/usage) + DOWNLOAD 行 finishTerminal(SUCCEEDED)。
- 失败路径（`onSegmentFailure` Provider 归一分支）：`completeCandidateFailed` + 该段证据行 finishTerminal(FAILED, error_code + 原文) 同事务。【2026-08-20 真实联调修订：下载段失败时 submit 段实际已成功（resultUrl 在手），只收 DOWNLOAD 行会把成功 submit 的响应原文/usage 永久丢失——下载段失败改为同事务三写：候选 FAILED + SUBMIT 行 finishTerminal(SUCCEEDED, raw/usage) + DOWNLOAD 行 FAILED；submit 段失败仍为两写。真实实录：task 1657de32 候选 4aa14454 下载 MODEL_RESULT_UNAVAILABLE，修复前 SUBMIT 行 c5d73dfb 停留 STARTED 且 blob/usage 全空。】
- 取消/持久化异常/停机分支不写候选也不收尾证据行——行停留 STARTED 如实反映中断（崩溃窗口证据，恢复语义零改动，仍不自动重发）。
- 端口形态：`MediaUnitOfWorkPort.run` 回调从 `(media)` 改为 `(repos: MediaRepositories)`，`MediaRepositories = { media, invocations }`（沿 JobRepositories 先例）。调度器/服务层全部调用点机械改为解构；SQLite 与内存两实现 + 组合根同步。

## D5 适配器通道（拍板：成功带 raw、错误 evidenceOf、Mock 同步）

- `ImageTaskSubmission` SYNC 形态加 `raw: Readonly<{ httpStatus: number; bodyText: string }>`（成功响应原文，同 64 KiB 截断规则）。
- `ImageModelPort` 加 `evidenceOf(error: unknown): ModelCallEvidence | null`（`{ httpStatus: number | null; bodyText: string | null }`）：main-only 证据通道，`NormalizedModelError` 保持零原始内容。Seedream 错误路径改为先 `response.text()` 读体（截断规则同上）再抛 `SeedreamAdapterError`（错误对象私有携带 evidence，`evidenceOf` 认领；非 Seedream 错误返回 null）。
- `MockImageModelAdapter`：raw 与 evidenceOf 提供确定性内容（含 `JINGXU_E2E_IMAGE_STEPS` 失败矩阵下的错误原文），供离线断言。
- `image-model-types.ts:21-23` 注释同步：model_invocations → media_model_invocations。

## D6 复盘与验收（拍板：工具 + 离线断言 + 真实联调 SQL 断言）

- `print-real-probe-invocations.mjs` 增媒体域段：`media_model_invocations × media_generation_tasks` 联查（model/segment/status/http/error_code/usage/耗时）。
- 离线：调度器集成测试断言两段式与原子性（成功三写同事务、失败两写同事务、取消停留 STARTED）；Mock E2E 断言证据行数=候选数、ref 非悬空。
- 真实探针一次后 SQL 断言：4 行 SUBMIT/任务（SUCCEEDED 行 usage.generated_images=1、blob 非空、provider_request_id 非空）、DOWNLOAD 行 sha256=落盘 sha256、候选 ref 逐行可 JOIN。

## 决策点汇总

| #   | 决策       | 拍板                                                                    |
| --- | ---------- | ----------------------------------------------------------------------- |
| D1  | 表形态     | 新表 `media_model_invocations`（否决表重建）                            |
| D2  | 粒度与挂点 | 每候选 SUBMIT 行 + DOWNLOAD 轻量行；候选 ref 指 SUBMIT 行               |
| D3  | 证据内容   | 快照不含字节；响应全文 blob + sha256 + 截断标记；usage 落列；失败留原文 |
| D4  | 事务边界   | 两段式；候选终态与证据收尾同一事务；UoW 回调改 MediaRepositories 对象   |
| D5  | 适配器通道 | SYNC 加 raw；Port 加 evidenceOf；错误先读体；Mock 确定性证据            |
| D6  | 复盘与验收 | 脚本扩媒体域 + 集成/E2E 断言 + 真实探针 SQL 断言                        |

## 风险与不变式保护

- **字节不入 SQLite**（spec 既有 Requirement）：DOWNLOAD 行 blob 恒 NULL，图片字节只在内容寻址存储。
- **原始内容不进 renderer/日志/诊断包**：raw/evidenceOf 仅 scheduler 消费；IPC 输出 schema 校验与既有红线不变，image 契约九方法零变化。
- **不自动重发**（spec 既有 Requirement）：恢复扫描逻辑零改动；STARTED 残留行是历史事实，不参与恢复决策（恢复仍只看候选 provider_task_id 证据）。
- **同步 Provider 崩溃窗口**：submit 网络在飞时崩溃 → SUBMIT 行 STARTED 残留、候选仍 PENDING 无 provider_task_id → 恢复仍判 INTERRUPTED 待人工，语义与现状完全一致。
- **UoW 签名变更是全调用点机械重构**：contract 测试钉住两仓储同事务语义；编译器保证无遗漏。
