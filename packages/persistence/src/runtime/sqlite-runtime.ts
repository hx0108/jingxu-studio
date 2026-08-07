import type Database from 'better-sqlite3';

import type { SqliteConnectionManager } from './sqlite-connection';

export const initializeSqliteDatabase = async (
  connectionManager: SqliteConnectionManager,
  migrate: (database: Database.Database) => void | Promise<void>,
): Promise<Database.Database> => {
  const database = connectionManager.open();
  await migrate(database);
  return database;
};
