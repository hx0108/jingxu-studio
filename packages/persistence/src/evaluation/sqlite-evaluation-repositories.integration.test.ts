import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EvaluationAnnotationRecord, EvaluationSampleRecord } from '@jingxu/application';

import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { mapEvaluationAnnotationRow, mapEvaluationSampleRow } from './evaluation-row-mappers';
import {
  SqliteEvaluationAnnotationRepository,
  SqliteEvaluationSampleRepository,
} from './sqlite-evaluation-repositories';
import { SqliteEvaluationUnitOfWork } from './sqlite-evaluation-unit-of-work';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-22T00:00:00.000Z';
const RULE_VERSION = 'jingxu-producibility-rules/1';

const openMigratedDatabase = async (root: string): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, 'evaluation.sqlite'));
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

/** 0017 播种后计数敏感用例先清种子行（种子核对独立用例保留原样）。 */
const clearEvaluationRows = (database: SqliteTestDatabase): void => {
  database.exec('DELETE FROM evaluation_annotations; DELETE FROM evaluation_samples;');
};

const insertProjectRow = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel,
        created_at, updated_at)
       VALUES ('project_eval1', '评测项目', 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO',
               'projects/project_eval1', ?, ?)`,
    )
    .run(NOW, NOW);
};

const sampleRecord = (overrides: Partial<EvaluationSampleRecord> = {}): EvaluationSampleRecord => ({
  authorization: 'SYNTHETIC',
  createdAt: NOW,
  datasetSplit: 'TRAIN',
  dedupKey: 'ut-shot-0001',
  expected: { acceptable: true, expectedIssueCodes: [], referenceContract: null },
  id: 'eval_ut0001',
  input: {
    candidate: {
      document: {
        shot_id: 'shot_seed_001',
        content: { character_ids: ['char_lin'], scene_id: 'scene_station' },
        dialogue: { dialogue_render_mode: 'NARRATION_FIRST' },
        target_duration_sec: 6,
      },
      kind: 'SHOT_CONTRACT',
    },
    context: { characters: ['char_lin'] },
  },
  projectId: null,
  ruleHits: [{ code: 'EVAL_ISSUE_PRODUCIBILITY_WARN', detail: '正脸长对白', path: 'dialogue' }],
  ruleVersion: RULE_VERSION,
  sampleType: 'SHOT_CONTRACT',
  ...overrides,
});

const annotationRecord = (
  sampleId: string,
  overrides: Partial<EvaluationAnnotationRecord> = {},
): EvaluationAnnotationRecord => ({
  annotator: '贺星',
  createdAt: NOW,
  guidelineVersion: 'jingxu-annotation-guideline/1',
  id: `anno_${sampleId}`,
  label: { issueCodes: [], severity: null, verdict: 'ACCEPTABLE' },
  rationale: '符合指南 v1 的可接受样本',
  sampleId,
  ...overrides,
});

describe('SqliteEvaluation 仓储 + 0017（storyboard-evaluation-set 3.1）', () => {
  it('0017 迁移—rule_hits_json/rule_version 列就位，dedup/枚举约束保持', async () => {
    await withMigratedDatabase((database) => {
      const columns = database
        .prepare('PRAGMA table_info(evaluation_samples)')
        .all() as unknown as readonly { readonly name: string }[];
      const names = columns.map(({ name }) => name);
      expect(names).toEqual(expect.arrayContaining(['rule_hits_json', 'rule_version']));
      expect(names).toEqual(
        expect.arrayContaining([
          'id',
          'project_id',
          'sample_type',
          'input_json',
          'expected_json',
          'authorization_status',
          'dedup_key',
          'dataset_split',
          'created_at',
        ]),
      );
    });
  });

  it('0017 播种—24 SYNTHETIC 样本 + SYSTEM_SEED 标注，九类全覆盖且零审计', async () => {
    await withMigratedDatabase((database) => {
      interface SeedRow {
        readonly dataset_split: string;
        readonly dedup_key: string;
        readonly expected_json: string;
        readonly id: string;
        readonly rule_hits_json: string;
        readonly rule_version: string;
        readonly sample_type: string;
      }
      const samples = database
        .prepare(
          'SELECT id, sample_type, dedup_key, dataset_split, expected_json, rule_hits_json, rule_version FROM evaluation_samples',
        )
        .all() as unknown as readonly SeedRow[];
      expect(samples).toHaveLength(24);
      expect(new Set(samples.map((row) => row.dedup_key)).size).toBe(24);
      expect(samples.every((row) => row.dedup_key.startsWith('seed-synthetic-shot-'))).toBe(true);
      expect(samples.every((row) => row.rule_version === RULE_VERSION)).toBe(true);
      expect(new Set(samples.map((row) => row.dataset_split))).toEqual(
        new Set(['TRAIN', 'VALIDATION', 'TEST']),
      );
      expect(new Set(samples.map((row) => row.sample_type))).toEqual(
        new Set(['SHOT_CONTRACT', 'SCRIPT_STAGE', 'EPISODE_STORYBOARD']),
      );

      const expected = samples.map(
        (row) =>
          JSON.parse(row.expected_json) as {
            acceptable: boolean;
            expectedIssueCodes: string[];
          },
      );
      // 11 可接受（含 1 例正脸长对白 WARN 非阻断判可接受）+ 13 问题，均超 spec ≥10 门槛。
      expect(expected.filter((item) => item.acceptable)).toHaveLength(11);
      expect(expected.filter((item) => !item.acceptable)).toHaveLength(13);
      const nineCategories = [
        'EVAL_ISSUE_MISSING_REQUIRED',
        'EVAL_ISSUE_ENUM_INVALID',
        'EVAL_ISSUE_DURATION_DEVIATION',
        'EVAL_ISSUE_CHARACTER_OVERFLOW',
        'EVAL_ISSUE_COMPLEX_ACTION',
        'EVAL_ISSUE_DIALOGUE_MODE_CONFLICT',
        'EVAL_ISSUE_CONTINUITY_INVALID',
        'EVAL_ISSUE_CAPABILITY_UNKNOWN',
        'EVAL_ISSUE_LOCK_CONFLICT',
      ];
      const labeledCodes = new Set(expected.flatMap((item) => item.expectedIssueCodes));
      for (const code of nineCategories) expect(labeledCodes.has(code), code).toBe(true);
      // 命中预计算与期望结论一致：问题样本零命中即矛盾，可接受样本仅允许 WARN。
      for (const [index, row] of samples.entries()) {
        const hits = JSON.parse(row.rule_hits_json) as { code: string }[];
        if (expected[index]?.acceptable) {
          expect(
            hits.every((hit) => hit.code === 'EVAL_ISSUE_PRODUCIBILITY_WARN'),
            `seed ${row.dedup_key}`,
          ).toBe(true);
        } else {
          expect(hits.length, `seed ${row.dedup_key}`).toBeGreaterThan(0);
        }
      }

      const annotations = database
        .prepare('SELECT sample_id, guideline_version, annotator FROM evaluation_annotations')
        .all() as unknown as readonly Record<string, string>[];
      expect(annotations).toHaveLength(24);
      expect(
        annotations.every(
          (row) =>
            row.annotator === 'SYSTEM_SEED' &&
            row.guideline_version === 'jingxu-annotation-guideline/1',
        ),
      ).toBe(true);
      expect(new Set(annotations.map((row) => row.sample_id)).size).toBe(24);

      const seedAudits = database
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action LIKE 'EVALUATION_%'")
        .get() as { readonly count: number };
      expect(seedAudits.count).toBe(0);
    });
  });

  it('样本插入/回读往返—信封、期望、规则命中与版本逐字段一致', async () => {
    await withMigratedDatabase(async (database) => {
      const repository = new SqliteEvaluationSampleRepository(database);
      const record = sampleRecord();
      await repository.insert(record);
      const loaded = await repository.findById(record.id);
      expect(loaded).toEqual(record);
      const byDedup = await repository.findByDedupKey(record.dedupKey);
      expect(byDedup?.id).toBe(record.id);
    });
  });

  it('0017 前语义行—rule_hits_json/rule_version 为 NULL 时映射为 null（不虚构命中）', async () => {
    await withMigratedDatabase(async (database) => {
      database
        .prepare(
          `INSERT INTO evaluation_samples
           (id, project_id, sample_type, input_json, expected_json, authorization_status,
            dedup_key, dataset_split, rule_hits_json, rule_version, created_at)
           VALUES ('eval_legacy001', NULL, 'SHOT_CONTRACT', ?, ?, 'SYNTHETIC',
                   'ut-shot-legacy', 'TRAIN', NULL, NULL, ?)`,
        )
        .run(JSON.stringify(sampleRecord().input), JSON.stringify(sampleRecord().expected), NOW);
      const loaded = await new SqliteEvaluationSampleRepository(database).findById(
        'eval_legacy001',
      );
      expect(loaded?.ruleHits).toBeNull();
      expect(loaded?.ruleVersion).toBeNull();
    });
  });

  it('list 过滤—scope/sampleType/datasetSplit 组合', async () => {
    await withMigratedDatabase(async (database) => {
      clearEvaluationRows(database);
      insertProjectRow(database);
      const repository = new SqliteEvaluationSampleRepository(database);
      await repository.insert(sampleRecord({ dedupKey: 'ut-shot-0001' }));
      await repository.insert(
        sampleRecord({
          id: 'eval_ut0002',
          projectId: 'project_eval1',
          datasetSplit: 'VALIDATION',
          dedupKey: 'ut-shot-0002',
          sampleType: 'EPISODE_STORYBOARD',
        }),
      );
      await repository.insert(
        sampleRecord({
          id: 'eval_ut0003',
          datasetSplit: 'TEST',
          dedupKey: 'ut-shot-0003',
        }),
      );

      const all = await repository.list({ scope: 'ALL' });
      const global = await repository.list({ scope: 'GLOBAL' });
      const projectScoped = await repository.list({
        projectId: 'project_eval1',
        scope: 'PROJECT',
      });
      const shotTrain = await repository.list({
        scope: 'ALL',
        sampleType: 'SHOT_CONTRACT',
        datasetSplit: 'TRAIN',
      });
      expect(all).toHaveLength(3);
      expect(global).toHaveLength(2);
      expect(global.every((record) => record.projectId === null)).toBe(true);
      expect(projectScoped).toHaveLength(1);
      expect(projectScoped[0]?.id).toBe('eval_ut0002');
      expect(shotTrain).toHaveLength(1);
      expect(shotTrain[0]?.id).toBe('eval_ut0001');
    });
  });

  it('dedup_key 唯一约束—重复插入被数据库拒绝且零残留', async () => {
    await withMigratedDatabase(async (database) => {
      clearEvaluationRows(database);
      const repository = new SqliteEvaluationSampleRepository(database);
      await repository.insert(sampleRecord());
      await expect(repository.insert(sampleRecord({ id: 'eval_seed0009' }))).rejects.toThrow();
      const remaining = await repository.list({ scope: 'ALL' });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe('eval_ut0001');
    });
  });

  it('删除级联—标注随样本删除并返回行数；不存在返回 null', async () => {
    await withMigratedDatabase(async (database) => {
      clearEvaluationRows(database);
      const samples = new SqliteEvaluationSampleRepository(database);
      const annotations = new SqliteEvaluationAnnotationRepository(database);
      await samples.insert(sampleRecord());
      await annotations.insert(annotationRecord('eval_ut0001'));
      await annotations.insert(
        annotationRecord('eval_ut0001', { id: 'anno_second001', createdAt: NOW }),
      );

      const missing = await samples.deleteById('eval_missing0');
      expect(missing).toBeNull();

      const deleted = await samples.deleteById('eval_ut0001');
      expect(deleted).toBe(2);
      expect(await samples.list({ scope: 'ALL' })).toHaveLength(0);
      expect(await annotations.listBySampleId('eval_ut0001')).toHaveLength(0);
    });
  });

  it('标注追加与时间序读取', async () => {
    await withMigratedDatabase(async (database) => {
      const samples = new SqliteEvaluationSampleRepository(database);
      const annotations = new SqliteEvaluationAnnotationRepository(database);
      await samples.insert(sampleRecord());
      await annotations.insert(
        annotationRecord('eval_ut0001', {
          id: 'anno_late0001',
          createdAt: '2026-08-22T02:00:00.000Z',
        }),
      );
      await annotations.insert(
        annotationRecord('eval_ut0001', {
          id: 'anno_early001',
          createdAt: '2026-08-22T01:00:00.000Z',
        }),
      );
      const listed = await annotations.listBySampleId('eval_ut0001');
      expect(listed.map((record) => record.id)).toEqual(['anno_early001', 'anno_late0001']);
      expect(listed[0]?.label.verdict).toBe('ACCEPTABLE');
    });
  });

  it('UnitOfWork—审计与样本同事务提交；中途抛出全量回滚零残留', async () => {
    await withMigratedDatabase(async (database) => {
      clearEvaluationRows(database);
      const unitOfWork = new SqliteEvaluationUnitOfWork(database);

      await unitOfWork.run(async (repositories) => {
        await repositories.samples.insert(sampleRecord());
        await repositories.audit.record({
          id: 'audit_eval0001',
          projectId: null,
          actor: 'USER',
          action: 'EVALUATION_SAMPLE_CREATED',
          objectType: 'EVALUATION_SAMPLE',
          objectId: 'eval_ut0001',
          objectVersionId: null,
          beforeSha256: null,
          afterSha256: null,
          metadata: { dedupKey: 'ut-shot-0001' },
          traceId: 'req-eval-0001',
          createdAt: NOW,
        });
      });
      const committed = database
        .prepare('SELECT COUNT(*) AS count FROM audit_events WHERE action = ?')
        .get('EVALUATION_SAMPLE_CREATED') as { readonly count: number };
      expect(committed.count).toBe(1);

      await expect(
        unitOfWork.run(async (repositories) => {
          await repositories.samples.insert(
            sampleRecord({ id: 'eval_seed0099', dedupKey: 'ut-shot-0099' }),
          );
          await repositories.annotations.insert(annotationRecord('eval_seed0099'));
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const total = database.prepare('SELECT COUNT(*) AS count FROM evaluation_samples').get() as {
        readonly count: number;
      };
      const annotationTotal = database
        .prepare('SELECT COUNT(*) AS count FROM evaluation_annotations')
        .get() as { readonly count: number };
      expect(total.count).toBe(1);
      expect(annotationTotal.count).toBe(0);
    });
  });

  it('行映射归一化—非法形状/非法枚举按行损坏抛 PersistenceRuntimeError', () => {
    const baseRow = {
      id: 'eval_row0001',
      project_id: null,
      sample_type: 'SHOT_CONTRACT',
      input_json: JSON.stringify(sampleRecord().input),
      expected_json: JSON.stringify(sampleRecord().expected),
      authorization_status: 'SYNTHETIC',
      dedup_key: 'ut-shot-row',
      dataset_split: 'TRAIN',
      rule_hits_json: JSON.stringify(sampleRecord().ruleHits),
      rule_version: RULE_VERSION,
      created_at: NOW,
    } as const;

    expect(mapEvaluationSampleRow(baseRow).id).toBe('eval_row0001');
    expect(() => mapEvaluationSampleRow({ ...baseRow, input_json: '"not-an-object"' })).toThrow(
      PersistenceRuntimeError,
    );
    expect(() =>
      mapEvaluationSampleRow({ ...baseRow, rule_hits_json: '{"not":"an-array"}' }),
    ).toThrow(PersistenceRuntimeError);
    expect(() => mapEvaluationSampleRow({ ...baseRow, sample_type: 'UNKNOWN' })).toThrow(
      PersistenceRuntimeError,
    );
    expect(() => mapEvaluationSampleRow({ ...baseRow, project_id: 42 })).toThrow(
      PersistenceRuntimeError,
    );

    const annotationRow = {
      id: 'anno_row0001',
      sample_id: 'eval_row0001',
      guideline_version: 'jingxu-annotation-guideline/1',
      label_json: JSON.stringify({ issueCodes: [], severity: null, verdict: 'ACCEPTABLE' }),
      rationale: '符合指南',
      annotator: '贺星',
      created_at: NOW,
    } as const;
    expect(mapEvaluationAnnotationRow(annotationRow).sampleId).toBe('eval_row0001');
    expect(() => mapEvaluationAnnotationRow({ ...annotationRow, label_json: '[1,2]' })).toThrow(
      PersistenceRuntimeError,
    );
  });
});
