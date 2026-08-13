import type { ProjectRepositories, ProjectUnitOfWorkPort } from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
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
  private tail: Promise<void> = Promise.resolve();
  private readonly repositories: ProjectRepositories;

  public constructor(private readonly database: SqliteDatabase) {
    this.repositories = {
      projects: new SqliteProjectRepository(database),
      formatProfiles: new SqliteFormatProfileRepository(database),
      receipts: new SqliteCommandReceiptRepository(database),
      audit: new SqliteAuditRepository(database),
      analytics: new SqliteAnalyticsRepository(database),
    };
  }

  public run<T>(work: (repositories: ProjectRepositories) => Promise<T>): Promise<T> {
    const execution = this.tail.then(() => this.execute(work));
    this.tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private async execute<T>(work: (repositories: ProjectRepositories) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await work(this.repositories);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error if SQLite already rolled back the transaction.
      }
      throw error;
    }
  }
}
