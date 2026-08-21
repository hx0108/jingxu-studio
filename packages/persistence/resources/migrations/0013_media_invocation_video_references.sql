-- 0013_media_invocation_video_references.sql
--
-- 0011 的 media_model_invocations 仅以外键指向图片任务/候选。0012 刻意采用平行
-- video_* 三表后，视频首个 SUBMIT 证据会被该旧 FK 拒绝，调度器只能安全地将任务
-- 标记为 MEDIA_TASK_INTERRUPTED。历史 migration 不可改写，因此本迁移重建证据表：
-- 保留所有列与旧图片行，改用两个触发器保障 (task,candidate) 必须同属图片域或视频域。
-- 这样仍拒绝悬空/跨域证据引用，也允许统一的 invocation Repository 服务两种媒体。

CREATE TABLE media_model_invocations_rebuilt (
  id TEXT PRIMARY KEY,
  media_task_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
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

INSERT INTO media_model_invocations_rebuilt
SELECT id, media_task_id, candidate_id, segment_kind, status, model_id, request_snapshot_json,
       request_sha256, provider_request_id, response_http_status, raw_response_blob,
       raw_response_truncated, raw_response_sha256, provider_reported_generated_images,
       provider_reported_output_tokens, error_code, finished_at, created_at, updated_at
FROM media_model_invocations;

DROP TABLE media_model_invocations;
ALTER TABLE media_model_invocations_rebuilt RENAME TO media_model_invocations;

CREATE INDEX ix_media_invocations_task ON media_model_invocations(media_task_id);
CREATE INDEX ix_media_invocations_created ON media_model_invocations(created_at);

CREATE TRIGGER trg_media_invocations_reference_guard_insert
BEFORE INSERT ON media_model_invocations
WHEN NOT EXISTS (
  SELECT 1
  FROM media_generation_tasks AS task
  JOIN image_candidates AS candidate ON candidate.id = NEW.candidate_id
  WHERE task.id = NEW.media_task_id
)
AND NOT EXISTS (
  SELECT 1
  FROM video_generation_tasks AS task
  JOIN video_candidates AS candidate ON candidate.id = NEW.candidate_id
  WHERE task.id = NEW.media_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_INVOCATION_REFERENCE_INVALID');
END;

CREATE TRIGGER trg_media_invocations_reference_guard_update
BEFORE UPDATE OF media_task_id, candidate_id ON media_model_invocations
WHEN NOT EXISTS (
  SELECT 1
  FROM media_generation_tasks AS task
  JOIN image_candidates AS candidate ON candidate.id = NEW.candidate_id
  WHERE task.id = NEW.media_task_id
)
AND NOT EXISTS (
  SELECT 1
  FROM video_generation_tasks AS task
  JOIN video_candidates AS candidate ON candidate.id = NEW.candidate_id
  WHERE task.id = NEW.media_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_INVOCATION_REFERENCE_INVALID');
END;
