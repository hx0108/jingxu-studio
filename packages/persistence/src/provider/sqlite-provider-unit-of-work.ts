import type {
  ProviderAuditPort,
  ProviderProfileRepositoryPort,
  ProviderUnitOfWorkPort,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import {
  SqliteProviderAuditRepository,
  type SqliteProviderAuditOptions,
} from './sqlite-provider-audit-repository';
import { SqliteProviderProfileRepository } from './sqlite-provider-profile-repository';

/** Serial short transactions over the process-wide SQLite write connection. */
export class SqliteProviderUnitOfWork implements ProviderUnitOfWorkPort {
  private readonly profiles: ProviderProfileRepositoryPort;
  private readonly audit: ProviderAuditPort;
  private tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly database: SqliteDatabase,
    options: SqliteProviderAuditOptions = {},
  ) {
    this.profiles = new SqliteProviderProfileRepository(database);
    this.audit = new SqliteProviderAuditRepository(database, options);
  }

  public run<T>(
    work: (repositories: {
      readonly audit: ProviderAuditPort;
      readonly profiles: ProviderProfileRepositoryPort;
    }) => Promise<T>,
  ): Promise<T> {
    const execution = this.tail.then(() => this.execute(work));
    this.tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private async execute<T>(
    work: (repositories: {
      readonly audit: ProviderAuditPort;
      readonly profiles: ProviderProfileRepositoryPort;
    }) => Promise<T>,
  ): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await work({ audit: this.audit, profiles: this.profiles });
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original repository or Application callback error.
      }
      throw error;
    }
  }
}
