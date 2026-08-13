import type { SchemaManifestRecord, SchemaManifestRepositoryPort } from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { syncToPromise } from '../runtime/sync-to-promise';
import { mapSchemaManifestRow } from './row-mapper';

const SELECT_ENABLED_SQL = `SELECT schema_id, semantic_version, resource_path, sha256, enabled
FROM schema_registry_manifest
WHERE enabled = 1
ORDER BY schema_id ASC`;

const INSERT_SQL = `INSERT INTO schema_registry_manifest
(schema_id, semantic_version, resource_path, sha256, enabled)
VALUES (?, ?, ?, ?, ?)`;

/** Transaction-scoped SQLite implementation; commit and rollback belong to the UnitOfWork. */
export class SqliteSchemaManifestRepository implements SchemaManifestRepositoryPort {
  public constructor(private readonly database: SqliteDatabase) {}

  public findEnabled(): Promise<readonly SchemaManifestRecord[]> {
    return syncToPromise(() =>
      this.database.prepare(SELECT_ENABLED_SQL).all().map(mapSchemaManifestRow),
    );
  }

  public replaceAll(records: readonly SchemaManifestRecord[]): Promise<void> {
    return syncToPromise(() => {
      this.database.prepare('DELETE FROM schema_registry_manifest').run();
      const insert = this.database.prepare(INSERT_SQL);
      for (const record of records) {
        insert.run(
          record.schemaId,
          record.semanticVersion,
          record.resourceName,
          record.sha256,
          record.enabled ? 1 : 0,
        );
      }
    });
  }
}
