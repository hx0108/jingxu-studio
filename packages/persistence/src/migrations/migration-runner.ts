import type Database from 'better-sqlite3';

import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { MigrationResource } from './migration-loader';

interface AppliedMigrationRow {
  readonly checksum: string;
  readonly name: string;
  readonly version: number;
}

export interface MigrationPlan {
  readonly currentVersion: number;
  readonly pending: readonly MigrationResource[];
}

const hasTable = (database: Database.Database, name: string): boolean =>
  database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name) !== undefined;

const listUserTables = (database: Database.Database): readonly string[] =>
  (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as readonly { readonly name: string }[]
  ).map(({ name }) => name);

export const inspectMigrationPlan = (
  database: Database.Database,
  migrations: readonly MigrationResource[],
): MigrationPlan => {
  if (!hasTable(database, 'schema_migrations')) {
    if (listUserTables(database).length > 0) {
      throw new PersistenceRuntimeError('DATABASE_UNVERSIONED_SCHEMA');
    }
    return { currentVersion: 0, pending: migrations };
  }

  const applied = database
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as readonly AppliedMigrationRow[];
  const latest = applied.at(-1)?.version ?? 0;
  if (latest > migrations.length) {
    throw new PersistenceRuntimeError('DATABASE_VERSION_TOO_NEW');
  }

  for (const [index, row] of applied.entries()) {
    const expected = migrations[index];
    if (expected === undefined) {
      throw new PersistenceRuntimeError('MIGRATION_CHECKSUM_MISMATCH');
    }
    if (
      row.version !== index + 1 ||
      row.name !== expected.name ||
      row.checksum !== expected.sha256
    ) {
      throw new PersistenceRuntimeError('MIGRATION_CHECKSUM_MISMATCH');
    }
  }
  return { currentVersion: latest, pending: migrations.slice(applied.length) };
};

export const applyMigrations = (
  database: Database.Database,
  migrations: readonly MigrationResource[],
  clock: () => string,
): MigrationPlan => {
  const plan = inspectMigrationPlan(database, migrations);
  if (plan.pending.length === 0) return plan;

  try {
    database.exec('BEGIN IMMEDIATE');
    for (const migration of plan.pending) {
      database.exec(migration.sql);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        )
        .run(migration.version, migration.name, migration.sha256, clock());
    }
    database.exec('COMMIT');
  } catch {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw new PersistenceRuntimeError('MIGRATION_APPLY_FAILED');
  }

  return { currentVersion: migrations.length, pending: [] };
};
