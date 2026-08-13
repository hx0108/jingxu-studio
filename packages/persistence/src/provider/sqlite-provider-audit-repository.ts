import type { ProviderAuditPort } from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { syncToPromise } from '../runtime/sync-to-promise';

const INSERT_AUDIT_SQL = `INSERT INTO audit_events
  (id, project_id, actor, action, object_type, object_id, object_version_id,
   before_sha256, after_sha256, metadata_json, trace_id, created_at)
VALUES (?, NULL, 'SYSTEM', 'PROVIDER_CREDENTIAL_DELETED', 'provider_profile', ?, NULL,
   NULL, NULL, '{}', 'system-provider-audit', ?)`;

export interface SqliteProviderAuditOptions {
  readonly createId?: () => string;
}

/** Transaction-scoped audit writer; commit and rollback belong to the UnitOfWork. */
export class SqliteProviderAuditRepository implements ProviderAuditPort {
  readonly #createId: () => string;

  public constructor(
    private readonly database: SqliteDatabase,
    options: SqliteProviderAuditOptions = {},
  ) {
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  public recordCredentialDeleted(profileId: string, occurredAt: string): Promise<void> {
    return syncToPromise(() => {
      this.database.prepare(INSERT_AUDIT_SQL).run(this.#createId(), profileId, occurredAt);
    });
  }
}
