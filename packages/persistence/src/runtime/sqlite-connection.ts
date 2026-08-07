import Database from 'better-sqlite3';

import { PersistenceRuntimeError } from './persistence-error';

type PragmaName = 'busy_timeout' | 'foreign_keys' | 'journal_mode' | 'synchronous';

export interface SqliteConnectionOptions {
  readonly beforePragma?: (name: PragmaName) => void;
}

const configureConnection = (
  database: Database.Database,
  beforePragma: ((name: PragmaName) => void) | undefined,
): void => {
  const apply = (name: PragmaName, statement: string) => {
    beforePragma?.(name);
    database.pragma(statement);
  };

  apply('foreign_keys', 'foreign_keys = ON');
  apply('journal_mode', 'journal_mode = WAL');
  apply('synchronous', 'synchronous = FULL');
  apply('busy_timeout', 'busy_timeout = 5000');

  const valid =
    database.pragma('foreign_keys', { simple: true }) === 1 &&
    database.pragma('journal_mode', { simple: true }) === 'wal' &&
    database.pragma('synchronous', { simple: true }) === 2 &&
    database.pragma('busy_timeout', { simple: true }) === 5000;
  if (!valid) throw new PersistenceRuntimeError('DATABASE_PRAGMA_FAILED');
};

export class SqliteConnectionManager {
  readonly #databasePath: string;
  readonly #options: SqliteConnectionOptions;
  #database: Database.Database | null = null;

  public constructor(databasePath: string, options: SqliteConnectionOptions = {}) {
    this.#databasePath = databasePath;
    this.#options = options;
  }

  public open(): Database.Database {
    if (this.#database !== null) return this.#database;

    let database: Database.Database;
    try {
      database = new Database(this.#databasePath);
    } catch {
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
