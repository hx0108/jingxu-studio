import type { ProjectRepositories, ProjectUnitOfWorkPort } from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTransactionCoordinator } from '../runtime/sqlite-transaction-coordinator';
import { SqliteAnalyticsRepository } from './sqlite-analytics-repository';
import { SqliteAuditRepository } from './sqlite-audit-repository';
import { SqliteCommandReceiptRepository } from './sqlite-command-receipt-repository';
import { SqliteFormatProfileRepository } from './sqlite-format-profile-repository';
import { SqliteProjectRepository } from './sqlite-project-repository';

/**
 * Serial Project UnitOfWork over the process-wide SQLite write connection.
 *
 * Repository methods bridge the synchronous node:sqlite API to rejected Promises. Therefore this
 * adapter must await the Application callback before COMMIT; wrapping a Promise in the synchronous
 * migration helper would commit before `await` continuations run. The queue prevents overlapping
 * callers from nesting `BEGIN IMMEDIATE` on the single connection.
 */
export class SqliteProjectUnitOfWork implements ProjectUnitOfWorkPort {
  private readonly repositories: ProjectRepositories;

  public constructor(
    database: SqliteDatabase,
    private readonly coordinator = new SqliteTransactionCoordinator(database),
  ) {
    this.repositories = {
      projects: new SqliteProjectRepository(database),
      formatProfiles: new SqliteFormatProfileRepository(database),
      receipts: new SqliteCommandReceiptRepository(database),
      audit: new SqliteAuditRepository(database),
      analytics: new SqliteAnalyticsRepository(database),
    };
  }

  public run<T>(work: (repositories: ProjectRepositories) => Promise<T>): Promise<T> {
    return this.coordinator.run(() => work(this.repositories));
  }
}
