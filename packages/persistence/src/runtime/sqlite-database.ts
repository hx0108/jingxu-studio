import { backup, DatabaseSync } from 'node:sqlite';

type SqliteInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;
export type SqliteOutputValue = null | number | bigint | string | Uint8Array;

export interface SqliteStatement {
  readonly all: (...parameters: SqliteInputValue[]) => Record<string, SqliteOutputValue>[];
  readonly get: (
    ...parameters: SqliteInputValue[]
  ) => Record<string, SqliteOutputValue> | undefined;
  readonly run: (...parameters: SqliteInputValue[]) => unknown;
}

/** Persistence-internal surface; concrete node:sqlite runtime objects never leave this package. */
export interface SqliteDatabase {
  readonly close: () => void;
  readonly exec: (sql: string) => void;
  readonly prepare: (sql: string) => SqliteStatement;
}

export interface OpenSqliteDatabaseOptions {
  readonly readOnly?: boolean;
}

export type SqlitePragmaSetting = 'busy_timeout' | 'foreign_keys' | 'journal_mode' | 'synchronous';

export type SqlitePragmaQuery = 'foreign_key_check' | 'integrity_check';

const PRAGMA_VALUE_SQL: Readonly<Record<SqlitePragmaSetting, string>> = {
  busy_timeout: 'PRAGMA busy_timeout',
  foreign_keys: 'PRAGMA foreign_keys',
  journal_mode: 'PRAGMA journal_mode',
  synchronous: 'PRAGMA synchronous',
};

const PRAGMA_VALUE_RESULT_KEY: Readonly<Record<SqlitePragmaSetting, string>> = {
  busy_timeout: 'timeout',
  foreign_keys: 'foreign_keys',
  journal_mode: 'journal_mode',
  synchronous: 'synchronous',
};

const PRAGMA_ROW_SQL: Readonly<Record<SqlitePragmaQuery, string>> = {
  foreign_key_check: 'PRAGMA foreign_key_check',
  integrity_check: 'PRAGMA integrity_check',
};

const nativeDatabases = new WeakMap<SqliteDatabase, DatabaseSync>();

/** Opens SQLite through the runtime-bundled implementation without external native addons. */
export const openSqliteDatabase = (
  databasePath: string,
  options: OpenSqliteDatabaseOptions = {},
): SqliteDatabase => {
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  nativeDatabases.set(database, database);
  return database;
};

/** Verifies the SQLite features required by the locked migration and contract DDL. */
export const assertSqliteRuntimeCapabilities = (database: SqliteDatabase): void => {
  const row = database
    .prepare(`SELECT json_extract('{"ready":true}', '$.ready') AS json_value`)
    .get();
  if (row?.json_value !== 1) throw new Error('SQLite JSON functions are unavailable');
};

export const queryPragmaValue = (
  database: SqliteDatabase,
  name: SqlitePragmaSetting,
): null | number | bigint | string | Uint8Array => {
  const row = database.prepare(PRAGMA_VALUE_SQL[name]).get();
  const value = row?.[PRAGMA_VALUE_RESULT_KEY[name]];
  if (value === undefined) throw new Error(`SQLite PRAGMA ${name} returned no value`);
  return value;
};

export const queryPragmaRows = (
  database: SqliteDatabase,
  name: SqlitePragmaQuery,
): readonly Record<string, null | number | bigint | string | Uint8Array>[] =>
  database.prepare(PRAGMA_ROW_SQL[name]).all();

/** Runs a synchronous immediate transaction and preserves the original operation error. */
export const runImmediateTransaction = <T>(database: SqliteDatabase, operation: () => T): T => {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // SQLite may already have rolled back. The operation error remains the useful evidence.
    }
    throw error;
  }
};

/** Creates a transactionally consistent file using SQLite's online backup API. */
export const backupSqliteDatabase = (
  database: SqliteDatabase,
  destination: string,
): Promise<number> => {
  const nativeDatabase = nativeDatabases.get(database);
  if (nativeDatabase === undefined) throw new Error('Unknown SQLite database handle');
  return backup(nativeDatabase, destination);
};
