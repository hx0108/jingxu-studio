import type { JobRepositories, JobUnitOfWorkPort } from '@jingxu/application';

import { SqliteModelInvocationRepository } from '../model-invocation/sqlite-model-invocation-repository';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTransactionCoordinator } from '../runtime/sqlite-transaction-coordinator';
import { SqliteJobRepository } from './sqlite-job-repository';

/** Serialized short transactions over the process-wide audited SQLite write connection. */
export class SqliteJobUnitOfWork implements JobUnitOfWorkPort {
  private readonly repositories: JobRepositories;
  public constructor(
    database: SqliteDatabase,
    private readonly coordinator = new SqliteTransactionCoordinator(database),
  ) {
    this.repositories = {
      jobs: new SqliteJobRepository(database),
      invocations: new SqliteModelInvocationRepository(database),
    };
  }
  public run<T>(work: (repositories: JobRepositories) => Promise<T>): Promise<T> {
    return this.coordinator.run(() => work(this.repositories));
  }
}
