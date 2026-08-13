import type { SqliteDatabase } from './sqlite-database';

/** Process-wide FIFO transaction queue for every UnitOfWork sharing one SQLite connection. */
export class SqliteTransactionCoordinator {
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly database: SqliteDatabase) {}

  public run<T>(work: () => Promise<T>): Promise<T> {
    const execution = this.tail.then(() => this.execute(work));
    this.tail = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private async execute<T>(work: () => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error if SQLite already rolled back.
      }
      throw error;
    }
  }
}
