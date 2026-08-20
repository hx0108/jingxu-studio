-- 0012_shot_video_generation.sql
-- 逐镜头视频段生成（shot-video-generation design A1，平行三表——不复用 image 三表：
-- media_generation_tasks 的 UNIQUE(shot_id, round_no) 与视频共用会撞唯一键，且不动
-- 生产验证过的图片 schema）：
--   video_batches / video_generation_tasks / video_candidates   镜像 0010/0009 约束族
-- 字节不落库红线不变：候选只存 sha256/尺寸/mp4 mime 与内容寻址相对路径（videos 命名空间）。
-- 增列（对 image_candidates）：requested_duration_sec（请求档位）/actual_duration_sec
-- （Provider 回报，未记 null 如实）/first_frame_candidate_id（生成时选中的首帧候选）/
-- first_frame_file_sha256（首帧改选 STALE 判定依据，确定性 join 无哈希簿记）。
-- 本切片不续写不裁剪：续写段数恒 0、裁剪区间恒 null，由应用层落列，不设列。
-- 另播种能力快照 volcark-seedance-video/v1：canonical JSON 1437 字节、
-- sha256=7aefec11df27ca2c232049f0870e6d40538de18c70edc147be2df750ac5bbee3、
-- model id 在 7.1 官方核验前为文档候选（快照内已注明；实测不符则快照升版留勘误）。
-- 快照行先于 profile_video_primary profile 行存在合法——0007 已解除该表对
-- provider_profiles 的外键。

CREATE TABLE video_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL_COMPLETED', 'CANCELLED')),
  -- 建批时经当前世代跳过过滤后的有效目标（顺序即排队顺序）。
  target_shot_ids_json TEXT NOT NULL CHECK (json_valid(target_shot_ids_json)),
  -- 尚未建档的队列（惰性消费：事务内取队首建档后移除）。
  pending_shot_ids_json TEXT NOT NULL CHECK (json_valid(pending_shot_ids_json)),
  -- 服务端跳过过滤回告（无已选首帧/当前世代已有 SUCCEEDED 视频候选的镜头）。
  skipped_shot_ids_json TEXT NOT NULL CHECK (json_valid(skipped_shot_ids_json)),
  -- 中止场景（成员建档失败）的批次级稳定错误码；正常收尾为 NULL。
  error_code TEXT CHECK (error_code IS NULL OR status <> 'COMPLETED'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE TABLE video_generation_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  shot_version_id TEXT NOT NULL REFERENCES shot_contract_versions(id),
  idempotency_key TEXT NOT NULL,
  provider_task_id TEXT,
  -- 相位机与图片任务同构；视频 Provider 真 ASYNC：SUBMITTED 后经 POLLING 推进。
  phase TEXT NOT NULL CHECK (
    phase IN ('SUBMITTED', 'POLLING', 'DOWNLOADING', 'COMPLETED', 'FAILED', 'CANCELLED')
  ),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  candidate_count INTEGER NOT NULL CHECK (candidate_count > 0 AND candidate_count <= 16),
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  batch_id TEXT REFERENCES video_batches(id),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key),
  UNIQUE (shot_id, round_no)
);

CREATE TABLE video_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  shot_version_id TEXT NOT NULL REFERENCES shot_contract_versions(id),
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  index_in_round INTEGER NOT NULL CHECK (index_in_round >= 0),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'STALE_INPUT')),
  -- 文件字段四元组同生同灭；SUCCEEDED 必须齐全，STALE_INPUT 保留可追溯；mime 仅 mp4。
  file_sha256 TEXT CHECK (file_sha256 IS NULL OR length(file_sha256) = 64),
  byte_size INTEGER,
  mime_type TEXT CHECK (mime_type IS NULL OR mime_type = 'video/mp4'),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  storage_rel_path TEXT,
  model_id TEXT NOT NULL CHECK (length(model_id) > 0),
  provider_task_id TEXT,
  -- 调用证据引用（media_model_invocations.id，与图片共用证据表）；终态候选必须可追溯。
  invocation_evidence_ref TEXT,
  -- 时长口径（PRD 10.3.1）：请求档位建候选时落列；实际时长取 Provider 回报字段，
  -- 未回报 null 如实（不估算）；仅 SUCCEEDED 行可有值。
  requested_duration_sec INTEGER NOT NULL CHECK (requested_duration_sec > 0),
  actual_duration_sec REAL CHECK (
    actual_duration_sec IS NULL OR (actual_duration_sec > 0 AND status = 'SUCCEEDED')
  ),
  -- 生成时选中的首帧（i2v 输入锚点）：候选与首帧候选/其文件 sha 成对固化，
  -- 首帧改选后按 sha 不一致判定 STALE（确定性 join）。
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

CREATE INDEX ix_video_candidates_shot
ON video_candidates(shot_id, round_no DESC, index_in_round);
CREATE INDEX ix_video_candidates_generation
ON video_candidates(shot_version_id, generation_input_hash);
CREATE INDEX ix_video_tasks_project_phase ON video_generation_tasks(project_id, phase);
CREATE INDEX ix_video_batches_project_status ON video_batches(project_id, status);
CREATE INDEX ix_video_tasks_batch ON video_generation_tasks(batch_id) WHERE batch_id IS NOT NULL;
-- 每镜头至多一个当前选择（STALE 候选上的历史指针在新选择落位时被清除）。
CREATE UNIQUE INDEX ux_video_candidate_selected
ON video_candidates(shot_id) WHERE selected_at IS NOT NULL;

INSERT INTO provider_capability_snapshots
  (id, provider_profile_id, snapshot_version, valid_from, expires_at,
   capabilities_json, source_url, sha256)
VALUES
  ('volcark-seedance-video/v1', 'profile_video_primary', '1', '2026-08-20', '9999-12-31',
   '{"provider":"volcark-seedance","capability":"VIDEO_GENERATION","model_id":"doubao-seedance-1-0-lite-i2v-250428","model_id_alternates":[],"endpoint":{"method":"POST","path":"/api/v3/contents/generations/tasks","poll":{"method":"GET","path":"/api/v3/contents/generations/tasks/{id}"},"base_url_cn_beijing":"https://ark.cn-beijing.volces.com","auth":"Bearer ARK_API_KEY"},"semantics":{"mode":"ASYNCHRONOUS","stream":false,"notes":"首帧图生视频（i2v）：content 数组 text+image_url(data URI)；create task→poll status→download video_url mp4。model id 与字段名在 7.1 官方核验前为文档候选，实测不符则快照升版并留勘误"},"request":{"duration_range":[5,10],"resolution":{"tiers":["720p","1080p"],"tier_rule":"短边就近：min(width,height)>=1080 取 1080p 否则 720p","max_edge_px":1920,"ratio":"adaptive"},"first_frame":{"max_bytes":10485760,"formats":["jpeg","png","webp"],"encoding":"data URI（base64）"},"unsupported_params":["seed","guidance_scale"],"client_defaults":{"return_url":true,"watermark":true}},"response":{"task_status_values":["queued","running","succeeded","failed","cancelled"],"video_format":"mp4（ftyp 魔数嗅探，不信任 Content-Type）","video_url_validity_hours":24,"usage_fields":["completion_tokens","generated_video_seconds"],"actual_duration":"usage.generated_video_seconds，未回报记 null 如实"},"rate_limit":{"note":"官方配额未实测，7.1 核验"}}',
   'https://www.volcengine.com/docs/82379/1520757',
   '7aefec11df27ca2c232049f0870e6d40538de18c70edc147be2df750ac5bbee3');
