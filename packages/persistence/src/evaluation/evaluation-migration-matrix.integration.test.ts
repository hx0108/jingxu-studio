import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import {
  SqliteEvaluationAnnotationRepository,
  SqliteEvaluationSampleRepository,
} from './sqlite-evaluation-repositories';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-22T00:00:00.000Z';

/**
 * 0016→0017 前向迁移与播种矩阵（storyboard-evaluation-set 3.3）：
 * 老库（仅 0001–0016）带着 0016 语义评测行无损升到 0017；重复应用零副作用；
 * 种子参与全局 dedup 与 CHECK 兜底；删除种子行级联其 SYSTEM_SEED 标注。
 */
const withMatrixDatabase = async <T>(
  initialMigrations: number,
  operation: (database: SqliteTestDatabase) => T | Promise<T>,
): Promise<T> =>
  withSqliteTestContext(async (context) => {
    const database = new SqliteTestDatabase(path.join(context.root, 'evaluation-matrix.sqlite'));
    try {
      database.pragma('foreign_keys = ON');
      const migrations = await loadMigrationSet(MIGRATION_DIRECTORY);
      applyMigrations(database, migrations.slice(0, initialMigrations), () => NOW);
      return await operation(database);
    } finally {
      database.close();
    }
  });

const insertLegacySampleRow = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO evaluation_samples
       (id, project_id, sample_type, input_json, expected_json, authorization_status,
        dedup_key, dataset_split, created_at)
       VALUES ('eval_legacy0016', NULL, 'SHOT_CONTRACT',
               '{"candidate":{"kind":"SHOT_CONTRACT","document":{"shot_id":"shot_legacy"}},"context":{}}',
               '{"acceptable":true,"expectedIssueCodes":[],"referenceContract":null}',
               'SYNTHETIC', 'ut-legacy-0016', 'TRAIN', ?)`,
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO evaluation_annotations (id, sample_id, guideline_version, label_json, rationale, annotator, created_at)
       VALUES ('anno_legacy0016', 'eval_legacy0016', 'jingxu-annotation-guideline/1',
               '{"issueCodes":[],"severity":null,"verdict":"ACCEPTABLE"}', '0016 语义历史标注', '贺星', ?)`,
    )
    .run(NOW);
};

const countRows = (database: SqliteTestDatabase, table: string): number =>
  (
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      readonly count: number;
    }
  ).count;

describe('0016→0017 前向迁移与播种矩阵（storyboard-evaluation-set 3.3）', () => {
  it('0016 库带历史评测行无损升级—旧行原样、rule 列 NULL、种子补齐、版本到 19', async () => {
    await withMatrixDatabase(16, async (database) => {
      // 0016 语义：两表存在但尚无 rule_hits 列。
      const columnsBefore = database
        .prepare('PRAGMA table_info(evaluation_samples)')
        .all() as unknown as readonly { readonly name: string }[];
      expect(columnsBefore.map(({ name }) => name)).not.toContain('rule_hits_json');
      insertLegacySampleRow(database);
      expect(countRows(database, 'evaluation_samples')).toBe(1);

      const migrations = await loadMigrationSet(MIGRATION_DIRECTORY);
      applyMigrations(database, migrations, () => NOW);

      const versions = database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as unknown as readonly { readonly version: number }[];
      expect(versions).toHaveLength(19);
      expect(versions.at(-1)?.version).toBe(19);

      // 旧行原样保留且读侧不虚构命中；种子 24 行补齐，标注 = 24 种子 + 1 历史。
      const legacy = await new SqliteEvaluationSampleRepository(database).findById(
        'eval_legacy0016',
      );
      expect(legacy?.dedupKey).toBe('ut-legacy-0016');
      expect(legacy?.ruleHits).toBeNull();
      expect(legacy?.ruleVersion).toBeNull();
      expect(countRows(database, 'evaluation_samples')).toBe(25);
      expect(countRows(database, 'evaluation_annotations')).toBe(25);
    });
  });

  it('重复应用迁移零副作用—schema_migrations 单次执行，种子不重复', async () => {
    await withMatrixDatabase(17, async (database) => {
      const plan = applyMigrations(
        database,
        await loadMigrationSet(MIGRATION_DIRECTORY),
        () => NOW,
      );
      expect(plan.currentVersion).toBe(19);
      expect(plan.pending).toHaveLength(0);
      expect(countRows(database, 'evaluation_samples')).toBe(24);
      expect(countRows(database, 'evaluation_annotations')).toBe(24);
    });
  });

  it('种子参与全局 dedup—findByDedupKey 命中种子，同键直插被 UNIQUE 拒绝', async () => {
    await withMatrixDatabase(17, async (database) => {
      const repository = new SqliteEvaluationSampleRepository(database);
      const seed = await repository.findByDedupKey('seed-synthetic-shot-7');
      expect(seed?.id).toBe('eval_seed0007');

      expect(() =>
        database
          .prepare(
            `INSERT INTO evaluation_samples
             (id, project_id, sample_type, input_json, expected_json, authorization_status,
              dedup_key, dataset_split, created_at)
             VALUES ('eval_dup0001', NULL, 'SHOT_CONTRACT', '{}', '{}', 'SYNTHETIC',
                     'seed-synthetic-shot-7', 'TRAIN', ?)`,
          )
          .run(NOW),
      ).toThrow();
      expect(countRows(database, 'evaluation_samples')).toBe(24);
    });
  });

  it('DDL CHECK 兜底—非法 dataset_split 直插被拒且零残留', async () => {
    await withMatrixDatabase(17, (database) => {
      expect(() =>
        database
          .prepare(
            `INSERT INTO evaluation_samples
             (id, project_id, sample_type, input_json, expected_json, authorization_status,
              dedup_key, dataset_split, created_at)
             VALUES ('eval_bad0001', NULL, 'SHOT_CONTRACT', '{}', '{}', 'SYNTHETIC',
                     'ut-bad-split', 'HOLDOUT', ?)`,
          )
          .run(NOW),
      ).toThrow();
      expect(countRows(database, 'evaluation_samples')).toBe(24);
    });
  });

  it('删除种子行—SYSTEM_SEED 标注级联，其余种子不受影响', async () => {
    await withMatrixDatabase(17, async (database) => {
      const samples = new SqliteEvaluationSampleRepository(database);
      const annotations = new SqliteEvaluationAnnotationRepository(database);

      const deleted = await samples.deleteById('eval_seed0003');
      expect(deleted).toBe(1);
      expect(await annotations.listBySampleId('eval_seed0003')).toHaveLength(0);
      expect(countRows(database, 'evaluation_samples')).toBe(23);
      expect(countRows(database, 'evaluation_annotations')).toBe(23);
      expect((await samples.findById('eval_seed0004'))?.id).toBe('eval_seed0004');
    });
  });
});
