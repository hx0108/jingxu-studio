-- 0007：快照表与 0006 同型的外键拆除（预排雷）。
-- provider_capability_snapshots / model_price_snapshots 的 provider_profile_id
-- 外键引用 provider_profiles，与 model_invocations 一样会在"删除凭据"（删整行）
-- 时因存在快照记录而永远 FOREIGN KEY 失败。当前全仓无写入代码（恒 0 行），
-- 但写入方一旦落地，历史快照就会复现 0006 的删除阻塞；趁表为空先解除。
-- 取舍与 0006 一致：快照是时点审计/参考记录，保留 provider_profile_id 文本
-- 以追溯来源 profile，不再以外键约束引用行的存在。
-- 重建为 SQLite 官方十二步流程的表重建子集；迁移器在 BEGIN 前关闭外键执行
-- 并在提交后以 foreign_key_check 复检（不能用 PRAGMA defer_foreign_keys 替代，
-- 见 0006 文件头说明）。表当前恒空，INSERT...SELECT 仅保持流程完整。
CREATE TABLE provider_capability_snapshots_v2 (
  id TEXT PRIMARY KEY,
  -- 审计引用：仅保留 profile id 文本，不设外键（见文件头说明）。
  provider_profile_id TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > valid_from),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  source_url TEXT NOT NULL CHECK (source_url LIKE 'https://%'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  UNIQUE (provider_profile_id, snapshot_version)
);

INSERT INTO provider_capability_snapshots_v2 (
  id, provider_profile_id, snapshot_version, valid_from, expires_at,
  capabilities_json, source_url, sha256
)
SELECT
  id, provider_profile_id, snapshot_version, valid_from, expires_at,
  capabilities_json, source_url, sha256
FROM provider_capability_snapshots;

DROP TABLE provider_capability_snapshots;

ALTER TABLE provider_capability_snapshots_v2 RENAME TO provider_capability_snapshots;

CREATE TABLE model_price_snapshots_v2 (
  id TEXT PRIMARY KEY,
  -- 审计引用：仅保留 profile id 文本，不设外键（见文件头说明）。
  provider_profile_id TEXT NOT NULL,
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

INSERT INTO model_price_snapshots_v2 (
  id, provider_profile_id, model_id, region, currency, tiers_json,
  effective_at, expires_at, source_url, sha256
)
SELECT
  id, provider_profile_id, model_id, region, currency, tiers_json,
  effective_at, expires_at, source_url, sha256
FROM model_price_snapshots;

DROP TABLE model_price_snapshots;

ALTER TABLE model_price_snapshots_v2 RENAME TO model_price_snapshots;
