import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listVerifiedBackups, performManagedMigration } from '../backup/backup-manager';
import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { createManagedDirectories, createManagedPaths } from '../runtime/managed-paths';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-16T00:00:00.000Z';
// design 0.2 锁定的 canonical capabilities_json 摘要（火山方舟官方 docs/82379/1541523）。
const SNAPSHOT_SHA256 = '801333f3ac43d6b3795b99d07875d0a492955048b21799a5aee3e197adfe3269';
// design A4 锁定的视频能力快照 canonical 摘要（火山方舟官方 docs/82379/1520757）。
const VIDEO_SNAPSHOT_SHA256 = '7aefec11df27ca2c232049f0870e6d40538de18c70edc147be2df750ac5bbee3';

const openMigratedDatabase = async (
  root: string,
  fileName: string,
  versions?: number,
): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, fileName));
  try {
    database.pragma('foreign_keys = ON');
    const migrations = await loadMigrationSet(MIGRATIONS);
    applyMigrations(
      database,
      versions === undefined ? migrations : migrations.slice(0, versions),
      () => NOW,
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

/** image_candidates / media_generation_tasks 外键链所需的最小镜头版本图。 */
const seedShotGraph = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'project_media',
      '媒体项目',
      'AI_ORIGINAL',
      'NARRATION_FIRST',
      'LOCAL_DEMO',
      'projects/project_media',
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, aspect_ratio, width, height, fps, language, subtitle_safe_area_json, is_current, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('format_media', 'project_media', 1, '9:16', 1440, 2560, 24, 'zh-CN', '{}', 1, NOW);
  database
    .prepare(
      'INSERT INTO episodes (id, project_id, title, target_duration_sec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('episode_media', 'project_media', '第一集', 90, NOW, NOW);
  database
    .prepare(
      'INSERT INTO shots (id, episode_id, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('shot_media', 'episode_media', 'ACTIVE', NOW, NOW);
  database
    .prepare(
      `INSERT INTO shot_contract_versions
       (id, shot_id, version_no, lineage_resolution_status, sequence, version_status, format_profile_id,
        target_duration_sec, dialogue_render_mode, document_json, document_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'shotv_media',
      'shot_media',
      1,
      'ROOT',
      1,
      'DRAFT',
      'format_media',
      8,
      'NARRATION_FIRST',
      '{}',
      'sha_shotv_media',
      NOW,
    );
};

const insertAsset = (
  database: SqliteTestDatabase,
  id: string,
  assetType = 'CHARACTER',
  bibleRefId = 'char_1',
): void => {
  database
    .prepare(
      `INSERT INTO assets (id, project_id, asset_type, bible_ref_id, display_name, created_at, updated_at)
       VALUES (?, 'project_media', ?, ?, ?, ?, ?)`,
    )
    .run(id, assetType, bibleRefId, '主角', NOW, NOW);
};

const insertAssetVersion = (
  database: SqliteTestDatabase,
  id: string,
  assetId: string,
  versionNo: number,
): void => {
  database
    .prepare(
      `INSERT INTO asset_versions
       (id, asset_id, version_no, provenance, file_sha256, byte_size, mime_type, created_at)
       VALUES (?, ?, ?, 'UPLOADED', ?, 2048, 'image/png', ?)`,
    )
    .run(id, assetId, versionNo, 'a'.repeat(64), NOW);
};

const insertCandidate = (
  database: SqliteTestDatabase,
  id: string,
  overrides: {
    readonly errorCode?: string | null;
    readonly fileSha256?: string | null;
    readonly indexInRound?: number;
    readonly invocationEvidenceRef?: string | null;
    readonly roundNo?: number;
    readonly selected?: boolean;
    readonly status?: string;
  } = {},
): void => {
  const status = overrides.status ?? 'SUCCEEDED';
  const fileSha256 =
    overrides.fileSha256 === undefined ? 'b'.repeat(64) : (overrides.fileSha256 ?? null);
  const evidence =
    overrides.invocationEvidenceRef === undefined
      ? 'invocation_media_1'
      : overrides.invocationEvidenceRef;
  database
    .prepare(
      `INSERT INTO image_candidates
       (id, project_id, shot_id, shot_version_id, round_no, index_in_round, generation_input_hash,
        status, file_sha256, byte_size, mime_type, width, height, storage_rel_path, model_id,
        invocation_evidence_ref, error_code, selected_at, selected_by_context, created_at, updated_at)
       VALUES (?, 'project_media', 'shot_media', 'shotv_media', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      overrides.roundNo ?? 1,
      overrides.indexInRound ?? 0,
      'c'.repeat(64),
      status,
      fileSha256,
      fileSha256 === null ? null : 1024,
      fileSha256 === null ? null : 'image/png',
      fileSha256 === null ? null : 64,
      fileSha256 === null ? null : 64,
      fileSha256 === null ? null : 'media/c0/c0c0.img',
      'doubao-seedream-5-0-lite-260128',
      evidence,
      overrides.errorCode ?? null,
      overrides.selected === true ? NOW : null,
      overrides.selected === true ? 'manual' : null,
      NOW,
      NOW,
    );
};

describe('0009_media_assets_images.sql', () => {
  it('空库—执行完整 migration—head 10 且五表/索引/trigger 登记', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'media_clean.sqlite');
      try {
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
          { version: 16 },
          { version: 17 },
        ]);
        const objects = database
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all() as unknown as readonly { readonly name: string; readonly type: string }[];
        const namesByType = (type: string) =>
          objects.filter((object) => object.type === type).map((object) => object.name);
        expect(namesByType('table')).toEqual(
          expect.arrayContaining([
            'assets',
            'asset_versions',
            'image_candidates',
            'media_generation_batches',
            'media_generation_tasks',
          ]),
        );
        expect(namesByType('index')).toEqual(
          expect.arrayContaining([
            'ix_asset_versions_asset',
            'ix_image_candidates_shot',
            'ix_image_candidates_generation',
            'ix_media_batches_project_status',
            'ix_media_tasks_batch',
            'ix_media_tasks_project_phase',
            'ux_image_candidate_selected',
          ]),
        );
        expect(namesByType('trigger')).toContain('trg_asset_versions_immutable');
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('能力快照种子—sha256 复算一致且 model id 与 0.2 锁定值吻合（无伪造）', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'media_snapshot.sqlite');
      try {
        const row = database
          .prepare(
            `SELECT id, provider_profile_id, snapshot_version, valid_from, expires_at,
                    capabilities_json, source_url, sha256
             FROM provider_capability_snapshots WHERE id = 'volcark-seedream-image/v1'`,
          )
          .get() as {
          capabilities_json: string;
          expires_at: string;
          id: string;
          provider_profile_id: string;
          sha256: string;
          snapshot_version: string;
          source_url: string;
          valid_from: string;
        };
        expect(row).toBeDefined();
        expect(row.provider_profile_id).toBe('profile_image_primary');
        expect(row.snapshot_version).toBe('1');
        expect(row.valid_from).toBe('2026-08-16');
        // 落库字节与登记摘要逐字节一致，且等于 design 0.2 锁定的 canonical 摘要。
        expect(createHash('sha256').update(row.capabilities_json, 'utf8').digest('hex')).toBe(
          row.sha256,
        );
        expect(row.sha256).toBe(SNAPSHOT_SHA256);
        expect(row.source_url).toBe('https://www.volcengine.com/docs/82379/1541523');
        const capabilities = JSON.parse(row.capabilities_json) as {
          readonly model_id: string;
          readonly model_id_alternates: readonly string[];
          readonly semantics: { readonly mode: string };
        };
        expect(capabilities.model_id).toBe('doubao-seedream-5-0-lite-260128');
        expect(capabilities.model_id_alternates).toEqual([
          'doubao-seedream-5-0-260128',
          'doubao-seedream-4-5-251128',
          'doubao-seedream-4-0-250828',
        ]);
        expect(capabilities.semantics.mode).toBe('SYNCHRONOUS');
      } finally {
        database.close();
      }
    });
  });

  it('v8 库—升级到 head 14—既有资产图保留且新表可写', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'media_upgrade.sqlite', 8);
      try {
        seedShotGraph(database);
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        expect(
          database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
        ).toEqual({ version: 17 });
        // v8 既有行在升级后原样保留。
        expect(
          database.prepare("SELECT id, lifecycle_status FROM shots WHERE id = 'shot_media'").get(),
        ).toEqual({ id: 'shot_media', lifecycle_status: 'ACTIVE' });
        insertAsset(database, 'asset_upgrade');
        insertAssetVersion(database, 'assetv_upgrade', 'asset_upgrade', 1);
        insertCandidate(database, 'candidate_upgrade');
        // 0010 新表可写：批次行落库 + 既有任务行 batch_id 保持 NULL 语义。
        database
          .prepare(
            `INSERT INTO media_generation_batches
             (id, project_id, idempotency_key, status, target_shot_ids_json,
              pending_shot_ids_json, skipped_shot_ids_json, created_at, updated_at)
             VALUES ('batch_upgrade', 'project_media', 'image-batch_u1', 'RUNNING',
                     '["shot_media"]', '["shot_media"]', '[]', ?, ?)`,
          )
          .run(NOW, NOW);
        expect(database.prepare('SELECT batch_id FROM media_generation_tasks').all()).toEqual([]);
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('v8 受管理库—performManagedMigration 升级—先备份 schema v8 再到 head 14', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const migrations = await loadMigrationSet(MIGRATIONS);
      const paths = createManagedPaths(path.join(root, 'managed'));
      await createManagedDirectories(paths);
      const database = new SqliteTestDatabase(paths.databasePath);
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, migrations.slice(0, 8), () => NOW);
        seedShotGraph(database);

        const result = await performManagedMigration({
          backupId: 'backup_media_0009',
          clock: () => NOW,
          database,
          migrations,
          paths,
        });
        expect(result.backup).toMatchObject({ schemaVersion: 8 });
        expect(await listVerifiedBackups(paths)).toEqual([
          expect.objectContaining({ backupId: 'backup_media_0009', schemaVersion: 8 }),
        ]);
        expect(
          database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
        ).toEqual({ version: 17 });
      } finally {
        database.close();
      }
    });
  });

  it('资产与版本—重复业务键或原地改写—由唯一/不可变约束拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'media_constraints_asset.sqlite');
      try {
        seedShotGraph(database);
        insertAsset(database, 'asset_a');
        expect(() => {
          insertAsset(database, 'asset_dup');
        }).toThrow(); // UNIQUE(project,type,ref)
        insertAsset(database, 'asset_b', 'SCENE', 'scene_1');
        expect(() => {
          insertAsset(database, 'asset_c', 'SCENE', 'scene_1');
        }).toThrow();
        insertAssetVersion(database, 'assetv_1', 'asset_a', 1);
        expect(() => {
          insertAssetVersion(database, 'assetv_2', 'asset_a', 1);
        }).toThrow(); // UNIQUE(asset,version)
        expect(() =>
          database
            .prepare("UPDATE asset_versions SET byte_size = 4096 WHERE id = 'assetv_1'")
            .run(),
        ).toThrow('IMMUTABLE_VERSION_ROW');
      } finally {
        database.close();
      }
    });
  });

  it('候选行—非法状态形态或重复世代位—由 CHECK/唯一约束拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'media_constraints_candidate.sqlite');
      try {
        seedShotGraph(database);
        // SUCCEEDED 必须携带完整文件四元组。
        expect(() => {
          insertCandidate(database, 'candidate_bad_success', { fileSha256: null });
        }).toThrow();
        // error_code 只允许出现在 FAILED。
        expect(() => {
          insertCandidate(database, 'candidate_bad_code', { errorCode: 'MODEL_TIMEOUT' });
        }).toThrow();
        // 终态候选必须携带调用证据引用。
        expect(() => {
          insertCandidate(database, 'candidate_bad_evidence', { invocationEvidenceRef: null });
        }).toThrow();
        // FAILED 合法形态：error_code + 证据 + 无文件。
        insertCandidate(database, 'candidate_failed', {
          errorCode: 'MODEL_CONTENT_REJECTED',
          fileSha256: null,
          status: 'FAILED',
        });
        // PENDING 合法形态：无文件、无错误码（submit 前预落库）。
        insertCandidate(database, 'candidate_pending', {
          fileSha256: null,
          indexInRound: 1,
          invocationEvidenceRef: null,
          status: 'PENDING',
        });
        // 世代位唯一。
        expect(() => {
          insertCandidate(database, 'candidate_dup_slot');
        }).toThrow();
        // 每镜头至多一个当前选择；切换 = 清旧再设新（2.3 事务语义）。
        insertCandidate(database, 'candidate_selected_2', { indexInRound: 2, selected: true });
        expect(() => {
          insertCandidate(database, 'candidate_selected_3', {
            indexInRound: 3,
            selected: true,
          });
        }).toThrow();
        database
          .prepare(
            "UPDATE image_candidates SET selected_at = NULL, selected_by_context = NULL WHERE id = 'candidate_selected_2'",
          )
          .run();
        insertCandidate(database, 'candidate_selected_3', { indexInRound: 3, selected: true });
        expect(
          database
            .prepare(
              "SELECT id FROM image_candidates WHERE shot_id = 'shot_media' AND selected_at IS NOT NULL",
            )
            .all(),
        ).toEqual([{ id: 'candidate_selected_3' }]);
      } finally {
        database.close();
      }
    });
  });

  it('媒体任务—非法 phase/幂等键重复/越界候选数—由约束拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'media_constraints_task.sqlite');
      try {
        seedShotGraph(database);
        let roundCounter = 0;
        const insertTask = (
          id: string,
          phase: string,
          candidateCount: number,
          key: string,
        ): void => {
          roundCounter += 1;
          database
            .prepare(
              `INSERT INTO media_generation_tasks
               (id, project_id, shot_id, shot_version_id, idempotency_key, phase,
                generation_input_hash, candidate_count, round_no, created_at, updated_at)
               VALUES (?, 'project_media', 'shot_media', 'shotv_media', ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(id, key, phase, 'd'.repeat(64), candidateCount, roundCounter, NOW, NOW);
        };
        insertTask('task_1', 'SUBMITTED', 4, 'idem_media_1');
        expect(() => {
          insertTask('task_bad_phase', 'RUNNING', 4, 'idem_media_2');
        }).toThrow();
        expect(() => {
          insertTask('task_bad_count', 'POLLING', 0, 'idem_media_3');
        }).toThrow();
        expect(() => {
          insertTask('task_dup_key', 'POLLING', 4, 'idem_media_1');
        }).toThrow();
        insertTask('task_2', 'COMPLETED', 4, 'idem_media_2');
        // 任务↔轮一一对应：同镜头重复 round_no 被 UNIQUE 拒绝；round_no ≤ 0 被 CHECK 拒绝。
        const insertTaskRound = (id: string, key: string, roundNo: number): void => {
          database
            .prepare(
              `INSERT INTO media_generation_tasks
               (id, project_id, shot_id, shot_version_id, idempotency_key, phase,
                generation_input_hash, candidate_count, round_no, created_at, updated_at)
               VALUES (?, 'project_media', 'shot_media', 'shotv_media', ?, 'POLLING', ?, 4, ?, ?, ?)`,
            )
            .run(id, key, 'd'.repeat(64), roundNo, NOW, NOW);
        };
        expect(() => {
          insertTaskRound('task_dup_round', 'idem_media_4', 5);
        }).toThrow();
        expect(() => {
          insertTaskRound('task_zero_round', 'idem_media_5', 0);
        }).toThrow();
      } finally {
        database.close();
      }
    });
  });
});

describe('0012_shot_video_generation.sql', () => {
  const seedFirstFrame = (database: SqliteTestDatabase): void => {
    seedShotGraph(database);
    insertCandidate(database, 'candidate_first_frame', { selected: true });
  };

  const insertVideoCandidate = (
    database: SqliteTestDatabase,
    id: string,
    overrides: {
      readonly actualDurationSec?: number | null;
      readonly errorCode?: string | null;
      readonly fileSha256?: string | null;
      readonly firstFrameCandidateId?: string;
      readonly firstFrameFileSha256?: string;
      readonly indexInRound?: number;
      readonly invocationEvidenceRef?: string | null;
      readonly mimeType?: string | null;
      readonly roundNo?: number;
      readonly selected?: boolean;
      readonly status?: string;
    } = {},
  ): void => {
    const status = overrides.status ?? 'SUCCEEDED';
    const fileSha256 =
      overrides.fileSha256 === undefined ? 'e'.repeat(64) : (overrides.fileSha256 ?? null);
    const mimeType =
      overrides.mimeType === undefined
        ? fileSha256 === null
          ? null
          : 'video/mp4'
        : overrides.mimeType;
    const actualDurationSec =
      overrides.actualDurationSec === undefined
        ? status === 'SUCCEEDED'
          ? 5
          : null
        : overrides.actualDurationSec;
    database
      .prepare(
        `INSERT INTO video_candidates
         (id, project_id, shot_id, shot_version_id, round_no, index_in_round, generation_input_hash,
          status, file_sha256, byte_size, mime_type, width, height, storage_rel_path, model_id,
          provider_task_id, invocation_evidence_ref, requested_duration_sec, actual_duration_sec,
          first_frame_candidate_id, first_frame_file_sha256, error_code, selected_at,
          selected_by_context, created_at, updated_at)
         VALUES (?, 'project_media', 'shot_media', 'shotv_media', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        overrides.roundNo ?? 1,
        overrides.indexInRound ?? 0,
        'a'.repeat(64),
        status,
        fileSha256,
        fileSha256 === null ? null : 1868,
        mimeType,
        fileSha256 === null ? null : 48,
        fileSha256 === null ? null : 48,
        fileSha256 === null ? null : 'videos/e1/e1e1.mp4',
        'doubao-seedance-1-0-lite-i2v-250428',
        null,
        overrides.invocationEvidenceRef === undefined
          ? 'invocation_video_1'
          : overrides.invocationEvidenceRef,
        5,
        actualDurationSec,
        overrides.firstFrameCandidateId ?? 'candidate_first_frame',
        overrides.firstFrameFileSha256 ?? 'b'.repeat(64),
        overrides.errorCode ?? null,
        overrides.selected === true ? NOW : null,
        overrides.selected === true ? 'manual' : null,
        NOW,
        NOW,
      );
  };

  it('0013—统一调用证据允许同域视频 task/candidate，拒绝跨域或悬空引用', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_invocation_guard.sqlite');
      try {
        seedFirstFrame(database);
        database
          .prepare(
            `INSERT INTO video_generation_tasks
             (id, project_id, shot_id, shot_version_id, idempotency_key, phase,
              generation_input_hash, candidate_count, round_no, created_at, updated_at)
             VALUES ('video_task_guard', 'project_media', 'shot_media', 'shotv_media',
                     'video-task_guard', 'SUBMITTED', ?, 2, 1, ?, ?)`,
          )
          .run('c'.repeat(64), NOW, NOW);
        insertVideoCandidate(database, 'video_candidate_guard', {
          fileSha256: null,
          invocationEvidenceRef: null,
          status: 'PENDING',
        });
        const insertEvidence = database.prepare(
          `INSERT INTO media_model_invocations
           (id, media_task_id, candidate_id, segment_kind, status, model_id,
            request_snapshot_json, request_sha256, created_at, updated_at)
           VALUES (?, ?, ?, 'SUBMIT', 'STARTED', 'seedance', '{}', ?, ?, ?)`,
        );
        expect(() =>
          insertEvidence.run(
            'invocation_video_guard',
            'video_task_guard',
            'video_candidate_guard',
            'd'.repeat(64),
            NOW,
            NOW,
          ),
        ).not.toThrow();
        expect(() =>
          insertEvidence.run(
            'invocation_cross_guard',
            'video_task_guard',
            'candidate_first_frame',
            'e'.repeat(64),
            NOW,
            NOW,
          ),
        ).toThrow('MEDIA_INVOCATION_REFERENCE_INVALID');
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('0014—首帧改选后 STALE 视频保留已回报真实时长与选择历史', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_stale_duration.sqlite');
      try {
        seedFirstFrame(database);
        insertVideoCandidate(database, 'video_stale_duration', { selected: true });
        expect(() =>
          database
            .prepare(
              `UPDATE video_candidates
               SET status = 'STALE_INPUT', error_code = NULL, updated_at = ?
               WHERE id = 'video_stale_duration'`,
            )
            .run(NOW),
        ).not.toThrow();
        expect(
          database
            .prepare(
              `SELECT status, actual_duration_sec, selected_at
               FROM video_candidates WHERE id = 'video_stale_duration'`,
            )
            .get(),
        ).toMatchObject({ actual_duration_sec: 5, status: 'STALE_INPUT', selected_at: NOW });
      } finally {
        database.close();
      }
    });
  });

  it('空库—执行完整 migration—三视频表/索引登记且外键链可写', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_clean.sqlite');
      try {
        const objects = database
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all() as unknown as readonly { readonly name: string; readonly type: string }[];
        const namesByType = (type: string) =>
          objects.filter((object) => object.type === type).map((object) => object.name);
        expect(namesByType('table')).toEqual(
          expect.arrayContaining(['video_batches', 'video_generation_tasks', 'video_candidates']),
        );
        expect(namesByType('index')).toEqual(
          expect.arrayContaining([
            'ix_video_batches_project_status',
            'ix_video_candidates_generation',
            'ix_video_candidates_shot',
            'ix_video_tasks_batch',
            'ix_video_tasks_project_phase',
            'ux_video_candidate_selected',
          ]),
        );
        // 平行三表最小闭环：批次→任务(batch_id)→候选(first_frame 指向 image_candidates)。
        seedFirstFrame(database);
        database
          .prepare(
            `INSERT INTO video_batches
             (id, project_id, idempotency_key, status, target_shot_ids_json,
              pending_shot_ids_json, skipped_shot_ids_json, created_at, updated_at)
             VALUES ('video_batch_1', 'project_media', 'video-batch_i1', 'RUNNING',
                     '["shot_media"]', '["shot_media"]', '[]', ?, ?)`,
          )
          .run(NOW, NOW);
        database
          .prepare(
            `INSERT INTO video_generation_tasks
             (id, project_id, shot_id, shot_version_id, idempotency_key, phase,
              generation_input_hash, candidate_count, round_no, batch_id, created_at, updated_at)
             VALUES ('video_task_1', 'project_media', 'shot_media', 'shotv_media', 'video-task_i1',
                     'POLLING', ?, 2, 1, 'video_batch_1', ?, ?)`,
          )
          .run('c'.repeat(64), NOW, NOW);
        insertVideoCandidate(database, 'video_candidate_1', { selected: true });
        expect(
          database
            .prepare(
              `SELECT candidate.id, task.batch_id, first.id AS first_frame_id
               FROM video_candidates candidate
               JOIN video_generation_tasks task ON task.shot_id = candidate.shot_id
               JOIN image_candidates first ON first.id = candidate.first_frame_candidate_id`,
            )
            .all(),
        ).toEqual([
          {
            batch_id: 'video_batch_1',
            first_frame_id: 'candidate_first_frame',
            id: 'video_candidate_1',
          },
        ]);
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('视频能力快照种子—sha256 复算一致且 ASYNC/i2v 事实与 design A4 锁定值吻合', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_snapshot.sqlite');
      try {
        const row = database
          .prepare(
            `SELECT id, provider_profile_id, snapshot_version, valid_from, capabilities_json,
                    source_url, sha256
             FROM provider_capability_snapshots WHERE id = 'volcark-seedance-video/v1'`,
          )
          .get() as {
          capabilities_json: string;
          id: string;
          provider_profile_id: string;
          sha256: string;
          snapshot_version: string;
          source_url: string;
          valid_from: string;
        };
        expect(row).toBeDefined();
        expect(row.provider_profile_id).toBe('profile_video_primary');
        expect(row.snapshot_version).toBe('1');
        expect(row.valid_from).toBe('2026-08-20');
        expect(createHash('sha256').update(row.capabilities_json, 'utf8').digest('hex')).toBe(
          row.sha256,
        );
        expect(row.sha256).toBe(VIDEO_SNAPSHOT_SHA256);
        expect(row.source_url).toBe('https://www.volcengine.com/docs/82379/1520757');
        const capabilities = JSON.parse(row.capabilities_json) as {
          readonly model_id: string;
          readonly request: {
            readonly duration_range: readonly number[];
            readonly resolution: { readonly tiers: readonly string[] };
          };
          readonly semantics: { readonly mode: string };
        };
        expect(capabilities.model_id).toBe('doubao-seedance-1-0-lite-i2v-250428');
        expect(capabilities.semantics.mode).toBe('ASYNCHRONOUS');
        expect(capabilities.request.duration_range).toEqual([5, 10]);
        expect(capabilities.request.resolution.tiers).toEqual(['720p', '1080p']);
      } finally {
        database.close();
      }
    });
  });

  it('视频候选—非法 mime/时长口径/首帧成对/世代位—由 CHECK/唯一约束拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_constraints_candidate.sqlite');
      try {
        seedFirstFrame(database);
        // mime 白名单仅 video/mp4。
        expect(() => {
          insertVideoCandidate(database, 'video_bad_mime', { mimeType: 'video/quicktime' });
        }).toThrow();
        // 请求档位必须为正整数（Seedance 档位 5/10 由应用层映射）。
        expect(() => {
          database
            .prepare(
              `INSERT INTO video_candidates
               (id, project_id, shot_id, shot_version_id, round_no, index_in_round,
                generation_input_hash, status, invocation_evidence_ref, requested_duration_sec,
                first_frame_candidate_id, first_frame_file_sha256, created_at, updated_at)
               VALUES ('video_bad_duration', 'project_media', 'shot_media', 'shotv_media', 1, 0,
                       ?, 'PENDING', NULL, 0, 'candidate_first_frame', ?, ?, ?)`,
            )
            .run('a'.repeat(64), 'b'.repeat(64), NOW, NOW);
        }).toThrow();
        // 实际时长只允许出现在 SUCCEEDED 行且必须为正。
        expect(() => {
          insertVideoCandidate(database, 'video_actual_pending', {
            actualDurationSec: 5,
            fileSha256: null,
            status: 'PENDING',
          });
        }).toThrow();
        expect(() => {
          insertVideoCandidate(database, 'video_actual_zero', { actualDurationSec: 0 });
        }).toThrow();
        // 首帧 sha 必须为 64 位十六进制（length CHECK）。
        expect(() => {
          insertVideoCandidate(database, 'video_bad_frame_sha', {
            firstFrameFileSha256: 'b'.repeat(63),
          });
        }).toThrow();
        // 首帧必须指向真实 image_candidates 行（外键）。
        expect(() => {
          insertVideoCandidate(database, 'video_missing_frame', {
            firstFrameCandidateId: 'missing_first_frame',
          });
        }).toThrow();
        // SUCCEEDED 必须携带完整文件四元组与调用证据。
        expect(() => {
          insertVideoCandidate(database, 'video_bad_success', { fileSha256: null });
        }).toThrow();
        expect(() => {
          insertVideoCandidate(database, 'video_bad_evidence', {
            invocationEvidenceRef: null,
          });
        }).toThrow();
        // 合法形态：PENDING（预落库）/ FAILED（证据+错误码，无文件）。
        insertVideoCandidate(database, 'video_pending', {
          fileSha256: null,
          indexInRound: 1,
          invocationEvidenceRef: null,
          status: 'PENDING',
        });
        insertVideoCandidate(database, 'video_failed', {
          errorCode: 'MODEL_TIMEOUT',
          fileSha256: null,
          indexInRound: 2,
          status: 'FAILED',
        });
        // 世代位唯一（与 video_failed 同轮同位）。
        expect(() => {
          insertVideoCandidate(database, 'video_dup_slot', { indexInRound: 2 });
        }).toThrow();
        // 每镜头至多一个当前选择；改选 = 清旧指针再设新（服务层事务语义）。
        insertVideoCandidate(database, 'video_selected_2', { indexInRound: 3, selected: true });
        expect(() => {
          insertVideoCandidate(database, 'video_selected_3', {
            indexInRound: 4,
            selected: true,
          });
        }).toThrow();
        database
          .prepare(
            "UPDATE video_candidates SET selected_at = NULL, selected_by_context = NULL WHERE id = 'video_selected_2'",
          )
          .run();
        insertVideoCandidate(database, 'video_selected_3', { indexInRound: 4, selected: true });
        expect(
          database
            .prepare(
              "SELECT id FROM video_candidates WHERE shot_id = 'shot_media' AND selected_at IS NOT NULL",
            )
            .all(),
        ).toEqual([{ id: 'video_selected_3' }]);
      } finally {
        database.close();
      }
    });
  });

  it('视频任务与批次—非法 phase/幂等键/轮次/批次错误码—由约束拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_constraints_task.sqlite');
      try {
        seedFirstFrame(database);
        const insertVideoTask = (
          id: string,
          phase: string,
          candidateCount: number,
          key: string,
          roundNo: number,
        ): void => {
          database
            .prepare(
              `INSERT INTO video_generation_tasks
               (id, project_id, shot_id, shot_version_id, idempotency_key, phase,
                generation_input_hash, candidate_count, round_no, created_at, updated_at)
               VALUES (?, 'project_media', 'shot_media', 'shotv_media', ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(id, key, phase, 'd'.repeat(64), candidateCount, roundNo, NOW, NOW);
        };
        insertVideoTask('video_task_ok', 'SUBMITTED', 2, 'video-idem_1', 1);
        expect(() => {
          insertVideoTask('video_task_bad_phase', 'RUNNING', 2, 'video-idem_2', 2);
        }).toThrow();
        expect(() => {
          insertVideoTask('video_task_zero_count', 'POLLING', 0, 'video-idem_3', 3);
        }).toThrow();
        expect(() => {
          insertVideoTask('video_task_dup_key', 'POLLING', 2, 'video-idem_1', 4);
        }).toThrow();
        expect(() => {
          insertVideoTask('video_task_dup_round', 'POLLING', 2, 'video-idem_4', 1);
        }).toThrow();
        // 批次：error_code 只允许出现在非 COMPLETED 收尾（中止场景）。
        database
          .prepare(
            `INSERT INTO video_batches
             (id, project_id, idempotency_key, status, target_shot_ids_json,
              pending_shot_ids_json, skipped_shot_ids_json, created_at, updated_at)
             VALUES ('video_batch_ok', 'project_media', 'video-batch_i1', 'RUNNING',
                     '["shot_media"]', '["shot_media"]', '[]', ?, ?)`,
          )
          .run(NOW, NOW);
        expect(() => {
          database
            .prepare(
              `INSERT INTO video_batches
               (id, project_id, idempotency_key, status, target_shot_ids_json,
                pending_shot_ids_json, skipped_shot_ids_json, error_code, created_at, updated_at)
               VALUES ('video_batch_bad', 'project_media', 'video-batch_i2', 'COMPLETED',
                       '["shot_media"]', '["shot_media"]', '[]', 'MEDIA_SHOT_GRAPH_INVALID', ?, ?)`,
            )
            .run(NOW, NOW);
        }).toThrow();
        expect(() => {
          database
            .prepare(
              `INSERT INTO video_batches
               (id, project_id, idempotency_key, status, target_shot_ids_json,
                pending_shot_ids_json, skipped_shot_ids_json, created_at, updated_at)
               VALUES ('video_batch_dup', 'project_media', 'video-batch_i1', 'RUNNING',
                       '["shot_media"]', '["shot_media"]', '[]', ?, ?)`,
            )
            .run(NOW, NOW);
        }).toThrow(); // UNIQUE(project_id, idempotency_key)
        // 批次成员外键：batch_id 必须指向真实 video_batches 行。
        expect(() => {
          database
            .prepare(
              `INSERT INTO video_generation_tasks
               (id, project_id, shot_id, shot_version_id, idempotency_key, phase,
                generation_input_hash, candidate_count, round_no, batch_id, created_at, updated_at)
               VALUES ('video_task_bad_batch', 'project_media', 'shot_media', 'shotv_media',
                       'video-idem_5', 'POLLING', ?, 2, 5, 'missing_batch', ?, ?)`,
            )
            .run('d'.repeat(64), NOW, NOW);
        }).toThrow();
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });
});
