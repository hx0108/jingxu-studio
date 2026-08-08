import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import {
  assertSqliteRuntimeCapabilities,
  backupSqliteDatabase,
  openSqliteDatabase,
  queryPragmaRows,
  queryPragmaValue,
  runImmediateTransaction,
} from './sqlite-database';

describe('node:sqlite compatibility boundary', () => {
  it('Node 22.16 baseline—execute prepared statements and PRAGMA—preserves expected values', async () => {
    await withSqliteTestContext(({ root }) => {
      const database = openSqliteDatabase(path.join(root, 'runtime.sqlite'));
      try {
        database.exec('CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
        database.prepare('INSERT INTO sample (id, value) VALUES (?, ?)').run('sample_1', 'ok');

        expect(database.prepare('SELECT value FROM sample WHERE id = ?').get('sample_1')).toEqual({
          value: 'ok',
        });
        expect(queryPragmaValue(database, 'foreign_keys')).toBe(1);
        expect(queryPragmaRows(database, 'integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      } finally {
        database.close();
      }
    });
  });

  it('runtime capability probe—check JSON function—accepts the locked SQLite feature set', async () => {
    await withSqliteTestContext(({ root }) => {
      const database = openSqliteDatabase(path.join(root, 'capability.sqlite'));
      try {
        expect(() => {
          assertSqliteRuntimeCapabilities(database);
        }).not.toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('transaction operation fails—rollback—does not persist partial writes', async () => {
    await withSqliteTestContext(({ root }) => {
      const database = openSqliteDatabase(path.join(root, 'rollback.sqlite'));
      try {
        database.exec('CREATE TABLE sample (id TEXT PRIMARY KEY)');
        expect(() =>
          runImmediateTransaction(database, () => {
            database.prepare('INSERT INTO sample (id) VALUES (?)').run('partial');
            throw new Error('expected failure');
          }),
        ).toThrow('expected failure');
        expect(database.prepare('SELECT id FROM sample').all()).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('online backup completes—open read-only candidate—contains committed data', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const sourcePath = path.join(root, 'source.sqlite');
      const backupPath = path.join(root, 'backup.sqlite');
      const source = openSqliteDatabase(sourcePath);
      try {
        source.exec(
          "CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample VALUES ('saved');",
        );
        await backupSqliteDatabase(source, backupPath);
      } finally {
        source.close();
      }

      expect((await readFile(backupPath)).byteLength).toBeGreaterThan(0);
      const backup = openSqliteDatabase(backupPath, { readOnly: true });
      try {
        expect(backup.prepare('SELECT value FROM sample').get()).toEqual({ value: 'saved' });
        expect(() => {
          backup.exec("INSERT INTO sample VALUES ('blocked')");
        }).toThrow();
      } finally {
        backup.close();
      }
    });
  });
});
