import { describe, expect, it } from 'vitest';

import {
  EVALUATION_GUIDELINE_VERSION,
  EVALUATION_IPC_CHANNELS,
  evaluationAddAnnotationInputSchema,
  evaluationCreateSampleInputSchema,
  evaluationExpectedSchema,
  evaluationImportBatchResultSchema,
  evaluationIssueCodeSchema,
  evaluationListSamplesInputSchema,
  evaluationSampleDetailSchema,
  evaluationSampleInputSchema,
} from './evaluation-api';

const projectId = 'project_eval_0001';
const requestId = 'request_eval_0001';
const sampleId = 'eval_sample_0001';

/** 最小合法样本信封（SHOT_CONTRACT 候选 + 按 kind 裁剪的最小上下文）。 */
const sampleInput = {
  candidate: {
    document: { shotId: 'shot_001', dialogue: [], durationSec: 4 },
    kind: 'SHOT_CONTRACT' as const,
  },
  context: {
    characters: ['char_001', 'char_002'],
    dialogueRenderMode: 'NARRATION_FIRST' as const,
    previousShotSummary: null,
    scenes: ['scene_001'],
  },
};

describe('evaluation contracts', () => {
  it('accepts strict create/list/detail/annotation DTOs', () => {
    expect(
      evaluationCreateSampleInputSchema.parse({
        authorization: 'SYNTHETIC',
        datasetSplit: 'TRAIN',
        dedupKey: 'seed-synthetic-shot-01',
        expected: {
          acceptable: false,
          expectedIssueCodes: ['EVAL_ISSUE_DURATION_DEVIATION'],
          referenceContract: null,
        },
        input: sampleInput,
        projectId: null,
      }),
    ).toMatchObject({ dedupKey: 'seed-synthetic-shot-01' });
    expect(
      evaluationListSamplesInputSchema.parse({
        datasetSplit: 'TEST',
        projectId,
        scope: 'PROJECT',
      }),
    ).toEqual({ datasetSplit: 'TEST', projectId, scope: 'PROJECT' });
    expect(
      evaluationSampleDetailSchema.parse({
        acceptable: false,
        annotations: [],
        authorization: 'SYNTHETIC',
        createdAt: '2026-08-22T00:00:00+08:00',
        datasetSplit: 'TRAIN',
        dedupKey: 'seed-synthetic-shot-01',
        expected: { acceptable: false, expectedIssueCodes: [], referenceContract: null },
        hitCodes: ['EVAL_ISSUE_DURATION_DEVIATION'],
        hits: [
          {
            code: 'EVAL_ISSUE_DURATION_DEVIATION',
            detail: '镜头时长 7s 偏离软带',
            path: 'durationSec',
          },
        ],
        input: sampleInput,
        latestAnnotation: null,
        projectId: null,
        ruleVersion: 'jingxu-producibility-rules/1',
        sampleId,
        sampleType: 'SHOT_CONTRACT',
      }),
    ).toMatchObject({ ruleVersion: 'jingxu-producibility-rules/1' });
    expect(
      evaluationAddAnnotationInputSchema.parse({
        annotator: 'alice',
        guidelineVersion: EVALUATION_GUIDELINE_VERSION,
        label: { issueCodes: [], severity: null, verdict: 'ACCEPTABLE' },
        rationale: '全部规则通过且人工复核无异议',
        requestId,
        sampleId,
      }),
    ).toMatchObject({ annotator: 'alice' });
  });

  it('pins the eleven stable issue codes (nine PRD §9.9 categories plus engine extras)', () => {
    expect(evaluationIssueCodeSchema.options).toEqual([
      'EVAL_ISSUE_MISSING_REQUIRED',
      'EVAL_ISSUE_ENUM_INVALID',
      'EVAL_ISSUE_DURATION_DEVIATION',
      'EVAL_ISSUE_CHARACTER_OVERFLOW',
      'EVAL_ISSUE_COMPLEX_ACTION',
      'EVAL_ISSUE_DIALOGUE_MODE_CONFLICT',
      'EVAL_ISSUE_CONTINUITY_INVALID',
      'EVAL_ISSUE_CAPABILITY_UNKNOWN',
      'EVAL_ISSUE_LOCK_CONFLICT',
      'EVAL_ISSUE_SCHEMA_INVALID',
      'EVAL_ISSUE_PRODUCIBILITY_WARN',
    ]);
  });

  it('rejects unknown fields and invalid enums across the envelope', () => {
    expect(() =>
      evaluationCreateSampleInputSchema.parse({
        authorization: 'SYNTHETIC',
        datasetSplit: 'TRAIN',
        dedupKey: 'seed-synthetic-shot-01',
        expected: { acceptable: false, expectedIssueCodes: [], referenceContract: null },
        input: sampleInput,
        path: 'C:\\secret\\sample.json',
        projectId: null,
      }),
    ).toThrow();
    expect(() =>
      evaluationSampleInputSchema.parse({
        candidate: { document: {}, kind: 'STORYBOARD' },
        context: {},
      }),
    ).toThrow();
    expect(() =>
      evaluationCreateSampleInputSchema.parse({
        authorization: 'UNKNOWN',
        datasetSplit: 'TRAIN',
        dedupKey: 'seed-synthetic-shot-01',
        expected: { acceptable: false, expectedIssueCodes: [], referenceContract: null },
        input: sampleInput,
      }),
    ).toThrow();
    expect(() =>
      evaluationCreateSampleInputSchema.parse({
        authorization: 'SYNTHETIC',
        datasetSplit: 'REGRESSION',
        dedupKey: 'seed-synthetic-shot-01',
        expected: { acceptable: false, expectedIssueCodes: [], referenceContract: null },
        input: sampleInput,
      }),
    ).toThrow();
    expect(() => evaluationListSamplesInputSchema.parse({ scope: 'EVERYTHING' })).toThrow();
  });

  it('rejects legacy issue-code naming, bad dedup keys and unversioned guidelines', () => {
    // 旧命名（design 草稿期的 EVAL_RULE_*）不得混入，稳定码漂移必须显式失败。
    expect(() =>
      evaluationExpectedSchema.parse({
        acceptable: false,
        expectedIssueCodes: ['EVAL_RULE_MISSING_REQUIRED'],
        referenceContract: null,
      }),
    ).toThrow();
    // project/version/shot 均可为带前缀 UUID；正式派生键必须通过回执复验。
    expect(
      evaluationCreateSampleInputSchema.parse({
        authorization: 'SYNTHETIC',
        datasetSplit: 'TRAIN',
        dedupKey: `derive:project_${'a'.repeat(36)}:episode_${'b'.repeat(36)}:shot_${'c'.repeat(36)}`,
        expected: { acceptable: false, expectedIssueCodes: [], referenceContract: null },
        input: sampleInput,
      }).dedupKey,
    ).toMatch(/^derive:/u);
    expect(() =>
      evaluationCreateSampleInputSchema.parse({
        authorization: 'SYNTHETIC',
        datasetSplit: 'TRAIN',
        dedupKey: 'd'.repeat(193),
        expected: { acceptable: false, expectedIssueCodes: [], referenceContract: null },
        input: sampleInput,
      }),
    ).toThrow();
    expect(() =>
      evaluationCreateSampleInputSchema.parse({
        authorization: 'SYNTHETIC',
        datasetSplit: 'TRAIN',
        dedupKey: 'C:\\evil\\path',
        expected: { acceptable: false, expectedIssueCodes: [], referenceContract: null },
        input: sampleInput,
      }),
    ).toThrow();
    expect(() =>
      evaluationCreateSampleInputSchema.parse({
        authorization: 'SYNTHETIC',
        datasetSplit: 'TRAIN',
        dedupKey: 'x',
        expected: { acceptable: false, expectedIssueCodes: [], referenceContract: null },
        input: sampleInput,
      }),
    ).toThrow();
    expect(() =>
      evaluationAddAnnotationInputSchema.parse({
        annotator: 'alice',
        guidelineVersion: 'latest',
        label: { issueCodes: [], severity: null, verdict: 'ACCEPTABLE' },
        rationale: 'ok',
        requestId,
        sampleId,
      }),
    ).toThrow();
  });

  it('keeps import receipts free of paths and SQL (path red line at contract level)', () => {
    expect(
      evaluationImportBatchResultSchema.parse({
        items: [
          {
            dedupKey: 'seed-synthetic-shot-01',
            reason: null,
            sampleId,
            status: 'CREATED',
          },
        ],
      }),
    ).toMatchObject({ items: [{ status: 'CREATED' }] });
    expect(() =>
      evaluationImportBatchResultSchema.parse({
        items: [
          {
            dedupKey: 'seed-synthetic-shot-01',
            reason: null,
            sampleId,
            sql: 'SELECT * FROM evaluation_samples',
            status: 'CREATED',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      evaluationImportBatchResultSchema.parse({
        items: [
          {
            dedupKey: 'seed-synthetic-shot-01',
            reason: null,
            sampleId,
            sourcePath: 'C:\\secret\\batch.json',
            status: 'CREATED',
          },
        ],
      }),
    ).toThrow();
  });

  it('exposes exactly the seven frozen evaluation channels', () => {
    expect(Object.keys(EVALUATION_IPC_CHANNELS).sort()).toEqual([
      'addAnnotation',
      'createFromEpisode',
      'createSample',
      'deleteSample',
      'getSample',
      'importBatch',
      'listSamples',
    ]);
  });
});
