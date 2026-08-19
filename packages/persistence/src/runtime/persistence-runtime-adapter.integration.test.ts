import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { StartupService, type SchemaRegistryStartupPort } from '@jingxu/application';
import { startupStatusSchema } from '@jingxu/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createOnlineBackup } from '../backup/backup-manager';
import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase as Database } from '../testing/sqlite-test-database';
import { createManagedDirectories, createManagedPaths } from './managed-paths';
import { SqlitePersistenceRuntimeAdapter } from './persistence-runtime-adapter';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
const roots: string[] = [];
const SUCCESSFUL_SCHEMA_STARTUP: SchemaRegistryStartupPort = {
  prepare: () => Promise.resolve({ manifest: [], ok: true }),
};

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-adapter-test-'));
  roots.push(root);
  return root;
};

const writeMigrationSet = async (directory: string, includeSecond: boolean): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, '0001_initial.sql'),
    `CREATE TABLE schema_migrations
     (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
     CREATE TABLE schema_registry_manifest
     (schema_id TEXT PRIMARY KEY, semantic_version TEXT NOT NULL, resource_path TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64), enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)));
     CREATE TABLE sample (value TEXT);\n`,
    'utf8',
  );
  if (includeSecond) {
    await writeFile(
      path.join(directory, '0002_add_marker.sql'),
      'ALTER TABLE sample ADD COLUMN marker TEXT;\n',
      'utf8',
    );
  }
};

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) =>
        rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 }),
      ),
  );
});

describe('SQLite PersistenceRuntimeAdapter', () => {
  it('全部启动阶段通过—启动服务执行完整检查—仅在最后进入 READY', async () => {
    const adapter = new SqlitePersistenceRuntimeAdapter({
      clock: () => '2026-08-08T00:00:00.000Z',
      createBackupId: () => 'backup_12345678',
      managedRoot: path.join(await createRoot(), 'managed'),
      migrationDirectory: MIGRATION_DIRECTORY,
    });
    const service = new StartupService(adapter, SUCCESSFUL_SCHEMA_STARTUP);

    const status = await service.start();

    expect(startupStatusSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({
      completedPhases: [
        'DATABASE_OPEN',
        'CONNECTION_BASELINE',
        'MIGRATION',
        'DATABASE_AUDIT',
        'RECOVERY_GATE',
        'SCHEMA_REGISTRY',
      ],
      errorCode: null,
      state: 'READY',
      writeEnabled: true,
    });
    service.close();
  });

  it('数据库文件不可打开—启动服务执行检查—进入脱敏只读故障且不覆盖原文件', async () => {
    const root = await createRoot();
    const dataDirectory = path.join(root, 'managed', 'data');
    await mkdir(path.dirname(dataDirectory), { recursive: true });
    await writeFile(dataDirectory, 'this path intentionally blocks the data directory');
    const adapter = new SqlitePersistenceRuntimeAdapter({
      clock: () => '2026-08-08T00:00:00.000Z',
      managedRoot: path.join(root, 'managed'),
      migrationDirectory: MIGRATION_DIRECTORY,
    });
    const service = new StartupService(adapter, SUCCESSFUL_SCHEMA_STARTUP);

    const status = await service.start();

    expect(status).toMatchObject({
      currentPhase: 'DATABASE_OPEN',
      errorCode: 'DATABASE_OPEN_FAILED',
      state: 'READ_ONLY_FAULT',
      writeEnabled: false,
    });
    expect(JSON.stringify(status)).not.toContain(root);
    expect(await readFile(dataDirectory, 'utf8')).toContain('intentionally blocks');
    service.close();
  });

  it('当前库损坏且存在有效备份—执行恢复—保留诊断证据并完整重检后进入 READY', async () => {
    const root = await createRoot();
    const managedRoot = path.join(root, 'managed');
    const migrationDirectory = path.join(root, 'migrations');
    await writeMigrationSet(migrationDirectory, false);
    const initialService = new StartupService(
      new SqlitePersistenceRuntimeAdapter({
        clock: () => '2026-08-08T00:00:00.000Z',
        managedRoot,
        migrationDirectory,
      }),
      SUCCESSFUL_SCHEMA_STARTUP,
    );
    expect((await initialService.start()).state).toBe('READY');
    initialService.close();

    await writeMigrationSet(migrationDirectory, true);
    const upgradeService = new StartupService(
      new SqlitePersistenceRuntimeAdapter({
        clock: () => '2026-08-08T00:01:00.000Z',
        createBackupId: () => 'backup_87654321',
        managedRoot,
        migrationDirectory,
      }),
      SUCCESSFUL_SCHEMA_STARTUP,
    );
    expect((await upgradeService.start()).state).toBe('READY');
    upgradeService.close();

    await writeFile(path.join(managedRoot, 'data', 'jingxu.sqlite'), 'corrupt live database');
    const restoreService = new StartupService(
      new SqlitePersistenceRuntimeAdapter({
        clock: () => '2026-08-08T00:02:00.000Z',
        createBackupId: () => 'backup_afterrestore01',
        managedRoot,
        migrationDirectory,
      }),
      SUCCESSFUL_SCHEMA_STARTUP,
    );
    const fault = await restoreService.start();
    expect(fault).toMatchObject({
      state: 'READ_ONLY_FAULT',
      writeEnabled: false,
    });
    expect(fault.backups.map(({ backupId }) => backupId)).toContain('backup_87654321');

    const restored = await restoreService.restoreBackup({
      backupId: 'backup_87654321',
      expectedRevision: fault.revision,
      requestId: 'restore-request-0001',
    });

    expect(restored).toMatchObject({
      completedPhases: [
        'DATABASE_OPEN',
        'CONNECTION_BASELINE',
        'MIGRATION',
        'DATABASE_AUDIT',
        'RECOVERY_GATE',
        'SCHEMA_REGISTRY',
      ],
      errorCode: null,
      state: 'READY',
      writeEnabled: true,
    });
    expect(await readdir(path.join(managedRoot, 'diagnostics'), { recursive: true })).toEqual(
      expect.arrayContaining([expect.stringMatching(/original-live\.sqlite/u)]),
    );
    restoreService.close();
  });

  it('备份可打开但违反应用不变量—执行恢复—返回恢复失败并保持只读故障', async () => {
    const root = await createRoot();
    const managedRoot = path.join(root, 'managed');
    const paths = createManagedPaths(managedRoot);
    await createManagedDirectories(paths);
    const database = new Database(paths.databasePath);
    applyMigrations(
      database,
      await loadMigrationSet(MIGRATION_DIRECTORY),
      () => '2026-08-08T00:00:00.000Z',
    );
    database
      .prepare(
        `INSERT INTO projects
         (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'project_invalid_pointer',
        '不变量测试项目',
        'AI_ORIGINAL',
        'NARRATION_FIRST',
        'LOCAL_DEMO',
        'projects/invalid-pointer',
        '2026-08-08T00:00:00.000Z',
        '2026-08-08T00:00:00.000Z',
      );
    database
      .prepare(
        `INSERT INTO episodes
         (id, project_id, title, target_duration_sec, current_version_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'episode_invalid_pointer',
        'project_invalid_pointer',
        '不变量测试集',
        90,
        'episode_version_missing',
        '2026-08-08T00:00:00.000Z',
        '2026-08-08T00:00:00.000Z',
      );
    await createOnlineBackup({
      backupId: 'backup_invalidaudit',
      clock: () => '2026-08-08T00:00:00.000Z',
      // 迁移 head 0011 后备份基线为 11（§2.3 同步点补漏：verifyBackupDatabase 对齐 MAX(version)）。
      currentVersion: 11,
      database,
      paths,
    });
    database.close();
    const service = new StartupService(
      new SqlitePersistenceRuntimeAdapter({
        clock: () => '2026-08-08T00:01:00.000Z',
        managedRoot,
        migrationDirectory: MIGRATION_DIRECTORY,
      }),
      SUCCESSFUL_SCHEMA_STARTUP,
    );
    const initialFault = await service.start();
    expect(initialFault.errorCode).toBe('DATABASE_INVARIANT_FAILED');

    const restoreFault = await service.restoreBackup({
      backupId: 'backup_invalidaudit',
      expectedRevision: initialFault.revision,
      requestId: 'restore-request-0002',
    });

    expect(restoreFault).toMatchObject({
      currentPhase: 'RECOVERY_GATE',
      errorCode: 'DATABASE_RESTORE_FAILED',
      state: 'READ_ONLY_FAULT',
      writeEnabled: false,
    });
    expect(await readdir(paths.diagnosticDirectory, { recursive: true })).not.toEqual([]);
    expect(await readdir(paths.backupDirectory)).toEqual(
      expect.arrayContaining(['backup_invalidaudit.sqlite', 'backup_invalidaudit.manifest.json']),
    );
    service.close();
  });

  it('备份替换后无法重新建立连接基线—执行恢复—返回恢复失败并保留替换前数据库', async () => {
    const root = await createRoot();
    const managedRoot = path.join(root, 'managed');
    const migrationDirectory = path.join(root, 'migrations');
    await writeMigrationSet(migrationDirectory, false);
    const paths = createManagedPaths(managedRoot);
    await createManagedDirectories(paths);
    const database = new Database(paths.databasePath);
    applyMigrations(
      database,
      await loadMigrationSet(migrationDirectory),
      () => '2026-08-08T00:00:00.000Z',
    );
    await createOnlineBackup({
      backupId: 'backup_reopenfail',
      clock: () => '2026-08-08T00:00:00.000Z',
      currentVersion: 1,
      database,
      paths,
    });
    database.close();
    await writeFile(paths.databasePath, 'corrupt live database');
    let rejectConnectionBaseline = false;
    const service = new StartupService(
      new SqlitePersistenceRuntimeAdapter({
        clock: () => '2026-08-08T00:01:00.000Z',
        managedRoot,
        migrationDirectory,
        sqliteConnectionOptions: {
          beforePragma: () => {
            if (rejectConnectionBaseline) throw new Error('injected reopen failure');
          },
        },
      }),
      SUCCESSFUL_SCHEMA_STARTUP,
    );
    const initialFault = await service.start();
    expect(initialFault.state).toBe('READ_ONLY_FAULT');
    rejectConnectionBaseline = true;

    const restoreFault = await service.restoreBackup({
      backupId: 'backup_reopenfail',
      expectedRevision: initialFault.revision,
      requestId: 'restore-request-0003',
    });

    expect(restoreFault).toMatchObject({
      currentPhase: 'RECOVERY_GATE',
      errorCode: 'DATABASE_RESTORE_FAILED',
      state: 'READ_ONLY_FAULT',
      writeEnabled: false,
    });
    expect(await readdir(paths.diagnosticDirectory, { recursive: true })).toEqual(
      expect.arrayContaining([expect.stringMatching(/original-live\.sqlite/u)]),
    );
    expect(await readdir(paths.backupDirectory)).toEqual(
      expect.arrayContaining(['backup_reopenfail.sqlite', 'backup_reopenfail.manifest.json']),
    );
    service.close();
  });
});
