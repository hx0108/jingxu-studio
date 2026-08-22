import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  EvaluationAnnotationRepositoryPort,
  EvaluationRepositories,
  EvaluationRulesPort,
  EvaluationSampleRepositoryPort,
  EvaluationUnitOfWorkPort,
} from './index';
import type { EvaluationSampleRecord } from './evaluation-types';

const sampleRecord = {
  id: 'eval_sample_0001',
  projectId: null,
  sampleType: 'SHOT_CONTRACT',
  input: {
    candidate: { document: {}, kind: 'SHOT_CONTRACT' },
    context: {},
  },
  expected: { acceptable: true, expectedIssueCodes: [], referenceContract: null },
  authorization: 'SYNTHETIC',
  dedupKey: 'seed-synthetic-shot-01',
  datasetSplit: 'TRAIN',
  ruleHits: [],
  ruleVersion: 'jingxu-producibility-rules/1',
  createdAt: '2026-08-22T00:00:00.000Z',
} satisfies EvaluationSampleRecord;

describe('Evaluation Application Ports', () => {
  it('条件—样本行投影—只暴露领域字段，不含 Row/路径/连接', () => {
    expect(sampleRecord.dedupKey).toBe('seed-synthetic-shot-01');
    expect(sampleRecord).not.toHaveProperty('row');
    expect(sampleRecord).not.toHaveProperty('connection');
    expect(sampleRecord).not.toHaveProperty('sourcePath');
  });

  it('条件—规则引擎 Port—同步纯函数签名（零 I/O、零时钟）', () => {
    const rules: EvaluationRulesPort = {
      evaluate: () => ({
        hits: [],
        ruleVersion: 'jingxu-producibility-rules/1',
      }),
    };
    const result = rules.evaluate(sampleRecord.input);
    expect(result.ruleVersion).toBe('jingxu-producibility-rules/1');
  });

  it('条件—UoW 聚合—评测两表 + 审计 + 派生只读投影可在同一事务访问', async () => {
    const repositories = {
      samples: {} as EvaluationSampleRepositoryPort,
      annotations: {} as EvaluationAnnotationRepositoryPort,
      audit: {} as EvaluationRepositories['audit'],
      projects: {} as EvaluationRepositories['projects'],
      episodes: {} as EvaluationRepositories['episodes'],
      episodeVersions: {} as EvaluationRepositories['episodeVersions'],
      shotContractVersions: {} as EvaluationRepositories['shotContractVersions'],
      stageHeads: {} as EvaluationRepositories['stageHeads'],
    } satisfies EvaluationRepositories;
    const unitOfWork: EvaluationUnitOfWorkPort = {
      run: async (work) => work(repositories),
    };
    await expect(
      unitOfWork.run((repo) => Promise.resolve(Object.keys(repo).length >= 8)),
    ).resolves.toBe(true);
  });

  it('条件—标注/样本仓储—没有 UPDATE 方法（追加式与留痕不可变的端口级保证）', () => {
    expectTypeOf<EvaluationAnnotationRepositoryPort>().not.toHaveProperty('update');
    expectTypeOf<EvaluationSampleRepositoryPort>().not.toHaveProperty('update');
  });
});
