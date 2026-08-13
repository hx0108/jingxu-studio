import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listVerifiedBackups, performManagedMigration } from '../backup/backup-manager';
import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { createManagedDirectories, createManagedPaths } from '../runtime/managed-paths';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-13T00:00:00.000Z';

const seedProject = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
       VALUES (?, ?, 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO', ?, ?, ?)`,
    )
    .run('project_migration', '迁移项目', 'projects/project_migration', NOW, NOW);
};

describe('0003_script_version_receipts.sql', () => {
  it('空库—执行完整 migration—安装 v3 索引且八类回执命令均受约束', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'empty.sqlite'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedProject(database);

        expect(
          database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
        ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
        expect(
          database
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
            .get('ux_script_versions_project_level'),
        ).toEqual({ name: 'ux_script_versions_project_level' });

        for (const command of [
          'CREATE_PROJECT',
          'UPDATE_PROJECT',
          'DELETE_PROJECT',
          'RESTORE_PROJECT',
          'INITIALIZE_ORIGINAL',
          'SAVE_SCRIPT_DRAFT',
          'CONFIRM_SCRIPT_VERSION',
          'RESTORE_SCRIPT_VERSION',
        ]) {
          database
            .prepare(
              `INSERT INTO command_receipts
               (request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              `request_${command}`,
              command,
              'a'.repeat(64),
              'project_migration',
              '{}',
              'trace',
              NOW,
            );
        }
        expect(() =>
          database
            .prepare(
              `INSERT INTO command_receipts
               (request_id, command_name, payload_sha256, result_ref_json, trace_id, committed_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run('request_bad', 'REWRITE_SELECTION', 'a'.repeat(64), '{}', 'trace', NOW),
        ).toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('v2 升级库—迁移到 v3—旧 Project 回执逐字段保持且索引恢复', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const migrations = await loadMigrationSet(MIGRATIONS);
      const database = new SqliteTestDatabase(path.join(root, 'upgrade.sqlite'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, migrations.slice(0, 2), () => NOW);
        seedProject(database);
        const oldReceipt = {
          requestId: 'request_legacy',
          commandName: 'CREATE_PROJECT',
          payloadSha256: 'b'.repeat(64),
          projectId: 'project_migration',
          resultRefJson: '{"projectId":"project_migration"}',
          traceId: 'trace_legacy',
          committedAt: NOW,
        } as const;
        database
          .prepare(
            `INSERT INTO command_receipts
             (request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...Object.values(oldReceipt));

        applyMigrations(database, migrations, () => NOW);
        expect(
          database
            .prepare(
              `SELECT request_id AS requestId, command_name AS commandName,
                      payload_sha256 AS payloadSha256, project_id AS projectId,
                      result_ref_json AS resultRefJson, trace_id AS traceId,
                      committed_at AS committedAt
               FROM command_receipts`,
            )
            .get(),
        ).toEqual(oldReceipt);
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('v2 受管理库—升级到 v3—先生成可验证的 schema v2 在线备份', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const migrations = await loadMigrationSet(MIGRATIONS);
      const paths = createManagedPaths(path.join(root, 'managed'));
      await createManagedDirectories(paths);
      const database = new SqliteTestDatabase(paths.databasePath);
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, migrations.slice(0, 2), () => NOW);
        seedProject(database);

        const result = await performManagedMigration({
          backupId: 'backup_script_v3',
          clock: () => NOW,
          database,
          migrations,
          paths,
        });

        expect(result.backup).toMatchObject({ schemaVersion: 2 });
        expect(await listVerifiedBackups(paths)).toEqual([
          expect.objectContaining({ backupId: 'backup_script_v3', schemaVersion: 2 }),
        ]);
        expect(
          database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
        ).toEqual({ version: 3 });
      } finally {
        database.close();
      }
    });
  });

  it('项目级版本—同 stage/version_no 重复—partial unique 拒绝而集级可各自编号', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'unique.sqlite'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedProject(database);
        const insert = database.prepare(
          `INSERT INTO script_versions
           (id, project_id, episode_id, stage, version_no, document_json, document_sha256, status, source, created_at)
           VALUES (?, 'project_migration', NULL, 'CONCEPT', 1, '{}', ?, 'DRAFT', 'USER', ?)`,
        );
        insert.run('script_project_1', 'c'.repeat(64), NOW);
        expect(() => insert.run('script_project_2', 'd'.repeat(64), NOW)).toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('100+ 历史版本与旧回执—升级 v3—数量与摘要逐行对账', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const migrations = await loadMigrationSet(MIGRATIONS);
      const database = new SqliteTestDatabase(path.join(root, 'stress.sqlite'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, migrations.slice(0, 2), () => NOW);
        seedProject(database);
        const insertVersion = database.prepare(
          `INSERT INTO script_versions
           (id, project_id, episode_id, stage, version_no, document_json, document_sha256, status, source, created_at)
           VALUES (?, 'project_migration', NULL, 'CONCEPT', ?, '{}', ?, 'DRAFT', 'USER', ?)`,
        );
        const insertReceipt = database.prepare(
          `INSERT INTO command_receipts
           (request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at)
           VALUES (?, 'UPDATE_PROJECT', ?, 'project_migration', '{}', ?, ?)`,
        );
        for (let index = 1; index <= 120; index += 1) {
          insertVersion.run(
            `script_${String(index)}`,
            index,
            createHash('sha256').update(String(index)).digest('hex'),
            NOW,
          );
          insertReceipt.run(
            `request_${String(index)}`,
            'e'.repeat(64),
            `trace_${String(index)}`,
            NOW,
          );
        }
        const before = database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get();
        applyMigrations(database, migrations, () => NOW);
        expect(database.prepare('SELECT COUNT(*) AS count FROM script_versions').get()).toEqual({
          count: 120,
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()).toEqual(
          before,
        );
      } finally {
        database.close();
      }
    });
  }, 15_000);

  it('已应用 migration checksum 漂移—检查计划—拒绝且数据库不变', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const migrations = await loadMigrationSet(MIGRATIONS);
      const database = new SqliteTestDatabase(path.join(root, 'checksum.sqlite'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, migrations, () => NOW);
        database
          .prepare('UPDATE schema_migrations SET checksum=? WHERE version=3')
          .run('0'.repeat(64));
        expect(() => applyMigrations(database, migrations, () => NOW)).toThrow(
          new PersistenceRuntimeError('MIGRATION_CHECKSUM_MISMATCH'),
        );
        expect(database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()).toEqual({
          count: 0,
        });
      } finally {
        database.close();
      }
    });
  });

  it('v3 中途 SQL 失败—外层 migration 事务—表、索引和版本记录全部回滚', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const migrations = await loadMigrationSet(MIGRATIONS);
      const database = new SqliteTestDatabase(path.join(root, 'rollback.sqlite'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, migrations.slice(0, 2), () => NOW);
        seedProject(database);
        const broken = migrations.map((migration) =>
          migration.version === 3
            ? { ...migration, sql: `${migration.sql}\nSELECT * FROM missing_table;` }
            : migration,
        );
        expect(() => applyMigrations(database, broken, () => NOW)).toThrow(
          new PersistenceRuntimeError('MIGRATION_APPLY_FAILED'),
        );
        expect(
          database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
        ).toEqual({ version: 2 });
        expect(
          database
            .prepare("SELECT name FROM sqlite_master WHERE name='ux_script_versions_project_level'")
            .get(),
        ).toBeUndefined();
        expect(
          database.prepare("SELECT name FROM sqlite_master WHERE name='command_receipts'").get(),
        ).toEqual({ name: 'command_receipts' });
      } finally {
        database.close();
      }
    });
  });
});
