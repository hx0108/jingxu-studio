CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE schema_registry_manifest (
  schema_id TEXT PRIMARY KEY,
  semantic_version TEXT NOT NULL,
  resource_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  UNIQUE (schema_id, semantic_version)
);

CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  region TEXT NOT NULL CHECK (length(region) > 0),
  base_url TEXT NOT NULL CHECK (base_url LIKE 'https://%'),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  model_id TEXT NOT NULL CHECK (length(model_id) > 0),
  model_snapshot_date TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  credential_ref TEXT NOT NULL CHECK (length(credential_ref) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE provider_capability_snapshots (
  id TEXT PRIMARY KEY,
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
  snapshot_version TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > valid_from),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  source_url TEXT NOT NULL CHECK (source_url LIKE 'https://%'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  UNIQUE (provider_profile_id, snapshot_version)
);

CREATE TABLE model_price_snapshots (
  id TEXT PRIMARY KEY,
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
  model_id TEXT NOT NULL,
  region TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('CNY', 'USD', 'CREDIT')),
  tiers_json TEXT NOT NULL CHECK (json_valid(tiers_json)),
  effective_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > effective_at),
  source_url TEXT NOT NULL CHECK (source_url LIKE 'https://%'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  UNIQUE (provider_profile_id, model_id, region, effective_at)
);

CREATE TABLE reference_price_snapshots (
  id TEXT PRIMARY KEY,
  price_version TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  region TEXT NOT NULL,
  capability_type TEXT NOT NULL CHECK (
    capability_type IN ('SHOT_PACKAGE', 'IMAGE', 'VIDEO', 'TTS', 'LIP_SYNC')
  ),
  billing_unit TEXT NOT NULL CHECK (
    billing_unit IN ('PER_SHOT', 'PER_IMAGE', 'PER_SECOND', 'PER_CLIP', 'PER_CREDIT')
  ),
  currency TEXT NOT NULL CHECK (currency IN ('CNY', 'USD', 'CREDIT')),
  price_range_json TEXT NOT NULL CHECK (
    json_valid(price_range_json)
    AND json_type(price_range_json, '$.min') IN ('integer', 'real')
    AND json_type(price_range_json, '$.max') IN ('integer', 'real')
    AND json_extract(price_range_json, '$.min') >= 0
    AND json_extract(price_range_json, '$.max') >= json_extract(price_range_json, '$.min')
  ),
  effective_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > effective_at),
  source_url TEXT NOT NULL CHECK (source_url LIKE 'https://%'),
  sha256 TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  CHECK (capability_type <> 'SHOT_PACKAGE' OR billing_unit = 'PER_SHOT')
);

CREATE TABLE prompt_templates (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL CHECK (
    stage IN ('CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT', 'SHOT_CONTRACT')
  ),
  version INTEGER NOT NULL CHECK (version >= 1),
  template_text TEXT NOT NULL CHECK (length(template_text) > 0),
  sha256 TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (stage, version)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  genre TEXT,
  style TEXT,
  creation_mode TEXT NOT NULL CHECK (
    creation_mode IN ('AI_ORIGINAL', 'AUTHORIZED_ADAPTATION', 'AI_OPTIMIZATION')
  ),
  dialogue_render_mode TEXT NOT NULL CHECK (
    dialogue_render_mode IN ('NARRATION_FIRST', 'WEAK_LIP_SYNC', 'PRECISE_LIP_SYNC', 'SUBTITLE_ONLY')
  ),
  deployment_mode TEXT NOT NULL DEFAULT 'LOCAL_DEMO' CHECK (
    deployment_mode IN ('LOCAL_DEMO', 'CONTROLLED_EXTERNAL_TEST')
  ),
  data_root_rel TEXT NOT NULL CHECK (
    length(data_root_rel) > 0
    AND data_root_rel NOT LIKE '/%'
    AND data_root_rel NOT LIKE '%:%'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE format_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  parent_id TEXT REFERENCES format_profiles(id),
  aspect_ratio TEXT NOT NULL CHECK (aspect_ratio IN ('9:16', '16:9', '1:1')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  fps REAL NOT NULL CHECK (fps > 0 AND fps <= 120),
  language TEXT NOT NULL CHECK (length(language) > 0),
  subtitle_safe_area_json TEXT NOT NULL CHECK (json_valid(subtitle_safe_area_json)),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version_no)
);

CREATE TABLE source_inputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  input_kind TEXT NOT NULL CHECK (input_kind IN ('CREATIVE', 'TXT', 'MARKDOWN')),
  file_name TEXT,
  encoding TEXT,
  content_text TEXT NOT NULL,
  char_count INTEGER NOT NULL CHECK (char_count >= 0 AND char_count <= 30000),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE consent_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_input_id TEXT NOT NULL REFERENCES source_inputs(id),
  consent_type TEXT NOT NULL CHECK (
    consent_type IN ('ADAPTATION_AUTHORIZATION', 'DATA_PROCESSING')
  ),
  content_source TEXT NOT NULL CHECK (
    content_source IN ('SELF_OWNED', 'AUTHORIZED', 'PUBLIC_DOMAIN', 'UNKNOWN')
  ),
  scope TEXT NOT NULL CHECK (scope IN ('PROJECT', 'SOURCE_INPUT')),
  statement_text TEXT NOT NULL CHECK (length(statement_text) > 0),
  confirmed_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL CHECK (length(title) > 0),
  target_duration_sec REAL NOT NULL CHECK (target_duration_sec BETWEEN 30 AND 180),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE story_bible_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  parent_id TEXT REFERENCES story_bible_versions(id),
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  document_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'READY', 'STALE_INPUT')),
  source TEXT NOT NULL CHECK (source IN ('AI', 'USER', 'IMPORT', 'SYSTEM_INVALIDATION')),
  source_invocation_id TEXT REFERENCES model_invocations(id),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version_no)
);

CREATE TABLE script_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  episode_id TEXT REFERENCES episodes(id),
  stage TEXT NOT NULL CHECK (
    stage IN ('CONCEPT', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT')
  ),
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  parent_id TEXT REFERENCES script_versions(id),
  source_input_id TEXT REFERENCES source_inputs(id),
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  document_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'READY', 'STALE_INPUT')),
  change_summary TEXT,
  source TEXT NOT NULL CHECK (source IN ('AI', 'USER', 'IMPORT', 'SYSTEM_INVALIDATION')),
  source_invocation_id TEXT REFERENCES model_invocations(id),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, episode_id, stage, version_no)
);

CREATE TABLE episode_versions (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  parent_id TEXT REFERENCES episode_versions(id),
  story_bible_version_id TEXT NOT NULL REFERENCES story_bible_versions(id),
  format_profile_id TEXT NOT NULL REFERENCES format_profiles(id),
  target_duration_sec REAL NOT NULL CHECK (target_duration_sec BETWEEN 30 AND 180),
  shot_set_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'READY', 'STALE_INPUT')),
  created_at TEXT NOT NULL,
  UNIQUE (episode_id, version_no)
);

CREATE TABLE stage_heads (
  project_id TEXT NOT NULL REFERENCES projects(id),
  episode_id TEXT REFERENCES episodes(id),
  stage TEXT NOT NULL CHECK (
    stage IN ('CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT', 'SHOT_CONTRACT')
  ),
  current_version_type TEXT NOT NULL CHECK (
    current_version_type IN ('STORY_BIBLE_VERSION', 'SCRIPT_VERSION', 'EPISODE_VERSION')
  ),
  current_version_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE script_stage_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  episode_id TEXT REFERENCES episodes(id),
  stage TEXT NOT NULL CHECK (
    stage IN ('CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT', 'SHOT_CONTRACT')
  ),
  operation_type TEXT NOT NULL CHECK (
    operation_type IN ('GENERATE', 'CONTINUE', 'SHORTEN', 'REWRITE', 'STRENGTHEN_CONFLICT')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('DRAFT', 'QUEUED', 'RUNNING', 'VALIDATING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
  ),
  idempotency_key TEXT NOT NULL,
  user_operation_id TEXT NOT NULL,
  input_versions_json TEXT NOT NULL CHECK (json_valid(input_versions_json)),
  input_version_set_hash TEXT NOT NULL,
  selection_json TEXT CHECK (selection_json IS NULL OR json_valid(selection_json)),
  write_set_json TEXT NOT NULL CHECK (json_valid(write_set_json)),
  lock_snapshot_hash TEXT NOT NULL,
  prompt_template_id TEXT NOT NULL REFERENCES prompt_templates(id),
  transport_attempts INTEGER NOT NULL DEFAULT 0 CHECK (transport_attempts BETWEEN 0 AND 3),
  structure_repair_attempts INTEGER NOT NULL DEFAULT 0 CHECK (
    structure_repair_attempts BETWEEN 0 AND 1
  ),
  lease_token TEXT,
  lease_expires_at TEXT,
  deadline_at TEXT,
  cancel_requested_at TEXT,
  error_code TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  queued_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE TABLE model_invocations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES script_stage_jobs(id),
  status TEXT NOT NULL CHECK (
    status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED_UNKNOWN_OUTCOME')
  ),
  attempt_kind TEXT NOT NULL CHECK (
    attempt_kind IN ('INITIAL', 'TRANSPORT_RETRY', 'STRUCTURE_REPAIR')
  ),
  transport_attempt INTEGER NOT NULL CHECK (transport_attempt BETWEEN 1 AND 3),
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
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

CREATE TABLE lock_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  object_type TEXT NOT NULL CHECK (
    object_type IN ('STORY_BIBLE', 'SCRIPT_VERSION', 'SHOT_CONTRACT', 'EPISODE_VERSION')
  ),
  object_id TEXT NOT NULL,
  object_version_id TEXT NOT NULL,
  json_pointer TEXT NOT NULL CHECK (json_pointer = '' OR json_pointer LIKE '/%'),
  locked_by TEXT NOT NULL CHECK (locked_by IN ('USER', 'SYSTEM')),
  note TEXT,
  locked_at TEXT NOT NULL,
  unlocked_at TEXT
);

CREATE TABLE dependency_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  upstream_type TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  upstream_version_id TEXT NOT NULL,
  downstream_type TEXT NOT NULL,
  downstream_id TEXT NOT NULL,
  downstream_version_id TEXT NOT NULL,
  dependency_type TEXT NOT NULL CHECK (
    dependency_type IN ('GENERATED_FROM', 'REFERENCES', 'INVALIDATES', 'SNAPSHOTS')
  ),
  created_at TEXT NOT NULL,
  UNIQUE (
    project_id,
    upstream_type,
    upstream_version_id,
    downstream_type,
    downstream_version_id,
    dependency_type
  )
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  actor TEXT NOT NULL CHECK (actor IN ('USER', 'SYSTEM', 'AI')),
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_version_id TEXT,
  before_sha256 TEXT,
  after_sha256 TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  trace_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE shots (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  lifecycle_status TEXT NOT NULL CHECK (
    lifecycle_status IN ('ACTIVE', 'SUPERSEDED', 'DELETED')
  ),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE shot_contract_versions (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id),
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  parent_id TEXT REFERENCES shot_contract_versions(id),
  external_parent_version_id TEXT,
  lineage_resolution_status TEXT NOT NULL CHECK (
    lineage_resolution_status IN ('ROOT', 'LOCAL_VERIFIED', 'EXTERNAL_UNRESOLVED')
  ),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  version_status TEXT NOT NULL CHECK (version_status IN ('DRAFT', 'READY', 'STALE_INPUT')),
  format_profile_id TEXT NOT NULL REFERENCES format_profiles(id),
  target_duration_sec REAL NOT NULL CHECK (target_duration_sec BETWEEN 1 AND 20),
  dialogue_render_mode TEXT NOT NULL CHECK (
    dialogue_render_mode IN ('NARRATION_FIRST', 'WEAK_LIP_SYNC', 'PRECISE_LIP_SYNC', 'SUBTITLE_ONLY')
  ),
  document_json TEXT NOT NULL CHECK (
    json_valid(document_json)
    AND json_extract(document_json, '$.version_id') = id
    AND json_extract(document_json, '$.shot_id') = shot_id
    AND json_extract(document_json, '$.contract_version') = version_no
    AND json_extract(document_json, '$.sequence') = sequence
    AND json_extract(document_json, '$.status') = version_status
    AND json_extract(document_json, '$.format_profile_id') = format_profile_id
    AND json_extract(document_json, '$.target_duration_sec') = target_duration_sec
    AND json_extract(document_json, '$.dialogue.dialogue_render_mode') = dialogue_render_mode
    AND (
      (
        lineage_resolution_status = 'ROOT'
        AND parent_id IS NULL
        AND external_parent_version_id IS NULL
        AND json_extract(document_json, '$.parent_version_id') IS NULL
      )
      OR (
        lineage_resolution_status = 'LOCAL_VERIFIED'
        AND parent_id IS NOT NULL
        AND external_parent_version_id IS NULL
        AND json_extract(document_json, '$.parent_version_id') = parent_id
      )
      OR (
        lineage_resolution_status = 'EXTERNAL_UNRESOLVED'
        AND parent_id IS NULL
        AND external_parent_version_id IS NOT NULL
        AND json_extract(document_json, '$.parent_version_id') = external_parent_version_id
      )
    )
  ),
  document_sha256 TEXT NOT NULL,
  source_invocation_id TEXT REFERENCES model_invocations(id),
  created_at TEXT NOT NULL,
  UNIQUE (shot_id, version_no)
);

CREATE TABLE episode_version_shots (
  episode_version_id TEXT NOT NULL REFERENCES episode_versions(id),
  shot_id TEXT NOT NULL REFERENCES shots(id),
  shot_version_id TEXT NOT NULL REFERENCES shot_contract_versions(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  PRIMARY KEY (episode_version_id, shot_id)
);

CREATE TABLE shot_derivations (
  new_shot_id TEXT NOT NULL REFERENCES shots(id),
  source_shot_id TEXT NOT NULL REFERENCES shots(id),
  operation TEXT NOT NULL CHECK (operation IN ('COPY', 'SPLIT', 'MERGE')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (new_shot_id, source_shot_id, operation),
  CHECK (new_shot_id <> source_shot_id)
);

CREATE TABLE producibility_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  shot_version_id TEXT REFERENCES shot_contract_versions(id),
  scope TEXT NOT NULL CHECK (scope IN ('SHOT', 'EPISODE')),
  rule_set_version TEXT NOT NULL,
  capability_snapshot_id TEXT NOT NULL REFERENCES provider_capability_snapshots(id),
  status TEXT NOT NULL CHECK (status IN ('PASS', 'WARN', 'BLOCK')),
  disclaimer TEXT NOT NULL CHECK (length(disclaimer) > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE producibility_findings (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES producibility_reports(id),
  rule_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARN', 'BLOCK')),
  json_pointer TEXT NOT NULL CHECK (json_pointer = '' OR json_pointer LIKE '/%'),
  observation TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  source_type TEXT NOT NULL CHECK (source_type IN ('RULE', 'LLM')),
  created_at TEXT NOT NULL,
  CHECK (source_type <> 'LLM' OR severity <> 'BLOCK')
);

CREATE TABLE finding_overrides (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES producibility_findings(id),
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPT_RISK', 'DISMISS')),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  actor TEXT NOT NULL CHECK (actor IN ('USER', 'SYSTEM')),
  created_at TEXT NOT NULL
);

CREATE TABLE export_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  episode_version_id TEXT NOT NULL REFERENCES episode_versions(id),
  export_type TEXT NOT NULL CHECK (export_type IN ('MARKDOWN', 'JSON', 'PROJECT_TRANSFER')),
  status TEXT NOT NULL CHECK (status IN ('PREPARING', 'FILE_READY', 'SUCCEEDED', 'FAILED')),
  target_path TEXT NOT NULL,
  temp_path TEXT,
  overwrite_policy TEXT NOT NULL CHECK (overwrite_policy IN ('REJECT', 'CONFIRMED_OVERWRITE')),
  payload_sha256 TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  schema_version TEXT NOT NULL,
  lineage_completeness TEXT NOT NULL CHECK (lineage_completeness IN ('COMPLETE', 'PARTIAL')),
  warning_overrides_json TEXT NOT NULL CHECK (json_valid(warning_overrides_json)),
  file_ready_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT
);

CREATE TABLE import_records (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  import_mode TEXT NOT NULL CHECK (import_mode IN ('RETURN_TO_ORIGIN', 'NEW_PROJECT')),
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STAGING', 'VALIDATING', 'SUCCEEDED', 'FAILED')),
  validation_errors_json TEXT CHECK (
    validation_errors_json IS NULL OR json_valid(validation_errors_json)
  ),
  id_mapping_json TEXT CHECK (id_mapping_json IS NULL OR json_valid(id_mapping_json)),
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE evaluation_samples (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  sample_type TEXT NOT NULL CHECK (
    sample_type IN ('SCRIPT_STAGE', 'SHOT_CONTRACT', 'EPISODE_STORYBOARD')
  ),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  expected_json TEXT NOT NULL CHECK (json_valid(expected_json)),
  authorization_status TEXT NOT NULL CHECK (
    authorization_status IN ('AUTHORIZED', 'PUBLIC_DOMAIN', 'SYNTHETIC')
  ),
  dedup_key TEXT NOT NULL UNIQUE,
  dataset_split TEXT NOT NULL CHECK (dataset_split IN ('TRAIN', 'VALIDATION', 'TEST')),
  created_at TEXT NOT NULL
);

CREATE TABLE evaluation_annotations (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES evaluation_samples(id),
  guideline_version TEXT NOT NULL,
  label_json TEXT NOT NULL CHECK (json_valid(label_json)),
  rationale TEXT NOT NULL,
  annotator TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  event_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  properties_json TEXT NOT NULL CHECK (json_valid(properties_json)),
  occurred_at TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_one_active_episode_per_project
ON episodes(project_id) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ux_stage_heads_project_level
ON stage_heads(project_id, stage) WHERE episode_id IS NULL;

CREATE UNIQUE INDEX ux_stage_heads_episode_level
ON stage_heads(project_id, episode_id, stage) WHERE episode_id IS NOT NULL;

CREATE UNIQUE INDEX ux_format_profile_current
ON format_profiles(project_id) WHERE is_current = 1;

CREATE UNIQUE INDEX ux_lock_active_pointer
ON lock_records(object_version_id, json_pointer) WHERE unlocked_at IS NULL;

CREATE UNIQUE INDEX ux_episode_version_sequence
ON episode_version_shots(episode_version_id, sequence);

CREATE UNIQUE INDEX ux_episode_version_shot_version
ON episode_version_shots(episode_version_id, shot_version_id);

CREATE UNIQUE INDEX ux_import_success_idempotency
ON import_records(source_sha256, import_mode, COALESCE(project_id, 'NEW_PROJECT'))
WHERE status = 'SUCCEEDED';

CREATE INDEX ix_job_status_created ON script_stage_jobs(status, created_at);
CREATE INDEX ix_script_project_stage
ON script_versions(project_id, episode_id, stage, version_no DESC);
CREATE INDEX ix_story_bible_project_version
ON story_bible_versions(project_id, version_no DESC);
CREATE INDEX ix_shot_episode_lifecycle ON shots(episode_id, lifecycle_status);
CREATE INDEX ix_shot_version_sequence
ON shot_contract_versions(shot_id, version_no DESC, sequence);
CREATE INDEX ix_dependency_upstream
ON dependency_edges(upstream_type, upstream_version_id);
CREATE INDEX ix_dependency_downstream
ON dependency_edges(downstream_type, downstream_version_id);
CREATE INDEX ix_audit_project_time ON audit_events(project_id, created_at DESC);
CREATE INDEX ix_export_episode_time ON export_records(episode_id, created_at DESC);
CREATE INDEX ix_evaluation_sample_type
ON evaluation_samples(sample_type, dataset_split, created_at);

CREATE TRIGGER trg_story_bible_versions_immutable
BEFORE UPDATE ON story_bible_versions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION_ROW');
END;

CREATE TRIGGER trg_script_versions_immutable
BEFORE UPDATE ON script_versions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION_ROW');
END;

CREATE TRIGGER trg_episode_versions_immutable
BEFORE UPDATE ON episode_versions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION_ROW');
END;

CREATE TRIGGER trg_shot_contract_versions_immutable
BEFORE UPDATE ON shot_contract_versions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION_ROW');
END;
