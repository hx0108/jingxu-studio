import { PersistenceRuntimeError } from './persistence-error';
import {
  assertSqliteRuntimeCapabilities,
  openSqliteDatabase,
  queryPragmaValue,
  type SqliteDatabase,
} from './sqlite-database';

type PragmaName = 'busy_timeout' | 'foreign_keys' | 'journal_mode' | 'synchronous';

export interface SqliteConnectionOptions {
  readonly beforePragma?: (name: PragmaName) => void;
}

const configureConnection = (
  database: SqliteDatabase,
  beforePragma: ((name: PragmaName) => void) | undefined,
): void => {
  const apply = (name: PragmaName, statement: string) => {
    beforePragma?.(name);
    database.exec(`PRAGMA ${statement}`);
  };

  apply('foreign_keys', 'foreign_keys = ON');
  apply('journal_mode', 'journal_mode = WAL');
  apply('synchronous', 'synchronous = FULL');
  apply('busy_timeout', 'busy_timeout = 5000');

  const valid =
    queryPragmaValue(database, 'foreign_keys') === 1 &&
    queryPragmaValue(database, 'journal_mode') === 'wal' &&
    queryPragmaValue(database, 'synchronous') === 2 &&
    queryPragmaValue(database, 'busy_timeout') === 5000;
  if (!valid) throw new PersistenceRuntimeError('DATABASE_PRAGMA_FAILED');
};

export class SqliteConnectionManager {
  readonly #databasePath: string;
  readonly #options: SqliteConnectionOptions;
  #database: SqliteDatabase | null = null;

  public constructor(databasePath: string, options: SqliteConnectionOptions = {}) {
    this.#databasePath = databasePath;
    this.#options = options;
  }

  public open(): SqliteDatabase {
    if (this.#database !== null) return this.#database;

    let database: SqliteDatabase;
    try {
      database = openSqliteDatabase(this.#databasePath);
    } catch {
      throw new PersistenceRuntimeError('DATABASE_OPEN_FAILED');
    }
    try {
      assertSqliteRuntimeCapabilities(database);
    } catch {
      database.close();
      throw new PersistenceRuntimeError('DATABASE_OPEN_FAILED');
    }

    try {
      configureConnection(database, this.#options.beforePragma);
    } catch {
      database.close();
      throw new PersistenceRuntimeError('DATABASE_PRAGMA_FAILED');
    }
    this.#database = database;
    return database;
  }

  public close(): void {
    if (this.#database === null) return;
    this.#database.close();
    this.#database = null;
  }
}
