-- 0024_low_cost_video_provider_provenance.sql
-- 视频 Provider 溯源冻结（low-cost-video-provider-integration design D3 余量切片）。
-- 0023 已被发布字节钉死（仅承载偏好单例），任务/候选冻结列顺延至此：
--   1) 播种 dashscope-wan-video/v1、agnes-video/v1 与 volcark-seedance-video/v3
--      （2.x 家族）能力快照，canonical JSON + sha256 三处可核；
--   2) 重建 video_generation_tasks / video_candidates，增 provider_kind /
--      provider_profile_id / model_id（任务侧）/ capability_snapshot_id / is_mock，
--      全部非空并受 Provider↔Profile 固定映射 CHECK 约束（与偏好单例同一张映射表）；
--   3) 历史行只按受控 model_id 映射回填：候选按自身 model_id，任务按同轮候选的
--      唯一 model_id；未知模型或无候选证据 → NOT NULL 违例 → 迁移整体回滚阻断，
--      不猜测 Provider（design D3）。
-- 缺省值说明：写路径在 4.1（建档事务显式冻结）落地前沿用 Seedance 真实档缺省——
-- 当前运行面仅 Seedance/Mock；Mock 行 is_mock 暂落 0 的窗口由 4.1 收口。

INSERT INTO provider_capability_snapshots
  (id, provider_profile_id, snapshot_version, valid_from, expires_at,
   capabilities_json, source_url, sha256)
VALUES
  ('dashscope-wan-video/v1', 'profile-video-wan-primary', '1', '2026-09-18', '9999-12-31',
   '{"provider":"dashscope-wan","capability":"VIDEO_GENERATION","model_id":"wan2.6-i2v-flash","model_id_alternates":[],"endpoint":{"method":"POST","path":"/api/v1/services/aigc/video-generation/video-synthesis","poll":{"method":"GET","path":"/api/v1/tasks/{task_id}"},"base_url_template":"https://{workspaceId}.cn-beijing.maas.aliyuncs.com","workspace_id_charset":"[A-Za-z0-9-]","auth":"Bearer DASHSCOPE_API_KEY","async_header":{"X-DashScope-Async":"enable"}},"semantics":{"mode":"ASYNCHRONOUS","stream":false,"notes":"首帧图生视频（i2v）：Base64 img_url 异步建任务→轮询任务状态→24 小时内下载结果 mp4。无声子集：请求必须显式 audio=false（模型默认有声，有声刊例价翻倍）。"},"request":{"duration_range":[2,15],"duration_rule":"2～15 秒整数","resolution":{"tiers":["720P","1080P"],"tier_rule":"按首帧目标尺寸就近映射（720P/1080P）"},"first_frame":{"max_bytes":20971520,"formats":["jpeg","png","bmp","webp"],"encoding":"Base64（img_url 字段）","pixel_edge_range":[240,8000]},"fixed_params":{"audio":false,"prompt_extend":false,"shot_type":"single","watermark":true}},"response":{"task_status_values":["PENDING","RUNNING","SUCCEEDED","FAILED","UNKNOWN"],"video_format":"mp4（ftyp 魔数嗅探，不信任 Content-Type）","video_url_validity_hours":24},"rate_limit":{"note":"配额与实际可用性以真实探针为准（7.4 未运行前不得声明万相账号可用）"}}',
   'https://help.aliyun.com/zh/model-studio/legacy-image-to-video-api-reference/',
   '299d0f2128078364d86f27122e553cd77824ce6c5a7604b9bb2cf5d0a4230d5c'),
  ('agnes-video/v1', 'profile-video-agnes-primary', '1', '2026-09-19', '9999-12-31',
   '{"provider":"agnes-ai","capability":"VIDEO_GENERATION","model_id":"agnes-video-v2.0","model_id_alternates":["agnes-video-2.5-flash"],"endpoint":{"method":"POST","path":"/v1/videos","poll":{"method":"GET","path":"/agnesapi?video_id={video_id}&model_name={model_id}"},"base_url":"https://apihub.agnes-ai.com","auth":"Bearer AGNES_API_KEY"},"semantics":{"mode":"ASYNCHRONOUS","stream":false,"notes":"首帧图生视频（i2v）：v2.0 走 image(data URL)+mode:ti2vid；2.5 Flash 走 first_frame+mode:keyframe（images 数组不被该模式接受）。完成态结果 URL 在顶层 url 字段（官方文档写 metadata.url，与 2026-09-19 实测不符，按实测冻结）。seconds 参数为字符串。"},"request":{"duration_range":[5,5],"duration_rule":"固定 5 秒，不开放时长参数","resolution":{"tiers":["720P"],"tier_rule":"固定 720P：2.5 Flash 服务端硬校验；v2.0 服务端归一到 720P 级预设"},"first_frame":{"max_bytes":10485760,"formats":["jpeg","png","webp"],"encoding":"data URL（data:<mime>;base64,...）","pixel_edge_range":[256,5760],"pixel_edge_note":"2.5 Flash 服务端校验首帧边长"},"fixed_params":{"seconds":"5"}},"response":{"task_status_values":["pending","queued","in_progress","completed","failed"],"video_format":"mp4（ftyp 魔数嗅探，不信任 Content-Type）","download_domain_suffixes":["agnes-ai.cn","agnes-ai.space"]},"rate_limit":{"free_tier_rpm":1,"note":"免费档 1 RPM 且有累积 API 限流与每日时长配额；429 归一 MODEL_RATE_LIMITED（可重试）交调度器退避"}}',
   'https://wiki.agnes-ai.com/en/docs/agnes-video-v20',
   '1535fad9497b21cb8f85f1cffeacc73ec7837bc05a247188e5314b87c017331e'),
  ('volcark-seedance-video/v3', 'profile_video_primary', '3', '2026-01-28', '9999-12-31',
   '{"provider":"volcark-seedance","capability":"VIDEO_GENERATION","model_id":"doubao-seedance-2-0-260128","model_id_alternates":["doubao-seedance-2-0-mini-260615","doubao-seedance-2-5-260628"],"endpoint":{"method":"POST","path":"/api/v3/contents/generations/tasks","poll":{"method":"GET","path":"/api/v3/contents/generations/tasks/{id}"},"base_url_cn_beijing":"https://ark.cn-beijing.volces.com","auth":"Bearer ARK_API_KEY"},"semantics":{"mode":"ASYNCHRONOUS","stream":false,"notes":"Seedance 2.x 家族（2.0 / 2.0-mini / 2.5）首帧图生视频（i2v）：content 数组 text+image_url(data URI)；create task→poll status→download video_url mp4。家族能力记录：mini 与 2.5 最高 720p，2.0 支持 1080p。"},"request":{"duration_range":[5,10],"resolution":{"tiers":["720p","1080p"],"tier_rule":"短边就近：min(width,height)>=1080 取 1080p 否则 720p（mini/2.5 恒 720p）","max_edge_px":1920,"ratio":"adaptive"},"first_frame":{"max_bytes":10485760,"formats":["jpeg","png","webp"],"encoding":"data URI（base64）"},"unsupported_params":["seed","guidance_scale"],"client_defaults":{"return_url":true,"watermark":true,"generate_audio":false}},"response":{"task_status_values":["queued","running","succeeded","failed","cancelled"],"video_format":"mp4（ftyp 魔数嗅探，不信任 Content-Type）","video_url_validity_hours":24,"usage_fields":["completion_tokens","generated_video_seconds"],"actual_duration":"usage.generated_video_seconds，未回报记 null 如实"},"rate_limit":{"note":"配额与实际模型可用性由真实探针记录"}}',
   'https://www.volcengine.com/docs/82379/1520757',
   '7386d17634368908cae4a2672f9b54f0e510cd4e0288a8e8a373420162a8b03a');

-- 证据表守卫触发器引用 video 两表；DROP/RENAME 会连带删触发器，先摘后重建（同 0014）。
DROP TRIGGER trg_media_invocations_reference_guard_insert;
DROP TRIGGER trg_media_invocations_reference_guard_update;

-- ── video_generation_tasks 重建（0012 全列 + 溯源五列）────────────────────────
-- 采用 0014 的 rebuilt→DROP→RENAME 顺序：先 RENAME 旧表会让子表外键被 SQLite
-- 改写指向 legacy 表名、DROP 后悬空；rebuilt 顺序下子表外键始终按原名解析。
CREATE TABLE video_generation_tasks_rebuilt_0024 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  shot_version_id TEXT NOT NULL REFERENCES shot_contract_versions(id),
  idempotency_key TEXT NOT NULL,
  provider_task_id TEXT,
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
  provider_kind TEXT NOT NULL DEFAULT 'VOLCARK_SEEDANCE'
    CHECK (provider_kind IN ('VOLCARK_SEEDANCE', 'DASHSCOPE_WAN_VIDEO', 'AGNES_VIDEO')),
  provider_profile_id TEXT NOT NULL DEFAULT 'profile-video-primary'
    CHECK (
      (provider_kind = 'VOLCARK_SEEDANCE' AND provider_profile_id = 'profile-video-primary')
      OR (provider_kind = 'DASHSCOPE_WAN_VIDEO' AND provider_profile_id = 'profile-video-wan-primary')
      OR (provider_kind = 'AGNES_VIDEO' AND provider_profile_id = 'profile-video-agnes-primary')
    ),
  capability_snapshot_id TEXT NOT NULL DEFAULT 'volcark-seedance-video/v3'
    REFERENCES provider_capability_snapshots(id),
  is_mock INTEGER NOT NULL DEFAULT 0 CHECK (is_mock IN (0, 1)),
  model_id TEXT NOT NULL DEFAULT 'doubao-seedance-2-0-260128' CHECK (length(model_id) > 0),
  UNIQUE (project_id, idempotency_key),
  UNIQUE (shot_id, round_no)
);

INSERT INTO video_generation_tasks_rebuilt_0024
  (id, project_id, shot_id, shot_version_id, idempotency_key, provider_task_id, phase,
   generation_input_hash, candidate_count, round_no, batch_id, error_code, created_at, updated_at)
SELECT id, project_id, shot_id, shot_version_id, idempotency_key, provider_task_id, phase,
       generation_input_hash, candidate_count, round_no, batch_id, error_code, created_at, updated_at
FROM video_generation_tasks;

-- 任务 model_id 回填：取同轮候选的唯一 model_id；多模型或无候选证据 → NULL → 阻断。
UPDATE video_generation_tasks_rebuilt_0024
SET model_id = (
  SELECT CASE WHEN COUNT(DISTINCT candidate.model_id) = 1 THEN MIN(candidate.model_id) END
  FROM video_candidates AS candidate
  WHERE candidate.shot_id = video_generation_tasks_rebuilt_0024.shot_id
    AND candidate.round_no = video_generation_tasks_rebuilt_0024.round_no
);

-- 溯源三列必须单条 UPDATE 一次成型：分步回填会短暂破坏 provider↔Profile 跨列
-- CHECK（SQLite 逐语句复核），受控映射外返回 NULL → NOT NULL 违例 → 整体回滚阻断。
UPDATE video_generation_tasks_rebuilt_0024
SET provider_kind = CASE model_id
      WHEN 'doubao-seedance-1-0-lite-i2v-250428' THEN 'VOLCARK_SEEDANCE'
      WHEN 'doubao-seedance-1-5-pro-251215' THEN 'VOLCARK_SEEDANCE'
      WHEN 'doubao-seedance-2-0-mini-260615' THEN 'VOLCARK_SEEDANCE'
      WHEN 'doubao-seedance-2-0-260128' THEN 'VOLCARK_SEEDANCE'
      WHEN 'doubao-seedance-2-5-260628' THEN 'VOLCARK_SEEDANCE'
      WHEN 'wan2.6-i2v-flash' THEN 'DASHSCOPE_WAN_VIDEO'
      WHEN 'agnes-video-v2.0' THEN 'AGNES_VIDEO'
      WHEN 'agnes-video-2.5-flash' THEN 'AGNES_VIDEO'
    END,
    provider_profile_id = CASE model_id
      WHEN 'doubao-seedance-1-0-lite-i2v-250428' THEN 'profile-video-primary'
      WHEN 'doubao-seedance-1-5-pro-251215' THEN 'profile-video-primary'
      WHEN 'doubao-seedance-2-0-mini-260615' THEN 'profile-video-primary'
      WHEN 'doubao-seedance-2-0-260128' THEN 'profile-video-primary'
      WHEN 'doubao-seedance-2-5-260628' THEN 'profile-video-primary'
      WHEN 'wan2.6-i2v-flash' THEN 'profile-video-wan-primary'
      WHEN 'agnes-video-v2.0' THEN 'profile-video-agnes-primary'
      WHEN 'agnes-video-2.5-flash' THEN 'profile-video-agnes-primary'
    END,
    capability_snapshot_id = CASE model_id
      WHEN 'doubao-seedance-1-0-lite-i2v-250428' THEN 'volcark-seedance-video/v1'
      WHEN 'doubao-seedance-1-5-pro-251215' THEN 'volcark-seedance-video/v2'
      WHEN 'doubao-seedance-2-0-mini-260615' THEN 'volcark-seedance-video/v3'
      WHEN 'doubao-seedance-2-0-260128' THEN 'volcark-seedance-video/v3'
      WHEN 'doubao-seedance-2-5-260628' THEN 'volcark-seedance-video/v3'
      WHEN 'wan2.6-i2v-flash' THEN 'dashscope-wan-video/v1'
      WHEN 'agnes-video-v2.0' THEN 'agnes-video/v1'
      WHEN 'agnes-video-2.5-flash' THEN 'agnes-video/v1'
    END;

DROP TABLE video_generation_tasks;
ALTER TABLE video_generation_tasks_rebuilt_0024 RENAME TO video_generation_tasks;

CREATE INDEX ix_video_tasks_project_phase ON video_generation_tasks(project_id, phase);
CREATE INDEX ix_video_tasks_batch
ON video_generation_tasks(batch_id) WHERE batch_id IS NOT NULL;

-- ── video_candidates 重建（0014 全列 + 溯源四列；model_id 既有）───────────────
-- 同上 rebuilt→DROP→RENAME 顺序（video_timeline_items.candidate_id 外键按名解析）。
CREATE TABLE video_candidates_rebuilt_0024 (
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
  provider_kind TEXT NOT NULL DEFAULT 'VOLCARK_SEEDANCE'
    CHECK (provider_kind IN ('VOLCARK_SEEDANCE', 'DASHSCOPE_WAN_VIDEO', 'AGNES_VIDEO')),
  provider_profile_id TEXT NOT NULL DEFAULT 'profile-video-primary'
    CHECK (
      (provider_kind = 'VOLCARK_SEEDANCE' AND provider_profile_id = 'profile-video-primary')
      OR (provider_kind = 'DASHSCOPE_WAN_VIDEO' AND provider_profile_id = 'profile-video-wan-primary')
      OR (provider_kind = 'AGNES_VIDEO' AND provider_profile_id = 'profile-video-agnes-primary')
    ),
  capability_snapshot_id TEXT NOT NULL DEFAULT 'volcark-seedance-video/v3'
    REFERENCES provider_capability_snapshots(id),
  is_mock INTEGER NOT NULL DEFAULT 0 CHECK (is_mock IN (0, 1)),
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

INSERT INTO video_candidates_rebuilt_0024
  (id, project_id, shot_id, shot_version_id, round_no, index_in_round, generation_input_hash,
   status, file_sha256, byte_size, mime_type, width, height, storage_rel_path, model_id,
   provider_task_id, invocation_evidence_ref, requested_duration_sec, actual_duration_sec,
   first_frame_candidate_id, first_frame_file_sha256, error_code, selected_at,
   selected_by_context, created_at, updated_at)
SELECT id, project_id, shot_id, shot_version_id, round_no, index_in_round, generation_input_hash,
       status, file_sha256, byte_size, mime_type, width, height, storage_rel_path, model_id,
       provider_task_id, invocation_evidence_ref, requested_duration_sec, actual_duration_sec,
       first_frame_candidate_id, first_frame_file_sha256, error_code, selected_at,
       selected_by_context, created_at, updated_at
FROM video_candidates;

UPDATE video_candidates_rebuilt_0024
SET provider_kind = CASE model_id
      WHEN 'doubao-seedance-1-0-lite-i2v-250428' THEN 'VOLCARK_SEEDANCE'
      WHEN 'doubao-seedance-1-5-pro-251215' THEN 'VOLCARK_SEEDANCE'
      WHEN 'doubao-seedance-2-0-mini-260615' THEN 'VOLCARK_SEEDANCE'
      WHEN 'doubao-seedance-2-0-260128' THEN 'VOLCARK_SEEDANCE'
      WHEN 'doubao-seedance-2-5-260628' THEN 'VOLCARK_SEEDANCE'
      WHEN 'wan2.6-i2v-flash' THEN 'DASHSCOPE_WAN_VIDEO'
      WHEN 'agnes-video-v2.0' THEN 'AGNES_VIDEO'
      WHEN 'agnes-video-2.5-flash' THEN 'AGNES_VIDEO'
    END,
    provider_profile_id = CASE model_id
      WHEN 'doubao-seedance-1-0-lite-i2v-250428' THEN 'profile-video-primary'
      WHEN 'doubao-seedance-1-5-pro-251215' THEN 'profile-video-primary'
      WHEN 'doubao-seedance-2-0-mini-260615' THEN 'profile-video-primary'
      WHEN 'doubao-seedance-2-0-260128' THEN 'profile-video-primary'
      WHEN 'doubao-seedance-2-5-260628' THEN 'profile-video-primary'
      WHEN 'wan2.6-i2v-flash' THEN 'profile-video-wan-primary'
      WHEN 'agnes-video-v2.0' THEN 'profile-video-agnes-primary'
      WHEN 'agnes-video-2.5-flash' THEN 'profile-video-agnes-primary'
    END,
    capability_snapshot_id = CASE model_id
      WHEN 'doubao-seedance-1-0-lite-i2v-250428' THEN 'volcark-seedance-video/v1'
      WHEN 'doubao-seedance-1-5-pro-251215' THEN 'volcark-seedance-video/v2'
      WHEN 'doubao-seedance-2-0-mini-260615' THEN 'volcark-seedance-video/v3'
      WHEN 'doubao-seedance-2-0-260128' THEN 'volcark-seedance-video/v3'
      WHEN 'doubao-seedance-2-5-260628' THEN 'volcark-seedance-video/v3'
      WHEN 'wan2.6-i2v-flash' THEN 'dashscope-wan-video/v1'
      WHEN 'agnes-video-v2.0' THEN 'agnes-video/v1'
      WHEN 'agnes-video-2.5-flash' THEN 'agnes-video/v1'
    END;

DROP TABLE video_candidates;
ALTER TABLE video_candidates_rebuilt_0024 RENAME TO video_candidates;

CREATE INDEX ix_video_candidates_shot
ON video_candidates(shot_id, round_no DESC, index_in_round);
CREATE INDEX ix_video_candidates_generation
ON video_candidates(shot_version_id, generation_input_hash);
CREATE UNIQUE INDEX ux_video_candidate_selected
ON video_candidates(shot_id) WHERE selected_at IS NOT NULL;

-- 证据表守卫触发器按 0014 原样重建。
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
