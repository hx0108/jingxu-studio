import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { createManagedDirectories, createManagedPaths } from '../runtime/managed-paths';
import { SqliteTestDatabase as Database } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { createOnlineBackup, listVerifiedBackups, performManagedMigration } from './backup-manager';

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
      const manifest: unknown = JSON.parse(
        await readFile(
          path.join(paths.backupDirectory, `${backups[0]?.backupId ?? ''}.manifest.json`),
          'utf8',
        ),
      );
      expect(manifest).toMatchObject({ schemaVersion: 1, targetSchemaVersion: 2 });
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

  it('在线备份含外键违规—验证候选—拒绝发布备份', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const database = new Database(paths.databasePath);
      database.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1, '0001_initial.sql', 'checksum', '2026-08-08T00:00:00.000Z'); CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));",
      );
      database.pragma('foreign_keys = OFF');
      database.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('child_1', 'missing');

      await expect(
        createOnlineBackup({
          backupId: 'backup_foreignkey',
          clock: context.clock,
          currentVersion: 1,
          database,
          paths,
        }),
      ).rejects.toMatchObject({ code: 'DATABASE_BACKUP_FAILED' });
      await expect(listVerifiedBackups(paths)).resolves.toEqual([]);
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

  it('WAL 源库备份创建与校验—backups 目录只余 sqlite 与 manifest，sidecar 与历史孤儿自愈', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const directory = await createMigrationSet(context.root, false);
      const database = new Database(paths.databasePath);
      try {
        // WAL 源库：备份文件头继承 WAL，readOnly 校验打开即产生 -shm/-wal sidecar。
        database.pragma('journal_mode = WAL');
        applyMigrations(database, await loadMigrationSet(directory), context.clock);
        await createMigrationSet(context.root, true);

        const result = await performManagedMigration({
          backupId: 'backup_walhygiene',
          clock: context.clock,
          database,
          migrations: await loadMigrationSet(directory),
          paths,
        });
        expect(result.backup?.schemaVersion).toBe(1);

        // 模拟修复前的两类残留：最终备份 sidecar + rename 后遗留的 .tmp 孤儿。
        await writeFile(
          path.join(paths.backupDirectory, 'backup_walhygiene.sqlite-shm'),
          '',
          'utf8',
        );
        await writeFile(
          path.join(paths.backupDirectory, 'backup_walhygiene.sqlite-wal'),
          '',
          'utf8',
        );
        await writeFile(
          path.join(paths.backupDirectory, 'backup_walhygiene.sqlite.tmp-shm'),
          '',
          'utf8',
        );
        await writeFile(
          path.join(paths.backupDirectory, 'backup_walhygiene.sqlite.tmp-wal'),
          '',
          'utf8',
        );

        // 启动语义：全量校验逐份打开备份 → 触发 sidecar 清理与存量自愈。
        const backups = await listVerifiedBackups(paths);
        expect(backups).toHaveLength(1);
        const entries = await readdir(paths.backupDirectory);
        expect(entries.sort()).toEqual([
          'backup_walhygiene.manifest.json',
          'backup_walhygiene.sqlite',
        ]);
      } finally {
        database.close();
      }
    });
  });
});
