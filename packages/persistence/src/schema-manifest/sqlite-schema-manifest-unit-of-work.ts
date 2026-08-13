import type {
  SchemaManifestRepositoryPort,
  SchemaManifestUnitOfWorkPort,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTransactionCoordinator } from '../runtime/sqlite-transaction-coordinator';
import { SqliteSchemaManifestRepository } from './sqlite-schema-manifest-repository';

/** Serial short transactions over the process-wide SQLite write connection. */
export class SqliteSchemaManifestUnitOfWork implements SchemaManifestUnitOfWorkPort {
  private readonly repository: SchemaManifestRepositoryPort;

  public constructor(
    database: SqliteDatabase,
    private readonly coordinator = new SqliteTransactionCoordinator(database),
  ) {
    this.repository = new SqliteSchemaManifestRepository(database);
  }

  public run<T>(work: (repository: SchemaManifestRepositoryPort) => Promise<T>): Promise<T> {
    return this.coordinator.run(() => work(this.repository));
  }
}
