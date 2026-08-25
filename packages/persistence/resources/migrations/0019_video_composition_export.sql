-- 0019_video_composition_export.sql
-- V2 单集视频时间线、音频资产和本地导出 Job；不修改既有候选/批次语义。

CREATE TABLE video_timelines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE video_timeline_versions (
  id TEXT PRIMARY KEY,
  timeline_id TEXT NOT NULL REFERENCES video_timelines(id) ON DELETE CASCADE,
  episode_version_id TEXT NOT NULL REFERENCES episode_versions(id),
  format_profile_id TEXT NOT NULL REFERENCES format_profiles(id),
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  parent_version_id TEXT REFERENCES video_timeline_versions(id),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  audio_asset_id TEXT,
  total_duration_ms INTEGER NOT NULL CHECK (total_duration_ms >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (timeline_id, version_no)
);

CREATE TABLE video_timeline_items (
  timeline_version_id TEXT NOT NULL REFERENCES video_timeline_versions(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  candidate_id TEXT NOT NULL REFERENCES video_candidates(id),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  position INTEGER NOT NULL CHECK (position >= 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  trim_in_ms INTEGER NOT NULL CHECK (trim_in_ms >= 0),
  trim_out_ms INTEGER NOT NULL CHECK (trim_out_ms > trim_in_ms),
  PRIMARY KEY (timeline_version_id, shot_id),
  UNIQUE (timeline_version_id, position)
);

CREATE TABLE video_audio_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_file_name TEXT NOT NULL CHECK (length(original_file_name) > 0),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 536870912),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('audio/mpeg', 'audio/wav', 'audio/x-m4a', 'audio/mp4')),
  storage_rel_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, file_sha256)
);

CREATE TABLE video_export_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  timeline_version_id TEXT NOT NULL REFERENCES video_timeline_versions(id),
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PREPARING', 'RUNNING', 'VALIDATING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  total_duration_ms INTEGER,
  file_sha256 TEXT CHECK (file_sha256 IS NULL OR length(file_sha256) = 64),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
  storage_rel_path TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, request_id)
);

CREATE INDEX ix_video_timeline_project_episode ON video_timelines(project_id, episode_id);
CREATE INDEX ix_video_timeline_versions_timeline ON video_timeline_versions(timeline_id, version_no DESC);
CREATE INDEX ix_video_export_jobs_project_status ON video_export_jobs(project_id, status, created_at DESC);
CREATE INDEX ix_video_export_jobs_timeline ON video_export_jobs(timeline_version_id);
