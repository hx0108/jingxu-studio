-- 0020_voice_audio_timeline.sql
-- V2 语音音频时间线（v2-voice-audio-timeline design D3）：配音生成/候选/映射三表
-- + 时间线版本 audio_volume 列 + 配音/字幕两轨表。不修改既有视频候选/导出语义。
--   voice_generation_jobs   整集批量请求行（requestId 幂等 + 两段式证据 JSON）
--   voice_candidates        逐镜头配音候选（字节不落库红线：sha256/mime/时长 +
--                           内容寻址相对路径，ffprobe duration_ms>0 才可 SUCCEEDED）
--   voice_mappings          项目级 speaker→voice（narrator 固定行由应用层钉住）
-- 字节不落库红线与候选字段四元组同生同灭语义沿用 0012 video_candidates 约束族。

CREATE TABLE voice_generation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  request_id TEXT NOT NULL,
  -- 同步调度器相位：建档 QUEUED → 串行 RUNNING → 终态（PARTIAL 为单镜头失败不阻断口径）。
  status TEXT NOT NULL CHECK (
    status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL_COMPLETED', 'CANCELLED')
  ),
  -- 建批回执（幂等重放返回一致回执）：目标镜头与跳过清单（含稳定原因）。
  target_shot_ids_json TEXT NOT NULL CHECK (json_valid(target_shot_ids_json)),
  skipped_shots_json TEXT NOT NULL CHECK (json_valid(skipped_shots_json)),
  -- 两段式调用证据（STARTED + 终态；证据边界沿用 media-invocation-evidence，
  -- 不含 spoken_text 与凭据）。取消先落库：证据即中止边界。
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, request_id)
);

CREATE TABLE voice_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  shot_version_id TEXT NOT NULL REFERENCES shot_contract_versions(id),
  job_id TEXT NOT NULL REFERENCES voice_generation_jobs(id),
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  index_in_round INTEGER NOT NULL CHECK (index_in_round >= 0),
  -- 说话人（narrator 或 char_*，ShotContract SPEAKER_ID_PATTERN 同源）。
  speaker_id TEXT NOT NULL CHECK (speaker_id = 'narrator' OR speaker_id LIKE 'char_%'),
  spoken_text_sha256 TEXT NOT NULL CHECK (length(spoken_text_sha256) = 64),
  -- 冻结的音色/模型（注册表内值；映射变更不改写已建档候选）。
  voice_id TEXT NOT NULL CHECK (length(voice_id) > 0),
  model_id TEXT NOT NULL CHECK (length(model_id) > 0),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'STALE_INPUT')),
  -- ffprobe 实测时长（>0 才可登记成功；不估算）。
  duration_ms INTEGER CHECK (duration_ms IS NULL OR (duration_ms > 0 AND status = 'SUCCEEDED')),
  file_sha256 TEXT CHECK (file_sha256 IS NULL OR length(file_sha256) = 64),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
  mime_type TEXT CHECK (
    mime_type IS NULL OR mime_type IN ('audio/mpeg', 'audio/wav', 'audio/mp4')
  ),
  storage_rel_path TEXT,
  error_code TEXT CHECK (error_code IS NULL OR status = 'FAILED'),
  selected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    status <> 'SUCCEEDED'
    OR (
      file_sha256 IS NOT NULL
      AND storage_rel_path IS NOT NULL
      AND byte_size IS NOT NULL
      AND mime_type IS NOT NULL
      AND duration_ms IS NOT NULL
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
  UNIQUE (shot_id, round_no, index_in_round)
);

CREATE TABLE voice_mappings (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  speaker_id TEXT NOT NULL CHECK (speaker_id = 'narrator' OR speaker_id LIKE 'char_%'),
  voice_id TEXT NOT NULL CHECK (length(voice_id) > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, speaker_id)
);

-- BGM 音量数据化（默认 0.20 = 既有 ffmpeg-video-composer 硬编码现状；
-- 既有版本行读出即等效旧行为）。
ALTER TABLE video_timeline_versions ADD COLUMN audio_volume REAL NOT NULL DEFAULT 0.2;

CREATE TABLE video_timeline_voice_items (
  timeline_version_id TEXT NOT NULL REFERENCES video_timeline_versions(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  -- 候选三元组（candidateId/fileSha256/generationInputHash）成对固化：漂移按稳定错误拒绝。
  candidate_id TEXT NOT NULL REFERENCES voice_candidates(id),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  offset_ms INTEGER NOT NULL CHECK (offset_ms >= 0),
  volume REAL NOT NULL CHECK (volume >= 0 AND volume <= 1),
  trim_in_ms INTEGER NOT NULL CHECK (trim_in_ms >= 0),
  trim_out_ms INTEGER NOT NULL CHECK (trim_out_ms > trim_in_ms),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (timeline_version_id, shot_id)
);

CREATE TABLE video_timeline_subtitle_items (
  timeline_version_id TEXT NOT NULL REFERENCES video_timeline_versions(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  -- 文本从镜头 spoken_text 派生，以哈希锚定（不复制文本本体）。
  spoken_text_sha256 TEXT NOT NULL CHECK (length(spoken_text_sha256) = 64),
  -- 默认安全区样式快照（随版本冻结；样式编辑器为非目标）。
  safe_area_pct INTEGER NOT NULL CHECK (safe_area_pct >= 0 AND safe_area_pct <= 20),
  style_snapshot_json TEXT NOT NULL CHECK (json_valid(style_snapshot_json)),
  PRIMARY KEY (timeline_version_id, shot_id)
);

CREATE INDEX ix_voice_jobs_project_status
ON voice_generation_jobs(project_id, status, created_at DESC);
CREATE INDEX ix_voice_candidates_shot
ON voice_candidates(shot_id, round_no DESC, index_in_round);
CREATE INDEX ix_voice_candidates_generation
ON voice_candidates(shot_version_id, generation_input_hash);
CREATE INDEX ix_voice_candidates_job ON voice_candidates(job_id);
CREATE INDEX ix_voice_timeline_items_candidate ON video_timeline_voice_items(candidate_id);
-- 每镜头至多一条当前配音候选（STALE 历史指针在新选择落位时清除，同 0012 语义）。
CREATE UNIQUE INDEX ux_voice_candidate_selected
ON voice_candidates(shot_id) WHERE selected_at IS NOT NULL;
