-- 0003_script_version_receipts.sql
-- Project-level script versions use NULL episode_id, so the table UNIQUE constraint alone
-- cannot prevent duplicate version numbers in SQLite. Published 0001/0002 remain immutable.

CREATE UNIQUE INDEX ux_script_versions_project_level
  ON script_versions(project_id, stage, version_no)
  WHERE episode_id IS NULL;

-- SQLite cannot alter a CHECK constraint in place. Rebuild the receipt table while preserving
-- every existing row and the original PK/FK/hash/JSON constraints.
CREATE TABLE command_receipts_v3 (
  request_id TEXT PRIMARY KEY,
  command_name TEXT NOT NULL CHECK (
    command_name IN (
      'CREATE_PROJECT',
      'UPDATE_PROJECT',
      'DELETE_PROJECT',
      'RESTORE_PROJECT',
      'INITIALIZE_ORIGINAL',
      'SAVE_SCRIPT_DRAFT',
      'CONFIRM_SCRIPT_VERSION',
      'RESTORE_SCRIPT_VERSION'
    )
  ),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  project_id TEXT REFERENCES projects(id),
  result_ref_json TEXT NOT NULL CHECK (json_valid(result_ref_json)),
  trace_id TEXT NOT NULL CHECK (length(trace_id) > 0),
  committed_at TEXT NOT NULL
);

INSERT INTO command_receipts_v3
  (request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at)
SELECT request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at
FROM command_receipts;

DROP TABLE command_receipts;
ALTER TABLE command_receipts_v3 RENAME TO command_receipts;

CREATE INDEX ix_command_receipts_project
  ON command_receipts(project_id)
  WHERE project_id IS NOT NULL;
