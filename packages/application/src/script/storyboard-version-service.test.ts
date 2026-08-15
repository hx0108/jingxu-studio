import { describe, expect, it } from 'vitest';

import type { ScriptJobRepositories, ScriptUnitOfWorkPort } from '../ports/script/index';
import { createScriptVersionService } from './script-version-service';
import { computeShotSetHash } from './shot-set-hash';
import {
  createStoryboardVersionService,
  invalidateStoryboardHead,
  type StoryboardVersionService,
} from './storyboard-version-service';

const hashText = (value: string): string => `h(${value})`;

interface Stores {
  readonly audit: unknown[];
  readonly dependencies: unknown[];
  readonly episodeVersions: Map<string, Record<string, unknown>>;
  readonly links: Map<
    string,
    readonly { shotId: string; shotVersionId: string; sequence: number }[]
  >;
  readonly pointerUpdates: unknown[];
  readonly receipts: Map<string, Record<string, unknown>>;
  readonly heads: Map<string, Record<string, unknown>>;
  readonly shotVersions: Map<string, Record<string, unknown>>;
  readonly scriptVersions: Map<string, Record<string, unknown>>;
}

const episodeVersionRow = (
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  createdAt: '2026-08-15T00:00:00.000Z',
  episodeId: 'episode-0001',
  formatProfileId: 'format-0001',
  id,
  parentId: null,
  shotSetHash: `hash-${id}`,
  storyBibleVersionId: 'story-0001',
  status: 'DRAFT',
  targetDurationSec: 90,
  versionNo: 1,
  ...overrides,
});

const shotVersionRow = (id: string, shotId: string, sequence: number): Record<string, unknown> => ({
  createdAt: '2026-08-15T00:00:00.000Z',
  dialogueRenderMode: 'NARRATION_FIRST',
  document: JSON.stringify({
    contract_version: 1,
    narrative_purpose: '开场',
    shot_id: shotId,
    status: 'DRAFT',
    version_id: id,
  }),
  documentSha256: `sha-${id}`,
  externalParentVersionId: null,
  formatProfileId: 'format-0001',
  id,
  lineageResolutionStatus: 'ROOT',
  parentId: null,
  sequence,
  shotId,
  sourceInvocationId: 'inv-0001',
  targetDurationSec: 12,
  versionNo: 1,
  versionStatus: 'DRAFT',
});

/** 仓储 fake：行为与行形状断言分离，行内容按 key 逐项校验。 */
const createRepositories = (stores: Stores): ScriptJobRepositories =>
  ({
    audit: { record: (entry: unknown) => void stores.audit.push(entry) },
    dependencies: {
      insertMany: (edges: readonly unknown[]) => void stores.dependencies.push(...edges),
    },
    episodeVersions: {
      findById: (id: string) => Promise.resolve(stores.episodeVersions.get(id) ?? null),
      findMaxVersionNo: (episodeId: string) =>
        Promise.resolve(
          Math.max(
            0,
            ...[...stores.episodeVersions.values()]
              .filter((version) => version.episodeId === episodeId)
              .map((version) => Number(version.versionNo)),
          ),
        ),
      insert: (version: Record<string, unknown>) =>
        void stores.episodeVersions.set(String(version.id), version),
      insertShotLinks: (links: readonly Record<string, unknown>[]) => {
        const episodeVersionId = String(links[0]?.episodeVersionId);
        const merged = [
          ...(stores.links.get(episodeVersionId) ?? []).map((link) => ({
            ...link,
            episodeVersionId,
          })),
          ...links.map((link) => ({
            sequence: Number(link.sequence),
            shotId: String(link.shotId),
            shotVersionId: String(link.shotVersionId),
          })),
        ];
        stores.links.set(episodeVersionId, merged);
      },
      listShotLinks: (episodeVersionId: string) =>
        Promise.resolve(
          (stores.links.get(episodeVersionId) ?? [])
            .slice()
            .sort((l, r) => l.sequence - r.sequence),
        ),
    },
    receipts: {
      findByRequestId: (requestId: string) =>
        Promise.resolve(stores.receipts.get(requestId) ?? null),
      insert: (receipt: Record<string, unknown>) =>
        void stores.receipts.set(String(receipt.requestId), receipt),
    },
    scriptVersions: {
      findById: (id: string) => Promise.resolve(stores.scriptVersions.get(id) ?? null),
      findMaxVersionNo: () => Promise.resolve(stores.scriptVersions.size),
      insert: (version: Record<string, unknown>) =>
        void stores.scriptVersions.set(String(version.id), version),
    },
    shotContractVersions: {
      findById: (id: string) => Promise.resolve(stores.shotVersions.get(id) ?? null),
      insertMany: (versions: readonly Record<string, unknown>[]) => {
        for (const version of versions) stores.shotVersions.set(String(version.id), version);
      },
    },
    shots: {
      updateCurrentVersionIds: (entries: readonly unknown[]) =>
        void stores.pointerUpdates.push(...entries),
    },
    stageHeads: {
      find: (projectId: string, episodeId: string | null, stage: string) =>
        Promise.resolve(stores.heads.get(`${projectId}:${String(episodeId)}:${stage}`) ?? null),
      upsert: (head: Record<string, unknown>) => {
        stores.heads.set(
          `${String(head.projectId)}:${String(head.episodeId)}:${String(head.stage)}`,
          head,
        );
        return Promise.resolve(true);
      },
    },
  }) as unknown as ScriptJobRepositories;

interface Fixture {
  readonly repositories: ScriptJobRepositories;
  readonly service: StoryboardVersionService;
  readonly stores: Stores;
}

const seedFixture = (): Fixture => {
  const stores: Stores = {
    audit: [],
    dependencies: [],
    episodeVersions: new Map([
      ['ev-1', episodeVersionRow('ev-1')],
      ['ev-other-episode', episodeVersionRow('ev-other-episode', { episodeId: 'episode-0002' })],
    ]),
    heads: new Map([
      [
        'project-0001:episode-0001:SHOT_CONTRACT',
        {
          currentVersionId: 'ev-1',
          currentVersionType: 'EPISODE_VERSION',
          episodeId: 'episode-0001',
          projectId: 'project-0001',
          stage: 'SHOT_CONTRACT',
        },
      ],
    ]),
    links: new Map([
      [
        'ev-1',
        [
          { sequence: 1, shotId: 'shot_a', shotVersionId: 'scv_a_v1' },
          { sequence: 2, shotId: 'shot_b', shotVersionId: 'scv_b_v1' },
        ],
      ],
    ]),
    pointerUpdates: [],
    receipts: new Map(),
    shotVersions: new Map([
      ['scv_a_v1', shotVersionRow('scv_a_v1', 'shot_a', 1)],
      ['scv_b_v1', shotVersionRow('scv_b_v1', 'shot_b', 2)],
    ]),
    scriptVersions: new Map(),
  };
  const repositories = createRepositories(stores);
  const unitOfWork: ScriptUnitOfWorkPort = {
    run: (work) => work(repositories),
  };
  const service = createStoryboardVersionService({
    hashPayload: (value) =>
      `sha-${
        typeof value.version_id === 'string'
          ? value.version_id
          : typeof value.id === 'string'
            ? value.id
            : 'payload'
      }`,
    hashText,
    newId: (() => {
      let sequence = 0;
      return () => {
        sequence += 1;
        return `new-${String(sequence)}`;
      };
    })(),
    now: () => '2026-08-15T01:00:00.000Z',
    unitOfWork,
  });
  return { repositories, service, stores };
};

const confirmInput = {
  episodeId: 'episode-0001',
  expectedVersionId: 'ev-1',
  projectId: 'project-0001',
  requestId: 'req-confirm-1',
};

describe('createStoryboardVersionService.confirmStoryboard', () => {
  it('条件—DRAFT 整集确认—逐镜头 READY 子版本 + READY 整集（hash 重算）+ 指针推进 + head 移动', async () => {
    const { service, stores } = seedFixture();

    const result = await service.confirmStoryboard(confirmInput, 'trace-1');

    expect(result.ok).toBe(true);
    const summary = result.ok ? result.data : null;
    expect(summary).toMatchObject({
      parentId: 'ev-1',
      shotCount: 2,
      status: 'READY',
      versionNo: 2,
    });

    // 逐镜头 v2：LOCAL_VERIFIED + READY，document 内四个同步改写键与行一致。
    const readyVersions = [...stores.shotVersions.values()].filter(
      (version) => version.parentId === 'scv_a_v1' || version.parentId === 'scv_b_v1',
    );
    expect(readyVersions).toHaveLength(2);
    for (const version of readyVersions) {
      const document = JSON.parse(String(version.document)) as Record<string, unknown>;
      expect(version.versionNo).toBe(2);
      expect(version.versionStatus).toBe('READY');
      expect(version.lineageResolutionStatus).toBe('LOCAL_VERIFIED');
      expect(document).toMatchObject({ contract_version: 2, status: 'READY' });
      expect(document.parent_version_id).toBe(version.parentId);
      expect(document.version_id).toBe(version.id);
    }

    // READY 镜头当前指针在同一事务推进。
    expect(stores.pointerUpdates).toHaveLength(2);
    expect(
      new Set(
        stores.pointerUpdates.map((entry) =>
          String((entry as Record<string, unknown>).currentVersionId),
        ),
      ),
    ).toEqual(new Set(readyVersions.map((version) => String(version.id))));

    // READY 整集：shot_set_hash 对 READY 集合重算（与 §1.5 同源）。
    const readyEpisodeVersion = stores.episodeVersions.get(String(summary?.id));
    expect(readyEpisodeVersion).toMatchObject({
      parentId: 'ev-1',
      status: 'READY',
      versionNo: 2,
    });
    const readyEntries = [...(stores.links.get(String(summary?.id)) ?? [])].map((link) => ({
      documentSha256: `sha-${link.shotVersionId}`,
      sequence: link.sequence,
      shotId: link.shotId,
      shotVersionId: link.shotVersionId,
    }));
    expect(readyEpisodeVersion?.shotSetHash).toBe(computeShotSetHash(readyEntries, hashText));

    // head 以 EPISODE_VERSION 指向 READY 整集；回执可重放。
    expect(stores.heads.get('project-0001:episode-0001:SHOT_CONTRACT')).toMatchObject({
      currentVersionId: summary?.id,
      currentVersionType: 'EPISODE_VERSION',
    });
    expect(stores.receipts.get('req-confirm-1')).toMatchObject({
      commandName: 'CONFIRM_SCRIPT_VERSION',
      resultRef: { versionId: summary?.id },
    });
  });

  it('条件—重复 requestId—回放既有结果且不再写入任何行', async () => {
    const { service, stores } = seedFixture();
    const first = await service.confirmStoryboard(confirmInput, 'trace-1');
    const episodeCount = stores.episodeVersions.size;
    const shotVersionCount = stores.shotVersions.size;

    const replay = await service.confirmStoryboard(confirmInput, 'trace-1');

    expect(replay.ok).toBe(true);
    expect(replay.ok && replay.data.id).toBe(first.ok && first.data.id);
    expect(stores.episodeVersions.size).toBe(episodeCount);
    expect(stores.shotVersions.size).toBe(shotVersionCount);
  });

  it('条件—expectedVersionId 过期—乐观并发冲突且零写入', async () => {
    const { service, stores } = seedFixture();
    await service.confirmStoryboard(confirmInput, 'trace-1');

    const conflicted = await service.confirmStoryboard(
      { ...confirmInput, expectedVersionId: 'ev-1', requestId: 'req-confirm-2' },
      'trace-2',
    );

    expect(conflicted.ok).toBe(false);
    if (conflicted.ok) return;
    expect(conflicted.error.code).toBe('SCRIPT_VERSION_CONFLICT');
    // head 已指向 READY：仅第一次写入的 3 行（DRAFT ev-1 起始 2 行 + READY 1 行）存在。
    expect(stores.episodeVersions.size).toBe(3);
  });
});

describe('createStoryboardVersionService.restoreStoryboard', () => {
  it('条件—恢复历史整集—新 DRAFT 复用同一批镜头版本与 shot_set_hash', async () => {
    const { service, stores } = seedFixture();
    const confirmed = await service.confirmStoryboard(confirmInput, 'trace-1');
    const readyId = confirmed.ok ? confirmed.data.id : '';
    const draftHashBefore = String(stores.episodeVersions.get('ev-1')?.shotSetHash);

    const restored = await service.restoreStoryboard(
      {
        episodeId: 'episode-0001',
        expectedVersionId: readyId,
        projectId: 'project-0001',
        requestId: 'req-restore-1',
        versionId: 'ev-1',
      },
      'trace-2',
    );

    expect(restored.ok).toBe(true);
    const summary = restored.ok ? restored.data : null;
    expect(summary).toMatchObject({ parentId: readyId, status: 'DRAFT', versionNo: 3 });
    expect(summary?.shotSetHash).toBe(draftHashBefore);
    expect(stores.links.get(String(summary?.id))).toEqual([
      { sequence: 1, shotId: 'shot_a', shotVersionId: 'scv_a_v1' },
      { sequence: 2, shotId: 'shot_b', shotVersionId: 'scv_b_v1' },
    ]);
    // 不创建镜头子版本，也不触碰当前指针。
    expect(stores.shotVersions.size).toBe(4);
    expect(stores.pointerUpdates).toHaveLength(2);
  });

  it('条件—恢复目标属于其他 Episode—稳定 NOT_FOUND', async () => {
    const { service } = seedFixture();

    const notFound = await service.restoreStoryboard(
      {
        episodeId: 'episode-0001',
        expectedVersionId: 'ev-1',
        projectId: 'project-0001',
        requestId: 'req-restore-2',
        versionId: 'ev-other-episode',
      },
      'trace-3',
    );

    expect(notFound.ok).toBe(false);
    if (notFound.ok) return;
    expect(notFound.error.code).toBe('SCRIPT_VERSION_NOT_FOUND');
  });
});

describe('invalidateStoryboardHead', () => {
  it('条件—上游 READY 变化—只插一行 STALE_INPUT 整集，快照与 hash 沿用', async () => {
    const { repositories, stores } = seedFixture();

    await invalidateStoryboardHead(
      repositories,
      { newId: () => 'stale-new-1', now: () => '2026-08-15T02:00:00.000Z' },
      {
        episodeId: 'episode-0001',
        projectId: 'project-0001',
        upstreamStage: 'SCENE_SCRIPT',
        upstreamVersionId: 'scene-2',
      },
      'trace-4',
    );

    const stale = stores.episodeVersions.get('stale-new-1');
    expect(stale).toMatchObject({
      id: 'stale-new-1',
      parentId: 'ev-1',
      shotSetHash: 'hash-ev-1',
      status: 'STALE_INPUT',
      versionNo: 2,
    });
    expect(stores.links.get('stale-new-1')).toEqual([
      { sequence: 1, shotId: 'shot_a', shotVersionId: 'scv_a_v1' },
      { sequence: 2, shotId: 'shot_b', shotVersionId: 'scv_b_v1' },
    ]);
    // 不逐镜头失效：镜头版本与指针零变化。
    expect(stores.shotVersions.size).toBe(2);
    expect(stores.pointerUpdates).toHaveLength(0);
    expect(stores.heads.get('project-0001:episode-0001:SHOT_CONTRACT')).toMatchObject({
      currentVersionId: 'stale-new-1',
    });
    // INVALIDATES 边：downstream 为 EPISODE_VERSION。
    expect(stores.dependencies).toHaveLength(1);
    expect(stores.dependencies[0]).toMatchObject({
      dependencyType: 'INVALIDATES',
      downstreamId: 'SHOT_CONTRACT',
      downstreamType: 'EPISODE_VERSION',
      downstreamVersionId: 'stale-new-1',
      upstreamType: 'SCRIPT_VERSION',
      upstreamVersionId: 'scene-2',
    });
    expect(stores.audit).toHaveLength(1);
    expect(stores.audit[0]).toMatchObject({
      action: 'SCRIPT_VERSION_INVALIDATED',
      actor: 'SYSTEM',
    });
  });

  it('条件—Episode 尚无分镜阶段头—静默跳过不产生失效行', async () => {
    const { repositories, stores } = seedFixture();
    stores.heads.delete('project-0001:episode-0001:SHOT_CONTRACT');

    await invalidateStoryboardHead(
      repositories,
      { newId: () => 'should-not-exist', now: () => '2026-08-15T02:00:00.000Z' },
      {
        episodeId: 'episode-0001',
        projectId: 'project-0001',
        upstreamStage: 'SCENE_SCRIPT',
        upstreamVersionId: 'scene-2',
      },
      'trace-5',
    );

    expect(stores.episodeVersions.size).toBe(2);
    expect(stores.dependencies).toHaveLength(0);
  });
});

describe('五阶段确认 → 分镜失效接线', () => {
  it('条件—SCENE_SCRIPT 确认 READY—事务内推进分镜 head 到 STALE_INPUT 整集', async () => {
    const { repositories, stores } = seedFixture();
    stores.scriptVersions.set('scene-1', {
      changeSummary: null,
      createdAt: '2026-08-15T00:00:00.000Z',
      document: JSON.stringify({ data: { scenes: [] }, source_invocation_id: 'inv-1' }),
      documentSha256: 'sha-scene-1',
      episodeId: 'episode-0001',
      id: 'scene-1',
      parentId: null,
      projectId: 'project-0001',
      source: 'AI',
      sourceInputId: null,
      sourceInvocationId: 'inv-1',
      stage: 'SCENE_SCRIPT',
      status: 'READY',
      versionNo: 1,
    });
    stores.heads.set('project-0001:episode-0001:SCENE_SCRIPT', {
      currentVersionId: 'scene-1',
      currentVersionType: 'SCRIPT_VERSION',
      episodeId: 'episode-0001',
      projectId: 'project-0001',
      stage: 'SCENE_SCRIPT',
    });
    const unitOfWork: ScriptUnitOfWorkPort = { run: (work) => work(repositories) };
    const fiveStage = createScriptVersionService({
      hashPayload: () => 'sha-five',
      newId: () => 'scene-2',
      now: () => '2026-08-15T03:00:00.000Z',
      unitOfWork,
      validateDocument: () => true,
    });

    const confirmed = await fiveStage.confirmVersion(
      {
        episodeId: 'episode-0001',
        expectedVersionId: 'scene-1',
        projectId: 'project-0001',
        requestId: 'req-scene-confirm',
        stage: 'SCENE_SCRIPT',
        versionId: 'scene-1',
      },
      'trace-6',
    );

    expect(confirmed.ok).toBe(true);
    // SCENE_SCRIPT 无五阶段下游：唯一失效对象是分镜整集。
    const staleVersions = [...stores.episodeVersions.values()].filter(
      (version) => version.status === 'STALE_INPUT',
    );
    expect(staleVersions).toHaveLength(1);
    expect(staleVersions[0]).toMatchObject({ parentId: 'ev-1', shotSetHash: 'hash-ev-1' });
    expect(stores.heads.get('project-0001:episode-0001:SHOT_CONTRACT')).toMatchObject({
      currentVersionId: staleVersions[0]?.id,
      currentVersionType: 'EPISODE_VERSION',
    });
  });
});
