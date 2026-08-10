import { randomUUID } from 'node:crypto';

import type { AuditEntry, AuditRepository } from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { syncToPromise } from '../runtime/sync-to-promise';

/** Writes Project audit evidence without user content or infrastructure details. */
export class SqliteAuditRepository implements AuditRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public record(entry: AuditEntry): Promise<void> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `INSERT INTO audit_events (
            id, project_id, actor, action, object_type, object_id, object_version_id,
            before_sha256, after_sha256, metadata_json, trace_id, created_at
          ) VALUES (?, ?, 'SYSTEM', ?, ?, ?, NULL, NULL, NULL, '{}', ?, ?)`,
        )
        .run(
          randomUUID(),
          entry.projectId,
          entry.action,
          entry.objectType,
          entry.objectId,
          entry.traceId,
          entry.occurredAt,
        );
    });
  }
}
