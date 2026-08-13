import type { SqliteConnectionManager } from './sqlite-connection';
import type { SqliteDatabase } from './sqlite-database';

export const initializeSqliteDatabase = async (
  connectionManager: SqliteConnectionManager,
  migrate: (database: SqliteDatabase) => void | Promise<void>,
): Promise<SqliteDatabase> => {
  const database = connectionManager.open();
  await migrate(database);
  return database;
};
