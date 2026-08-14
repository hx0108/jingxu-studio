-- 0006：凭据删除与调用历史追溯的矛盾修复。
-- deleteCredential 的设计语义是删除 provider_profiles 整行（credential_ref NOT NULL：
-- 行存在即已配置）。但 model_invocations.provider_profile_id 外键引用该行，一旦产生过
-- 调用记录，DELETE 永远 FOREIGN KEY 约束失败；且旧实现先删密文文件后删行，事务回滚后
-- 留下"已配置但密文缺失"的悬挂态（真实联调 2026-08-14 触发）。
-- 取舍：model_invocations 是审计记录，保留 provider_profile_id 文本以追溯"这次调用
-- 用了哪个 profile"，不再以外键约束引用行的存在。删除凭据（安全硬要求）与保留调用
-- 历史（回执硬要求）从此互不阻塞。
-- 注：provider_capability_snapshots / model_price_snapshots 存在同型外键，当前全仓
-- 无写入代码（恒 0 行），本次不动；引入写入方时必须先解决同样的删除阻塞问题。
-- 重建为 SQLite 官方十二步流程的表重建子集。迁移器在 BEGIN 前关闭外键执行并在
-- 提交后以 foreign_key_check 复检——不能用 PRAGMA defer_foreign_keys 替代：它虽在
-- 事务内生效，但 DROP 旧表时隐式 DELETE 产生的违例会记入延迟队列，即使 RENAME 后
-- 数据完整，COMMIT 仍按队列报告 FOREIGN KEY constraint failed（真实库已复现）。
CREATE TABLE model_invocations_v2 (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES script_stage_jobs(id),
  status TEXT NOT NULL CHECK (
    status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED_UNKNOWN_OUTCOME')
  ),
  attempt_kind TEXT NOT NULL CHECK (
    attempt_kind IN ('INITIAL', 'TRANSPORT_RETRY', 'STRUCTURE_REPAIR')
  ),
  transport_attempt INTEGER NOT NULL CHECK (transport_attempt BETWEEN 1 AND 3),
  -- 审计引用：仅保留 profile id 文本，不设外键（见文件头说明）。
  provider_profile_id TEXT NOT NULL,
  provider_request_id TEXT,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
  request_snapshot_json TEXT NOT NULL CHECK (json_valid(request_snapshot_json)),
  request_sha256 TEXT NOT NULL,
  request_sent_at TEXT,
  timeout_at TEXT,
  raw_response_blob BLOB,
  raw_response_sha256 TEXT,
  response_complete_at TEXT,
  late_response_at TEXT,
  parsed_json TEXT CHECK (parsed_json IS NULL OR json_valid(parsed_json)),
  validation_errors_json TEXT CHECK (
    validation_errors_json IS NULL OR json_valid(validation_errors_json)
  ),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  estimated_cost_micros INTEGER CHECK (
    estimated_cost_micros IS NULL OR estimated_cost_micros >= 0
  ),
  currency TEXT CHECK (currency IS NULL OR currency IN ('CNY', 'USD', 'CREDIT')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT
);

INSERT INTO model_invocations_v2 (
  id, job_id, status, attempt_kind, transport_attempt, provider_profile_id,
  provider_request_id, model_id, model_version, parameters_json, request_snapshot_json,
  request_sha256, request_sent_at, timeout_at, raw_response_blob, raw_response_sha256,
  response_complete_at, late_response_at, parsed_json, validation_errors_json,
  input_tokens, output_tokens, estimated_cost_micros, currency, started_at, finished_at,
  error_code
)
SELECT
  id, job_id, status, attempt_kind, transport_attempt, provider_profile_id,
  provider_request_id, model_id, model_version, parameters_json, request_snapshot_json,
  request_sha256, request_sent_at, timeout_at, raw_response_blob, raw_response_sha256,
  response_complete_at, late_response_at, parsed_json, validation_errors_json,
  input_tokens, output_tokens, estimated_cost_micros, currency, started_at, finished_at,
  error_code
FROM model_invocations;

DROP TABLE model_invocations;

ALTER TABLE model_invocations_v2 RENAME TO model_invocations;
