import { access, readFile } from 'node:fs/promises';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createDatabaseFixtureSet } from './database-fixtures';
import { withSqliteTestContext } from './sqlite-test-kit';

describe('SQLite 数据库 Fixture', () => {
  it('生成固定 Fixture 集—重复检查—得到空库、旧库、压力库、损坏库和单错 migration', async () => {
    await withSqliteTestContext(async (context) => {
      const fixtures = await createDatabaseFixtureSet(context);

      const targets = [
        fixtures.corruptDatabasePath,
        fixtures.emptyDatabasePath,
        fixtures.invalidMigrationDirectory,
        fixtures.pressureDatabasePath,
        fixtures.previousDatabasePath,
      ];
      await Promise.all(targets.map(async (target) => access(target)));
      const pressure = new Database(fixtures.pressureDatabasePath, { readonly: true });
      const count = pressure.prepare('SELECT COUNT(*) AS count FROM fixture_versions').get() as {
        count: number;
      };
      pressure.close();

      expect(count.count).toBe(101);
      await expect(readFile(fixtures.corruptDatabasePath, 'utf8')).resolves.toBe(
        'not-a-sqlite-database',
      );
      expect(JSON.stringify(fixtures)).not.toMatch(/api[_-]?key|prompt|用户剧本/iu);
    });
  });
});
