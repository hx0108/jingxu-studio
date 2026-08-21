import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runDatabaseAudit } from '../audit/database-audit';
import { listVerifiedBackups, performManagedMigration } from '../backup/backup-manager';
import { createManagedDirectories, createManagedPaths } from '../runtime/managed-paths';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { type MigrationResource, loadMigrationSet } from './migration-loader';
import { applyMigrations, inspectMigrationPlan } from './migration-runner';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
// 0001_initial.sql 已发布且不可改写；本常量锁死其原始字节 SHA-256，任何编辑都会让 §4.1 失败。
const FROZEN_0001_SHA256 = '0248c0e6a87350806e1869768a65354aea23843d1ccc219b1a70d7eb1f1adbaf';
const NOW = '2026-08-08T00:00:00.000Z';
const LOWERCASE_HEX64 = 'a'.repeat(64);

const openMigratedDatabase = async (root: string): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, 'command-receipts.sqlite'));
  try {
    database.pragma('foreign_keys = ON');
    applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), () => NOW);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

const withMigratedDatabase = async <T>(
  operation: (database: SqliteTestDatabase) => T | Promise<T>,
): Promise<T> =>
  withSqliteTestContext(async (context) => {
    const database = await openMigratedDatabase(context.root);
    try {
      return await operation(database);
    } finally {
      database.close();
    }
  });

const insertProject = (database: SqliteTestDatabase, id = 'project_1'): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      '测试项目',
      'AI_ORIGINAL',
      'NARRATION_FIRST',
      'LOCAL_DEMO',
      `projects/${id}`,
      NOW,
      NOW,
    );
};

interface ReceiptOverrides {
  readonly requestId: string;
  readonly commandName?: string;
  readonly payloadSha256?: string;
  readonly projectId?: string | null;
  readonly resultRefJson?: string;
  readonly traceId?: string;
  readonly committedAt?: string;
}

const insertReceipt = (database: SqliteTestDatabase, overrides: ReceiptOverrides): void => {
  const values = {
    commandName: 'CREATE_PROJECT',
    payloadSha256: LOWERCASE_HEX64,
    projectId: null,
    resultRefJson: '{}',
    traceId: 'trace_1',
    committedAt: NOW,
    ...overrides,
  };
  database
    .prepare(
      `INSERT INTO command_receipts
       (request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.requestId,
      values.commandName,
      values.payloadSha256,
      values.projectId,
      values.resultRefJson,
      values.traceId,
      values.committedAt,
    );
};

const receiptCount = (database: SqliteTestDatabase): number =>
  (database.prepare('SELECT COUNT(*) AS count FROM command_receipts').get() as { count: number })
    .count;

const copyMigrations = async (source: string, destination: string): Promise<void> => {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source);
  await Promise.all(
    entries.map(async (name) =>
      writeFile(path.join(destination, name), await readFile(path.join(source, name))),
    ),
  );
};

const openVersionOneDatabase = async (
  root: string,
): Promise<{
  readonly database: SqliteTestDatabase;
  readonly migrations: readonly MigrationResource[];
  readonly paths: ReturnType<typeof createManagedPaths>;
}> => {
  const paths = createManagedPaths(path.join(root, 'managed'));
  await createManagedDirectories(paths);
  const migrations = await loadMigrationSet(MIGRATION_DIRECTORY);
  const database = new SqliteTestDatabase(paths.databasePath);
  database.pragma('foreign_keys = ON');
  applyMigrations(database, migrations.slice(0, 1), () => NOW);
  return { database, migrations: migrations.slice(0, 2), paths };
};

describe('0002 migration 资源集合', () => {
  it('资源集合—连续 0001/0002、0001 已发布字节/checksum 不变、Forge 清单含 0002', async () => {
    const migrations = await loadMigrationSet(MIGRATION_DIRECTORY);

    expect(migrations.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: '0001_initial.sql', version: 1 },
      { name: '0002_project_command_receipts.sql', version: 2 },
      { name: '0003_script_version_receipts.sql', version: 3 },
      { name: '0004_prompt_templates_v2.sql', version: 4 },
      { name: '0005_prompt_templates_story_bible_v3.sql', version: 5 },
      { name: '0006_model_invocations_profile_ref.sql', version: 6 },
      { name: '0007_snapshot_tables_profile_ref.sql', version: 7 },
      { name: '0008_prompt_templates_shot_contract.sql', version: 8 },
      { name: '0009_media_assets_images.sql', version: 9 },
      { name: '0010_media_generation_batches.sql', version: 10 },
      { name: '0011_media_model_invocations.sql', version: 11 },
      { name: '0012_shot_video_generation.sql', version: 12 },
      { name: '0013_media_invocation_video_references.sql', version: 13 },
      { name: '0014_video_stale_duration.sql', version: 14 },
      { name: '0015_seedance_video_v2_snapshot.sql', version: 15 },
    ]);
    expect(migrations[0]?.sha256).toBe(FROZEN_0001_SHA256);
    expect(migrations[1]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    // apps/desktop/forge.config.ts 通过 packagerConfig.extraResource 打包本目录。
    const entries = await readdir(MIGRATION_DIRECTORY);
    expect(entries).toEqual(
      expect.arrayContaining([
        '0001_initial.sql',
        '0002_project_command_receipts.sql',
        '0003_script_version_receipts.sql',
        '0004_prompt_templates_v2.sql',
        '0005_prompt_templates_story_bible_v3.sql',
        '0006_model_invocations_profile_ref.sql',
        '0007_snapshot_tables_profile_ref.sql',
        '0008_prompt_templates_shot_contract.sql',
        '0009_media_assets_images.sql',
        '0010_media_generation_batches.sql',
        '0011_media_model_invocations.sql',
        '0012_shot_video_generation.sql',
        '0013_media_invocation_video_references.sql',
        '0014_video_stale_duration.sql',
        '0015_seedance_video_v2_snapshot.sql',
      ]),
    );
  });

  it('空库—应用完整集合—终态版本 14 且 command_receipts 登记对象存在', async () => {
    await withMigratedDatabase((database) => {
      expect(
        database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 },
        { version: 15 },
      ]);
      const objects = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('command_receipts','ix_command_receipts_project')",
        )
        .all() as unknown as readonly { readonly name: string }[];
      expect(objects.map(({ name }) => name).sort()).toEqual([
        'command_receipts',
        'ix_command_receipts_project',
      ]);
      expect(database.pragma('foreign_key_check')).toEqual([]);
    });
  });

  it('重复启动—已应用完整集合—完全跳过且 schema_migrations 记录不变', async () => {
    await withSqliteTestContext(async (context) => {
      const migrations = await loadMigrationSet(MIGRATION_DIRECTORY);
      const database = await openMigratedDatabase(context.root);
      const before = database
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all();

      expect(inspectMigrationPlan(database, migrations).pending).toHaveLength(0);
      applyMigrations(database, migrations, () => NOW);

      const after = database
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all();
      expect(after).toEqual(before);
      expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
        count: 15,
      });
      database.close();
    });
  });
});

describe('command_receipts DDL 约束', () => {
  it('正例—result_ref 仅需安全 ID/revision 不要求用户内容—写入成功', async () => {
    await withMigratedDatabase((database) => {
      insertProject(database, 'project_1');
      // result_ref 只携带安全 ID 与提交时间/changed，不含 name/genre/style。
      insertReceipt(database, {
        projectId: 'project_1',
        requestId: 'req_create',
        resultRefJson: JSON.stringify({
          projectId: 'project_1',
          formatProfileId: 'format_1',
          updatedAt: NOW,
          changed: true,
        }),
      });
      // no-op 回执（changed=false）同样合法。
      insertReceipt(database, {
        commandName: 'UPDATE_PROJECT',
        projectId: 'project_1',
        requestId: 'req_noop',
        resultRefJson: JSON.stringify({
          projectId: 'project_1',
          formatProfileId: 'format_1',
          updatedAt: NOW,
          changed: false,
        }),
      });

      expect(receiptCount(database)).toBe(2);
    });
  });

  it('负例—非法 command/非 64 位小写 hash/非法 JSON—由 CHECK 约束拒绝且零残留', async () => {
    await withMigratedDatabase((database) => {
      insertProject(database, 'project_1');
      expect(() => {
        insertReceipt(database, { requestId: 'r1', commandName: 'INVALID_COMMAND' });
      }).toThrow();
      expect(() => {
        insertReceipt(database, { requestId: 'r2', payloadSha256: 'A'.repeat(64) });
      }).toThrow();
      expect(() => {
        insertReceipt(database, { requestId: 'r3', payloadSha256: 'a'.repeat(63) });
      }).toThrow();
      expect(() => {
        insertReceipt(database, { requestId: 'r4', payloadSha256: 'g'.repeat(64) });
      }).toThrow();
      expect(() => {
        insertReceipt(database, { requestId: 'r5', resultRefJson: '{' });
      }).toThrow();

      expect(receiptCount(database)).toBe(0);
    });
  });

  it('负例—重复 requestId—由主键拒绝', async () => {
    await withMigratedDatabase((database) => {
      insertProject(database, 'project_1');
      insertReceipt(database, { projectId: 'project_1', requestId: 'dup' });
      expect(() => {
        insertReceipt(database, { projectId: 'project_1', requestId: 'dup' });
      }).toThrow();

      expect(receiptCount(database)).toBe(1);
    });
  });

  it('负例—缺失 project 外键—由外键约束拒绝', async () => {
    await withMigratedDatabase((database) => {
      insertProject(database, 'project_1');
      expect(() => {
        insertReceipt(database, { projectId: 'missing_project', requestId: 'r1' });
      }).toThrow();

      expect(receiptCount(database)).toBe(0);
    });
  });
});

describe('0002 受管理升级、备份与回滚', () => {
  it('仅 0001 上一版本库—受管理升级—先在线备份(manifest source=1 target=2)后提交 0002', async () => {
    await withSqliteTestContext(async (context) => {
      const { database, migrations, paths } = await openVersionOneDatabase(context.root);
      insertProject(database, 'project_1');

      const result = await performManagedMigration({
        backupId: 'backup_0002upgrd',
        clock: () => NOW,
        database,
        migrations,
        paths,
      });

      expect(result.backup?.schemaVersion).toBe(1);
      expect(
        database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toEqual({ version: 2 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'command_receipts'")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = 'project_1'").get(),
      ).toEqual({ count: 1 });

      const backups = await listVerifiedBackups(paths);
      expect(backups).toHaveLength(1);
      const manifest: unknown = JSON.parse(
        await readFile(path.join(paths.backupDirectory, 'backup_0002upgrd.manifest.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({ schemaVersion: 1, targetSchemaVersion: 2 });
      const backupDatabase = new SqliteTestDatabase(
        path.join(paths.backupDirectory, 'backup_0002upgrd.sqlite'),
        { readonly: true },
      );
      expect(
        backupDatabase
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'command_receipts'")
          .get(),
      ).toEqual({ count: 0 });
      backupDatabase.close();
      database.close();
    });
  });

  it('0002 中途失败—受管理升级—回滚到 v1、真实 0002 未生效且备份保留', async () => {
    await withSqliteTestContext(async (context) => {
      const { database, migrations, paths } = await openVersionOneDatabase(context.root);
      // 用同名空表制造确定性冲突，让真实 0002 的 CREATE TABLE 在事务中失败。
      database.exec('CREATE TABLE command_receipts (collision_marker TEXT)');

      await expect(
        performManagedMigration({
          backupId: 'backup_0002fail01',
          clock: () => NOW,
          database,
          migrations,
          paths,
        }),
      ).rejects.toMatchObject({ code: 'MIGRATION_APPLY_FAILED' });

      expect(
        database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([{ version: 1 }]);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'ix_command_receipts_project'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(await listVerifiedBackups(paths)).toHaveLength(1);
      database.close();
    });
  });

  it('0002 已应用后字节漂移—检查计划—MIGRATION_CHECKSUM_MISMATCH 且零写入', async () => {
    await withSqliteTestContext(async (context) => {
      const directory = path.join(context.root, 'migrations');
      await copyMigrations(MIGRATION_DIRECTORY, directory);
      const migrations = await loadMigrationSet(directory);
      const database = new SqliteTestDatabase(path.join(context.root, 'drift.sqlite'));
      database.pragma('foreign_keys = ON');
      applyMigrations(database, migrations, () => NOW);

      const driftedPath = path.join(directory, '0002_project_command_receipts.sql');
      await writeFile(driftedPath, `${await readFile(driftedPath, 'utf8')}-- drift\n`, 'utf8');
      const drifted = await loadMigrationSet(directory);

      const before = database
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all();
      expect(() => inspectMigrationPlan(database, drifted)).toThrow('MIGRATION_CHECKSUM_MISMATCH');
      const after = database
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all();
      expect(after).toEqual(before);
      database.close();
    });
  });

  it('数据库版本高于应用—检查计划—DATABASE_VERSION_TOO_NEW 且零写入', async () => {
    await withSqliteTestContext(async (context) => {
      const migrations = await loadMigrationSet(MIGRATION_DIRECTORY);
      const database = new SqliteTestDatabase(path.join(context.root, 'higher.sqlite'));
      database.pragma('foreign_keys = ON');
      applyMigrations(database, migrations, () => NOW);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        )
        .run(16, '0016_future.sql', 'b'.repeat(64), NOW);

      const before = database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get();
      expect(() => inspectMigrationPlan(database, migrations)).toThrow('DATABASE_VERSION_TOO_NEW');
      const after = database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get();
      expect(after).toEqual(before);
      database.close();
    });
  });

  it('升级前在线备份失败—受管理升级—DATABASE_BACKUP_FAILED 且源库保持 v1', async () => {
    await withSqliteTestContext(async (context) => {
      const { database, migrations, paths } = await openVersionOneDatabase(context.root);
      insertProject(database, 'project_1');

      await expect(
        performManagedMigration({
          backupDatabase: () => Promise.reject(new Error('injected backup failure')),
          backupId: 'backup_0002bkup01',
          clock: () => NOW,
          database,
          migrations,
          paths,
        }),
      ).rejects.toMatchObject({ code: 'DATABASE_BACKUP_FAILED' });

      expect(
        database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toEqual({ version: 1 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'command_receipts'")
          .get(),
      ).toEqual({ count: 0 });
      expect(await listVerifiedBackups(paths)).toEqual([]);
      database.close();
    });
  });
});

describe('0002 压力库演练', () => {
  it('100+ 历史对象库—0001→0002 演练—对账不变、receipts 初始为空、完整性/审计通过', async () => {
    await withSqliteTestContext(async (context) => {
      const directory = path.join(context.root, 'migrations');
      await copyMigrations(MIGRATION_DIRECTORY, directory);
      const database = new SqliteTestDatabase(path.join(context.root, 'pressure.sqlite'));
      database.pragma('foreign_keys = ON');
      applyMigrations(database, (await loadMigrationSet(directory)).slice(0, 1), () => NOW);

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
          NOW,
          NOW,
        );
      database
        .prepare(
          `INSERT INTO format_profiles
           (id, project_id, version_no, parent_id, aspect_ratio, width, height, fps, language,
            subtitle_safe_area_json, is_current, created_at)
           VALUES (?, ?, 1, NULL, '9:16', 1080, 1920, 30, 'zh-CN', ?, 1, ?)`,
        )
        .run(
          'format_pressure_1',
          'project_pressure',
          JSON.stringify({ top: 5, right: 5, bottom: 12, left: 5 }),
          NOW,
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
            NOW,
          );
        }
      })();

      const startedAt = performance.now();
      applyMigrations(database, await loadMigrationSet(directory), () => NOW);
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
      expect(receiptCount(database)).toBe(0);
      expect(database.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(database.pragma('foreign_key_check')).toEqual([]);
      expect(runDatabaseAudit(database).ok).toBe(true);
      expect(durationMs).toBeGreaterThanOrEqual(0);
      database.close();
    });
  });
});
