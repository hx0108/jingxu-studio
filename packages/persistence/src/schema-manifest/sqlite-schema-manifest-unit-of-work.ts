import type {
  SchemaManifestRepositoryPort,
  SchemaManifestUnitOfWorkPort,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteSchemaManifestRepository } from './sqlite-schema-manifest-repository';

/** Serial short transactions over the process-wide SQLite write connection. */
export class SqliteSchemaManifestUnitOfWork implements SchemaManifestUnitOfWorkPort {
  private readonly repository: SchemaManifestRepositoryPort;
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly database: SqliteDatabase) {
    this.repository = new SqliteSchemaManifestRepository(database);
  }

  public run<T>(work: (repository: SchemaManifestRepositoryPort) => Promise<T>): Promise<T> {
    const execution = this.tail.then(() => this.execute(work));
    this.tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private async execute<T>(
    work: (repository: SchemaManifestRepositoryPort) => Promise<T>,
  ): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await work(this.repository);
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
