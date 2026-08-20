import { describe, expect, it } from 'vitest';

import type { FormatProfile } from '@jingxu/domain';

import type { MediaTaskRecord, MediaUnitOfWorkPort } from '../ports/media/media-repository';
import type {
  EpisodeVersion,
  ScriptWorkspaceSnapshot,
  ShotContractVersion,
  StoryboardShotSnapshot,
} from '../ports/script/script-types';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import { InMemoryMediaInvocationRepository } from './in-memory-media-invocation-repository';
import { InMemoryMediaRepository } from './in-memory-media-repository';
import { createMediaRequestBlueprintBuilder } from './media-request-blueprint';

const NOW = '2026-08-16T00:00:00.000Z';
const MODEL_ID = 'doubao-seedream-5-0-lite-260128';
const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);

const shotVersionOf = (versionId: string, document: string): ShotContractVersion => ({
  createdAt: NOW,
  dialogueRenderMode: 'NARRATION_FIRST',
  document,
  documentSha256: hash64(`doc_${versionId}`),
  externalParentVersionId: null,
  formatProfileId: 'fp_1',
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

const bibleDocument = (extraCharacters: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    characters: {
      char_hero: { appearance: '白裙少女', motivation: '', name: '少女', personality: '' },
      ...extraCharacters,
    },
    props: {},
    scenes: { scene_alley: { description: '青石板雨巷', name: '雨巷' } },
    world_rules: [],
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
    height: 2560,
    language: 'zh-CN',
    subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
    width: 1440,
  },
  versionNo: 1,
};

interface Fixture {
  readonly reads: { readonly fileSha256: string; readonly mimeType: string }[];
  readonly referenceImages: { readReference: (input: never) => Promise<Uint8Array> };
  readonly repository: InMemoryMediaRepository;
  readonly workspaceQuery: { snapshot: ScriptWorkspaceSnapshot | null };
  readonly build: ReturnType<typeof createMediaRequestBlueprintBuilder>['build'];
}

const fixture = (snapshot: ScriptWorkspaceSnapshot | null): Fixture => {
  const repository = new InMemoryMediaRepository();
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
  };
  const workspaceQuery: ScriptWorkspaceQueryPort & {
    snapshot: ScriptWorkspaceSnapshot | null;
  } = {
    snapshot,
    getWorkspace: () => Promise.resolve(workspaceQuery.snapshot),
    getVersionDocument: () => Promise.resolve(null),
  };
  const reads: { fileSha256: string; mimeType: string }[] = [];
  const referenceImages = {
    readReference: (input: { fileSha256: string; mimeType: string }): Promise<Uint8Array> => {
      reads.push({ fileSha256: input.fileSha256, mimeType: input.mimeType });
      return Promise.resolve(Uint8Array.from([1, 2, 3]));
    },
  };
  const builder = createMediaRequestBlueprintBuilder({
    formatProfiles: { findAllByProject: () => Promise.resolve([formatProfile]) },
    mediaUnitOfWork: unitOfWork,
    referenceImages,
    workspaceQuery,
  });
  return { reads, referenceImages, repository, workspaceQuery, build: builder.build };
};

const snapshotOf = (
  shots: readonly StoryboardShotSnapshot[],
  bibleDocumentText: string | null,
): ScriptWorkspaceSnapshot => ({
  episode: null,
  projectId: 'project_1',
  sourceInput: null,
  stages:
    bibleDocumentText === null
      ? []
      : [
          {
            current: {
              createdAt: NOW,
              document: bibleDocumentText,
              documentSha256: hash64('bible'),
              id: 'sbv_1',
              parentId: null,
              projectId: 'project_1',
              source: 'AI',
              sourceInvocationId: null,
              status: 'READY',
              versionNo: 1,
            },
            episodeId: null,
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
      status: 'READY' satisfies EpisodeVersion['status'],
      storyBibleVersionId: 'sbv_1',
      targetDurationSec: 90,
      versionNo: 1,
    },
    currentShots: shots,
    history: [],
    historyTruncated: false,
  },
});

const seedTask = async (repository: InMemoryMediaRepository): Promise<string> => {
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
  };
  const task = await unitOfWork.run(({ media }) =>
    media.insertTask({
      candidateCount: 4,
      generationInputHash: hash64('gen'),
      id: 'task_1',
      idempotencyKey: 'req_1',
      projectId: 'project_1',
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    }),
  );
  await unitOfWork.run(({ media }) =>
    media.insertCandidates({
      candidateIds: ['c_1', 'c_2', 'c_3', 'c_4'],
      generationInputHash: hash64('gen'),
      modelId: MODEL_ID,
      projectId: 'project_1',
      roundNo: task.roundNo,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    }),
  );
  return task.id;
};

const seedAsset = async (
  repository: InMemoryMediaRepository,
  assetType: 'CHARACTER' | 'SCENE',
  bibleRefId: string,
): Promise<void> => {
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
  };
  const asset = await unitOfWork.run(({ media }) =>
    media.createAsset({
      assetType,
      bibleRefId,
      displayName: bibleRefId,
      id: `asset_${bibleRefId}`,
      projectId: 'project_1',
    }),
  );
  await unitOfWork.run(({ media }) =>
    media.appendAssetVersion({
      assetId: asset.id,
      byteSize: 3,
      fileSha256: hash64(`file_${bibleRefId}`),
      id: `assetv_${bibleRefId}`,
      mimeType: 'image/png',
    }),
  );
};

const shot1 = (document: string): StoryboardShotSnapshot => ({
  sequence: 1,
  shotId: 'shot_1',
  version: shotVersionOf('scv_1', document),
});

describe('createMediaRequestBlueprintBuilder', () => {
  it('齐全输入—画幅映射尺寸—Prompt 融合圣经描述—参考图按绑定资产加载', async () => {
    const fixture_ = fixture(
      snapshotOf([shot1(shotDocument(['char_hero'], 'scene_alley'))], bibleDocument()),
    );
    await seedTask(fixture_.repository);
    await seedAsset(fixture_.repository, 'CHARACTER', 'char_hero');
    await seedAsset(fixture_.repository, 'SCENE', 'scene_alley');
    const blueprint = await fixture_.build(await unitOfWorkTask(fixture_.repository));
    expect(blueprint.modelId).toBe(MODEL_ID);
    const request = blueprint.buildRequest('inv_1');
    expect(request.invocationId).toBe('inv_1');
    expect(request.size).toEqual({ height: 2560, width: 1440 });
    expect(request.prompt).toContain('白裙少女');
    expect(request.prompt).toContain('青石板雨巷');
    expect(request.referenceImages).toEqual([
      { bytes: Uint8Array.from([1, 2, 3]), mimeType: 'image/png' },
      { bytes: Uint8Array.from([1, 2, 3]), mimeType: 'image/png' },
    ]);
    expect(JSON.parse(blueprint.submitSnapshotJson)).toEqual({
      modelId: MODEL_ID,
      prompt: request.prompt,
      referenceImageSha256s: [hash64('file_char_hero'), hash64('file_scene_alley')],
      responseFormat: 'url',
      size: { height: 2560, width: 1440 },
      watermark: true,
    });
    expect(fixture_.reads.map((read) => read.fileSha256)).toEqual([
      hash64('file_char_hero'),
      hash64('file_scene_alley'),
    ]);
  });

  it('STORY_BIBLE 缺失—Prompt 降级仍可构建—参考图不受影响', async () => {
    const fixture_ = fixture(snapshotOf([shot1(shotDocument(['char_hero'], 'scene_alley'))], null));
    await seedTask(fixture_.repository);
    await seedAsset(fixture_.repository, 'CHARACTER', 'char_hero');
    const blueprint = await fixture_.build(await unitOfWorkTask(fixture_.repository));
    const request = blueprint.buildRequest('inv_1');
    expect(request.prompt).toContain('雨巷中的少女');
    expect(request.prompt).not.toContain('白裙少女');
    expect(request.referenceImages).toHaveLength(1);
  });

  it('绑定超过契约上限 14—参考图读取截断到前 14', async () => {
    const characterIds = Array.from(
      { length: 20 },
      (_, index) => `char_${String(index).padStart(2, '0')}`,
    );
    const extraCharacters = Object.fromEntries(
      characterIds.map((id) => [
        id,
        { appearance: '样貌', motivation: '', name: id, personality: '' },
      ]),
    );
    const fixture_ = fixture(
      snapshotOf(
        [shot1(shotDocument(characterIds, 'scene_alley'))],
        bibleDocument(extraCharacters),
      ),
    );
    await seedTask(fixture_.repository);
    for (const id of characterIds) {
      await seedAsset(fixture_.repository, 'CHARACTER', id);
    }
    const blueprint = await fixture_.build(await unitOfWorkTask(fixture_.repository));
    expect(fixture_.reads).toHaveLength(14);
    expect(blueprint.buildRequest('inv_1').referenceImages).toHaveLength(14);
  });

  it('工作区缺失 / 分镜版本不一致—稳定 message 标记', async () => {
    const missing = fixture(null);
    await seedTask(missing.repository);
    await expect(missing.build(await unitOfWorkTask(missing.repository))).rejects.toThrow(
      'MEDIA_BLUEPRINT_WORKSPACE_MISSING',
    );

    const fixture_ = fixture(
      snapshotOf([shot1(shotDocument(['char_hero'], 'scene_alley'))], bibleDocument()),
    );
    const repository = fixture_.repository;
    const unitOfWork: MediaUnitOfWorkPort = {
      run: (work) =>
        work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
    };
    const task = await unitOfWork.run(({ media }) =>
      media.insertTask({
        candidateCount: 4,
        generationInputHash: hash64('gen'),
        id: 'task_2',
        idempotencyKey: 'req_2',
        projectId: 'project_1',
        shotId: 'shot_1',
        shotVersionId: 'scv_stale',
      }),
    );
    await expect(fixture_.build(task)).rejects.toThrow('MEDIA_BLUEPRINT_SHOT_VERSION_MISMATCH');
  });
});

/** 从仓储取回种下的任务行（build 消费 MediaTaskRecord）。 */
const unitOfWorkTask = async (repository: InMemoryMediaRepository): Promise<MediaTaskRecord> => {
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
  };
  const task = await unitOfWork.run(({ media }) => media.findTaskById('project_1', 'task_1'));
  if (task === null) throw new Error('task_1 not seeded');
  return task;
};
