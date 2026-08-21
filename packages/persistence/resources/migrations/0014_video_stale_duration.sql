-- 0014_video_stale_duration.sql
--
-- 0012 将 actual_duration_sec 限制为仅 SUCCEEDED。输入变化后视频候选必须保留
-- 已回报的真实时长并转为 STALE_INPUT（用于人工追溯），该 CHECK 会使首帧改选事务
-- 整体回滚。历史 migration 不可重写，因此重建 video_candidates：允许 STALE_INPUT
-- 保留已回报的正时长，其余列、外键、唯一索引与文件四元组不变量保持不变。

DROP TRIGGER trg_media_invocations_reference_guard_insert;
DROP TRIGGER trg_media_invocations_reference_guard_update;

CREATE TABLE video_candidates_rebuilt (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  shot_version_id TEXT NOT NULL REFERENCES shot_contract_versions(id),
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  index_in_round INTEGER NOT NULL CHECK (index_in_round >= 0),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'STALE_INPUT')),
  file_sha256 TEXT CHECK (file_sha256 IS NULL OR length(file_sha256) = 64),
  byte_size INTEGER,
  mime_type TEXT CHECK (mime_type IS NULL OR mime_type = 'video/mp4'),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  storage_rel_path TEXT,
  model_id TEXT NOT NULL CHECK (length(model_id) > 0),
  provider_task_id TEXT,
  invocation_evidence_ref TEXT,
  requested_duration_sec INTEGER NOT NULL CHECK (requested_duration_sec > 0),
  actual_duration_sec REAL CHECK (
    actual_duration_sec IS NULL
    OR (actual_duration_sec > 0 AND status IN ('SUCCEEDED', 'STALE_INPUT'))
  ),
  first_frame_candidate_id TEXT NOT NULL REFERENCES image_candidates(id),
  first_frame_file_sha256 TEXT NOT NULL CHECK (length(first_frame_file_sha256) = 64),
  error_code TEXT CHECK (error_code IS NULL OR status = 'FAILED'),
  selected_at TEXT,
  selected_by_context TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    status <> 'SUCCEEDED'
    OR (
      file_sha256 IS NOT NULL
      AND storage_rel_path IS NOT NULL
      AND byte_size IS NOT NULL
      AND mime_type IS NOT NULL
    )
  ),
  CHECK (
    file_sha256 IS NULL
    OR (
      storage_rel_path IS NOT NULL
      AND byte_size IS NOT NULL
      AND mime_type IS NOT NULL
    )
  ),
  CHECK (status NOT IN ('SUCCEEDED', 'FAILED') OR invocation_evidence_ref IS NOT NULL),
  UNIQUE (shot_id, round_no, index_in_round)
);

INSERT INTO video_candidates_rebuilt
SELECT id, project_id, shot_id, shot_version_id, round_no, index_in_round, generation_input_hash,
       status, file_sha256, byte_size, mime_type, width, height, storage_rel_path, model_id,
       provider_task_id, invocation_evidence_ref, requested_duration_sec, actual_duration_sec,
       first_frame_candidate_id, first_frame_file_sha256, error_code, selected_at,
       selected_by_context, created_at, updated_at
FROM video_candidates;

DROP TABLE video_candidates;
ALTER TABLE video_candidates_rebuilt RENAME TO video_candidates;

CREATE INDEX ix_video_candidates_shot
ON video_candidates(shot_id, round_no DESC, index_in_round);
CREATE INDEX ix_video_candidates_generation
ON video_candidates(shot_version_id, generation_input_hash);
CREATE UNIQUE INDEX ux_video_candidate_selected
ON video_candidates(shot_id) WHERE selected_at IS NOT NULL;

CREATE TRIGGER trg_media_invocations_reference_guard_insert
BEFORE INSERT ON media_model_invocations
WHEN NOT EXISTS (
  SELECT 1 FROM media_generation_tasks AS task
  JOIN image_candidates AS candidate ON candidate.id = NEW.candidate_id
  WHERE task.id = NEW.media_task_id
)
AND NOT EXISTS (
  SELECT 1 FROM video_generation_tasks AS task
  JOIN video_candidates AS candidate ON candidate.id = NEW.candidate_id
  WHERE task.id = NEW.media_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_INVOCATION_REFERENCE_INVALID');
END;

CREATE TRIGGER trg_media_invocations_reference_guard_update
BEFORE UPDATE OF media_task_id, candidate_id ON media_model_invocations
WHEN NOT EXISTS (
  SELECT 1 FROM media_generation_tasks AS task
  JOIN image_candidates AS candidate ON candidate.id = NEW.candidate_id
  WHERE task.id = NEW.media_task_id
)
AND NOT EXISTS (
  SELECT 1 FROM video_generation_tasks AS task
  JOIN video_candidates AS candidate ON candidate.id = NEW.candidate_id
  WHERE task.id = NEW.media_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_INVOCATION_REFERENCE_INVALID');
END;
