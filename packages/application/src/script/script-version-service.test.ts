import { describe, expect, it } from 'vitest';

import type {
  ScriptAuditEntry,
  ScriptCommandReceipt,
  ScriptDependency,
  ScriptJobRepositories,
  ScriptVersion,
  StageHead,
  StoryBibleVersion,
} from '../ports/script/index';
import { createScriptVersionService } from './script-version-service';

const document = (stage: ScriptVersion['stage'], episodeId: string | null = null) => ({
  data: { title: stage },
  episode_id: episodeId,
  project_id: 'project-0001',
  schema_version: '1.0.0',
  source_invocation_id: 'invocation-0001',
  stage,
});

const version = (id: string, stage: ScriptVersion['stage'], status: ScriptVersion['status']) =>
  ({
    changeSummary: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    document: JSON.stringify(document(stage)),
    documentSha256: id.padEnd(64, 'a').slice(0, 64),
    episodeId: null,
    id,
    parentId: null,
    projectId: 'project-0001',
    source: 'AI',
    sourceInputId: 'source-0001',
    sourceInvocationId: 'invocation-0001',
    stage,
    status,
    versionNo: 1,
  }) satisfies ScriptVersion;

const createHarness = () => {
  const current = version('version-draft', 'CONCEPT', 'DRAFT');
  const stored = new Map<string, ScriptVersion>([[current.id, current]]);
  const inserted: ScriptVersion[] = [];
  let head: StageHead = {
    currentVersionId: current.id,
    currentVersionType: 'SCRIPT_VERSION',
    episodeId: null,
    projectId: current.projectId,
    stage: current.stage,
    updatedAt: current.createdAt,
  };
  const repositories = {
    audit: { record: () => Promise.resolve() },
    dependencies: {
      insertMany: () => Promise.resolve(),
      listByUpstreamVersionIds: () => Promise.resolve([]),
    },
    receipts: { findByRequestId: () => Promise.resolve(null), insert: () => Promise.resolve() },
    scriptVersions: {
      findById: (id: string) => Promise.resolve(stored.get(id) ?? null),
      findMaxVersionNo: () => Promise.resolve(inserted.length + 1),
      insert: (candidate: ScriptVersion) => {
        inserted.push(candidate);
        stored.set(candidate.id, candidate);
        return Promise.resolve();
      },
    },
    stageHeads: {
      find: (_projectId: string, _episodeId: string | null, stage: string) =>
        Promise.resolve(stage === 'CONCEPT' ? head : null),
      listByProjectId: () => Promise.resolve([head]),
      upsert: (candidate: StageHead, expected: string | null) => {
        if (head.currentVersionId !== expected) return Promise.resolve(false);
        head = candidate;
        return Promise.resolve(true);
      },
    },
  } as unknown as ScriptJobRepositories;
  const ids = ['version-ready', 'audit-0001'];
  const service = createScriptVersionService({
    hashPayload: () => 'f'.repeat(64),
    newId: () => ids.shift() ?? 'generated-id',
    now: () => '2026-08-13T01:00:00.000Z',
    unitOfWork: { run: (work) => work(repositories) },
    validateDocument: () => true,
  });
  return { current, inserted, service };
};

describe('ScriptVersionService', () => {
  it('条件—确认当前 DRAFT—创建内容相同 READY 子版本且不改历史', async () => {
    const harness = createHarness();
    const before = JSON.stringify(harness.current);
    const result = await harness.service.confirmVersion(
      {
        episodeId: null,
        expectedVersionId: harness.current.id,
        projectId: 'project-0001',
        requestId: 'request-0001',
        stage: 'CONCEPT',
        versionId: harness.current.id,
      },
      'trace-0001',
    );
    expect(result).toMatchObject({
      ok: true,
      data: { parentId: harness.current.id, status: 'READY' },
    });
    expect(JSON.stringify(harness.current)).toBe(before);
    expect(harness.inserted).toHaveLength(1);
  });

  it('条件—expectedVersionId 过期—拒绝且零新版本', async () => {
    const harness = createHarness();
    const result = await harness.service.confirmVersion(
      {
        episodeId: null,
        expectedVersionId: 'stale-version',
        projectId: 'project-0001',
        requestId: 'request-0001',
        stage: 'CONCEPT',
        versionId: harness.current.id,
      },
      'trace-0001',
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'SCRIPT_VERSION_CONFLICT' } });
    expect(harness.inserted).toEqual([]);
  });
});

type AnyVersion = ScriptVersion | StoryBibleVersion;

const createPropagationHarness = (
  failAtInvalidationAudit: number | null = null,
  validateDocument = true,
) => {
  const makeScript = (
    id: string,
    stage: ScriptVersion['stage'],
    episodeId: string | null,
  ): ScriptVersion => ({
    changeSummary: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    document: JSON.stringify(document(stage, episodeId)),
    documentSha256: id.padEnd(64, 'a').slice(0, 64),
    episodeId,
    id,
    parentId: null,
    projectId: 'project-0001',
    source: 'AI',
    sourceInputId: 'source-0001',
    sourceInvocationId: 'invocation-0001',
    stage,
    status: 'READY',
    versionNo: 1,
  });
  const concept = makeScript('concept-ready', 'CONCEPT', null);
  const historical = {
    ...makeScript('concept-history', 'CONCEPT', null),
    document: JSON.stringify({ ...document('CONCEPT'), data: { title: '历史内容' } }),
  };
  const bible: StoryBibleVersion = {
    createdAt: concept.createdAt,
    document: JSON.stringify({ ...document('CONCEPT'), stage: 'STORY_BIBLE' }),
    documentSha256: 'b'.repeat(64),
    id: 'bible-ready',
    parentId: null,
    projectId: 'project-0001',
    source: 'AI',
    sourceInvocationId: 'invocation-0001',
    status: 'READY',
    versionNo: 1,
  };
  const outline = makeScript('outline-ready', 'EPISODE_OUTLINE', 'episode-0001');
  const beat = makeScript('beat-ready', 'BEAT_SHEET', 'episode-0001');
  const scene = makeScript('scene-ready', 'SCENE_SCRIPT', 'episode-0001');
  const originals = [concept, bible, outline, beat, scene] as const;
  const scriptVersions = new Map(
    [concept, historical, outline, beat, scene].map((item) => [item.id, item] as const),
  );
  const bibleVersions = new Map([[bible.id, bible]]);
  const heads = new Map<string, StageHead>(
    [
      [concept.stage, concept],
      ['STORY_BIBLE', bible],
      [outline.stage, outline],
      [beat.stage, beat],
      [scene.stage, scene],
    ].map(([stage, item]) => {
      const typedStage = stage as StageHead['stage'];
      const typed = item as AnyVersion;
      return [
        typedStage,
        {
          currentVersionId: typed.id,
          currentVersionType:
            typedStage === 'STORY_BIBLE' ? 'STORY_BIBLE_VERSION' : 'SCRIPT_VERSION',
          episodeId:
            typedStage === 'CONCEPT' || typedStage === 'STORY_BIBLE' ? null : 'episode-0001',
          projectId: 'project-0001',
          stage: typedStage,
          updatedAt: typed.createdAt,
        },
      ];
    }),
  );
  const inserted: AnyVersion[] = [];
  const dependencies: ScriptDependency[] = [];
  const audits: ScriptAuditEntry[] = [];
  const receipts: ScriptCommandReceipt[] = [];
  let invalidationAuditCount = 0;
  let sequence = 0;

  const repositories = {
    audit: {
      record: (entry: ScriptAuditEntry) => {
        if (entry.action === 'SCRIPT_VERSION_INVALIDATED') {
          invalidationAuditCount += 1;
          if (invalidationAuditCount === failAtInvalidationAudit) {
            return Promise.reject(new Error('injected audit failure'));
          }
        }
        audits.push(entry);
        return Promise.resolve();
      },
    },
    dependencies: {
      insertMany: (items: readonly ScriptDependency[]) => {
        dependencies.push(...items);
        return Promise.resolve();
      },
      listByUpstreamVersionIds: () => Promise.resolve([]),
    },
    receipts: {
      findByRequestId: () => Promise.resolve(null),
      insert: (receipt: ScriptCommandReceipt) => {
        receipts.push(receipt);
        return Promise.resolve();
      },
    },
    scriptVersions: {
      findById: (id: string) => Promise.resolve(scriptVersions.get(id) ?? null),
      findMaxVersionNo: (_projectId: string, _episodeId: string | null, stage: string) =>
        Promise.resolve([...scriptVersions.values()].filter((item) => item.stage === stage).length),
      insert: (candidate: ScriptVersion) => {
        inserted.push(candidate);
        scriptVersions.set(candidate.id, candidate);
        return Promise.resolve();
      },
    },
    stageHeads: {
      find: (_projectId: string, _episodeId: string | null, stage: string) =>
        Promise.resolve(heads.get(stage) ?? null),
      listByProjectId: () => Promise.resolve([...heads.values()]),
      upsert: (candidate: StageHead, expected: string | null) => {
        if (heads.get(candidate.stage)?.currentVersionId !== expected)
          return Promise.resolve(false);
        heads.set(candidate.stage, candidate);
        return Promise.resolve(true);
      },
    },
    storyBibleVersions: {
      findById: (id: string) => Promise.resolve(bibleVersions.get(id) ?? null),
      findMaxVersionNo: () => Promise.resolve(bibleVersions.size),
      insert: (candidate: StoryBibleVersion) => {
        inserted.push(candidate);
        bibleVersions.set(candidate.id, candidate);
        return Promise.resolve();
      },
    },
  } as unknown as ScriptJobRepositories;

  const unitOfWork = {
    run: async <T>(work: (value: ScriptJobRepositories) => Promise<T>): Promise<T> => {
      const scriptSnapshot = new Map(scriptVersions);
      const bibleSnapshot = new Map(bibleVersions);
      const headSnapshot = new Map(heads);
      const lengths = [inserted.length, dependencies.length, audits.length, receipts.length];
      try {
        return await work(repositories);
      } catch (error) {
        scriptVersions.clear();
        for (const item of scriptSnapshot) scriptVersions.set(...item);
        bibleVersions.clear();
        for (const item of bibleSnapshot) bibleVersions.set(...item);
        heads.clear();
        for (const item of headSnapshot) heads.set(...item);
        inserted.length = lengths[0] ?? 0;
        dependencies.length = lengths[1] ?? 0;
        audits.length = lengths[2] ?? 0;
        receipts.length = lengths[3] ?? 0;
        throw error;
      }
    },
  };
  const service = createScriptVersionService({
    hashPayload: () => 'f'.repeat(64),
    newId: () => `generated-${String(++sequence).padStart(4, '0')}`,
    now: () => '2026-08-13T01:00:00.000Z',
    unitOfWork,
    validateDocument: () => validateDocument,
  });
  return {
    audits,
    dependencies,
    heads,
    historical,
    inserted,
    originals,
    receipts,
    service,
  };
};

describe('ScriptVersionService downstream invalidation', () => {
  const confirmConcept = (harness: ReturnType<typeof createPropagationHarness>) =>
    harness.service.confirmVersion(
      {
        episodeId: null,
        expectedVersionId: 'concept-ready',
        projectId: 'project-0001',
        requestId: 'request-confirm',
        stage: 'CONCEPT',
        versionId: 'concept-ready',
      },
      'trace-confirm',
    );

  it('条件—CONCEPT 重新确认 READY—每个已有下游创建 STALE、dependency 和 SYSTEM audit', async () => {
    const harness = createPropagationHarness();
    const before = harness.originals.map((item) => JSON.stringify(item));
    const result = await confirmConcept(harness);

    expect(result).toMatchObject({ ok: true, data: { status: 'READY' } });
    expect(harness.inserted.filter(({ status }) => status === 'STALE_INPUT')).toHaveLength(4);
    expect(harness.dependencies).toHaveLength(4);
    expect(
      harness.dependencies.every(
        (edge) =>
          edge.dependencyType === 'INVALIDATES' &&
          edge.upstreamVersionId === (result.ok ? result.data.id : ''),
      ),
    ).toBe(true);
    const invalidationAudits = harness.audits.filter(
      ({ action }) => action === 'SCRIPT_VERSION_INVALIDATED',
    );
    expect(invalidationAudits).toHaveLength(4);
    expect(
      invalidationAudits.every(
        ({ actor, metadata }) =>
          actor === 'SYSTEM' &&
          metadata.source === 'SYSTEM_INVALIDATION' &&
          metadata.reason === 'UPSTREAM_READY_CHANGED',
      ),
    ).toBe(true);
    expect(
      [...harness.heads.values()]
        .filter(({ stage }) => stage !== 'CONCEPT')
        .every((head) =>
          harness.inserted.some(
            (item) => item.id === head.currentVersionId && item.status === 'STALE_INPUT',
          ),
        ),
    ).toBe(true);
    expect(harness.originals.map((item) => JSON.stringify(item))).toEqual(before);
  });

  it('条件—第二个下游 audit 写入失败—READY、全部 STALE、head、dependency、audit、receipt 整体回滚', async () => {
    const harness = createPropagationHarness(2);
    const originalHeads = [...harness.heads.values()].map((head) => ({ ...head }));
    const result = await confirmConcept(harness);

    expect(result).toMatchObject({ ok: false, error: { code: 'PROJECT_PERSISTENCE_FAILED' } });
    expect(harness.inserted).toEqual([]);
    expect(harness.dependencies).toEqual([]);
    expect(harness.audits).toEqual([]);
    expect(harness.receipts).toEqual([]);
    expect([...harness.heads.values()]).toEqual(originalHeads);
  });

  it('条件—恢复历史版本—复制历史内容但 parent 指向恢复前 current，历史字节不变', async () => {
    const harness = createPropagationHarness();
    const historicalBefore = JSON.stringify(harness.historical);
    const result = await harness.service.restoreVersion(
      {
        episodeId: null,
        expectedVersionId: 'concept-ready',
        projectId: 'project-0001',
        requestId: 'request-restore',
        stage: 'CONCEPT',
        versionId: harness.historical.id,
      },
      'trace-restore',
    );

    expect(result).toMatchObject({
      data: { parentId: 'concept-ready', status: 'DRAFT' },
      ok: true,
    });
    expect(result.ok ? result.data.document : null).toEqual(
      JSON.parse(harness.historical.document),
    );
    expect(JSON.stringify(harness.historical)).toBe(historicalBefore);
  });

  it('条件—人工保存后的正式文档 Schema 无效—稳定拒绝且版本、head、审计和回执零写入', async () => {
    const harness = createPropagationHarness(null, false);
    const originalHeads = [...harness.heads.values()].map((head) => ({ ...head }));
    const result = await harness.service.saveDraft(
      {
        data: { invalid: true },
        episodeId: null,
        expectedVersionId: 'concept-ready',
        projectId: 'project-0001',
        requestId: 'request-invalid',
        stage: 'CONCEPT',
      },
      'trace-invalid',
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'SCRIPT_SCHEMA_INVALID' } });
    expect(harness.inserted).toEqual([]);
    expect(harness.audits).toEqual([]);
    expect(harness.receipts).toEqual([]);
    expect([...harness.heads.values()]).toEqual(originalHeads);
  });
});
