import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import {
  INITIAL_SCHEMA_INDEXES,
  INITIAL_SCHEMA_TABLES,
  INITIAL_SCHEMA_TRIGGERS,
} from './initial-schema-trace';
import { loadMigrationSet } from './migration-loader';
import { applyMigrations } from './migration-runner';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-08T00:00:00.000Z';

const openMigratedDatabase = async (root: string): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, 'initial-schema.sqlite'));
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

const seedProjectGraph = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'project_1',
      '测试项目',
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
      `INSERT INTO episodes
       (id, project_id, title, target_duration_sec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('episode_1', 'project_1', '第一集', 90, NOW, NOW);
  database
    .prepare(
      `INSERT INTO story_bible_versions
       (id, project_id, version_no, document_json, document_sha256, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('bible_v1', 'project_1', 1, '{}', 'sha_bible', 'DRAFT', 'AI', NOW);
  database
    .prepare(
      `INSERT INTO script_versions
       (id, project_id, episode_id, stage, version_no, document_json, document_sha256, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'script_v1',
      'project_1',
      'episode_1',
      'CONCEPT',
      1,
      '{}',
      'sha_script',
      'DRAFT',
      'AI',
      NOW,
    );
  database
    .prepare(
      `INSERT INTO episode_versions
       (id, episode_id, version_no, story_bible_version_id, format_profile_id, target_duration_sec, shot_set_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('episode_v1', 'episode_1', 1, 'bible_v1', 'format_1', 90, 'sha_shot_set', 'DRAFT', NOW);
  database
    .prepare(
      `INSERT INTO shots
       (id, episode_id, lifecycle_status, created_at, updated_at)
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
      'shot_v1',
      'shot_1',
      1,
      'ROOT',
      1,
      'DRAFT',
      'format_1',
      8,
      'NARRATION_FIRST',
      JSON.stringify({
        contract_version: 1,
        dialogue: { dialogue_render_mode: 'NARRATION_FIRST' },
        format_profile_id: 'format_1',
        parent_version_id: null,
        sequence: 1,
        shot_id: 'shot_1',
        status: 'DRAFT',
        target_duration_sec: 8,
        version_id: 'shot_v1',
      }),
      'sha_shot',
      NOW,
    );
};

describe('0001_initial.sql', () => {
  it('空库—执行初始 migration—创建 TECH §8.4 全部登记对象', async () => {
    await withMigratedDatabase((database) => {
      const objects = database
        .prepare(
          "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as unknown as readonly { readonly name: string; readonly type: string }[];
      const namesByType = (type: string) =>
        objects.filter((object) => object.type === type).map((object) => object.name);

      expect(namesByType('table')).toEqual(expect.arrayContaining([...INITIAL_SCHEMA_TABLES]));
      expect(namesByType('index')).toEqual(expect.arrayContaining([...INITIAL_SCHEMA_INDEXES]));
      expect(namesByType('trigger')).toEqual(expect.arrayContaining([...INITIAL_SCHEMA_TRIGGERS]));
      expect(database.pragma('foreign_key_check')).toEqual([]);
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
      ]);
    });
  });

  it('系统配置与价格—写入非法 JSON/枚举/区间—由数据库约束拒绝', async () => {
    await withMigratedDatabase((database) => {
      expect(() =>
        database
          .prepare('INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)')
          .run('bad', '{', NOW),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO provider_profiles
             (id, provider, region, base_url, workspace_id, model_id, model_snapshot_date,
              config_json, credential_ref, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'provider_bad',
            'QWEN',
            'cn',
            'https://example.invalid',
            'workspace',
            'model',
            '2026-08-08',
            '{',
            'credential_ref',
            1,
          ),
      ).toThrow();
      // 0007 起快照表为审计引用：provider_profile_id 仅保留文本，允许悬空
      // （同 model_invocations，避免删除凭据被历史快照阻塞）。
      database
        .prepare(
          `INSERT INTO provider_capability_snapshots
           (id, provider_profile_id, snapshot_version, valid_from, expires_at,
            capabilities_json, source_url, sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'capability_1',
          'missing_provider',
          'v1',
          NOW,
          '2027-01-01T00:00:00.000Z',
          '{}',
          'https://example.invalid',
          'a'.repeat(64),
        );
      expect(() =>
        database
          .prepare(
            `INSERT INTO provider_capability_snapshots
             (id, provider_profile_id, snapshot_version, valid_from, expires_at,
              capabilities_json, source_url, sha256)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'capability_2',
            'missing_provider',
            'v1',
            NOW,
            '2027-01-01T00:00:00.000Z',
            '{',
            'https://example.invalid',
            'a'.repeat(64),
          ),
      ).toThrow();
      database
        .prepare(
          `INSERT INTO prompt_templates (id, stage, version, template_text, sha256, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('prompt_1', 'CONCEPT', 99, 'template', 'sha_prompt', 1, NOW);
      expect(() =>
        database
          .prepare(
            `INSERT INTO prompt_templates (id, stage, version, template_text, sha256, active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('prompt_2', 'CONCEPT', 99, 'other', 'sha_other', 1, NOW),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO reference_price_snapshots
             (id, price_version, provider, model, region, capability_type, billing_unit, currency,
              price_range_json, effective_at, expires_at, source_url, sha256, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'price_1',
            'v1',
            'ref',
            'package',
            'CN',
            'SHOT_PACKAGE',
            'PER_IMAGE',
            'CNY',
            '{"min":2,"max":1}',
            NOW,
            '2027-01-01T00:00:00.000Z',
            'https://example.invalid',
            'sha',
            1,
          ),
      ).toThrow();
      const providerColumns = database.pragma('table_info(provider_profiles)') as readonly {
        readonly name: string;
      }[];
      expect(providerColumns.map(({ name }) => name)).toContain('credential_ref');
      expect(providerColumns.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining(['api_key', 'credential_plaintext']),
      );
    });
  });

  it('项目版本与阶段头—制造重复 current/active/stage head—由唯一约束拒绝', async () => {
    await withMigratedDatabase((database) => {
      seedProjectGraph(database);
      expect(() =>
        database
          .prepare(
            `INSERT INTO format_profiles
             (id, project_id, version_no, aspect_ratio, width, height, fps, language, subtitle_safe_area_json, is_current, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('format_bad', 'project_1', 2, '16:9', 1920, 1080, 24, 'zh-CN', '{', 0, NOW),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO format_profiles
             (id, project_id, version_no, aspect_ratio, width, height, fps, language, subtitle_safe_area_json, is_current, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('format_2', 'project_1', 2, '16:9', 1920, 1080, 24, 'zh-CN', '{}', 1, NOW),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            'INSERT INTO episodes (id, project_id, title, target_duration_sec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run('episode_2', 'project_1', '第二集', 90, NOW, NOW),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO story_bible_versions
             (id, project_id, version_no, document_json, document_sha256, status, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('bible_duplicate', 'project_1', 1, '{}', 'sha_duplicate', 'DRAFT', 'USER', NOW),
      ).toThrow();
      database
        .prepare(
          `INSERT INTO stage_heads
           (project_id, episode_id, stage, current_version_type, current_version_id, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?)`,
        )
        .run('project_1', 'STORY_BIBLE', 'STORY_BIBLE_VERSION', 'bible_v1', NOW);
      expect(() =>
        database
          .prepare(
            `INSERT INTO stage_heads
             (project_id, episode_id, stage, current_version_type, current_version_id, updated_at)
             VALUES (?, NULL, ?, ?, ?, ?)`,
          )
          .run('project_1', 'STORY_BIBLE', 'STORY_BIBLE_VERSION', 'bible_v1', NOW),
      ).toThrow();
    });
  });

  it('任务、锁和血缘—写入非法状态或重复有效边—由约束拒绝', async () => {
    await withMigratedDatabase((database) => {
      seedProjectGraph(database);
      database
        .prepare(
          `INSERT INTO prompt_templates (id, stage, version, template_text, sha256, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('prompt_1', 'CONCEPT', 99, 'template', 'sha_prompt', 1, NOW);
      expect(() =>
        database
          .prepare(
            `INSERT INTO script_stage_jobs
             (id, project_id, stage, operation_type, status, idempotency_key, user_operation_id,
              input_versions_json, input_version_set_hash, write_set_json, lock_snapshot_hash,
              prompt_template_id, queued_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'job_1',
            'project_1',
            'CONCEPT',
            'GENERATE',
            'UNKNOWN',
            'idem',
            'op',
            '[]',
            'sha_inputs',
            '[]',
            'sha_locks',
            'prompt_1',
            NOW,
            NOW,
          ),
      ).toThrow();
      database
        .prepare(
          `INSERT INTO lock_records
           (id, project_id, object_type, object_id, object_version_id, json_pointer, locked_by, locked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'lock_1',
          'project_1',
          'SHOT_CONTRACT',
          'shot_1',
          'shot_v1',
          '/cinematography',
          'USER',
          NOW,
        );
      expect(() =>
        database
          .prepare(
            `INSERT INTO lock_records
             (id, project_id, object_type, object_id, object_version_id, json_pointer, locked_by, locked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'lock_2',
            'project_1',
            'SHOT_CONTRACT',
            'shot_1',
            'shot_v1',
            '/cinematography',
            'USER',
            NOW,
          ),
      ).toThrow();
      database
        .prepare(
          `INSERT INTO dependency_edges
           (id, project_id, upstream_type, upstream_id, upstream_version_id,
            downstream_type, downstream_id, downstream_version_id, dependency_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'edge_1',
          'project_1',
          'STORY_BIBLE',
          'project_1',
          'bible_v1',
          'SHOT_CONTRACT',
          'shot_1',
          'shot_v1',
          'GENERATED_FROM',
          NOW,
        );
      expect(() =>
        database
          .prepare(
            `INSERT INTO dependency_edges
             (id, project_id, upstream_type, upstream_id, upstream_version_id,
              downstream_type, downstream_id, downstream_version_id, dependency_type, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'edge_2',
            'project_1',
            'STORY_BIBLE',
            'project_1',
            'bible_v1',
            'SHOT_CONTRACT',
            'shot_1',
            'shot_v1',
            'GENERATED_FROM',
            NOW,
          ),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO audit_events
             (id, project_id, actor, action, object_type, object_id, metadata_json, trace_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'audit_1',
            'project_1',
            'SYSTEM',
            'TEST',
            'PROJECT',
            'project_1',
            '{',
            'trace_1',
            NOW,
          ),
      ).toThrow();
      const auditColumns = database.pragma('table_info(audit_events)') as readonly {
        readonly name: string;
      }[];
      expect(auditColumns.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining(['api_key', 'prompt_text', 'raw_response']),
      );
      expect(() =>
        database
          .prepare(
            'INSERT INTO shot_derivations (new_shot_id, source_shot_id, operation, created_at) VALUES (?, ?, ?, ?)',
          )
          .run('shot_1', 'shot_1', 'INVALID', NOW),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            'INSERT INTO shot_derivations (new_shot_id, source_shot_id, operation, created_at) VALUES (?, ?, ?, ?)',
          )
          .run('shot_1', 'shot_1', 'COPY', NOW),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO shot_contract_versions
             (id, shot_id, version_no, parent_id, lineage_resolution_status, sequence, version_status,
              format_profile_id, target_duration_sec, dialogue_render_mode, document_json, document_sha256, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'shot_v2',
            'shot_1',
            2,
            'shot_v1',
            'LOCAL_VERIFIED',
            2,
            'DRAFT',
            'format_1',
            8,
            'NARRATION_FIRST',
            JSON.stringify({
              contract_version: 2,
              dialogue: { dialogue_render_mode: 'NARRATION_FIRST' },
              format_profile_id: 'format_1',
              parent_version_id: 'shot_v1',
              sequence: 99,
              shot_id: 'shot_1',
              status: 'DRAFT',
              target_duration_sec: 8,
              version_id: 'shot_v2',
            }),
            'sha_shot_v2',
            NOW,
          ),
      ).toThrow();
      database
        .prepare(
          'INSERT INTO episode_version_shots (episode_version_id, shot_id, shot_version_id, sequence) VALUES (?, ?, ?, ?)',
        )
        .run('episode_v1', 'shot_1', 'shot_v1', 1);
      database
        .prepare(
          'INSERT INTO shots (id, episode_id, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('shot_2', 'episode_1', 'ACTIVE', NOW, NOW);
      expect(() =>
        database
          .prepare(
            'INSERT INTO episode_version_shots (episode_version_id, shot_id, shot_version_id, sequence) VALUES (?, ?, ?, ?)',
          )
          .run('episode_v1', 'shot_2', 'shot_v1', 1),
      ).toThrow();
    });
  });

  it('导入评测和本地分析—写入非法状态或 JSON—由约束拒绝', async () => {
    await withMigratedDatabase((database) => {
      seedProjectGraph(database);
      expect(() =>
        database
          .prepare(
            `INSERT INTO import_records
             (id, import_mode, source_path, source_sha256, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run('import_1', 'NEW_PROJECT', 'source.json', 'sha_source', 'UNKNOWN', NOW),
      ).toThrow();
      database
        .prepare(
          `INSERT INTO import_records
           (id, import_mode, source_path, source_sha256, status, created_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('import_success_1', 'NEW_PROJECT', 'source.json', 'sha_source', 'SUCCEEDED', NOW, NOW);
      expect(() =>
        database
          .prepare(
            `INSERT INTO import_records
             (id, import_mode, source_path, source_sha256, status, created_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'import_success_2',
            'NEW_PROJECT',
            'source-again.json',
            'sha_source',
            'SUCCEEDED',
            NOW,
            NOW,
          ),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO evaluation_samples
             (id, sample_type, input_json, expected_json, authorization_status, dedup_key, dataset_split, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('sample_1', 'SHOT_CONTRACT', '{', '{}', 'AUTHORIZED', 'dedup', 'TRAIN', NOW),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            'INSERT INTO analytics_events (id, event_name, session_id, properties_json, occurred_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run('event_1', 'startup', 'session_1', '{', NOW),
      ).toThrow();
    });
  });

  it('不可变版本—尝试原地 UPDATE—四类版本均拒绝但允许 INSERT 新版本', async () => {
    await withMigratedDatabase((database) => {
      seedProjectGraph(database);
      const updates = [
        ['story_bible_versions', 'bible_v1'],
        ['script_versions', 'script_v1'],
        ['episode_versions', 'episode_v1'],
        ['shot_contract_versions', 'shot_v1'],
      ] as const;
      for (const [table, id] of updates) {
        expect(() =>
          database.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(NOW, id),
        ).toThrow('IMMUTABLE_VERSION_ROW');
      }
      expect(() =>
        database
          .prepare(
            `INSERT INTO story_bible_versions
             (id, project_id, version_no, parent_id, document_json, document_sha256, status, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('bible_v2', 'project_1', 2, 'bible_v1', '{}', 'sha_bible_v2', 'DRAFT', 'USER', NOW),
      ).not.toThrow();
    });
  });
});
