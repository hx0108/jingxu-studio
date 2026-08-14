import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { runImmediateTransaction, type SqliteDatabase } from '../runtime/sqlite-database';
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

const hasTable = (database: SqliteDatabase, name: string): boolean =>
  database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name) !== undefined;

const listUserTables = (database: SqliteDatabase): readonly string[] =>
  (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as unknown as readonly { readonly name: string }[]
  ).map(({ name }) => name);

export const inspectMigrationPlan = (
  database: SqliteDatabase,
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
    .all() as unknown as readonly AppliedMigrationRow[];
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
  database: SqliteDatabase,
  migrations: readonly MigrationResource[],
  clock: () => string,
): MigrationPlan => {
  const plan = inspectMigrationPlan(database, migrations);
  if (plan.pending.length === 0) return plan;

  try {
    // SQLite 官方表重建流程（如 0006）要求迁移期间关闭外键执行：
    // PRAGMA foreign_keys 在事务内是 no-op，必须在 BEGIN 之前设置。
    // 迁移提交后以 foreign_key_check 复检，违例按迁移失败处理（启动阻断）。
    database.exec('PRAGMA foreign_keys = OFF');
    runImmediateTransaction(database, () => {
      for (const migration of plan.pending) {
        database.exec(migration.sql);
        database
          .prepare(
            'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          )
          .run(migration.version, migration.name, migration.sha256, clock());
      }
    });
    const violations = database.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new PersistenceRuntimeError('MIGRATION_APPLY_FAILED');
    }
  } catch {
    throw new PersistenceRuntimeError('MIGRATION_APPLY_FAILED');
  } finally {
    try {
      // 失败路径也恢复外键执行；此处异常不应掩盖原始迁移错误。
      database.exec('PRAGMA foreign_keys = ON');
    } catch {
      // 连接已不可用时由上层启动流程报告。
    }
  }

  return { currentVersion: migrations.length, pending: [] };
};
