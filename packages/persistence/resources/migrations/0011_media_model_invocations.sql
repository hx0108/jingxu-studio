-- 0011_media_model_invocations.sql
-- 媒体域调用证据表（media-invocation-evidence design D1-D3）：
--   每段真实 Provider 请求一行——SUBMIT 每候选一行（1 任务 4 候选 = 4 行，
--   id = ImageGenerationRequest.invocationId），DOWNLOAD 轻量行（raw_response_blob
--   恒 NULL——图片字节只在内容寻址存储，「字节不入 SQLite」红线不变）。
--   POLL 枚举预留（Seedream 为 SYNC 形态恒不触发）。
--   候选行 image_candidates.invocation_evidence_ref 指向 SUBMIT 行 id（消灭悬空引用）；
--   证据终态收尾与候选终态同一事务原子提交（design D4 两段式）。
--   请求快照不含参考图字节与凭据（只存 sha256 清单）；失败响应原文同样留档（429 复盘）。

CREATE TABLE media_model_invocations (
  id TEXT PRIMARY KEY,
  media_task_id TEXT NOT NULL REFERENCES media_generation_tasks(id),
  candidate_id TEXT NOT NULL REFERENCES image_candidates(id),
  segment_kind TEXT NOT NULL CHECK (segment_kind IN ('SUBMIT', 'POLL', 'DOWNLOAD')),
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED')),
  model_id TEXT NOT NULL,
  request_snapshot_json TEXT NOT NULL CHECK (json_valid(request_snapshot_json)),
  request_sha256 TEXT NOT NULL,
  provider_request_id TEXT,
  response_http_status INTEGER,
  raw_response_blob BLOB,
  raw_response_truncated INTEGER NOT NULL DEFAULT 0 CHECK (raw_response_truncated IN (0, 1)),
  raw_response_sha256 TEXT,
  provider_reported_generated_images INTEGER CHECK (
    provider_reported_generated_images IS NULL OR provider_reported_generated_images >= 0
  ),
  provider_reported_output_tokens INTEGER CHECK (
    provider_reported_output_tokens IS NULL OR provider_reported_output_tokens >= 0
  ),
  error_code TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ix_media_invocations_task ON media_model_invocations(media_task_id);
CREATE INDEX ix_media_invocations_created ON media_model_invocations(created_at);
