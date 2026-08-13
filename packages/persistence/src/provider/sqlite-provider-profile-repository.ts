import type { ProviderProfile, ProviderProfileRepositoryPort } from '@jingxu/application';

import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { syncToPromise } from '../runtime/sync-to-promise';
import { mapProviderProfileRow, serializeProviderConfig } from './row-mapper';

const SELECT_BY_ID_SQL = `SELECT id, provider, region, base_url, workspace_id, model_id,
  model_snapshot_date, config_json, credential_ref, enabled
FROM provider_profiles
WHERE id = ?`;

const UPSERT_SQL = `INSERT INTO provider_profiles
  (id, provider, region, base_url, workspace_id, model_id, model_snapshot_date,
   config_json, credential_ref, enabled)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  provider = excluded.provider,
  region = excluded.region,
  base_url = excluded.base_url,
  workspace_id = excluded.workspace_id,
  model_id = excluded.model_id,
  model_snapshot_date = excluded.model_snapshot_date,
  config_json = excluded.config_json,
  credential_ref = excluded.credential_ref,
  enabled = excluded.enabled`;

const DELETE_SQL = 'DELETE FROM provider_profiles WHERE id = ?';

/** Transaction-scoped SQLite implementation; commit and rollback belong to the UnitOfWork. */
export class SqliteProviderProfileRepository implements ProviderProfileRepositoryPort {
  public constructor(private readonly database: SqliteDatabase) {}

  public findById(id: string): Promise<ProviderProfile | null> {
    return syncToPromise(() => {
      const row = this.database.prepare(SELECT_BY_ID_SQL).get(id);
      return row === undefined ? null : mapProviderProfileRow(row);
    });
  }

  public save(profile: ProviderProfile): Promise<void> {
    if (profile.credentialRef === null) {
      throw new PersistenceRuntimeError('PROVIDER_PROFILE_CREDENTIAL_REF_REQUIRED');
    }
    return syncToPromise(() => {
      this.database
        .prepare(UPSERT_SQL)
        .run(
          profile.id,
          profile.provider,
          profile.region,
          profile.baseUrl,
          profile.workspaceId,
          profile.modelId,
          profile.modelSnapshotDate,
          serializeProviderConfig(profile),
          profile.credentialRef,
          profile.enabled ? 1 : 0,
        );
    });
  }

  public delete(id: string): Promise<void> {
    return syncToPromise(() => {
      this.database.prepare(DELETE_SQL).run(id);
    });
  }
}
