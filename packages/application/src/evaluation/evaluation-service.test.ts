import type { EvaluationCreateSampleInputDto, EvaluationRuleHitDto } from '@jingxu/contracts';
import type { Project } from '@jingxu/domain';
import { describe, expect, it } from 'vitest';

import type {
  Episode,
  EpisodeVersion,
  EpisodeVersionShot,
  ScriptAuditEntry,
  ShotContractVersion,
} from '../ports/script';
import type {
  EvaluationAnnotationRecord,
  EvaluationSampleRecord,
} from '../ports/evaluation/evaluation-types';
import type { EvaluationRepositories, EvaluationUnitOfWorkPort } from '../ports/evaluation';

import { createEvaluationService } from './evaluation-service';

const NOW = '2026-08-22T12:00:00.000+08:00';
const RULE_VERSION = 'jingxu-producibility-rules/1';

const shotDocumentA = {
  shot_id: 'shot_ep01_001',
  content: { character_ids: ['char_lin'], scene_id: 'scene_station' },
  dialogue: { dialogue_render_mode: 'NARRATION_FIRST' },
  target_duration_sec: 6,
};
const shotDocumentB = {
  shot_id: 'shot_ep01_002',
  content: { character_ids: ['char_su'], scene_id: 'scene_train' },
  dialogue: { dialogue_render_mode: 'NARRATION_FIRST' },
  target_duration_sec: 8,
};

interface Harness {
  readonly service: ReturnType<typeof createEvaluationService>;
  readonly samples: EvaluationSampleRecord[];
  readonly annotations: EvaluationAnnotationRecord[];
  readonly audits: ScriptAuditEntry[];
  readonly project: Project;
  readonly episode: Episode;
  readonly episodeVersion: EpisodeVersion;
}

const createHarness = (
  options: {
    hits?: readonly EvaluationRuleHitDto[];
    versionStatus?: EpisodeVersion['status'];
  } = {},
): Harness => {
  const samples: EvaluationSampleRecord[] = [];
  const annotations: EvaluationAnnotationRecord[] = [];
  const audits: ScriptAuditEntry[] = [];
  let counter = 0;
  const newId = (): string => `gen${(counter += 1).toString().padStart(6, '0')}`;

  const project: Project = {
    id: 'project_eval0001',
    name: '评测项目',
    genre: null,
    style: null,
    creationMode: 'AI_ORIGINAL',
    dialogueRenderMode: 'NARRATION_FIRST',
    deploymentMode: 'LOCAL_DEMO',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
  const episode: Episode = {
    id: 'episode_eval0001',
    projectId: project.id,
    title: '第一集',
    targetDurationSec: 90,
    currentVersionId: 'epv_eval0001',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
  const episodeVersion: EpisodeVersion = {
    id: 'epv_eval0001',
    episodeId: episode.id,
    versionNo: 1,
    parentId: null,
    storyBibleVersionId: 'sbv_eval0001',
    formatProfileId: 'format_eval0001',
    targetDurationSec: 90,
    shotSetHash: 'shothash0001',
    status: options.versionStatus ?? 'READY',
    createdAt: NOW,
  };
  const links: readonly EpisodeVersionShot[] = [
    {
      episodeVersionId: episodeVersion.id,
      shotId: 'shot_ep01_001',
      shotVersionId: 'scv_eval0001',
      sequence: 1,
    },
    {
      episodeVersionId: episodeVersion.id,
      shotId: 'shot_ep01_002',
      shotVersionId: 'scv_eval0002',
      sequence: 2,
    },
  ];
  const shotVersions: Readonly<Record<string, ShotContractVersion>> = {
    scv_eval0001: {
      id: 'scv_eval0001',
      shotId: 'shot_ep01_001',
      versionNo: 1,
      parentId: null,
      externalParentVersionId: null,
      lineageResolutionStatus: 'ROOT',
      sequence: 1,
      versionStatus: 'READY',
      formatProfileId: 'format_eval0001',
      targetDurationSec: 6,
      dialogueRenderMode: 'NARRATION_FIRST',
      document: JSON.stringify(shotDocumentA),
      documentSha256: 'sha0000000001',
      sourceInvocationId: null,
      createdAt: NOW,
    },
    scv_eval0002: {
      id: 'scv_eval0002',
      shotId: 'shot_ep01_002',
      versionNo: 1,
      parentId: null,
      externalParentVersionId: null,
      lineageResolutionStatus: 'ROOT',
      sequence: 2,
      versionStatus: 'READY',
      formatProfileId: 'format_eval0001',
      targetDurationSec: 8,
      dialogueRenderMode: 'NARRATION_FIRST',
      document: JSON.stringify(shotDocumentB),
      documentSha256: 'sha0000000002',
      sourceInvocationId: null,
      createdAt: NOW,
    },
  };

  const removeAnnotationsOf = (sampleId: string): number => {
    const removed = annotations.filter((annotation) => annotation.sampleId === sampleId);
    for (const annotation of removed) {
      annotations.splice(annotations.indexOf(annotation), 1);
    }
    return removed.length;
  };

  const repositories: EvaluationRepositories = {
    samples: {
      list: (filter) =>
        Promise.resolve(
          samples
            .filter((record) =>
              filter.scope === 'ALL'
                ? true
                : filter.scope === 'GLOBAL'
                  ? record.projectId === null
                  : record.projectId === (filter.projectId ?? null),
            )
            .filter(
              (record) => filter.sampleType == null || record.sampleType === filter.sampleType,
            )
            .filter(
              (record) =>
                filter.datasetSplit == null || record.datasetSplit === filter.datasetSplit,
            ),
        ),
      findById: (id) => Promise.resolve(samples.find((record) => record.id === id) ?? null),
      findByDedupKey: (dedupKey) =>
        Promise.resolve(samples.find((record) => record.dedupKey === dedupKey) ?? null),
      insert: (record) => {
        samples.push(record);
        return Promise.resolve();
      },
      deleteById: (id) => {
        const index = samples.findIndex((record) => record.id === id);
        if (index === -1) return Promise.resolve(null);
        samples.splice(index, 1);
        return Promise.resolve(removeAnnotationsOf(id));
      },
    },
    annotations: {
      listBySampleId: (sampleId) =>
        Promise.resolve(
          annotations
            .filter((annotation) => annotation.sampleId === sampleId)
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        ),
      insert: (record) => {
        annotations.push(record);
        return Promise.resolve();
      },
      deleteBySampleId: (sampleId) => Promise.resolve(removeAnnotationsOf(sampleId)),
    },
    audit: {
      record: (entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    },
    projects: {
      findById: (id) => Promise.resolve(id === project.id ? project : null),
    },
    episodes: {
      findById: (id) => Promise.resolve(id === episode.id ? episode : null),
    },
    episodeVersions: {
      findById: (id) => Promise.resolve(id === episodeVersion.id ? episodeVersion : null),
      listShotLinks: (id) => Promise.resolve(id === episodeVersion.id ? links : []),
    },
    shotContractVersions: {
      findById: (id) => Promise.resolve(shotVersions[id] ?? null),
    },
  };
  const unitOfWork: EvaluationUnitOfWorkPort = {
    run: (work) => work(repositories),
  };

  const service = createEvaluationService({
    newId,
    now: () => NOW,
    rules: {
      evaluate: () => ({ hits: options.hits ?? [], ruleVersion: RULE_VERSION }),
    },
    unitOfWork,
  });
  return { service, samples, annotations, audits, project, episode, episodeVersion };
};

const createInput = (
  overrides: Partial<EvaluationCreateSampleInputDto> = {},
): EvaluationCreateSampleInputDto => ({
  authorization: 'SYNTHETIC',
  datasetSplit: 'TRAIN',
  dedupKey: 'manual-shot-0001',
  expected: { acceptable: true, expectedIssueCodes: [], referenceContract: null },
  input: {
    candidate: { document: { shot_id: 'shot_ep01_001' }, kind: 'SHOT_CONTRACT' },
    context: { characters: ['char_lin'] },
  },
  projectId: null,
  ...overrides,
});

describe('EvaluationService 样本入库与去重', () => {
  it('创建可接受样本—同事务校验/命中/入库/审计，回执为摘要', async () => {
    const harness = createHarness({
      hits: [{ code: 'EVAL_ISSUE_COMPLEX_ACTION', detail: '动作过长', path: 'content.action' }],
    });
    const result = await harness.service.createSample(createInput(), 'trace-create-0001');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hitCodes).toEqual(['EVAL_ISSUE_COMPLEX_ACTION']);
    expect(result.data.acceptable).toBe(true);
    expect(harness.samples).toHaveLength(1);
    expect(harness.samples[0]?.ruleHits).toHaveLength(1);
    expect(harness.samples[0]?.ruleVersion).toBe(RULE_VERSION);
    expect(harness.samples[0]?.id).toBe(result.data.sampleId);
    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0]?.action).toBe('EVALUATION_SAMPLE_CREATED');
    expect(harness.audits[0]?.actor).toBe('USER');
    expect(harness.audits[0]?.objectId).toBe(result.data.sampleId);
  });

  it('重复 dedup_key 被拒绝—稳定错误且零新增行', async () => {
    const harness = createHarness();
    const first = await harness.service.createSample(createInput(), 'trace-1');
    expect(first.ok).toBe(true);
    const second = await harness.service.createSample(createInput(), 'trace-2');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('EVALUATION_DEDUP_CONFLICT');
    expect(harness.samples).toHaveLength(1);
    expect(harness.audits).toHaveLength(1);
  });

  it('非法期望契约被拒绝—防御性校验携带字段级原因', async () => {
    const harness = createHarness();
    const corrupted = {
      ...createInput(),
      expected: {
        acceptable: true,
        expectedIssueCodes: ['EVAL_ISSUE_NOT_A_CODE'],
        referenceContract: null,
      },
    } as unknown as EvaluationCreateSampleInputDto;
    const result = await harness.service.createSample(corrupted, 'trace-3');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EVALUATION_SAMPLE_INVALID');
    expect(result.error.fieldErrors).not.toBeNull();
    expect(harness.samples).toHaveLength(0);
  });

  it('归属项目不存在被拒绝—零入库', async () => {
    const harness = createHarness();
    const result = await harness.service.createSample(
      createInput({ projectId: 'project_missing0' }),
      'trace-4',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROJECT_NOT_FOUND');
    expect(harness.samples).toHaveLength(0);
  });
});

describe('EvaluationService 项目派生样本', () => {
  const deriveInput = (overrides: Record<string, unknown> = {}) =>
    ({
      authorization: 'AUTHORIZED',
      datasetSplit: 'TRAIN',
      expectedVersionId: 'epv_eval0001',
      projectId: 'project_eval0001',
      requestId: 'req-derive-0001',
      shotIndexes: null,
      ...overrides,
    }) as Parameters<ReturnType<typeof createEvaluationService>['createFromEpisode']>[0];

  it('READY 整集派生—上下文冻结/项目归属/确定性 dedup_key/逐样本审计', async () => {
    const harness = createHarness();
    const result = await harness.service.createFromEpisode(deriveInput(), 'trace-derive-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.samples).toHaveLength(2);
    expect(harness.samples).toHaveLength(2);
    for (const sample of harness.samples) {
      expect(sample.projectId).toBe('project_eval0001');
      expect(sample.dedupKey.startsWith('derive:project_eval0001:epv_eval0001:')).toBe(true);
      expect(sample.expected.acceptable).toBe(true);
      const context = sample.input.context as Record<string, unknown>;
      expect(context.characters).toEqual(['char_lin', 'char_su']);
      expect(context.scenes).toEqual(['scene_station', 'scene_train']);
      expect(context.dialogueRenderMode).toBe('NARRATION_FIRST');
    }
    expect(harness.audits).toHaveLength(2);
    for (const entry of harness.audits) {
      expect(entry.action).toBe('EVALUATION_SAMPLE_CREATED');
      expect(entry.traceId).toBe('req-derive-0001');
    }
  });

  it('重复派生幂等—返回既有样本且零新增行/零新增审计', async () => {
    const harness = createHarness();
    await harness.service.createFromEpisode(deriveInput(), 'trace-1');
    const again = await harness.service.createFromEpisode(deriveInput(), 'trace-2');
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.samples).toHaveLength(2);
    expect(harness.samples).toHaveLength(2);
    expect(harness.audits).toHaveLength(2);
  });

  it('shotIndexes 子集—仅派生所选镜头', async () => {
    const harness = createHarness();
    const result = await harness.service.createFromEpisode(
      deriveInput({ shotIndexes: [1] }),
      'trace-3',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.samples).toHaveLength(1);
    expect(harness.samples[0]?.dedupKey.endsWith(':shot_ep01_002')).toBe(true);
  });

  it('非 READY 版本拒绝派生—稳定错误且零样本', async () => {
    const harness = createHarness({ versionStatus: 'DRAFT' });
    const result = await harness.service.createFromEpisode(deriveInput(), 'trace-4');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EVALUATION_DERIVE_NOT_READY');
    expect(harness.samples).toHaveLength(0);
  });

  it('expectedVersionId 过期—返回版本冲突', async () => {
    const harness = createHarness();
    const result = await harness.service.createFromEpisode(
      deriveInput({ expectedVersionId: 'epv_stale0001' }),
      'trace-5',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SCRIPT_VERSION_CONFLICT');
    expect(harness.samples).toHaveLength(0);
  });
});

describe('EvaluationService 删除与读取', () => {
  it('删除样本—标注级联/审计留痕/列表刷新', async () => {
    const harness = createHarness();
    const created = await harness.service.createSample(createInput(), 'trace-1');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    harness.annotations.push(
      {
        id: 'anno_eval0001',
        sampleId: created.data.sampleId,
        guidelineVersion: 'jingxu-annotation-guideline/1',
        label: { issueCodes: [], severity: null, verdict: 'ACCEPTABLE' },
        rationale: '符合指南',
        annotator: '贺星',
        createdAt: NOW,
      },
      {
        id: 'anno_eval0002',
        sampleId: created.data.sampleId,
        guidelineVersion: 'jingxu-annotation-guideline/1',
        label: { issueCodes: [], severity: 'WARN', verdict: 'PROBLEM' },
        rationale: '复核升级为问题',
        annotator: '贺星',
        createdAt: NOW,
      },
    );
    const deleted = await harness.service.deleteSample(
      { requestId: 'req-delete-0001', sampleId: created.data.sampleId },
      'trace-2',
    );
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.data.deletedAnnotations).toBe(2);
    expect(harness.samples).toHaveLength(0);
    expect(harness.annotations).toHaveLength(0);
    const audit = harness.audits.find((entry) => entry.action === 'EVALUATION_SAMPLE_DELETED');
    expect(audit?.traceId).toBe('req-delete-0001');
    expect((audit?.metadata as Record<string, unknown> | undefined)?.deletedAnnotations).toBe(2);
    const listed = await harness.service.listSamples({ projectId: null, scope: 'ALL' }, 'trace-3');
    expect(listed.ok && listed.data.samples).toHaveLength(0);
  });

  it('删除不存在的样本—EVALUATION_NOT_FOUND', async () => {
    const harness = createHarness();
    const result = await harness.service.deleteSample(
      { requestId: 'req-delete-0002', sampleId: 'eval_missing0' },
      'trace-1',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EVALUATION_NOT_FOUND');
  });

  it('listSamples scope 过滤与最新标注摘要；getSample 返回完整详情', async () => {
    const harness = createHarness();
    const global = await harness.service.createSample(createInput(), 'trace-1');
    const projectScoped = await harness.service.createSample(
      createInput({
        dedupKey: 'manual-shot-0002',
        projectId: harness.project.id,
      }),
      'trace-2',
    );
    expect(global.ok && projectScoped.ok).toBe(true);
    if (!global.ok || !projectScoped.ok) return;
    harness.annotations.push({
      id: 'anno_eval0003',
      sampleId: projectScoped.data.sampleId,
      guidelineVersion: 'jingxu-annotation-guideline/1',
      label: { issueCodes: ['EVAL_ISSUE_LOCK_CONFLICT'], severity: 'BLOCK', verdict: 'PROBLEM' },
      rationale: '锁定路径无法解析',
      annotator: '贺星',
      createdAt: NOW,
    });

    const all = await harness.service.listSamples({ projectId: null, scope: 'ALL' }, 't');
    const onlyGlobal = await harness.service.listSamples({ projectId: null, scope: 'GLOBAL' }, 't');
    const onlyProject = await harness.service.listSamples(
      { projectId: harness.project.id, scope: 'PROJECT' },
      't',
    );
    expect(all.ok && all.data.samples).toHaveLength(2);
    expect(onlyGlobal.ok && onlyGlobal.data.samples).toHaveLength(1);
    expect(onlyGlobal.ok && onlyGlobal.data.samples[0]?.projectId).toBeNull();
    expect(onlyProject.ok && onlyProject.data.samples).toHaveLength(1);
    expect(onlyProject.ok && onlyProject.data.samples[0]?.latestAnnotation?.label.verdict).toBe(
      'PROBLEM',
    );

    const detail = await harness.service.getSample({ sampleId: projectScoped.data.sampleId }, 't');
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.annotations).toHaveLength(1);
    expect(detail.data.ruleVersion).toBe(RULE_VERSION);
    expect(detail.data.input.candidate.kind).toBe('SHOT_CONTRACT');
    const missing = await harness.service.getSample({ sampleId: 'eval_missing0' }, 't');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('EVALUATION_NOT_FOUND');
  });
});
