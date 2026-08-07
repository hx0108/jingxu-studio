import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createOnlineBackup } from '../backup/backup-manager';
import { createManagedDirectories, createManagedPaths } from '../runtime/managed-paths';
import { SqliteConnectionManager } from '../runtime/sqlite-connection';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { restoreManagedBackup } from './recovery-manager';

describe('受控数据库恢复', () => {
  it('有效 opaque backup id—执行恢复—先保存诊断证据且备份保持可用', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const manager = new SqliteConnectionManager(paths.databasePath);
      const database = manager.open();
      database.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1, '0001_initial.sql', 'checksum', '2026-08-08T00:00:00.000Z'); CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('before');",
      );
      const backup = await createOnlineBackup({
        backupId: 'backup_12345678',
        clock: context.clock,
        currentVersion: 1,
        database,
        paths,
      });
      database.exec("UPDATE sample SET value = 'after';");

      await restoreManagedBackup({
        backupId: backup.backupId,
        connectionManager: manager,
        operationId: 'restore_12345678',
        paths,
      });

      const restored = manager.open();
      expect(restored.prepare('SELECT value FROM sample').get()).toEqual({ value: 'before' });
      manager.close();
      expect(await readdir(paths.backupDirectory)).toEqual(
        expect.arrayContaining(['backup_12345678.sqlite', 'backup_12345678.manifest.json']),
      );
      const diagnosticEntries = await readdir(paths.diagnosticDirectory, { recursive: true });
      expect(diagnosticEntries).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/restore_12345678.*current-online\.sqlite/u),
          expect.stringMatching(/restore_12345678.*jingxu\.sqlite/u),
          expect.stringMatching(/restore_12345678.*operation\.manifest\.json/u),
        ]),
      );
    });
  });

  it('伪造 backup id—执行恢复—返回 BACKUP_NOT_ALLOWED 且不创建诊断操作', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const manager = new SqliteConnectionManager(paths.databasePath);
      manager.open();
      const before = await readdir(paths.diagnosticDirectory);

      await expect(
        restoreManagedBackup({
          backupId: '..\\escape.sqlite',
          connectionManager: manager,
          operationId: 'restore_12345678',
          paths,
        }),
      ).rejects.toMatchObject({ code: 'BACKUP_NOT_ALLOWED' });
      expect(await readdir(paths.diagnosticDirectory)).toEqual(before);
      manager.close();
    });
  });

  it('受管理备份 hash 被篡改—执行恢复—拒绝读取且不创建诊断操作', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const manager = new SqliteConnectionManager(paths.databasePath);
      const database = manager.open();
      database.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1, '0001_initial.sql', 'checksum', '2026-08-08T00:00:00.000Z');",
      );
      await createOnlineBackup({
        backupId: 'backup_23456789',
        clock: context.clock,
        currentVersion: 1,
        database,
        paths,
      });
      await writeFile(
        path.join(paths.backupDirectory, 'backup_23456789.sqlite'),
        'tampered backup',
        'utf8',
      );
      const before = await readdir(paths.diagnosticDirectory);

      await expect(
        restoreManagedBackup({
          backupId: 'backup_23456789',
          connectionManager: manager,
          operationId: 'restore_23456789',
          paths,
        }),
      ).rejects.toMatchObject({ code: 'BACKUP_NOT_ALLOWED' });
      expect(await readdir(paths.diagnosticDirectory)).toEqual(before);
      manager.close();
    });
  });

  it('替换前故障—执行恢复—保留当前库、备份和诊断证据', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const manager = new SqliteConnectionManager(paths.databasePath);
      const database = manager.open();
      database.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1, '0001_initial.sql', 'checksum', '2026-08-08T00:00:00.000Z'); CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('current');",
      );
      await createOnlineBackup({
        backupId: 'backup_12345678',
        clock: context.clock,
        currentVersion: 1,
        database,
        paths,
      });

      await expect(
        restoreManagedBackup({
          backupId: 'backup_12345678',
          beforeReplace: () => {
            throw new Error('injected replacement fault');
          },
          connectionManager: manager,
          operationId: 'restore_87654321',
          paths,
        }),
      ).rejects.toMatchObject({ code: 'DATABASE_RESTORE_FAILED' });
      expect(manager.open().prepare('SELECT value FROM sample').get()).toEqual({
        value: 'current',
      });
      manager.close();
      expect(await readdir(paths.backupDirectory)).toEqual(
        expect.arrayContaining(['backup_12345678.sqlite', 'backup_12345678.manifest.json']),
      );
      expect(await readdir(paths.diagnosticDirectory, { recursive: true })).not.toEqual([]);
    });
  });
});
