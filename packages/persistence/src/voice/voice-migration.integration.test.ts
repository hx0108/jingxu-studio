import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-27T00:00:00.000Z';
const HASH = 'a'.repeat(64);

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

/** 配音候选/轨道条目外键链所需的最小图（projects → … → video_timeline_versions）。 */
const seedVoiceGraph = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'project_1',
      'V2',
      'AI_ORIGINAL',
      'NARRATION_FIRST',
      'LOCAL_DEMO',
      'projects/project_1',
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, aspect_ratio, width, height, fps, language, subtitle_safe_area_json, is_current, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('format_1', 'project_1', 1, '9:16', 1080, 1920, 24, 'zh-CN', '{}', 1, NOW);
  database
    .prepare(
      `INSERT INTO episodes (id, project_id, title, target_duration_sec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('episode_1', 'project_1', '第一集', 90, NOW, NOW);
  database
    .prepare(
      `INSERT INTO story_bible_versions
       (id, project_id, version_no, document_json, document_sha256, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('bible_1', 'project_1', 1, '{}', HASH, 'READY', 'USER', NOW);
  database
    .prepare(
      `INSERT INTO episode_versions
       (id, episode_id, version_no, story_bible_version_id, format_profile_id, target_duration_sec, shot_set_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('episode_v1', 'episode_1', 1, 'bible_1', 'format_1', 90, HASH, 'READY', NOW);
  database
    .prepare(
      `INSERT INTO shots (id, episode_id, lifecycle_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('shot_1', 'episode_1', 'ACTIVE', NOW, NOW);
  database
    .prepare(
      `INSERT INTO shot_contract_versions
       (id, shot_id, version_no, lineage_resolution_status, sequence, version_status, format_profile_id,
        target_duration_sec, dialogue_render_mode, document_json, document_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'shotv_1',
      'shot_1',
      1,
      'ROOT',
      1,
      'READY',
      'format_1',
      5,
      'NARRATION_FIRST',
      '{}',
      HASH,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO video_timelines (id, project_id, episode_id, current_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('timeline_1', 'project_1', 'episode_1', null, NOW, NOW);
  // audio_volume 缺省列不显式提供——缺省回填行为即被本用例覆盖。
  database
    .prepare(
      `INSERT INTO video_timeline_versions
       (id, timeline_id, episode_version_id, format_profile_id, version_no, input_hash, total_duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('tvv_1', 'timeline_1', 'episode_v1', 'format_1', 1, HASH, 5_000, NOW);
};

/** 约束冒烟用动态行插入：列名来自测试内字面量，单列覆盖即可触发目标 CHECK。 */
const insertRow = (
  database: SqliteTestDatabase,
  table: string,
  row: Record<string, unknown>,
): ReturnType<ReturnType<SqliteTestDatabase['prepare']>['run']> => {
  const columns = Object.keys(row);
  const values = columns.map((column) => row[column]) as (string | number | null)[];
  return database
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...values);
};

const validJob = (): Record<string, unknown> => ({
  created_at: NOW,
  episode_id: 'episode_1',
  evidence_json: '[]',
  id: 'job_1',
  project_id: 'project_1',
  request_id: 'request_voice_0001',
  skipped_shots_json: '[]',
  status: 'QUEUED',
  target_shot_ids_json: '["shot_1"]',
  updated_at: NOW,
});

const validCandidate = (id: string): Record<string, unknown> => ({
  byte_size: 2_048,
  created_at: NOW,
  duration_ms: 1_500,
  file_sha256: HASH,
  generation_input_hash: HASH,
  id,
  index_in_round: 0,
  job_id: 'job_1',
  mime_type: 'audio/mpeg',
  model_id: 'qwen3-tts-instruct-flash',
  project_id: 'project_1',
  round_no: 1,
  shot_id: 'shot_1',
  shot_version_id: 'shotv_1',
  speaker_id: 'narrator',
  spoken_text_sha256: HASH,
  status: 'SUCCEEDED',
  storage_rel_path: `projects/project_1/audio/aa/${HASH}.mp3`,
  updated_at: NOW,
  voice_id: 'Neil',
});

describe('migration 0020（v2-voice-audio-timeline D3）', () => {
  it('空库到 head—配音表族与索引全集存在、audio_volume 列就位且外键自洽', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'voice_head.sqlite');
      try {
        const objects = database
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all() as unknown as readonly { readonly name: string; readonly type: string }[];
        const namesByType = (type: string) =>
          objects.filter((object) => object.type === type).map((object) => object.name);
        expect(namesByType('table')).toEqual(
          expect.arrayContaining([
            'voice_generation_jobs',
            'voice_candidates',
            'voice_mappings',
            'video_timeline_voice_items',
            'video_timeline_subtitle_items',
          ]),
        );
        expect(namesByType('index')).toEqual(
          expect.arrayContaining([
            'ix_voice_jobs_project_status',
            'ix_voice_candidates_shot',
            'ix_voice_candidates_generation',
            'ix_voice_candidates_job',
            'ix_voice_timeline_items_candidate',
            'ux_voice_candidate_selected',
          ]),
        );
        const columns = database
          .prepare('PRAGMA table_info(video_timeline_versions)')
          .all() as unknown as readonly { readonly name: string }[];
        expect(columns.map(({ name }) => name)).toContain('audio_volume');
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('v19 库升级—既有时间线版本 audio_volume 缺省回填 0.2（等效旧硬编码行为）', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'voice_upgrade.sqlite', 19);
      try {
        seedVoiceGraph(database);
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        expect(database.prepare('SELECT audio_volume FROM video_timeline_versions').all()).toEqual([
          { audio_volume: 0.2 },
        ]);
        // 升级后新写入不显式给列——同样落到缺省。
        database
          .prepare(
            `INSERT INTO video_timeline_versions
             (id, timeline_id, episode_version_id, format_profile_id, version_no, input_hash, total_duration_ms, created_at)
             VALUES ('tvv_2', 'timeline_1', 'episode_v1', 'format_1', 2, ?, 5_000, ?)`,
          )
          .run(HASH.replace('a', 'b'), NOW);
        expect(
          database
            .prepare("SELECT audio_volume FROM video_timeline_versions WHERE id = 'tvv_2'")
            .get(),
        ).toEqual({ audio_volume: 0.2 });
      } finally {
        database.close();
      }
    });
  });

  it('voice_generation_jobs—非法状态/重复 requestId/非法 JSON—由约束拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'voice_jobs.sqlite');
      try {
        seedVoiceGraph(database);
        insertRow(database, 'voice_generation_jobs', validJob());
        expect(() =>
          insertRow(database, 'voice_generation_jobs', {
            ...validJob(),
            id: 'job_bad_status',
            status: 'PAUSED',
          }),
        ).toThrow();
        expect(() =>
          insertRow(database, 'voice_generation_jobs', {
            ...validJob(),
            id: 'job_dup_request',
            request_id: 'request_voice_0001',
          }),
        ).toThrow(/UNIQUE/u);
        expect(() =>
          insertRow(database, 'voice_generation_jobs', {
            ...validJob(),
            evidence_json: 'not-json',
            id: 'job_bad_json',
          }),
        ).toThrow();
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('voice_candidates—SUCCEEDED 缺四元组/非成功带时长/非法 mime 与 speaker—由约束拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'voice_candidates.sqlite');
      try {
        seedVoiceGraph(database);
        insertRow(database, 'voice_generation_jobs', validJob());
        // 合法 SUCCEEDED 行先行落位（四元组 + 时长齐备）。
        insertRow(database, 'voice_candidates', validCandidate('vc_ok'));
        expect(() =>
          insertRow(
            database,
            'voice_candidates',
            (() => {
              const row = validCandidate('vc_no_file');
              delete row.file_sha256;
              delete row.storage_rel_path;
              return row;
            })(),
          ),
        ).toThrow();
        expect(() =>
          insertRow(database, 'voice_candidates', {
            ...validCandidate('vc_pending_duration'),
            duration_ms: 1_500,
            file_sha256: null,
            status: 'PENDING',
            storage_rel_path: null,
          }),
        ).toThrow();
        expect(() =>
          insertRow(database, 'voice_candidates', {
            ...validCandidate('vc_bad_mime'),
            mime_type: 'audio/ogg',
          }),
        ).toThrow();
        expect(() =>
          insertRow(database, 'voice_candidates', {
            ...validCandidate('vc_bad_speaker'),
            speaker_id: 'hero',
          }),
        ).toThrow();
        expect(() =>
          insertRow(database, 'voice_candidates', {
            ...validCandidate('vc_bad_hash'),
            file_sha256: 'short',
          }),
        ).toThrow();
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('voice_candidates—同轮次重复/第二当前候选/非 FAILED 带 error_code—由唯一与 CHECK 拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'voice_unique.sqlite');
      try {
        seedVoiceGraph(database);
        insertRow(database, 'voice_generation_jobs', validJob());
        insertRow(database, 'voice_candidates', {
          ...validCandidate('vc_selected'),
          selected_at: NOW,
        });
        // 同 (shot_id, round_no, index_in_round) 重复——轮次键唯一。
        expect(() =>
          insertRow(database, 'voice_candidates', validCandidate('vc_dup_slot')),
        ).toThrow(/UNIQUE/u);
        // 第二条当前候选——partial unique（selected_at 非空）拒绝。
        expect(() =>
          insertRow(database, 'voice_candidates', {
            ...validCandidate('vc_second_selected'),
            index_in_round: 1,
            selected_at: NOW,
          }),
        ).toThrow(/UNIQUE/u);
        // 非 FAILED 状态携带 error_code——CHECK 拒绝。
        expect(() =>
          insertRow(database, 'voice_candidates', {
            ...validCandidate('vc_error_on_success'),
            error_code: 'PROVIDER_ERROR',
          }),
        ).toThrow();
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  it('voice_mappings—同项目同说话人重复—由主键拒绝', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'voice_mappings.sqlite');
      try {
        seedVoiceGraph(database);
        insertRow(database, 'voice_mappings', {
          project_id: 'project_1',
          speaker_id: 'char_hero',
          updated_at: NOW,
          voice_id: 'Stella',
        });
        expect(() =>
          insertRow(database, 'voice_mappings', {
            project_id: 'project_1',
            speaker_id: 'char_hero',
            updated_at: NOW,
            voice_id: 'Mochi',
          }),
        ).toThrow(/UNIQUE/u);
        expect(() =>
          insertRow(database, 'voice_mappings', {
            project_id: 'project_1',
            speaker_id: 'protagonist',
            updated_at: NOW,
            voice_id: 'Mochi',
          }),
        ).toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('配音/字幕轨道条目—越界 trim/volume/safe_area 与非法 JSON—由约束拒绝；版本删除级联清理', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await openMigratedDatabase(root, 'voice_items.sqlite');
      try {
        seedVoiceGraph(database);
        insertRow(database, 'voice_generation_jobs', validJob());
        insertRow(database, 'voice_candidates', validCandidate('vc_item'));
        insertRow(database, 'video_timeline_voice_items', {
          candidate_id: 'vc_item',
          enabled: 1,
          file_sha256: HASH,
          generation_input_hash: HASH,
          offset_ms: 0,
          shot_id: 'shot_1',
          timeline_version_id: 'tvv_1',
          trim_in_ms: 0,
          trim_out_ms: 1_500,
          volume: 0.8,
        });
        insertRow(database, 'video_timeline_subtitle_items', {
          enabled: 1,
          safe_area_pct: 5,
          shot_id: 'shot_1',
          spoken_text_sha256: HASH,
          style_snapshot_json: '{}',
          timeline_version_id: 'tvv_1',
        });
        expect(() =>
          insertRow(database, 'video_timeline_voice_items', {
            candidate_id: 'vc_item',
            enabled: 1,
            file_sha256: HASH,
            generation_input_hash: HASH,
            offset_ms: 0,
            shot_id: 'shot_1',
            timeline_version_id: 'tvv_1',
            trim_in_ms: 1_000,
            trim_out_ms: 1_000,
            volume: 0.8,
          }),
        ).toThrow();
        expect(() =>
          insertRow(database, 'video_timeline_voice_items', {
            candidate_id: 'vc_item',
            enabled: 1,
            file_sha256: HASH,
            generation_input_hash: HASH,
            offset_ms: 0,
            shot_id: 'shot_1',
            timeline_version_id: 'tvv_1',
            trim_in_ms: 0,
            trim_out_ms: 1_500,
            volume: 1.5,
          }),
        ).toThrow();
        expect(() =>
          insertRow(database, 'video_timeline_subtitle_items', {
            enabled: 1,
            safe_area_pct: 25,
            shot_id: 'shot_1',
            spoken_text_sha256: HASH,
            style_snapshot_json: '{}',
            timeline_version_id: 'tvv_1',
          }),
        ).toThrow();
        // 版本行删除沿 ON DELETE CASCADE 清理两轨（时间线版本不可变，删除仅测试链路）。
        database.prepare('PRAGMA foreign_keys = ON').run();
        database.prepare("DELETE FROM video_timeline_versions WHERE id = 'tvv_1'").run();
        expect(
          database.prepare('SELECT COUNT(*) AS count FROM video_timeline_voice_items').get(),
        ).toEqual({ count: 0 });
        expect(
          database.prepare('SELECT COUNT(*) AS count FROM video_timeline_subtitle_items').get(),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    });
  });
});
