import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { createManagedDirectories, createManagedPaths } from '../runtime/managed-paths';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { listVerifiedBackups, performManagedMigration } from './backup-manager';

const createMigrationSet = async (root: string, includeSecond: boolean) => {
  const directory = path.join(root, 'migrations');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, '0001_initial.sql'),
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE sample (id TEXT PRIMARY KEY);\n',
    'utf8',
  );
  if (includeSecond) {
    await writeFile(
      path.join(directory, '0002_add_title.sql'),
      'ALTER TABLE sample ADD COLUMN title TEXT;\n',
      'utf8',
    );
  }
  return directory;
};

describe('SQLite 在线备份与升级', () => {
  it('已有版本存在待执行 migration—执行升级—先创建可验证备份再提交 DDL', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const directory = await createMigrationSet(context.root, false);
      const database = new Database(paths.databasePath);
      applyMigrations(database, await loadMigrationSet(directory), context.clock);
      await createMigrationSet(context.root, true);

      const result = await performManagedMigration({
        backupId: 'backup_12345678',
        clock: context.clock,
        database,
        migrations: await loadMigrationSet(directory),
        paths,
      });

      expect(result.backup?.schemaVersion).toBe(1);
      expect(database.pragma('table_info(sample)')).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'title' })]),
      );
      const backups = await listVerifiedBackups(paths);
      expect(backups).toHaveLength(1);
      const backupDatabase = new Database(
        path.join(paths.backupDirectory, `${backups[0]?.backupId ?? ''}.sqlite`),
        { readonly: true },
      );
      expect(
        backupDatabase.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toEqual({
        version: 1,
      });
      expect(backupDatabase.pragma('table_info(sample)')).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'title' })]),
      );
      backupDatabase.close();
      database.close();
    });
  });

  it('备份 API 失败—执行升级—拒绝 migration 且源库结构和记录不变', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const directory = await createMigrationSet(context.root, false);
      const database = new Database(paths.databasePath);
      applyMigrations(database, await loadMigrationSet(directory), context.clock);
      await createMigrationSet(context.root, true);

      await expect(
        performManagedMigration({
          backupDatabase: vi.fn().mockRejectedValue(new Error('raw backup failure')),
          backupId: 'backup_23456789',
          clock: context.clock,
          database,
          migrations: await loadMigrationSet(directory),
          paths,
        }),
      ).rejects.toMatchObject({ code: 'DATABASE_BACKUP_FAILED' });
      expect(
        database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toEqual({
        version: 1,
      });
      expect(database.pragma('table_info(sample)')).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'title' })]),
      );
      database.close();
    });
  });

  it('全新空库—应用初始 migration—不制造无内容升级备份', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const database = new Database(paths.databasePath);
      const directory = await createMigrationSet(context.root, false);

      const result = await performManagedMigration({
        backupId: 'backup_34567890',
        clock: context.clock,
        database,
        migrations: await loadMigrationSet(directory),
        paths,
      });

      expect(result.backup).toBeNull();
      expect(await listVerifiedBackups(paths)).toEqual([]);
      expect(await readFile(path.join(directory, '0001_initial.sql'), 'utf8')).toContain(
        'schema_migrations',
      );
      database.close();
    });
  });

  it('备份目录不可写—执行升级—返回备份失败且源库保持原版本', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const blockedBackupDirectory = path.join(context.root, 'blocked-backups');
      await writeFile(blockedBackupDirectory, 'not a directory', 'utf8');
      const directory = await createMigrationSet(context.root, false);
      const database = new Database(paths.databasePath);
      applyMigrations(database, await loadMigrationSet(directory), context.clock);
      await createMigrationSet(context.root, true);

      await expect(
        performManagedMigration({
          backupId: 'backup_45678901',
          clock: context.clock,
          database,
          migrations: await loadMigrationSet(directory),
          paths: { ...paths, backupDirectory: blockedBackupDirectory },
        }),
      ).rejects.toMatchObject({ code: 'DATABASE_BACKUP_FAILED' });
      expect(
        database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toEqual({
        version: 1,
      });
      expect(database.pragma('table_info(sample)')).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'title' })]),
      );
      database.close();
    });
  });

  it('备份 API 产物不是有效 SQLite—验证备份—拒绝 migration 且源库保持原版本', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const directory = await createMigrationSet(context.root, false);
      const database = new Database(paths.databasePath);
      applyMigrations(database, await loadMigrationSet(directory), context.clock);
      await createMigrationSet(context.root, true);

      await expect(
        performManagedMigration({
          backupDatabase: async (_database, destination) => {
            await writeFile(destination, 'invalid SQLite backup', 'utf8');
          },
          backupId: 'backup_56789012',
          clock: context.clock,
          database,
          migrations: await loadMigrationSet(directory),
          paths,
        }),
      ).rejects.toMatchObject({ code: 'DATABASE_BACKUP_FAILED' });
      expect(
        database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toEqual({
        version: 1,
      });
      expect(database.pragma('table_info(sample)')).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'title' })]),
      );
      database.close();
    });
  });
});
