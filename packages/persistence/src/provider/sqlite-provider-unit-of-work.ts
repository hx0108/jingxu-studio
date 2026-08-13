import type {
  ProviderAuditPort,
  ProviderProfileRepositoryPort,
  ProviderUnitOfWorkPort,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTransactionCoordinator } from '../runtime/sqlite-transaction-coordinator';
import {
  SqliteProviderAuditRepository,
  type SqliteProviderAuditOptions,
} from './sqlite-provider-audit-repository';
import { SqliteProviderProfileRepository } from './sqlite-provider-profile-repository';

/** Serial short transactions over the process-wide SQLite write connection. */
export class SqliteProviderUnitOfWork implements ProviderUnitOfWorkPort {
  private readonly profiles: ProviderProfileRepositoryPort;
  private readonly audit: ProviderAuditPort;

  public constructor(
    database: SqliteDatabase,
    options: SqliteProviderAuditOptions = {},
    private readonly coordinator = new SqliteTransactionCoordinator(database),
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
    return this.coordinator.run(() => work({ audit: this.audit, profiles: this.profiles }));
  }
}
