import {
  openSqliteDatabase,
  runImmediateTransaction,
  type SqliteDatabase,
} from '../runtime/sqlite-database';

interface SqliteTestDatabaseOptions {
  readonly readonly?: boolean;
}

interface SqliteTestPragmaOptions {
  readonly simple?: boolean;
}

interface SqliteTestConvenienceMethods {
  readonly pragma: (statement: string, options?: SqliteTestPragmaOptions) => unknown;
  readonly transaction: <TArguments extends readonly unknown[], TResult>(
    operation: (...args: TArguments) => TResult,
  ) => (...args: TArguments) => TResult;
}

export type SqliteTestDatabase = SqliteDatabase & SqliteTestConvenienceMethods;

type SqliteTestDatabaseConstructor = new (
  databasePath: string,
  options?: SqliteTestDatabaseOptions,
) => SqliteTestDatabase;

const SAFE_TEST_PRAGMA =
  /^(?:busy_timeout|foreign_key_check|foreign_keys|integrity_check|journal_mode|synchronous|table_info\([a-z_][a-z0-9_]*\))(?:\s*=\s*(?:ON|OFF|WAL|FULL|\d+))?$/iu;

function createSqliteTestDatabase(
  databasePath: string,
  options: SqliteTestDatabaseOptions = {},
): SqliteTestDatabase {
  const database = openSqliteDatabase(databasePath, { readOnly: options.readonly ?? false });
  const convenience: SqliteTestConvenienceMethods = {
    pragma: (statement, pragmaOptions = {}) => {
      if (!SAFE_TEST_PRAGMA.test(statement)) throw new Error('Unsupported test PRAGMA');
      if (statement.includes('=')) {
        database.exec(`PRAGMA ${statement}`);
        return [];
      }
      const rows = database.prepare(`PRAGMA ${statement}`).all();
      if (pragmaOptions.simple !== true) return rows;
      const first = rows[0];
      return first === undefined ? undefined : Object.values(first)[0];
    },
    transaction:
      <TArguments extends readonly unknown[], TResult>(
        operation: (...args: TArguments) => TResult,
      ) =>
      (...args: TArguments): TResult =>
        runImmediateTransaction(database, () => operation(...args)),
  };
  return Object.assign(database, convenience);
}

/** Test-only constructor compatibility around a real node:sqlite DatabaseSync instance. */
export const SqliteTestDatabase =
  createSqliteTestDatabase as unknown as SqliteTestDatabaseConstructor;
