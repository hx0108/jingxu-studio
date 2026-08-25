-- V1 可生产性报告绑定其运行时输入版本和参考价格快照；历史报告保持可读。
ALTER TABLE producibility_reports ADD COLUMN episode_version_id TEXT REFERENCES episode_versions(id);
ALTER TABLE producibility_reports ADD COLUMN reference_price_snapshot_id TEXT REFERENCES reference_price_snapshots(id);

INSERT INTO reference_price_snapshots
  (id, price_version, provider, model, region, capability_type, billing_unit, currency,
   price_range_json, effective_at, expires_at, source_url, sha256, enabled)
VALUES
  ('price_shot_package_v1', 'shot-package-v1', 'REFERENCE_ONLY', 'SHOT_PACKAGE', 'CN',
   'SHOT_PACKAGE', 'PER_SHOT', 'CNY', '{"min":0,"max":0}', '2026-08-22', '9999-12-31',
   'https://jingxu.studio/reference-prices/v1',
   '0000000000000000000000000000000000000000000000000000000000000000', 1);

CREATE TABLE command_receipts_v4 (
  request_id TEXT PRIMARY KEY,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'CREATE_PROJECT', 'UPDATE_PROJECT', 'DELETE_PROJECT', 'RESTORE_PROJECT',
    'INITIALIZE_ORIGINAL', 'INITIALIZE_INPUT', 'REWRITE_SELECTION',
    'SAVE_SCRIPT_DRAFT', 'CONFIRM_SCRIPT_VERSION', 'RESTORE_SCRIPT_VERSION'
  )),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  project_id TEXT REFERENCES projects(id),
  result_ref_json TEXT NOT NULL CHECK (json_valid(result_ref_json)),
  trace_id TEXT NOT NULL CHECK (length(trace_id) > 0),
  committed_at TEXT NOT NULL
);
INSERT INTO command_receipts_v4 (request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at)
SELECT request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at FROM command_receipts;
DROP TABLE command_receipts;
ALTER TABLE command_receipts_v4 RENAME TO command_receipts;
CREATE INDEX ix_command_receipts_project ON command_receipts(project_id) WHERE project_id IS NOT NULL;
