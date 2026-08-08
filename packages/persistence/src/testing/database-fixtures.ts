import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openSqliteDatabase, runImmediateTransaction } from '../runtime/sqlite-database';
import type { SqliteTestContext } from './sqlite-test-kit';

export interface DatabaseFixtureSet {
  readonly corruptDatabasePath: string;
  readonly emptyDatabasePath: string;
  readonly invalidMigrationDirectory: string;
  readonly previousDatabasePath: string;
  readonly pressureDatabasePath: string;
}

export const createDatabaseFixtureSet = async (
  context: SqliteTestContext,
): Promise<DatabaseFixtureSet> => {
  const emptyDatabasePath = path.join(context.root, 'empty.sqlite');
  const previousDatabasePath = path.join(context.root, 'previous.sqlite');
  const pressureDatabasePath = path.join(context.root, 'pressure.sqlite');
  const corruptDatabasePath = path.join(context.root, 'corrupt.sqlite');
  const invalidMigrationDirectory = path.join(context.root, 'invalid-migrations');

  openSqliteDatabase(emptyDatabasePath).close();

  const previous = openSqliteDatabase(previousDatabasePath);
  previous.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);',
  );
  previous.close();

  const pressure = openSqliteDatabase(pressureDatabasePath);
  pressure.exec(
    'CREATE TABLE fixture_versions (id TEXT PRIMARY KEY, parent_id TEXT, content_sha256 TEXT NOT NULL);',
  );
  const insert = pressure.prepare(
    'INSERT INTO fixture_versions (id, parent_id, content_sha256) VALUES (?, ?, ?)',
  );
  runImmediateTransaction(pressure, () => {
    for (let version = 1; version <= 101; version += 1) {
      insert.run(
        `fixture_v${String(version)}`,
        version === 1 ? null : `fixture_v${String(version - 1)}`,
        `sha256_${String(version).padStart(3, '0')}`,
      );
    }
  });
  pressure.close();

  await writeFile(corruptDatabasePath, Buffer.from('not-a-sqlite-database', 'utf8'));
  await mkdir(invalidMigrationDirectory, { recursive: true });
  await writeFile(
    path.join(invalidMigrationDirectory, '0002_invalid.sql'),
    'CREATE TABLE invalid_fixture (id TEXT PRIMARY KEY);\n',
    'utf8',
  );

  return {
    corruptDatabasePath,
    emptyDatabasePath,
    invalidMigrationDirectory,
    pressureDatabasePath,
    previousDatabasePath,
  };
};
