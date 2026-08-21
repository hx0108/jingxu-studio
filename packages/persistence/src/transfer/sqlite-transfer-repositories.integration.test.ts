import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TransferExportRecord, TransferImportRecord } from '@jingxu/application';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteTransferRecordRepository } from './sqlite-transfer-record-repository';
import { SqliteTransferUnitOfWork } from './sqlite-transfer-unit-of-work';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-21T00:00:00.000Z';
const LOWERCASE_HEX64 = 'a'.repeat(64);

const openMigratedDatabase = async (root: string): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, 'transfer-records.sqlite'));
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
  operation: (database: SqliteTestDatabase, root: string) => T | Promise<T>,
): Promise<T> =>
  withSqliteTestContext(async (context) => {
    const database = await openMigratedDatabase(context.root);
    try {
      return await operation(database, context.root);
    } finally {
      database.close();
    }
  });

/** export_records 外键链：project → episode/bible/format → episode_version。 */
const insertExportForeignKeyChain = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel,
        created_at, updated_at)
       VALUES ('project_1', '雾都来信', 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO',
               'projects/project_1', ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO episodes (id, project_id, title, target_duration_sec, created_at, updated_at)
       VALUES ('episode_1', 'project_1', '第 1 集', 60, ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO story_bible_versions
       (id, project_id, version_no, document_json, document_sha256, status, source, created_at)
       VALUES ('sbv_1', 'project_1', 1, '{}', ?, 'READY', 'AI', ?)`,
    )
    .run(LOWERCASE_HEX64, NOW);
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, aspect_ratio, width, height, fps, language,
        subtitle_safe_area_json, is_current, created_at)
       VALUES ('format_1', 'project_1', 1, '9:16', 1080, 1920, 30, 'zh-CN',
               '{"top":5,"right":5,"bottom":12,"left":5}', 1, ?)`,
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO episode_versions
       (id, episode_id, version_no, story_bible_version_id, format_profile_id,
        target_duration_sec, shot_set_hash, status, created_at)
       VALUES ('ev_1', 'episode_1', 1, 'sbv_1', 'format_1', 60, ?, 'READY', ?)`,
    )
    .run(LOWERCASE_HEX64, NOW);
};

const exportRecord = (overrides: Partial<TransferExportRecord> = {}): TransferExportRecord => ({
  byteSize: 4096,
  createdAt: NOW,
  errorCode: null,
  episodeId: 'episode_1',
  episodeVersionId: 'ev_1',
  finishedAt: NOW,
  id: 'export_1',
  overwritePolicy: 'REJECT',
  payloadSha256: LOWERCASE_HEX64,
  projectId: 'project_1',
  requestId: 'req_export_1',
  resultSummary: { inputFingerprint: 'fingerprint-1', warningCodes: ['TRANSFER_CURRENT_ONLY'] },
  status: 'SUCCEEDED',
  targetRef: 'opaque-target-ref',
  ...overrides,
});

const importRecord = (overrides: Partial<TransferImportRecord> = {}): TransferImportRecord => ({
  createdAt: NOW,
  finishedAt: NOW,
  id: 'import_1',
  idMapping: null,
  importMode: 'NEW_PROJECT',
  projectId: null,
  requestId: 'req_import_1',
  resultSummary: null,
  sourceRef: 'opaque-source-ref',
  sourceSha256: LOWERCASE_HEX64,
  status: 'FAILED',
  validationErrors: ['TRANSFER_BUNDLE_INVALID'],
  ...overrides,
});

describe('SqliteTransferRecordRepository + 0016（project-transfer-import-export 3.1）', () => {
  it('0016 迁移—request_id/result_json 列与部分唯一索引就位', async () => {
    await withMigratedDatabase((database) => {
      const exportColumns = database
        .prepare('PRAGMA table_info(export_records)')
        .all() as unknown as readonly { readonly name: string }[];
      const importColumns = database
        .prepare('PRAGMA table_info(import_records)')
        .all() as unknown as readonly { readonly name: string }[];
      expect(exportColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['request_id', 'result_json']),
      );
      expect(importColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['request_id', 'result_json']),
      );
      const indexes = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?)")
        .all(
          'ux_export_records_request_id',
          'ux_import_records_request_id',
        ) as unknown as readonly { readonly name: string }[];
      expect(indexes.map(({ name }) => name).sort()).toEqual([
        'ux_export_records_request_id',
        'ux_import_records_request_id',
      ]);
    });
  });

  it('export SUCCEEDED 写入与 requestId 回读—resultSummary 完整往返—FAILED 不参与回放', async () => {
    await withMigratedDatabase(async (database) => {
      insertExportForeignKeyChain(database);
      const repository = new SqliteTransferRecordRepository(database);
      await repository.insertExport(exportRecord());
      const replayed = await repository.findExportByRequestId('req_export_1');
      expect(replayed).not.toBeNull();
      expect(replayed?.id).toBe('export_1');
      expect(replayed?.resultSummary).toEqual({
        inputFingerprint: 'fingerprint-1',
        warningCodes: ['TRANSFER_CURRENT_ONLY'],
      });
      expect(replayed?.targetRef).toBe('opaque-target-ref');
      // 非 SUCCEEDED 行不是幂等事实源，find 不得返回。
      await repository.insertExport(
        exportRecord({
          id: 'export_2',
          requestId: 'req_export_failed',
          resultSummary: null,
          status: 'FAILED',
          errorCode: 'TRANSFER_FILE_WRITE_FAILED',
          finishedAt: null,
        }),
      );
      expect(await repository.findExportByRequestId('req_export_failed')).toBeNull();
    });
  });

  it('同 requestId 二次 SUCCEEDED 写入—部分唯一索引拒绝—并发双写兜底', async () => {
    await withMigratedDatabase(async (database) => {
      insertExportForeignKeyChain(database);
      const repository = new SqliteTransferRecordRepository(database);
      await repository.insertExport(exportRecord());
      await expect(repository.insertExport(exportRecord({ id: 'export_dup' }))).rejects.toThrow();
      // FAILED 行不受 SUCCEEDED 唯一约束影响（导入失败可重复留证）。
      await expect(
        repository.insertImport(importRecord({ id: 'import_failed_a' })),
      ).resolves.toBeUndefined();
      await expect(
        repository.insertImport(importRecord({ id: 'import_failed_b' })),
      ).resolves.toBeUndefined();
      const latest = await repository.findImportByRequestId('req_import_1');
      expect(latest?.id).toBe('import_failed_b');
      expect(latest?.validationErrors).toEqual(['TRANSFER_BUNDLE_INVALID']);
    });
  });

  it('import SUCCEEDED 往返—idMapping/resultSummary 落库回读', async () => {
    await withMigratedDatabase(async (database) => {
      insertExportForeignKeyChain(database);
      const repository = new SqliteTransferRecordRepository(database);
      await repository.insertImport(
        importRecord({
          id: 'import_ok',
          idMapping: { project_src: 'project_1', shot_src: 'shot_9' },
          projectId: 'project_1',
          requestId: 'req_import_ok',
          resultSummary: {
            createdObjectCount: 12,
            importId: 'import_ok',
            projectId: 'project_1',
            sourceProjectId: 'project_src',
            warningCodes: ['TRANSFER_CURRENT_ONLY'],
          },
          status: 'SUCCEEDED',
          validationErrors: [],
        }),
      );
      const replayed = await repository.findImportByRequestId('req_import_ok');
      expect(replayed?.status).toBe('SUCCEEDED');
      expect(replayed?.idMapping).toEqual({ project_src: 'project_1', shot_src: 'shot_9' });
      expect(replayed?.resultSummary?.createdObjectCount).toBe(12);
      expect(replayed?.resultSummary?.warningCodes).toEqual(['TRANSFER_CURRENT_ONLY']);
    });
  });

  it('TransferUnitOfWork—聚合 Script 仓储与 Transfer 投影—中途抛出全量回滚零残留', async () => {
    await withMigratedDatabase(async (database) => {
      const unitOfWork = new SqliteTransferUnitOfWork(database);
      await expect(
        unitOfWork.run(async (repositories) => {
          await repositories.transfer.insertImport(importRecord({ id: 'import_rollback' }));
          // 同一事务内可见（读己之写）。
          expect(await repositories.transfer.findImportByRequestId('req_import_1')).not.toBeNull();
          // 聚合暴露导入写入器所需的投影。
          expect(repositories.projects).not.toBeNull();
          expect(repositories.formatProfiles).not.toBeNull();
          expect(repositories.stageHeads).not.toBeNull();
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      // 回滚后零残留：import_records 无该 requestId 行。
      const repository = new SqliteTransferRecordRepository(database);
      expect(await repository.findImportByRequestId('req_import_1')).toBeNull();
      expect(database.prepare('SELECT COUNT(*) AS total FROM import_records').get()).toEqual({
        total: 0,
      });
    });
  });
});
