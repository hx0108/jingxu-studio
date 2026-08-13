import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { createManagedDirectories, createManagedPaths } from './managed-paths';
import { SqliteConnectionManager } from './sqlite-connection';
import { queryPragmaValue } from './sqlite-database';
import { initializeSqliteDatabase } from './sqlite-runtime';

describe('SQLite 连接基线', () => {
  it('新安装—打开唯一写连接—设置并回读固定 PRAGMA', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await createManagedDirectories(paths);
      const manager = new SqliteConnectionManager(paths.databasePath);

      const first = manager.open();
      const second = manager.open();

      expect(second).toBe(first);
      expect(queryPragmaValue(first, 'foreign_keys')).toBe(1);
      expect(queryPragmaValue(first, 'journal_mode')).toBe('wal');
      expect(queryPragmaValue(first, 'synchronous')).toBe(2);
      expect(queryPragmaValue(first, 'busy_timeout')).toBe(5000);
      manager.close();
    });
  });

  it('PRAGMA 设置失败—初始化数据库—返回稳定错误且不执行 migration', async () => {
    await withSqliteTestContext(async (context) => {
      const migrate = vi.fn();
      const manager = new SqliteConnectionManager(path.join(context.root, 'database.sqlite'), {
        beforePragma: (name) => {
          if (name === 'journal_mode') throw new Error('raw sqlite path and SQL');
        },
      });

      await expect(initializeSqliteDatabase(manager, migrate)).rejects.toMatchObject({
        code: 'DATABASE_PRAGMA_FAILED',
      });
      expect(migrate).not.toHaveBeenCalled();
      manager.close();
    });
  });
});
