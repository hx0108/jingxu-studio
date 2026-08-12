import type { JobRepositories, JobUnitOfWorkPort } from '@jingxu/application';

import { SqliteModelInvocationRepository } from '../model-invocation/sqlite-model-invocation-repository';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteJobRepository } from './sqlite-job-repository';

/** Serialized short transactions over the process-wide audited SQLite write connection. */
export class SqliteJobUnitOfWork implements JobUnitOfWorkPort {
  private tail: Promise<void> = Promise.resolve();
  private readonly repositories: JobRepositories;
  public constructor(private readonly database: SqliteDatabase) {
    this.repositories = {
      jobs: new SqliteJobRepository(database),
      invocations: new SqliteModelInvocationRepository(database),
    };
  }
  public run<T>(work: (repositories: JobRepositories) => Promise<T>): Promise<T> {
    const execution = this.tail.then(() => this.execute(work));
    this.tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }
  private async execute<T>(work: (repositories: JobRepositories) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await work(this.repositories);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        /* Preserve original operation error. */
      }
      throw error;
    }
  }
}
