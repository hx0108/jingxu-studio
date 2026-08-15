-- 0009_media_assets_images.sql
-- V2 图片切片持久化（shot-first-frame-image-generation design D3）：
--   assets / asset_versions        CHARACTER/SCENE 资产与不可变参考图版本链
--   image_candidates               逐镜头候选世代、人工选择指针与 STALE_INPUT
--   media_generation_tasks         submit/poll/download 三段任务状态机
-- 图片字节不落库（design D5 红线）：只存 sha256/尺寸/格式与内容寻址相对路径。
-- 另按 design 0.2 官方核对结论播种 provider_capability_snapshots 静态快照：
-- canonical JSON 1381 字节、sha256=801333f3ac43d6b3795b99d07875d0a492955048b21799a5aee3e197adfe3269、
-- model id 无伪造（火山方舟官方 docs/82379/1541523 + 1330310）。快照行先于
-- profile_image_primary profile 行存在合法——0007 已解除该表对 provider_profiles 的外键。

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('CHARACTER', 'SCENE')),
  -- 指向 STORY_BIBLE document_json 内的 character_id/scene_id 文本键，无法用外键。
  bible_ref_id TEXT NOT NULL CHECK (length(bible_ref_id) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, asset_type, bible_ref_id)
);

CREATE TABLE asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  parent_id TEXT REFERENCES asset_versions(id),
  -- 本切片参考图仅上传（design D1）；AI 生成路径留给后续切片扩展枚举。
  provenance TEXT NOT NULL CHECK (provenance = 'UPLOADED'),
  description TEXT,
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, version_no)
);

CREATE TABLE image_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  shot_version_id TEXT NOT NULL REFERENCES shot_contract_versions(id),
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  index_in_round INTEGER NOT NULL CHECK (index_in_round >= 0),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'STALE_INPUT')),
  -- 文件字段四元组同生同灭；SUCCEEDED 必须齐全，STALE_INPUT 保留可追溯。
  file_sha256 TEXT CHECK (file_sha256 IS NULL OR length(file_sha256) = 64),
  byte_size INTEGER,
  mime_type TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  storage_rel_path TEXT,
  model_id TEXT NOT NULL CHECK (length(model_id) > 0),
  -- 同步 Provider（方舟）无任务 id，此列恒空；异步 Provider（未来视频）持久化后轮询。
  provider_task_id TEXT,
  -- 调用证据引用（model_invocations.id）；终态候选必须可追溯。
  invocation_evidence_ref TEXT,
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

CREATE TABLE media_generation_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  shot_version_id TEXT NOT NULL REFERENCES shot_contract_versions(id),
  idempotency_key TEXT NOT NULL,
  provider_task_id TEXT,
  -- phase 单字段即任务状态机（含终态）；SUBMITTED 无 taskId 不可证明未发出，
  -- 重启按既有恢复语义标 FAILED 等待人工，不自动重发（design D4）。
  phase TEXT NOT NULL CHECK (
    phase IN ('SUBMITTED', 'POLLING', 'DOWNLOADING', 'COMPLETED', 'FAILED', 'CANCELLED')
  ),
  generation_input_hash TEXT NOT NULL CHECK (length(generation_input_hash) = 64),
  candidate_count INTEGER NOT NULL CHECK (candidate_count > 0 AND candidate_count <= 16),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX ix_asset_versions_asset ON asset_versions(asset_id, version_no DESC);
CREATE INDEX ix_image_candidates_shot
ON image_candidates(shot_id, round_no DESC, index_in_round);
CREATE INDEX ix_image_candidates_generation
ON image_candidates(shot_version_id, generation_input_hash);
CREATE INDEX ix_media_tasks_project_phase ON media_generation_tasks(project_id, phase);
-- 每镜头至多一个当前选择（STALE 候选上的历史指针在新选择落位时被清除）。
CREATE UNIQUE INDEX ux_image_candidate_selected
ON image_candidates(shot_id) WHERE selected_at IS NOT NULL;

CREATE TRIGGER trg_asset_versions_immutable
BEFORE UPDATE ON asset_versions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION_ROW');
END;

INSERT INTO provider_capability_snapshots
  (id, provider_profile_id, snapshot_version, valid_from, expires_at,
   capabilities_json, source_url, sha256)
VALUES
  ('volcark-seedream-image/v1', 'profile_image_primary', '1', '2026-08-16', '9999-12-31',
   '{"provider":"volcark-seedream","capability":"IMAGE_GENERATION","model_id":"doubao-seedream-5-0-lite-260128","model_id_alternates":["doubao-seedream-5-0-260128","doubao-seedream-4-5-251128","doubao-seedream-4-0-250828"],"endpoint":{"method":"POST","path":"/api/v3/images/generations","base_url_cn_beijing":"https://ark.cn-beijing.volces.com","auth":"Bearer ARK_API_KEY"},"semantics":{"mode":"SYNCHRONOUS","stream":false,"notes":"POST 直接返回终态结果，无图片任务轮询 API；Port submit 返回终态结果引用，poll 恒 SUCCEEDED，download 经结果 URL（24h 有效）"},"request":{"prompt_recommended_max":"300 汉字 / 600 英文词","image_param":{"max_count":14,"max_bytes_each":31457280,"formats":["jpeg","png","webp","bmp","tiff","gif","heic","heif"],"aspect_ratio_range":[0.0625,16],"min_side_px":14,"max_total_pixels":36000000},"size":{"default":"2048x2048","total_pixels_range":[3686400,16777216],"aspect_ratio_range":[0.0625,16]},"unsupported_params":["n","seed","guidance_scale"],"client_defaults":{"response_format":"url","watermark":true,"sequential_image_generation":"disabled","tools":[]}},"response":{"result_url_validity_hours":24,"usage_fields":["generated_images","output_tokens","total_tokens"],"output_tokens_formula":"floor(sum(width*height)/256)","partial_failure":"data[].error 可逐项失败"},"rate_limit":{"max_images_per_minute":500}}',
   'https://www.volcengine.com/docs/82379/1541523',
   '801333f3ac43d6b3795b99d07875d0a492955048b21799a5aee3e197adfe3269');
