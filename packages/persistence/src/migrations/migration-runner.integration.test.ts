import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SqliteTestDatabase as Database } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { loadMigrationSet } from './migration-loader';
import { applyMigrations, inspectMigrationPlan } from './migration-runner';

const createMigrationDirectory = async (root: string) => {
  const directory = path.join(root, 'migrations');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, '0001_initial.sql'),
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE sample (id TEXT PRIMARY KEY);\n',
    'utf8',
  );
  return directory;
};

describe('Migration Runner', () => {
  it('空库—应用初始 migration—记录证据且第二次启动完全跳过', async () => {
    await withSqliteTestContext(async (context) => {
      const directory = await createMigrationDirectory(context.root);
      const migrations = await loadMigrationSet(directory);
      const database = new Database(path.join(context.root, 'database.sqlite'));

      expect(inspectMigrationPlan(database, migrations).pending).toHaveLength(1);
      applyMigrations(database, migrations, context.clock);
      expect(inspectMigrationPlan(database, migrations).pending).toHaveLength(0);
      expect(
        database.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations').all(),
      ).toEqual([
        {
          applied_at: context.clock(),
          checksum: migrations[0]?.sha256,
          name: '0001_initial.sql',
          version: 1,
        },
      ]);

      applyMigrations(database, migrations, context.clock);
      expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
        count: 1,
      });
      database.close();
    });
  });

  it('已应用文件发生漂移—检查计划—拒绝且数据库零写入', async () => {
    await withSqliteTestContext(async (context) => {
      const directory = await createMigrationDirectory(context.root);
      const original = await loadMigrationSet(directory);
      const database = new Database(path.join(context.root, 'database.sqlite'));
      applyMigrations(database, original, context.clock);
      await writeFile(
        path.join(directory, '0001_initial.sql'),
        `${await readFile(path.join(directory, '0001_initial.sql'), 'utf8')}-- drift\n`,
        'utf8',
      );

      await expect(loadMigrationSet(directory)).resolves.toHaveLength(1);
      const drifted = await loadMigrationSet(directory);
      expect(() => inspectMigrationPlan(database, drifted)).toThrow('MIGRATION_CHECKSUM_MISMATCH');
      expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
        count: 1,
      });
      database.close();
    });
  });

  it('数据库版本高于应用—检查计划—拒绝且零写入', async () => {
    await withSqliteTestContext(async (context) => {
      const migrations = await loadMigrationSet(await createMigrationDirectory(context.root));
      const database = new Database(path.join(context.root, 'higher.sqlite'));
      database.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (2, '0002_future.sql', 'future', '2026-08-08T00:00:00.000Z');",
      );

      expect(() => inspectMigrationPlan(database, migrations)).toThrow('DATABASE_VERSION_TOO_NEW');
      expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
        count: 1,
      });
      database.close();
    });
  });

  it('存在用户表但没有 migration 记录—检查计划—拒绝未版本化库', async () => {
    await withSqliteTestContext(async (context) => {
      const migrations = await loadMigrationSet(await createMigrationDirectory(context.root));
      const database = new Database(path.join(context.root, 'unversioned.sqlite'));
      database.exec('CREATE TABLE existing_user_data (id TEXT PRIMARY KEY);');

      expect(() => inspectMigrationPlan(database, migrations)).toThrow(
        'DATABASE_UNVERSIONED_SCHEMA',
      );
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      ).toEqual([{ name: 'existing_user_data' }]);
      database.close();
    });
  });

  it('多个待执行 migration 中途失败—应用计划—回滚全部 DDL 与版本记录', async () => {
    await withSqliteTestContext(async (context) => {
      const directory = path.join(context.root, 'atomic-migrations');
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, '0001_initial.sql'),
        'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE stable_data (id TEXT PRIMARY KEY);\n',
        'utf8',
      );
      await writeFile(
        path.join(directory, '0002_add_column.sql'),
        'ALTER TABLE stable_data ADD COLUMN title TEXT;\n',
        'utf8',
      );
      await writeFile(
        path.join(directory, '0003_invalid_sql.sql'),
        'THIS IS NOT VALID SQL;\n',
        'utf8',
      );
      const database = new Database(path.join(context.root, 'atomic.sqlite'));
      const migrations = await loadMigrationSet(directory);

      expect(() => applyMigrations(database, migrations, context.clock)).toThrow(
        'MIGRATION_APPLY_FAILED',
      );
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all(),
      ).toEqual([]);
      database.close();
    });
  });

  it('100+ 历史版本库—应用后续 migration—保留行数、hash、父链并通过完整性检查', async () => {
    await withSqliteTestContext(async (context) => {
      const directory = path.join(context.root, 'pressure-migrations');
      await mkdir(directory, { recursive: true });
      const initialSql = await readFile(
        path.resolve(import.meta.dirname, '../../resources/migrations/0001_initial.sql'),
      );
      await writeFile(path.join(directory, '0001_initial.sql'), initialSql);
      const database = new Database(path.join(context.root, 'pressure.sqlite'));
      database.pragma('foreign_keys = ON');
      applyMigrations(database, await loadMigrationSet(directory), context.clock);
      database
        .prepare(
          `INSERT INTO projects
           (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'project_pressure',
          '压力项目',
          'AI_ORIGINAL',
          'NARRATION_FIRST',
          'LOCAL_DEMO',
          'projects/pressure',
          context.clock(),
          context.clock(),
        );
      const insertVersion = database.prepare(
        `INSERT INTO story_bible_versions
         (id, project_id, version_no, parent_id, document_json, document_sha256, status, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      database.transaction(() => {
        for (let version = 1; version <= 101; version += 1) {
          insertVersion.run(
            `bible_pressure_${String(version)}`,
            'project_pressure',
            version,
            version === 1 ? null : `bible_pressure_${String(version - 1)}`,
            '{}',
            `sha_${String(version).padStart(3, '0')}`,
            'DRAFT',
            'USER',
            context.clock(),
          );
        }
      })();
      await writeFile(
        path.join(directory, '0002_pressure_index.sql'),
        'CREATE INDEX ix_pressure_story_hash ON story_bible_versions(document_sha256);\n',
        'utf8',
      );

      const startedAt = performance.now();
      applyMigrations(database, await loadMigrationSet(directory), context.clock);
      const durationMs = performance.now() - startedAt;

      expect(database.prepare('SELECT COUNT(*) AS count FROM story_bible_versions').get()).toEqual({
        count: 101,
      });
      expect(
        database
          .prepare(
            'SELECT parent_id, document_sha256 FROM story_bible_versions WHERE version_no = 101',
          )
          .get(),
      ).toEqual({ parent_id: 'bible_pressure_100', document_sha256: 'sha_101' });
      expect(database.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(database.pragma('foreign_key_check')).toEqual([]);
      expect(durationMs).toBeGreaterThanOrEqual(0);
      database.close();
    });
  });
});
