-- 0022_media_style_assets.sql
-- 项目级画风锚点：扩展媒体资产枚举为 CHARACTER/SCENE/STYLE。
-- SQLite 不能原地修改 CHECK，故按子表→父表顺序重建并完整复制版本父链。

DROP TRIGGER trg_asset_versions_immutable;
DROP INDEX ix_asset_versions_asset;

ALTER TABLE asset_versions RENAME TO asset_versions_legacy_0022;
ALTER TABLE assets RENAME TO assets_legacy_0022;

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('CHARACTER', 'SCENE', 'STYLE')),
  bible_ref_id TEXT NOT NULL CHECK (length(bible_ref_id) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, asset_type, bible_ref_id),
  CHECK (
    (asset_type = 'STYLE' AND bible_ref_id = 'project-style')
    OR (asset_type <> 'STYLE' AND bible_ref_id <> 'project-style')
  )
);

CREATE TABLE asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  parent_id TEXT REFERENCES asset_versions(id),
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

INSERT INTO assets
  (id, project_id, asset_type, bible_ref_id, display_name, created_at, updated_at)
SELECT id, project_id, asset_type, bible_ref_id, display_name, created_at, updated_at
FROM assets_legacy_0022;

INSERT INTO asset_versions
  (id, asset_id, version_no, parent_id, provenance, description, file_sha256,
   byte_size, mime_type, width, height, created_at)
SELECT id, asset_id, version_no, parent_id, provenance, description, file_sha256,
       byte_size, mime_type, width, height, created_at
FROM asset_versions_legacy_0022;

DROP TABLE asset_versions_legacy_0022;
DROP TABLE assets_legacy_0022;

CREATE INDEX ix_asset_versions_asset ON asset_versions(asset_id, version_no DESC);

CREATE TRIGGER trg_asset_versions_immutable
BEFORE UPDATE ON asset_versions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION_ROW');
END;
