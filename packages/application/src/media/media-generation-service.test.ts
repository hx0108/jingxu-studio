import { describe, expect, it } from 'vitest';

import type { MediaUnitOfWorkPort } from '../ports/media/media-repository';
import type {
  EpisodeVersion,
  ScriptWorkspaceSnapshot,
  ShotContractVersion,
  StoryboardShotSnapshot,
} from '../ports/script/script-types';
import type { FormatProfile } from '@jingxu/domain';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import { InMemoryMediaInvocationRepository } from './in-memory-media-invocation-repository';
import { InMemoryMediaRepository } from './in-memory-media-repository';
import { InMemoryVideoMediaRepository } from './in-memory-video-media-repository';
import { computeGenerationInputHash } from './media-generation-prompt';
import { createMediaGenerationService } from './media-generation-service';

const NOW = '2026-08-16T00:00:00.000Z';
const MODEL_ID = 'doubao-seedream-5-0-lite-260128';
const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);

const shotVersionOf = (
  versionId: string,
  document: string,
  formatProfileId = 'fp_1',
): ShotContractVersion => ({
  createdAt: NOW,
  dialogueRenderMode: 'NARRATION_FIRST',
  document,
  documentSha256: hash64(`doc_${versionId}`),
  externalParentVersionId: null,
  formatProfileId,
  id: versionId,
  lineageResolutionStatus: 'LOCAL_VERIFIED',
  parentId: null,
  sequence: 1,
  shotId: 'shot_1',
  sourceInvocationId: null,
  targetDurationSec: 8,
  versionNo: 1,
  versionStatus: 'READY',
});

const shotDocument = (characterIds: readonly string[], sceneId: string): string =>
  JSON.stringify({
    cinematography: { shot_size: 'MEDIUM', camera_angle: 'EYE_LEVEL' },
    content: { action: '走过雨巷', character_ids: characterIds, scene_id: sceneId },
    continuity: { continuity_mode: 'SCENE_CHANGE' },
    generation_constraints: { image_prompt: '雨巷中的少女' },
  });

const workspaceOf = (
  shots: readonly StoryboardShotSnapshot[],
  status: EpisodeVersion['status'] = 'READY',
): ScriptWorkspaceSnapshot => ({
  episode: null,
  projectId: 'project_1',
  sourceInput: null,
  stages: [],
  storyboard: {
    current: {
      createdAt: NOW,
      episodeId: 'episode_1',
      formatProfileId: 'fp_1',
      id: 'ev_1',
      parentId: null,
      shotSetHash: hash64('set'),
      status,
      storyBibleVersionId: 'sbv_1',
      targetDurationSec: 90,
      versionNo: 1,
    },
    currentShots: shots,
    history: [],
    historyTruncated: false,
  },
});

const formatProfile: FormatProfile = {
  createdAt: NOW,
  id: 'fp_1',
  isCurrent: true,
  parentId: null,
  projectId: 'project_1',
  spec: {
    aspectRatio: '9:16',
    fps: 30,
    height: 1920,
    language: 'zh-CN',
    subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
    width: 1080,
  },
  versionNo: 1,
};

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  hash64(JSON.stringify(value));

const parametersFingerprint = (size: Readonly<{ height: number; width: number }>): string =>
  `seedream-v1/${String(size.width)}x${String(size.height)}`;

interface Fixture {
  readonly repository: InMemoryMediaRepository;
  readonly service: ReturnType<typeof createMediaGenerationService>;
  readonly workspaceQuery: { snapshot: ScriptWorkspaceSnapshot | null };
}

const fixture = (
  shots: readonly StoryboardShotSnapshot[],
  status: EpisodeVersion['status'] = 'READY',
): Fixture => {
  const repository = new InMemoryMediaRepository();
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({
        invocations: new InMemoryMediaInvocationRepository(),
        media: repository,
        video: new InMemoryVideoMediaRepository(),
      }),
  };
  const workspaceQuery: ScriptWorkspaceQueryPort & {
    snapshot: ScriptWorkspaceSnapshot | null;
  } = {
    snapshot: workspaceOf(shots, status),
    getWorkspace: () => Promise.resolve(workspaceQuery.snapshot),
    getVersionDocument: () => Promise.resolve(null),
  };
  const service = createMediaGenerationService({
    candidateCount: 4,
    formatProfiles: { findAllByProject: () => Promise.resolve([formatProfile]) },
    hashPayload,
    mediaUnitOfWork: unitOfWork,
    modelId: MODEL_ID,
    newId: (() => {
      let counter = 0;
      return () => `id_${String((counter += 1))}`;
    })(),
    parametersFingerprint,
    workspaceQuery,
  });
  return { repository, service, workspaceQuery };
};

const shot1 = (): StoryboardShotSnapshot => ({
  sequence: 1,
  shotId: 'shot_1',
  version: shotVersionOf('scv_1', shotDocument(['char_hero'], 'scene_alley')),
});

const shot2 = (): StoryboardShotSnapshot => ({
  sequence: 2,
  shotId: 'shot_2',
  version: shotVersionOf('scv_2', shotDocument(['char_other'], 'scene_alley')),
});

describe('MediaGenerationService.generateCandidates', () => {
  it('冻结输入齐全—建任务与 4 个 PENDING 候选—哈希按描述符独立复算一致', async () => {
    const { repository, service } = fixture([shot1(), shot2()]);
    const result = await service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      candidateCount: 4,
      idempotencyKey: 'req_1',
      phase: 'SUBMITTED',
      providerTaskId: null,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    expect(repository.tasks).toHaveLength(1);
    const candidates = repository.candidates.filter((candidate) => candidate.shotId === 'shot_1');
    expect(candidates).toHaveLength(4);
    expect(candidates.every((candidate) => candidate.status === 'PENDING')).toBe(true);
    // 独立复算：绑定解析（无资产 → 空列表）+ 9:16 画幅指纹。
    const expectedHash = computeGenerationInputHash(
      {
        boundAssetVersionIds: [],
        modelId: MODEL_ID,
        parametersFingerprint: parametersFingerprint({ height: 2560, width: 1440 }),
        shotContentHash: hash64('doc_scv_1'),
        shotVersionId: 'scv_1',
      },
      hashPayload,
    );
    expect(result.data.generationInputHash).toBe(expectedHash);
  });

  it('requestId 重放返回原任务不新建—同 requestId 换镜头稳定拒绝', async () => {
    const { repository, service } = fixture([shot1(), shot2()]);
    const first = await service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    const replay = await service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_2',
    );
    expect(replay.ok).toBe(true);
    if (replay.ok && first.ok) expect(replay.data.id).toBe(first.data.id);
    expect(repository.tasks).toHaveLength(1);
    expect(repository.candidates).toHaveLength(4);

    const mismatch = await service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_2' },
      'trace_3',
    );
    expect(mismatch).toMatchObject({ ok: false });
    if (!mismatch.ok) expect(mismatch.error.code).toBe('REQUEST_ID_REUSED');
  });

  it('分镜未 READY 与镜头不在集合—稳定前置错误且零写入', async () => {
    const draft = fixture([shot1()], 'DRAFT');
    const draftResult = await draft.service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(draftResult).toMatchObject({ ok: false });
    if (!draftResult.ok) expect(draftResult.error.code).toBe('MEDIA_STORYBOARD_NOT_READY');
    expect(draft.repository.tasks).toHaveLength(0);

    const missing = fixture([shot1()]);
    const missingResult = await missing.service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_missing' },
      'trace_2',
    );
    expect(missingResult).toMatchObject({ ok: false });
    if (!missingResult.ok) expect(missingResult.error.code).toBe('MEDIA_SHOT_NOT_IN_READY_SET');
    expect(missing.repository.candidates).toHaveLength(0);

    const empty = fixture([shot1()]);
    empty.workspaceQuery.snapshot = null;
    const emptyResult = await empty.service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_3',
    );
    expect(emptyResult).toMatchObject({ ok: false });
    if (!emptyResult.ok) expect(emptyResult.error.code).toBe('SCRIPT_WORKSPACE_NOT_INITIALIZED');
  });
});

describe('MediaGenerationService.propagateStaleForAssetChange', () => {
  it('受绑定镜头旧世代候选标记 STALE—未绑定镜头与当前世代不受影响', async () => {
    const { repository, service } = fixture([shot1(), shot2()]);
    // 资产 char_hero 当前版本 v2（升版后）。
    await repository.createAsset({
      assetType: 'CHARACTER',
      bibleRefId: 'char_hero',
      displayName: '主角',
      id: 'asset_hero',
      projectId: 'project_1',
    });
    await repository.appendAssetVersion({
      assetId: 'asset_hero',
      byteSize: 10,
      fileSha256: 'a'.repeat(64),
      id: 'av_2',
      mimeType: 'image/png',
    });
    // shot_1 存在两个世代的候选：旧哈希（生成时无资产版本）与新哈希（= 当前重算）。
    await repository.insertCandidates({
      candidateIds: ['c_old_1', 'c_old_2'],
      generationInputHash: hash64('old_generation'),
      modelId: MODEL_ID,
      projectId: 'project_1',
      roundNo: 1,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    const currentHash = computeGenerationInputHash(
      {
        boundAssetVersionIds: ['av_2'],
        modelId: MODEL_ID,
        parametersFingerprint: parametersFingerprint({ height: 2560, width: 1440 }),
        shotContentHash: hash64('doc_scv_1'),
        shotVersionId: 'scv_1',
      },
      hashPayload,
    );
    await repository.insertCandidates({
      candidateIds: ['c_new_1'],
      generationInputHash: currentHash,
      modelId: MODEL_ID,
      projectId: 'project_1',
      roundNo: 2,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    // shot_2 绑定 char_other 与同一场景 scene_alley——场景资产未变，不应误伤。
    await repository.insertCandidates({
      candidateIds: ['c_other_1'],
      generationInputHash: hash64('other_generation'),
      modelId: MODEL_ID,
      projectId: 'project_1',
      roundNo: 1,
      shotId: 'shot_2',
      shotVersionId: 'scv_2',
    });

    const affected = await service.propagateStaleForAssetChange(
      { bibleRefId: 'char_hero', projectId: 'project_1' },
      'trace_1',
    );
    expect(affected.ok).toBe(true);
    if (affected.ok) {
      expect(affected.data).toEqual([{ candidateCount: 2, shotId: 'shot_1' }]);
    }
    const statusOf = (id: string): string | undefined =>
      repository.candidates.find((candidate) => candidate.id === id)?.status;
    expect(statusOf('c_old_1')).toBe('STALE_INPUT');
    expect(statusOf('c_old_2')).toBe('STALE_INPUT');
    expect(statusOf('c_new_1')).toBe('PENDING');
    expect(statusOf('c_other_1')).toBe('PENDING');
  });

  it('无工作区时空传播不报错返回空清单', async () => {
    const empty = fixture([]);
    empty.workspaceQuery.snapshot = null;
    await expect(
      empty.service.propagateStaleForAssetChange(
        { bibleRefId: 'char_hero', projectId: 'project_1' },
        'trace_1',
      ),
    ).resolves.toMatchObject({ data: [], ok: true });
  });
});

describe('MediaGenerationService.propagateStaleForShotVersion', () => {
  it('按旧镜头版本传播 STALE 并返回受影响镜头摘要', async () => {
    const { repository, service } = fixture([shot1()]);
    await repository.insertCandidates({
      candidateIds: ['c_1'],
      generationInputHash: hash64('gen_1'),
      modelId: MODEL_ID,
      projectId: 'project_1',
      roundNo: 1,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    const affected = await service.propagateStaleForShotVersion('scv_1', 'trace_1');
    expect(affected).toMatchObject({ data: [{ candidateCount: 1, shotId: 'shot_1' }], ok: true });
    expect(repository.candidates[0]?.status).toBe('STALE_INPUT');
  });
});
