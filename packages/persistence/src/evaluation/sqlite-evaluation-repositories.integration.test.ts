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
  dedupKey: 'seed-synthetic-shot-1',
  expected: { acceptable: true, expectedIssueCodes: [], referenceContract: null },
  id: 'eval_seed0001',
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
                   'seed-synthetic-shot-legacy', 'TRAIN', NULL, NULL, ?)`,
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
      insertProjectRow(database);
      const repository = new SqliteEvaluationSampleRepository(database);
      await repository.insert(sampleRecord({ dedupKey: 'seed-synthetic-shot-1' }));
      await repository.insert(
        sampleRecord({
          id: 'eval_seed0002',
          projectId: 'project_eval1',
          datasetSplit: 'VALIDATION',
          dedupKey: 'seed-synthetic-shot-2',
          sampleType: 'EPISODE_STORYBOARD',
        }),
      );
      await repository.insert(
        sampleRecord({
          id: 'eval_seed0003',
          datasetSplit: 'TEST',
          dedupKey: 'seed-synthetic-shot-3',
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
      expect(projectScoped[0]?.id).toBe('eval_seed0002');
      expect(shotTrain).toHaveLength(1);
      expect(shotTrain[0]?.id).toBe('eval_seed0001');
    });
  });

  it('dedup_key 唯一约束—重复插入被数据库拒绝且零残留', async () => {
    await withMigratedDatabase(async (database) => {
      const repository = new SqliteEvaluationSampleRepository(database);
      await repository.insert(sampleRecord());
      await expect(repository.insert(sampleRecord({ id: 'eval_seed0009' }))).rejects.toThrow();
      const remaining = await repository.list({ scope: 'ALL' });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe('eval_seed0001');
    });
  });

  it('删除级联—标注随样本删除并返回行数；不存在返回 null', async () => {
    await withMigratedDatabase(async (database) => {
      const samples = new SqliteEvaluationSampleRepository(database);
      const annotations = new SqliteEvaluationAnnotationRepository(database);
      await samples.insert(sampleRecord());
      await annotations.insert(annotationRecord('eval_seed0001'));
      await annotations.insert(
        annotationRecord('eval_seed0001', { id: 'anno_second001', createdAt: NOW }),
      );

      const missing = await samples.deleteById('eval_missing0');
      expect(missing).toBeNull();

      const deleted = await samples.deleteById('eval_seed0001');
      expect(deleted).toBe(2);
      expect(await samples.list({ scope: 'ALL' })).toHaveLength(0);
      expect(await annotations.listBySampleId('eval_seed0001')).toHaveLength(0);
    });
  });

  it('标注追加与时间序读取', async () => {
    await withMigratedDatabase(async (database) => {
      const samples = new SqliteEvaluationSampleRepository(database);
      const annotations = new SqliteEvaluationAnnotationRepository(database);
      await samples.insert(sampleRecord());
      await annotations.insert(
        annotationRecord('eval_seed0001', {
          id: 'anno_late0001',
          createdAt: '2026-08-22T02:00:00.000Z',
        }),
      );
      await annotations.insert(
        annotationRecord('eval_seed0001', {
          id: 'anno_early001',
          createdAt: '2026-08-22T01:00:00.000Z',
        }),
      );
      const listed = await annotations.listBySampleId('eval_seed0001');
      expect(listed.map((record) => record.id)).toEqual(['anno_early001', 'anno_late0001']);
      expect(listed[0]?.label.verdict).toBe('ACCEPTABLE');
    });
  });

  it('UnitOfWork—审计与样本同事务提交；中途抛出全量回滚零残留', async () => {
    await withMigratedDatabase(async (database) => {
      const unitOfWork = new SqliteEvaluationUnitOfWork(database);

      await unitOfWork.run(async (repositories) => {
        await repositories.samples.insert(sampleRecord());
        await repositories.audit.record({
          id: 'audit_eval0001',
          projectId: null,
          actor: 'USER',
          action: 'EVALUATION_SAMPLE_CREATED',
          objectType: 'EVALUATION_SAMPLE',
          objectId: 'eval_seed0001',
          objectVersionId: null,
          beforeSha256: null,
          afterSha256: null,
          metadata: { dedupKey: 'seed-synthetic-shot-1' },
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
            sampleRecord({ id: 'eval_seed0099', dedupKey: 'seed-synthetic-shot-99' }),
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
      dedup_key: 'seed-synthetic-shot-row',
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
