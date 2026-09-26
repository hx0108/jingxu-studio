-- 0027_editable_composition_timeline.sql
-- 每个时间线片段具有稳定身份与绝对起点；旧版本按既有顺序确定性回填。

ALTER TABLE video_timeline_versions
  ADD COLUMN voice_track_muted INTEGER NOT NULL DEFAULT 0 CHECK (voice_track_muted IN (0, 1));
ALTER TABLE video_timeline_versions
  ADD COLUMN bgm_start_ms INTEGER NOT NULL DEFAULT 0 CHECK (bgm_start_ms >= 0);
ALTER TABLE video_timeline_versions
  ADD COLUMN bgm_trim_in_ms INTEGER NOT NULL DEFAULT 0 CHECK (bgm_trim_in_ms >= 0);
ALTER TABLE video_timeline_versions
  ADD COLUMN bgm_trim_out_ms INTEGER CHECK (bgm_trim_out_ms IS NULL OR bgm_trim_out_ms > bgm_trim_in_ms);
ALTER TABLE video_timeline_versions
  ADD COLUMN bgm_muted INTEGER NOT NULL DEFAULT 0 CHECK (bgm_muted IN (0, 1));
ALTER TABLE video_timeline_versions
  ADD COLUMN bgm_fade_in_ms INTEGER NOT NULL DEFAULT 0 CHECK (bgm_fade_in_ms >= 0);
ALTER TABLE video_timeline_versions
  ADD COLUMN bgm_fade_out_ms INTEGER NOT NULL DEFAULT 2000 CHECK (bgm_fade_out_ms >= 0);

ALTER TABLE video_timeline_items RENAME TO video_timeline_items_legacy;

CREATE TABLE video_timeline_items (
  timeline_version_id TEXT NOT NULL REFERENCES video_timeline_versions(id) ON DELETE CASCADE,
  clip_id TEXT NOT NULL CHECK (length(clip_id) BETWEEN 8 AND 128),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  candidate_id TEXT NOT NULL REFERENCES video_candidates(id),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  position INTEGER NOT NULL CHECK (position >= 0),
  target_start_ms INTEGER NOT NULL CHECK (target_start_ms >= 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  trim_in_ms INTEGER NOT NULL CHECK (trim_in_ms >= 0),
  trim_out_ms INTEGER NOT NULL CHECK (trim_out_ms > trim_in_ms),
  PRIMARY KEY (timeline_version_id, clip_id),
  UNIQUE (timeline_version_id, position)
);

INSERT INTO video_timeline_items
  (timeline_version_id, clip_id, shot_id, candidate_id, file_sha256,
   generation_input_hash, position, target_start_ms, enabled, trim_in_ms, trim_out_ms)
SELECT old.timeline_version_id,
       'clip_' || printf('%016x', old.rowid) || '_' || substr(hex(old.timeline_version_id), 1, 16) || '_' || substr(hex(old.shot_id), 1, 16),
       old.shot_id, old.candidate_id, old.file_sha256, old.generation_input_hash,
       old.position,
       COALESCE(SUM(old.trim_out_ms - old.trim_in_ms) OVER (
         PARTITION BY old.timeline_version_id ORDER BY old.position
         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
       ), 0),
       old.enabled, old.trim_in_ms, old.trim_out_ms
FROM video_timeline_items_legacy AS old;

DROP TABLE video_timeline_items_legacy;

ALTER TABLE video_timeline_voice_items RENAME TO video_timeline_voice_items_legacy;

CREATE TABLE video_timeline_voice_items (
  timeline_version_id TEXT NOT NULL REFERENCES video_timeline_versions(id) ON DELETE CASCADE,
  clip_id TEXT NOT NULL CHECK (length(clip_id) BETWEEN 8 AND 128),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  candidate_id TEXT NOT NULL REFERENCES voice_candidates(id),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  offset_ms INTEGER NOT NULL CHECK (offset_ms >= 0),
  target_start_ms INTEGER NOT NULL CHECK (target_start_ms >= 0),
  volume REAL NOT NULL CHECK (volume >= 0 AND volume <= 1),
  trim_in_ms INTEGER NOT NULL CHECK (trim_in_ms >= 0),
  trim_out_ms INTEGER NOT NULL CHECK (trim_out_ms > trim_in_ms),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (timeline_version_id, clip_id)
);

INSERT INTO video_timeline_voice_items
  (timeline_version_id, clip_id, shot_id, candidate_id, file_sha256,
   generation_input_hash, offset_ms, target_start_ms, volume, trim_in_ms, trim_out_ms, enabled)
SELECT old.timeline_version_id,
       'voice_' || printf('%016x', old.rowid) || '_' || substr(hex(old.timeline_version_id), 1, 16) || '_' || substr(hex(old.shot_id), 1, 16),
       old.shot_id, old.candidate_id, old.file_sha256, old.generation_input_hash,
       old.offset_ms, video.target_start_ms + old.offset_ms, old.volume,
       old.trim_in_ms, old.trim_out_ms, old.enabled
FROM video_timeline_voice_items_legacy AS old
JOIN video_timeline_items AS video
  ON video.timeline_version_id = old.timeline_version_id AND video.shot_id = old.shot_id;

DROP TABLE video_timeline_voice_items_legacy;

CREATE INDEX ix_video_timeline_items_candidate ON video_timeline_items(candidate_id);
CREATE INDEX ix_video_timeline_items_shot ON video_timeline_items(shot_id);
CREATE INDEX ix_video_timeline_items_start ON video_timeline_items(timeline_version_id, target_start_ms, clip_id);
CREATE INDEX ix_voice_timeline_items_candidate ON video_timeline_voice_items(candidate_id);
CREATE INDEX ix_voice_timeline_items_start ON video_timeline_voice_items(timeline_version_id, target_start_ms, clip_id);

-- 时间线保存加入通用幂等回执；已发布的旧 migration 不改写，通过本次追加重建 CHECK。
CREATE TABLE command_receipts_v27 (
  request_id TEXT PRIMARY KEY,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'CREATE_PROJECT', 'UPDATE_PROJECT', 'DELETE_PROJECT', 'RESTORE_PROJECT',
    'INITIALIZE_ORIGINAL', 'INITIALIZE_INPUT', 'REWRITE_SELECTION',
    'SAVE_SCRIPT_DRAFT', 'CONFIRM_SCRIPT_VERSION', 'RESTORE_SCRIPT_VERSION',
    'UPDATE_VIDEO_TIMELINE'
  )),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  project_id TEXT REFERENCES projects(id),
  result_ref_json TEXT NOT NULL CHECK (json_valid(result_ref_json)),
  trace_id TEXT NOT NULL CHECK (length(trace_id) > 0),
  committed_at TEXT NOT NULL
);

INSERT INTO command_receipts_v27
  (request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at)
SELECT request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at
FROM command_receipts;

DROP TABLE command_receipts;
ALTER TABLE command_receipts_v27 RENAME TO command_receipts;
CREATE INDEX ix_command_receipts_project
  ON command_receipts(project_id)
  WHERE project_id IS NOT NULL;
