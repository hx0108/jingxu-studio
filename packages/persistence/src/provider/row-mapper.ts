import type {
  ProviderProfile,
  ProviderProfileConfig,
  ProviderProfileKind,
} from '@jingxu/application';

import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { SqliteOutputValue } from '../runtime/sqlite-database';

export type ProviderProfileRow = Readonly<Record<string, SqliteOutputValue>>;

/** 镜像 DB CHECK：`base_url LIKE 'https://%'`。 */
const HTTPS_BASE_URL = /^https:\/\/.+/u;

const invalidRow = (): never => {
  throw new PersistenceRuntimeError('PROVIDER_PROFILE_ROW_INVALID');
};

const requiredString = (value: SqliteOutputValue | undefined): string =>
  typeof value === 'string' && value.length > 0 ? value : invalidRow();

interface StoredConfig {
  readonly credentialLast4: string | null;
  readonly dataProcessingHints: readonly string[];
  readonly lastValidatedAt: string | null;
}

const parseStoredConfig = (raw: string): StoredConfig => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidRow();
  }
  if (parsed === null || typeof parsed !== 'object') return invalidRow();
  const object = parsed as Record<string, unknown>;
  const hints = object.dataProcessingHints;
  if (!Array.isArray(hints) || hints.some((hint) => typeof hint !== 'string')) {
    return invalidRow();
  }
  const lastValidatedAt = object.lastValidatedAt;
  if (lastValidatedAt !== null && typeof lastValidatedAt !== 'string') return invalidRow();
  const credentialLast4 = object.credentialLast4;
  if (credentialLast4 !== null && typeof credentialLast4 !== 'string') return invalidRow();
  return { credentialLast4, dataProcessingHints: hints, lastValidatedAt };
};

/**
 * 把 {@link ProviderProfile} 的 `config` 与末四位序列化为 `config_json`。
 * 末四位属于验证元数据（非密钥本身），与提示同存于唯一 JSON 列。
 */
export const serializeProviderConfig = (profile: ProviderProfile): string =>
  JSON.stringify({
    credentialLast4: profile.credentialLast4,
    dataProcessingHints: profile.config.dataProcessingHints,
    lastValidatedAt: profile.config.lastValidatedAt,
  });

/** Maps a persistence-internal SQLite row to the bounded Application profile. */
export const mapProviderProfileRow = (row: ProviderProfileRow): ProviderProfile => {
  const id = requiredString(row.id);
  const provider = requiredString(row.provider);
  const region = requiredString(row.region);
  const baseUrl = requiredString(row.base_url);
  const workspaceId = requiredString(row.workspace_id);
  const modelId = requiredString(row.model_id);
  const modelSnapshotDate = requiredString(row.model_snapshot_date);
  const configJson = requiredString(row.config_json);
  const credentialRef = requiredString(row.credential_ref);
  const enabled = row.enabled;

  const providerKind: ProviderProfileKind =
    provider === 'QWEN' || provider === 'VOLCARK_SEEDREAM' ? provider : invalidRow();
  if (region !== 'cn-beijing') invalidRow();
  if (!HTTPS_BASE_URL.test(baseUrl)) invalidRow();
  if (enabled !== 0 && enabled !== 1) invalidRow();

  const stored = parseStoredConfig(configJson);
  const config: ProviderProfileConfig = {
    dataProcessingHints: stored.dataProcessingHints,
    lastValidatedAt: stored.lastValidatedAt,
  };

  return {
    baseUrl,
    config,
    credentialLast4: stored.credentialLast4,
    credentialRef,
    enabled: enabled === 1,
    id,
    modelId,
    modelSnapshotDate,
    provider: providerKind,
    region: 'cn-beijing',
    workspaceId,
  };
};
