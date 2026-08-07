import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { loadMigrationSet } from './migration-loader';

const writeMigration = async (directory: string, name: string, sql: string | Uint8Array) => {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), sql);
};

describe('Migration 文件集合', () => {
  it('连续合法文件—加载集合—保留原始字节并生成稳定 SHA-256', async () => {
    await withSqliteTestContext(async (context) => {
      const directory = path.join(context.root, 'migrations');
      await writeMigration(directory, '0001_initial.sql', 'CREATE TABLE one (id TEXT);\n');
      await writeMigration(directory, '0002_add_index.sql', 'CREATE INDEX ix_one_id ON one(id);\n');

      const migrations = await loadMigrationSet(directory);

      expect(migrations.map(({ name, version }) => ({ name, version }))).toEqual([
        { name: '0001_initial.sql', version: 1 },
        { name: '0002_add_index.sql', version: 2 },
      ]);
      expect(migrations[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(migrations[0]?.sql.endsWith('\n')).toBe(true);
    });
  });

  it.each([
    [['0002_gap.sql'], '编号缺口'],
    [['0001_ok.sql', '0001_duplicate.sql'], '重复版本'],
    [['1_invalid.sql'], '非法名称'],
  ])('非法文件集合 %j—加载集合—统一拒绝为顺序错误', async (names) => {
    await withSqliteTestContext(async (context) => {
      const directory = path.join(context.root, 'migrations');
      await Promise.all(
        names.map(async (name) =>
          writeMigration(directory, name, 'CREATE TABLE sample (id TEXT);\n'),
        ),
      );

      await expect(loadMigrationSet(directory)).rejects.toMatchObject({
        code: 'MIGRATION_SEQUENCE_INVALID',
      });
    });
  });

  it.each([
    [new Uint8Array([0xef, 0xbb, 0xbf, 0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0x31]), 'BOM'],
    [new Uint8Array([0xc3, 0x28]), '非法 UTF-8'],
  ])('%s—读取 migration—拒绝非 UTF-8/no-BOM 输入', async (bytes) => {
    await withSqliteTestContext(async (context) => {
      const directory = path.join(context.root, 'migrations');
      await writeMigration(directory, '0001_initial.sql', bytes);

      await expect(loadMigrationSet(directory)).rejects.toMatchObject({
        code: 'MIGRATION_SEQUENCE_INVALID',
      });
    });
  });
});
