import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteVideoProviderPreferences } from './sqlite-video-provider-preferences';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-09-19T00:00:00.000Z';
const SEED_UPDATED_AT = '2026-09-19T00:00:00.000Z';
// 0024 播种的 canonical capabilities_json 摘要（生成时 sha256 复算冻结）。
const WAN_SNAPSHOT_SHA256 = '299d0f2128078364d86f27122e553cd77824ce6c5a7604b9bb2cf5d0a4230d5c';
const AGNES_SNAPSHOT_SHA256 = '1535fad9497b21cb8f85f1cffeacc73ec7837bc05a247188e5314b87c017331e';
const SEEDANCE_V3_SNAPSHOT_SHA256 =
  '7386d17634368908cae4a2672f9b54f0e510cd4e0288a8e8a373420162a8b03a';

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

const preferenceRow = (database: SqliteTestDatabase) =>
  database
    .prepare('SELECT id, mode, provider_profile_id, updated_at FROM video_provider_preferences')
    .get() as
    { id: number; mode: string; provider_profile_id: string; updated_at: string } | undefined;

/** 偏好/任务/候选外键链所需的最小镜头版本图（同 media-migration 矩阵的最小闭环）。 */
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

/** Seedance 2.0/2.5 两形态既有 Profile（0023/0024 不得改写历史行）。 */
const seedProviderProfiles = (database: SqliteTestDatabase): void => {
  const CONFIG_JSON = JSON.stringify({
    credentialLast4: '7777',
    dataProcessingHints: [],
    lastValidatedAt: '2026-08-11T00:00:00Z',
  });
  const insert = database.prepare(
    `INSERT INTO provider_profiles
     (base_url, config_json, credential_ref, enabled, id, model_id, model_snapshot_date,
      provider, region, workspace_id)
     VALUES (?, ?, ?, 1, ?, ?, ?, 'VOLCARK_SEEDANCE', 'cn-beijing', 'ark')`,
  );
  insert.run(
    'https://ark.cn-beijing.volces.com/api/v3',
    CONFIG_JSON,
    'opaque-video-ref',
    'profile-video-primary',
    'doubao-seedance-2-0-260128',
    '2026-01-28',
  );
  insert.run(
    'https://ark.cn-beijing.volces.com/api/v3',
    CONFIG_JSON,
    'opaque-video-25-ref',
    'provider_seedance_25',
    'doubao-seedance-2-5-260628',
    '2026-06-28',
  );
};

/** 视频候选的首帧锚点（image_candidates 选中行）。 */
const seedFirstFrame = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO image_candidates
       (id, project_id, shot_id, shot_version_id, round_no, index_in_round, generation_input_hash,
        status, file_sha256, byte_size, mime_type, width, height, storage_rel_path, model_id,
        invocation_evidence_ref, error_code, selected_at, selected_by_context, created_at, updated_at)
       VALUES ('candidate_first_frame', 'project_media', 'shot_media', 'shotv_media', 1, 0, ?,
               'SUCCEEDED', ?, 1024, 'image/png', 64, 64, 'media/c0/c0c0.img',
               'doubao-seedream-5-0-lite-260128', 'invocation_media_1', NULL, ?, 'manual', ?, ?)`,
    )
    .run('c'.repeat(64), 'b'.repeat(64), NOW, NOW, NOW);
};

/** 一轮完整视频世代：任务 + 两个 PENDING 候选（同轮同模型）。 */
const seedVideoRound = (
  database: SqliteTestDatabase,
  roundNo: number,
  modelId: string,
  options: { readonly withoutCandidates?: boolean } = {},
): void => {
  database
    .prepare(
      `INSERT INTO video_generation_tasks
       (id, project_id, shot_id, shot_version_id, idempotency_key, phase,
        generation_input_hash, candidate_count, round_no, created_at, updated_at)
       VALUES (?, 'project_media', 'shot_media', 'shotv_media', ?, 'POLLING', ?, 2, ?, ?, ?)`,
    )
    .run(
      `video_task_round_${String(roundNo)}`,
      `video-task_round_${String(roundNo)}`,
      'c'.repeat(64),
      roundNo,
      NOW,
      NOW,
    );
  if (options.withoutCandidates === true) return;
  const insertCandidate = database.prepare(
    `INSERT INTO video_candidates
     (id, project_id, shot_id, shot_version_id, round_no, index_in_round, generation_input_hash,
      status, model_id, requested_duration_sec, first_frame_candidate_id, first_frame_file_sha256,
      created_at, updated_at)
     VALUES (?, 'project_media', 'shot_media', 'shotv_media', ?, ?, ?, 'PENDING', ?, 5,
             'candidate_first_frame', ?, ?, ?)`,
  );
  for (const index of [0, 1]) {
    insertCandidate.run(
      `video_candidate_r${String(roundNo)}_${String(index)}`,
      roundNo,
      index,
      'a'.repeat(64),
      modelId,
      'b'.repeat(64),
      NOW,
      NOW,
    );
  }
};

describe('0023_video_provider_preferences 迁移矩阵（low-cost-video 3.1 切片）', () => {
  it('空库—全链迁移到 head 24—单例行按 SEEDANCE 固定映射播种', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_pref_clean.sqlite');
      try {
        expect(
          database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
        ).toEqual({ version: 26 });
        expect(preferenceRow(database)).toEqual({
          id: 1,
          mode: 'SEEDANCE',
          provider_profile_id: 'profile-video-primary',
          updated_at: SEED_UPDATED_AT,
        });
        // 0023 不触碰既有能力快照（volcark-seedance-video/v1 原样；v2/v3 另测）。
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM provider_capability_snapshots WHERE id = 'volcark-seedance-video/v1'",
            )
            .get(),
        ).toEqual({ count: 1 });
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('单例 CHECK—MOCK 入库、错配 mode→Profile 映射、第二行、坏 UPDATE 均拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_pref_check.sqlite');
      try {
        const insert = database.prepare(
          'INSERT INTO video_provider_preferences (id, mode, provider_profile_id, updated_at) VALUES (?, ?, ?, ?)',
        );
        // MOCK 是 Main-only 联调模式，不允许入库（design D1/D2）。
        expect(() => insert.run(1, 'MOCK', 'profile-video-primary', NOW)).toThrow();
        // mode 与 Profile 映射错配被 CHECK 拒绝。
        expect(() => insert.run(1, 'WAN', 'profile-video-primary', NOW)).toThrow();
        expect(() => insert.run(1, 'AGNES', 'profile-video-wan-primary', NOW)).toThrow();
        // 单例：只允许 id=1。
        expect(() => insert.run(2, 'SEEDANCE', 'profile-video-primary', NOW)).toThrow();
        // 已播种行不能被 UPDATE 成非法映射。
        expect(() =>
          database
            .prepare("UPDATE video_provider_preferences SET mode = 'MOCK' WHERE id = 1")
            .run(),
        ).toThrow();
        expect(() =>
          database
            .prepare(
              "UPDATE video_provider_preferences SET provider_profile_id = 'profile-video-wan-primary' WHERE id = 1",
            )
            .run(),
        ).toThrow();
        expect(preferenceRow(database)).toMatchObject({ mode: 'SEEDANCE' });
      } finally {
        database.close();
      }
    });
  });

  it('v22 样本库—既有 Seedance 2.0/2.5 Profile 与在途视频任务在 23/24 后业务列不变', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_pref_upgrade.sqlite', 22);
      try {
        seedShotGraph(database);
        seedProviderProfiles(database);
        seedFirstFrame(database);
        seedVideoRound(database, 1, 'doubao-seedance-2-0-260128');
        const TASK_LEGACY_COLUMNS = `id, project_id, shot_id, shot_version_id, idempotency_key,
             provider_task_id, phase, generation_input_hash, candidate_count, round_no, batch_id,
             error_code, created_at, updated_at`;
        const profilesBefore = database
          .prepare('SELECT * FROM provider_profiles ORDER BY id')
          .all();
        const taskBefore = database
          .prepare(`SELECT ${TASK_LEGACY_COLUMNS} FROM video_generation_tasks WHERE round_no = 1`)
          .get();

        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);

        expect(
          database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
        ).toEqual({ version: 26 });
        // 既有 Profile（含 2.0/2.5 两种 model_id）逐列不变。
        expect(database.prepare('SELECT * FROM provider_profiles ORDER BY id').all()).toEqual(
          profilesBefore,
        );
        // 任务业务列不变；溯源五列按同轮候选唯一模型回填（0024）。
        expect(
          database
            .prepare(`SELECT ${TASK_LEGACY_COLUMNS} FROM video_generation_tasks WHERE round_no = 1`)
            .get(),
        ).toEqual(taskBefore);
        expect(
          database
            .prepare(
              `SELECT provider_kind, provider_profile_id, model_id, capability_snapshot_id, is_mock
               FROM video_generation_tasks WHERE round_no = 1`,
            )
            .get(),
        ).toEqual({
          capability_snapshot_id: 'volcark-seedance-video/v3',
          is_mock: 0,
          model_id: 'doubao-seedance-2-0-260128',
          provider_kind: 'VOLCARK_SEEDANCE',
          provider_profile_id: 'profile-video-primary',
        });
        // 偏好单例仍按固定映射播种。
        expect(preferenceRow(database)).toEqual({
          id: 1,
          mode: 'SEEDANCE',
          provider_profile_id: 'profile-video-primary',
          updated_at: SEED_UPDATED_AT,
        });
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('100+ 历史版本压力库—v22→24 升级—版本链/Profile/在途任务全量对账', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_pref_pressure.sqlite', 22);
      try {
        seedShotGraph(database);
        seedProviderProfiles(database);
        seedFirstFrame(database);
        seedVideoRound(database, 1, 'doubao-seedance-2-5-260628');
        database
          .prepare(
            `INSERT INTO assets (id, project_id, asset_type, bible_ref_id, display_name, created_at, updated_at)
             VALUES ('asset_pressure', 'project_media', 'CHARACTER', 'char_pressure', '主角', ?, ?)`,
          )
          .run(NOW, NOW);
        for (let versionNo = 1; versionNo <= 120; versionNo += 1) {
          database
            .prepare(
              `INSERT INTO asset_versions
               (id, asset_id, version_no, provenance, file_sha256, byte_size, mime_type, created_at)
               VALUES (?, 'asset_pressure', ?, 'UPLOADED', ?, 2048, 'image/png', ?)`,
            )
            .run(
              `assetv_pressure_${String(versionNo)}`,
              versionNo,
              'a'.repeat(63) + String(versionNo % 10),
              NOW,
            );
        }
        const headBefore = database
          .prepare(
            'SELECT id, version_no FROM asset_versions WHERE asset_id = ? ORDER BY version_no DESC LIMIT 1',
          )
          .get('asset_pressure');

        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);

        expect(
          database
            .prepare('SELECT COUNT(*) AS count FROM asset_versions WHERE asset_id = ?')
            .get('asset_pressure'),
        ).toEqual({ count: 120 });
        expect(
          database
            .prepare(
              'SELECT id, version_no FROM asset_versions WHERE asset_id = ? ORDER BY version_no DESC LIMIT 1',
            )
            .get('asset_pressure'),
        ).toEqual(headBefore);
        expect(database.prepare('SELECT COUNT(*) AS count FROM provider_profiles').get()).toEqual({
          count: 2,
        });
        expect(
          database
            .prepare(`SELECT phase, provider_kind FROM video_generation_tasks WHERE round_no = 1`)
            .get(),
        ).toEqual({ phase: 'POLLING', provider_kind: 'VOLCARK_SEEDANCE' });
        expect(preferenceRow(database)).toMatchObject({ mode: 'SEEDANCE' });
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });
});

describe('0024_low_cost_video_provider_provenance 迁移矩阵（low-cost-video 3.1/3.2/3.3）', () => {
  it('三能力快照播种—sha256 复算一致且冻结事实与 design D3/D5/D5b 锁定值吻合', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_prov_snapshots.sqlite');
      try {
        const rows = database
          .prepare(
            `SELECT id, provider_profile_id, snapshot_version, valid_from, capabilities_json,
                    source_url, sha256
             FROM provider_capability_snapshots
             WHERE id IN ('dashscope-wan-video/v1', 'agnes-video/v1', 'volcark-seedance-video/v3')`,
          )
          .all() as unknown as readonly {
          capabilities_json: string;
          id: string;
          provider_profile_id: string;
          sha256: string;
          snapshot_version: string;
          source_url: string;
          valid_from: string;
        }[];
        expect(rows.map(({ id }) => id).sort()).toEqual([
          'agnes-video/v1',
          'dashscope-wan-video/v1',
          'volcark-seedance-video/v3',
        ]);
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const row of rows) {
          expect(createHash('sha256').update(row.capabilities_json, 'utf8').digest('hex')).toBe(
            row.sha256,
          );
        }
        expect(byId.get('dashscope-wan-video/v1')).toMatchObject({
          provider_profile_id: 'profile-video-wan-primary',
          sha256: WAN_SNAPSHOT_SHA256,
          snapshot_version: '1',
          valid_from: '2026-09-18',
        });
        expect(byId.get('agnes-video/v1')).toMatchObject({
          provider_profile_id: 'profile-video-agnes-primary',
          sha256: AGNES_SNAPSHOT_SHA256,
          snapshot_version: '1',
          valid_from: '2026-09-19',
        });
        expect(byId.get('volcark-seedance-video/v3')).toMatchObject({
          provider_profile_id: 'profile_video_primary',
          sha256: SEEDANCE_V3_SNAPSHOT_SHA256,
          snapshot_version: '3',
        });
        const capabilitiesOf = (id: string): Record<string, unknown> => {
          const row = byId.get(id);
          if (row === undefined) throw new Error(`snapshot missing: ${id}`);
          return JSON.parse(row.capabilities_json) as Record<string, unknown>;
        };
        const wan = capabilitiesOf('dashscope-wan-video/v1') as {
          request: {
            duration_range: readonly number[];
            first_frame: { formats: readonly string[]; max_bytes: number };
            fixed_params: { audio: boolean };
          };
        };
        expect(wan.request.duration_range).toEqual([2, 15]);
        expect(wan.request.fixed_params.audio).toBe(false);
        expect(wan.request.first_frame.max_bytes).toBe(20 * 1024 * 1024);
        expect(wan.request.first_frame.formats).toContain('bmp');
        const agnes = capabilitiesOf('agnes-video/v1') as {
          model_id_alternates: readonly string[];
          rate_limit: { free_tier_rpm: number };
          request: { duration_range: readonly number[]; resolution: { tiers: readonly string[] } };
        };
        expect(agnes.model_id_alternates).toEqual(['agnes-video-2.5-flash']);
        expect(agnes.request.duration_range).toEqual([5, 5]);
        expect(agnes.request.resolution.tiers).toEqual(['720P']);
        expect(agnes.rate_limit.free_tier_rpm).toBe(1);
        const seedance = capabilitiesOf('volcark-seedance-video/v3') as {
          model_id_alternates: readonly string[];
          request: { duration_range: readonly number[] };
        };
        expect(seedance.model_id_alternates).toEqual([
          'doubao-seedance-2-0-mini-260615',
          'doubao-seedance-2-5-260628',
        ]);
        expect(seedance.request.duration_range).toEqual([5, 10]);
      } finally {
        database.close();
      }
    });
  });

  it('v23 样本库—六轮受控模型世代回填—任务取同轮候选唯一模型、候选按自身模型', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_prov_backfill.sqlite', 23);
      try {
        seedShotGraph(database);
        seedFirstFrame(database);
        const rounds: readonly [number, string, string, string][] = [
          [1, 'doubao-seedance-2-0-260128', 'VOLCARK_SEEDANCE', 'volcark-seedance-video/v3'],
          [2, 'doubao-seedance-2-5-260628', 'VOLCARK_SEEDANCE', 'volcark-seedance-video/v3'],
          [
            3,
            'doubao-seedance-1-0-lite-i2v-250428',
            'VOLCARK_SEEDANCE',
            'volcark-seedance-video/v1',
          ],
          [4, 'doubao-seedance-1-5-pro-251215', 'VOLCARK_SEEDANCE', 'volcark-seedance-video/v2'],
          [5, 'wan2.6-i2v-flash', 'DASHSCOPE_WAN_VIDEO', 'dashscope-wan-video/v1'],
          [6, 'agnes-video-v2.0', 'AGNES_VIDEO', 'agnes-video/v1'],
        ];
        for (const [roundNo, modelId] of rounds) seedVideoRound(database, roundNo, modelId);

        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);

        const profileByKind: Readonly<Record<string, string>> = {
          AGNES_VIDEO: 'profile-video-agnes-primary',
          DASHSCOPE_WAN_VIDEO: 'profile-video-wan-primary',
          VOLCARK_SEEDANCE: 'profile-video-primary',
        };
        for (const [roundNo, modelId, kind, snapshotId] of rounds) {
          expect(
            database
              .prepare(
                `SELECT provider_kind, provider_profile_id, model_id, capability_snapshot_id, is_mock
                 FROM video_generation_tasks WHERE round_no = ?`,
              )
              .get(roundNo),
            `task round ${String(roundNo)}`,
          ).toEqual({
            capability_snapshot_id: snapshotId,
            is_mock: 0,
            model_id: modelId,
            provider_kind: kind,
            provider_profile_id: profileByKind[kind],
          });
          expect(
            database
              .prepare(
                `SELECT provider_kind, provider_profile_id, model_id, capability_snapshot_id, is_mock
                 FROM video_candidates WHERE round_no = ? AND index_in_round = 0`,
              )
              .get(roundNo),
            `candidate round ${String(roundNo)}`,
          ).toEqual({
            capability_snapshot_id: snapshotId,
            is_mock: 0,
            model_id: modelId,
            provider_kind: kind,
            provider_profile_id: profileByKind[kind],
          });
        }
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('未知历史 model_id—迁移整体回滚阻断—v23 库原样可读且不猜测 Provider', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_prov_unknown_model.sqlite', 23);
      try {
        seedShotGraph(database);
        seedFirstFrame(database);
        seedVideoRound(database, 1, 'doubao-seedance-2-0-260128');
        seedVideoRound(database, 2, 'some-unknown-video-model-x');
        const tasksBefore = database
          .prepare('SELECT COUNT(*) AS count FROM video_generation_tasks')
          .get();
        const migrations = await loadMigrationSet(MIGRATIONS);

        expect(() => applyMigrations(database, migrations, () => NOW)).toThrow(
          PersistenceRuntimeError,
        );

        // 回滚对账：前沿保持 23，业务行原样，新表/新列未落。
        expect(
          database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
        ).toEqual({ version: 23 });
        expect(
          database.prepare('SELECT COUNT(*) AS count FROM video_generation_tasks').get(),
        ).toEqual(tasksBefore);
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'video_generation_tasks_rebuilt_0024'",
            )
            .get(),
        ).toEqual({ count: 0 });
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('无候选证据的在途任务—任务 model_id 无法受控映射—同样阻断不猜测', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_prov_orphan_task.sqlite', 23);
      try {
        seedShotGraph(database);
        seedFirstFrame(database);
        seedVideoRound(database, 1, 'doubao-seedance-2-0-260128', { withoutCandidates: true });
        const migrations = await loadMigrationSet(MIGRATIONS);

        expect(() => applyMigrations(database, migrations, () => NOW)).toThrow(
          PersistenceRuntimeError,
        );
        expect(
          database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
        ).toEqual({ version: 23 });
      } finally {
        database.close();
      }
    });
  });

  it('head 24 新行—省略溯源列按 Seedance 真实档缺省落库—坏枚举/错配/坏 is_mock 拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_prov_defaults.sqlite');
      try {
        seedShotGraph(database);
        seedFirstFrame(database);
        // 4.1 落地前的既有写路径形状：INSERT 不带溯源列 → DEFAULT 生效。
        database
          .prepare(
            `INSERT INTO video_generation_tasks
             (id, project_id, shot_id, shot_version_id, idempotency_key, phase,
              generation_input_hash, candidate_count, round_no, created_at, updated_at)
             VALUES ('video_task_default', 'project_media', 'shot_media', 'shotv_media',
                     'video-task_default', 'SUBMITTED', ?, 2, 7, ?, ?)`,
          )
          .run('d'.repeat(64), NOW, NOW);
        expect(
          database
            .prepare(
              `SELECT provider_kind, provider_profile_id, model_id, capability_snapshot_id, is_mock
               FROM video_generation_tasks WHERE id = 'video_task_default'`,
            )
            .get(),
        ).toEqual({
          capability_snapshot_id: 'volcark-seedance-video/v3',
          is_mock: 0,
          model_id: 'doubao-seedance-2-0-260128',
          provider_kind: 'VOLCARK_SEEDANCE',
          provider_profile_id: 'profile-video-primary',
        });
        // CHECK：坏枚举 / Provider↔Profile 错配 / 坏 is_mock 一律拒绝。
        const badTask = (id: string, kind: string, profile: string, isMock: number): void => {
          database
            .prepare(
              `INSERT INTO video_generation_tasks
               (id, project_id, shot_id, shot_version_id, idempotency_key, phase,
                generation_input_hash, candidate_count, round_no, created_at, updated_at,
                provider_kind, provider_profile_id, is_mock)
               VALUES (?, 'project_media', 'shot_media', 'shotv_media', ?, 'SUBMITTED', ?, 2, 8,
                       ?, ?, ?, ?, ?)`,
            )
            .run(id, `video-task_${id}`, 'd'.repeat(64), NOW, NOW, kind, profile, isMock);
        };
        expect(() => {
          badTask('video_task_bad_kind', 'OPENAI', 'profile-video-primary', 0);
        }).toThrow();
        expect(() => {
          badTask('video_task_bad_profile', 'VOLCARK_SEEDANCE', 'profile-video-wan-primary', 0);
        }).toThrow();
        expect(() => {
          badTask('video_task_bad_mock', 'VOLCARK_SEEDANCE', 'profile-video-primary', 2);
        }).toThrow();
        // 溯源列外键：能力快照必须真实存在。
        expect(() =>
          database
            .prepare(
              `INSERT INTO video_generation_tasks
               (id, project_id, shot_id, shot_version_id, idempotency_key, phase,
                generation_input_hash, candidate_count, round_no, created_at, updated_at,
                capability_snapshot_id)
               VALUES ('video_task_bad_snapshot', 'project_media', 'shot_media', 'shotv_media',
                       'video-task_bad_snapshot', 'SUBMITTED', ?, 2, 9, ?, ?,
                       'not-a-snapshot/v9')`,
            )
            .run('d'.repeat(64), NOW, NOW),
        ).toThrow();
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });
});

describe('SqliteVideoProviderPreferences（low-cost-video 3.4）', () => {
  it('get/save—CAS 乐观并发—成功保存更新映射，过期或 null 期望稳定冲突且行不变', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_pref_port.sqlite');
      try {
        const preferences = new SqliteVideoProviderPreferences(database);
        await expect(preferences.get()).resolves.toEqual({
          mode: 'SEEDANCE',
          providerProfileId: 'profile-video-primary',
          updatedAt: SEED_UPDATED_AT,
        });

        const saved = await preferences.save(SEED_UPDATED_AT, 'AGNES', '2026-09-19T01:00:00.000Z');
        expect(saved).toEqual({
          mode: 'AGNES',
          providerProfileId: 'profile-video-agnes-primary',
          updatedAt: '2026-09-19T01:00:00.000Z',
        });
        await expect(preferences.get()).resolves.toMatchObject({
          mode: 'AGNES',
          providerProfileId: 'profile-video-agnes-primary',
        });

        // 过期期望：CAS changes=0 → 稳定冲突，行保持上次成功保存值。
        await expect(
          preferences.save(SEED_UPDATED_AT, 'AGNES', '2026-09-19T02:00:00.000Z'),
        ).rejects.toThrow('VIDEO_PROVIDER_SELECTION_CONFLICT');
        // 行已存在时 null 期望同样冲突（首保存只允许在空行语义下成立）。
        await expect(preferences.save(null, 'AGNES', '2026-09-19T03:00:00.000Z')).rejects.toThrow(
          PersistenceRuntimeError,
        );
        expect(preferenceRow(database)).toEqual({
          id: 1,
          mode: 'AGNES',
          provider_profile_id: 'profile-video-agnes-primary',
          updated_at: '2026-09-19T01:00:00.000Z',
        });
      } finally {
        database.close();
      }
    });
  });

  it('保存成功与冲突—三家 Provider Profile 行零读取零修改（切换零触碰）', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'video_pref_isolation.sqlite');
      try {
        seedProviderProfiles(database);
        const profilesBefore = database
          .prepare('SELECT * FROM provider_profiles ORDER BY id')
          .all();
        const preferences = new SqliteVideoProviderPreferences(database);

        await preferences.save(SEED_UPDATED_AT, 'AGNES', '2026-09-19T04:00:00.000Z');
        await expect(
          preferences.save('1970-01-01T00:00:00.000Z', 'SEEDANCE', '2026-09-19T05:00:00.000Z'),
        ).rejects.toThrow('VIDEO_PROVIDER_SELECTION_CONFLICT');

        expect(database.prepare('SELECT * FROM provider_profiles ORDER BY id').all()).toEqual(
          profilesBefore,
        );
      } finally {
        database.close();
      }
    });
  });
});
