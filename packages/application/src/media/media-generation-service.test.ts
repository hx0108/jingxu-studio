import { describe, expect, it } from 'vitest';

import type { MediaUnitOfWorkPort } from '../ports/media/media-repository';
import type {
  EpisodeVersion,
  ScriptWorkspaceSnapshot,
  ShotContractVersion,
  StoryboardShotSnapshot,
} from '../ports/script/script-types';
import type { FormatProfile } from '@jingxu/domain';
import { PROJECT_STYLE_BIBLE_REF_ID } from '@jingxu/contracts';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import { InMemoryMediaInvocationRepository } from './in-memory-media-invocation-repository';
import { InMemoryMediaRepository } from './in-memory-media-repository';
import { InMemoryVideoMediaRepository } from './in-memory-video-media-repository';
import { createMediaConsistencyService } from './media-consistency-service';
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

const storyBibleDocument = (): string =>
  JSON.stringify({
    data: {
      characters: {
        char_hero: { appearance: '银白短发，黑色风衣', name: '林峥' },
        char_other: { appearance: '栗色长发，白色衬衫', name: '林知夏' },
      },
      scenes: {
        scene_alley: { description: '雨后青石巷，霓虹倒影', name: '雨巷' },
      },
    },
    schema_version: '1.0.0',
    stage: 'STORY_BIBLE',
  });

const brokenStoryBibleDocument = (): string =>
  JSON.stringify({ data: { characters: {} }, schema_version: '1.0.0', stage: 'SHOT_CONTRACT' });

const workspaceOf = (
  shots: readonly StoryboardShotSnapshot[],
  status: EpisodeVersion['status'] = 'READY',
  bibleDocument: string | null = storyBibleDocument(),
): ScriptWorkspaceSnapshot => ({
  episode: null,
  projectId: 'project_1',
  sourceInput: null,
  stages: [
    {
      current:
        bibleDocument === null
          ? null
          : {
              createdAt: NOW,
              document: bibleDocument,
              documentSha256: hash64('bible'),
              id: 'sbv_1',
              parentId: null,
              projectId: 'project_1',
              source: 'AI',
              sourceInvocationId: null,
              status: 'READY',
              versionNo: 1,
            },
      episodeId: 'episode_1',
      head: null,
      history: [],
      historyTruncated: false,
      stage: 'STORY_BIBLE',
    },
  ],
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

/** 为一致性预检播种画风与角色锚点；style=false 可模拟缺画风。 */
const seedConsistencyAssets = async (
  repository: InMemoryMediaRepository,
  characterIds: readonly string[],
  style = true,
): Promise<void> => {
  if (style) {
    const styleAsset = await repository.createAsset({
      assetType: 'STYLE',
      bibleRefId: PROJECT_STYLE_BIBLE_REF_ID,
      displayName: '项目画风',
      id: 'asset_style',
      projectId: 'project_1',
    });
    await repository.appendAssetVersion({
      assetId: styleAsset.id,
      byteSize: 1024,
      description: '赛博朋克水墨风，冷青主色调',
      fileSha256: hash64('style_v1'),
      id: 'ver_style_v1',
      mimeType: 'image/png',
    });
  }
  for (const [index, characterId] of characterIds.entries()) {
    const asset = await repository.createAsset({
      assetType: 'CHARACTER',
      bibleRefId: characterId,
      displayName: `角色${String(index + 1)}`,
      id: `asset_${characterId}`,
      projectId: 'project_1',
    });
    await repository.appendAssetVersion({
      assetId: asset.id,
      byteSize: 1024,
      description: null,
      fileSha256: hash64(`${characterId}_v1`),
      id: `ver_${characterId}_v1`,
      mimeType: 'image/png',
    });
  }
};

const fixture = async (
  shots: readonly StoryboardShotSnapshot[],
  status: EpisodeVersion['status'] = 'READY',
  options: {
    readonly assets?: 'full' | 'no-style' | 'none' | 'style-only';
    readonly bibleDocument?: string | null;
  } = {},
): Promise<Fixture> => {
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
    snapshot: workspaceOf(shots, status, options.bibleDocument ?? storyBibleDocument()),
    getWorkspace: () => Promise.resolve(workspaceQuery.snapshot),
    getVersionDocument: () => Promise.resolve(null),
  };
  const consistency = createMediaConsistencyService({
    mediaUnitOfWork: unitOfWork,
    workspaceQuery,
  });
  const service = createMediaGenerationService({
    candidateCount: 4,
    consistency,
    formatProfiles: { findAllByProject: () => Promise.resolve([formatProfile]) },
    hashPayload,
    mediaUnitOfWork: unitOfWork,
    modelId: () => MODEL_ID,
    newId: (() => {
      let counter = 0;
      return () => `id_${String((counter += 1))}`;
    })(),
    parametersFingerprint,
    workspaceQuery,
  });
  const assets = options.assets ?? 'full';
  if (assets === 'full' || assets === 'no-style') {
    await seedConsistencyAssets(repository, ['char_hero', 'char_other'], assets === 'full');
  } else if (assets === 'style-only') {
    await seedConsistencyAssets(repository, ['char_hero'], true);
  }
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
    const { repository, service } = await fixture([shot1(), shot2()]);
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
    // 独立复算：绑定解析（STYLE + 出场角色，服务端按版本 ID 排序）+ 9:16 画幅指纹。
    const styleVersion = await repository.findCurrentAssetVersion(
      'project_1',
      'STYLE',
      PROJECT_STYLE_BIBLE_REF_ID,
    );
    const heroVersion = await repository.findCurrentAssetVersion(
      'project_1',
      'CHARACTER',
      'char_hero',
    );
    const expectedHash = computeGenerationInputHash(
      {
        boundAssetVersionIds: [styleVersion?.id, heroVersion?.id]
          .filter((id): id is string => typeof id === 'string')
          .sort(),
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
    const { repository, service } = await fixture([shot1(), shot2()]);
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

  it('缺项目画风锚点—一致门禁阻断且零写入零建档', async () => {
    const { repository, service } = await fixture([shot1()], 'READY', { assets: 'no-style' });
    const result = await service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_style', shotId: 'shot_1' },
      'trace_style',
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error.code).toBe('MEDIA_CONSISTENCY_STYLE_REQUIRED');
    expect(repository.tasks).toHaveLength(0);
    expect(repository.candidates).toHaveLength(0);
  });

  it('出场角色缺少参考图—阻断并列出去重缺失项', async () => {
    const { repository, service } = await fixture([shot1(), shot2()], 'READY', {
      assets: 'style-only',
    });
    // char_other 无资产：为 shot_2 生成应被阻断并点名该角色。
    const result = await service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_char', shotId: 'shot_2' },
      'trace_char',
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok)
      expect(result.error.code).toBe('MEDIA_CONSISTENCY_CHARACTER_REFERENCE_REQUIRED');
    expect(repository.tasks).toHaveLength(0);
  });

  it('StoryBible 信封损坏—阻断且零写入', async () => {
    const { repository, service } = await fixture([shot1()], 'READY', {
      bibleDocument: brokenStoryBibleDocument(),
    });
    const result = await service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_bible', shotId: 'shot_1' },
      'trace_bible',
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error.code).toBe('MEDIA_CONSISTENCY_STORY_BIBLE_INVALID');
    expect(repository.tasks).toHaveLength(0);
    expect(repository.candidates).toHaveLength(0);
  });

  it('画风加角色参考图超过 Provider 上限—稳定阻断不截断必需项', async () => {
    const crowd = Array.from({ length: 14 }, (_, index) => `char_c${String(index + 1)}`);
    const crowdShot = (): StoryboardShotSnapshot => ({
      sequence: 1,
      shotId: 'shot_crowd',
      version: shotVersionOf('scv_crowd', shotDocument(crowd, 'scene_alley')),
    });
    const { repository, service } = await fixture([crowdShot()], 'READY', { assets: 'none' });
    await seedConsistencyAssets(repository, crowd);
    const result = await service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_limit', shotId: 'shot_crowd' },
      'trace_limit',
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error.code).toBe('MEDIA_CONSISTENCY_REFERENCE_LIMIT_EXCEEDED');
    expect(repository.tasks).toHaveLength(0);
    expect(repository.candidates).toHaveLength(0);
  });

  it('分镜未 READY 与镜头不在集合—稳定前置错误且零写入', async () => {
    const draft = await fixture([shot1()], 'DRAFT');
    const draftResult = await draft.service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(draftResult).toMatchObject({ ok: false });
    if (!draftResult.ok) expect(draftResult.error.code).toBe('MEDIA_STORYBOARD_NOT_READY');
    expect(draft.repository.tasks).toHaveLength(0);

    const missing = await fixture([shot1()]);
    const missingResult = await missing.service.generateCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_missing' },
      'trace_2',
    );
    expect(missingResult).toMatchObject({ ok: false });
    if (!missingResult.ok) expect(missingResult.error.code).toBe('MEDIA_SHOT_NOT_IN_READY_SET');
    expect(missing.repository.candidates).toHaveLength(0);

    const empty = await fixture([shot1()]);
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
    const { repository, service } = await fixture([shot1(), shot2()], 'READY', {
      assets: 'none',
    });
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
    const empty = await fixture([]);
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
    const { repository, service } = await fixture([shot1()]);
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
