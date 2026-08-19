import { describe, expect, it } from 'vitest';

import type { AppResultDto, MediaTaskViewDto } from '@jingxu/contracts';

import type { MediaStaleAffectedShot, MediaUnitOfWorkPort } from '../ports/media/media-repository';
import { InMemoryMediaInvocationRepository } from './in-memory-media-invocation-repository';
import { InMemoryMediaRepository } from './in-memory-media-repository';
import type { ImageApiService } from './image-api-service';
import { createImageApiService } from './image-api-service';
import type { MediaGenerationService } from './media-generation-service';

const NOW = '2026-08-16T00:00:00.000Z';
const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);

/** 生成侧桩：只回放固定任务行，验证 ImageApiService 的编排与映射。 */
const generationStub = (
  task: { readonly id: string; readonly projectId: string } | null,
): MediaGenerationService => ({
  generateCandidates: () =>
    task === null
      ? Promise.resolve({
          error: {
            code: 'MEDIA_STORYBOARD_NOT_READY' as const,
            fieldErrors: null,
            message: '分镜尚未确认',
            retryable: false,
            traceId: 'trace_1',
            userAction: null,
          },
          ok: false,
        })
      : Promise.resolve({
          data: {
            candidateCount: 4,
            createdAt: NOW,
            errorCode: null,
            generationInputHash: hash64('gen'),
            id: task.id,
            idempotencyKey: 'req_1',
            phase: 'SUBMITTED' as const,
            projectId: task.projectId,
            providerTaskId: null,
            roundNo: 1,
            shotId: 'shot_1',
            shotVersionId: 'scv_1',
            updatedAt: NOW,
          },
          ok: true,
        }),
  propagateStaleForShotVersion: () =>
    Promise.resolve({ data: [], ok: true } as AppResultDto<readonly MediaStaleAffectedShot[]>),
  propagateStaleForAssetChange: () =>
    Promise.resolve({ data: [], ok: true } as AppResultDto<readonly MediaStaleAffectedShot[]>),
});

interface Fixture {
  readonly kicked: string[];
  readonly repository: InMemoryMediaRepository;
  readonly service: ImageApiService;
  readonly writes: {
    readonly byteSize: number;
    readonly projectId: string;
    readonly sha256: string;
  }[];
}

const buildFixture = (
  generation: MediaGenerationService = generationStub({ id: 'task_1', projectId: 'project_1' }),
  assertCredentialReady?: () => Promise<void>,
): Fixture => {
  const repository = new InMemoryMediaRepository();
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
  };
  const kicked: string[] = [];
  const writes: { byteSize: number; projectId: string; sha256: string }[] = [];
  let counter = 0;
  const service = createImageApiService({
    ...(assertCredentialReady === undefined ? {} : { assertCredentialReady }),
    // 六方法用例不触批次路径：占位实现一旦被调用即失败暴露接线错误。
    batch: {
      cancelBatch: () => Promise.reject(new Error('batch not under test')),
      createBatch: () => Promise.reject(new Error('batch not under test')),
      listStoryboardImageStates: () => Promise.reject(new Error('batch not under test')),
      progressBatch: () => Promise.reject(new Error('batch not under test')),
    },
    assetFileStore: {
      writeAsset: ({ bytes, projectId }) => {
        counter += 1;
        const sha256 = hash64(`asset_${String(counter)}`);
        const record = { byteSize: bytes.byteLength, projectId, sha256 };
        writes.push(record);
        return Promise.resolve({
          byteSize: record.byteSize,
          mimeType: 'image/png',
          sha256,
          storageRelPath: `projects/${projectId}/assets/${sha256.slice(0, 2)}/${sha256}.png`,
        });
      },
    },
    generation,
    mediaUnitOfWork: unitOfWork,
    newId: () => `gen_${String((counter += 1))}`,
    scheduler: { kick: (projectId) => kicked.push(projectId) },
  });
  return { kicked, repository, service, writes };
};

/** 落一枚成功候选（供选择与 mediaUrl 断言）。 */
const seedSucceededCandidate = async (
  repository: InMemoryMediaRepository,
  candidateId: string,
): Promise<void> => {
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
  };
  const inserted = await unitOfWork.run(({ media }) =>
    media.insertCandidates({
      candidateIds: [candidateId],
      generationInputHash: hash64('gen'),
      modelId: 'doubao-seedream-5-0-lite-260128',
      projectId: 'project_1',
      roundNo: 1,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    }),
  );
  const id = inserted[0]?.id;
  if (id === undefined) throw new Error('candidate not seeded');
  await unitOfWork.run(({ media }) =>
    media.completeCandidateSucceeded(id, {
      byteSize: 4,
      fileSha256: hash64('file'),
      height: 2560,
      invocationEvidenceRef: 'inv_1',
      mimeType: 'image/png',
      storageRelPath: `projects/project_1/images/${hash64('file').slice(0, 2)}/${hash64('file')}.png`,
      width: 1440,
    }),
  );
};

describe('createImageApiService', () => {
  it('generateCandidates—建档成功后 kick 调度器—任务 DTO 不泄漏幂等键与 providerTaskId', async () => {
    const fixture = buildFixture();
    const result = await fixture.service.generateCandidates(
      { projectId: 'project_1', requestId: 'request_12345678', shotId: 'shot_1' },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const view: MediaTaskViewDto = result.data;
      expect(view.id).toBe('task_1');
      expect(view.phase).toBe('SUBMITTED');
      expect(Object.keys(view).sort()).toEqual([
        'candidateCount',
        'createdAt',
        'errorCode',
        'generationInputHash',
        'id',
        'phase',
        'shotId',
        'shotVersionId',
        'updatedAt',
      ]);
    }
    expect(fixture.kicked).toEqual(['project_1']);
  });

  it('generateCandidates—生成前置失败原样透传—不 kick', async () => {
    const fixture = buildFixture(generationStub(null));
    const result = await fixture.service.generateCandidates(
      { projectId: 'project_1', requestId: 'request_12345678', shotId: 'shot_1' },
      'trace_1',
    );
    expect(result).toMatchObject({ error: { code: 'MEDIA_STORYBOARD_NOT_READY' }, ok: false });
    expect(fixture.kicked).toEqual([]);
  });

  it('凭据闸抛错—generateCandidates 前置稳定失败—不触发生成、kick 与其余五方法', async () => {
    let gateCalls = 0;
    const fixture = buildFixture(generationStub({ id: 'task_1', projectId: 'project_1' }), () => {
      gateCalls += 1;
      return Promise.reject(new Error('CREDENTIAL_NOT_FOUND'));
    });

    const result = await fixture.service.generateCandidates(
      { projectId: 'project_1', requestId: 'request_12345678', shotId: 'shot_1' },
      'trace_1',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MODEL_CREDENTIAL_INVALID');
      expect(result.error.userAction).toContain('图片');
    }
    expect(gateCalls).toBe(1);
    expect(fixture.kicked).toEqual([]);
    // 查询类方法不受凭据闸影响。
    await expect(
      fixture.service.listCandidates({ projectId: 'project_1', shotId: 'shot_1' }, 'trace_1'),
    ).resolves.toMatchObject({ ok: true });
  });

  it('凭据闸通过—generateCandidates 正常建档并 kick（闸在场不改变行为）', async () => {
    const fixture = buildFixture(generationStub({ id: 'task_1', projectId: 'project_1' }), () =>
      Promise.resolve(),
    );

    const result = await fixture.service.generateCandidates(
      { projectId: 'project_1', requestId: 'request_12345678', shotId: 'shot_1' },
      'trace_1',
    );

    expect(result.ok).toBe(true);
    expect(fixture.kicked).toEqual(['project_1']);
  });

  it('listCandidates—SUCCEEDED 携带受限 mediaUrl—其余状态为 null', async () => {
    const fixture = buildFixture();
    await seedSucceededCandidate(fixture.repository, 'cand_succ_1');
    await fixture.repository.insertCandidates({
      candidateIds: ['cand_pend_1'],
      generationInputHash: hash64('gen'),
      modelId: 'doubao-seedream-5-0-lite-260128',
      projectId: 'project_1',
      roundNo: 2,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    const result = await fixture.service.listCandidates(
      { projectId: 'project_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    const succeeded = result.data.find((candidate) => candidate.id === 'cand_succ_1');
    expect(succeeded).toMatchObject({
      mediaUrl: 'jingxu://media/candidate/cand_succ_1',
      status: 'SUCCEEDED',
    });
    const pending = result.data.find((candidate) => candidate.id === 'cand_pend_1');
    expect(pending).toMatchObject({ mediaUrl: null, status: 'PENDING' });
  });

  it('selectCandidate—原子切换并返回全量候选—旧选择被清空', async () => {
    const fixture = buildFixture();
    await seedSucceededCandidate(fixture.repository, 'cand_a_1');
    await seedSucceededCandidate(fixture.repository, 'cand_b_1');
    const unitOfWork: MediaUnitOfWorkPort = {
      run: (work) =>
        work({ invocations: new InMemoryMediaInvocationRepository(), media: fixture.repository }),
    };
    await unitOfWork.run(({ media }) => media.selectCandidate('shot_1', 'cand_a_1'));
    const result = await fixture.service.selectCandidate(
      { candidateId: 'cand_b_1', projectId: 'project_1', requestId: 'request_select_1' },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.data.find((candidate) => candidate.id === 'cand_a_1');
    const b = result.data.find((candidate) => candidate.id === 'cand_b_1');
    expect(a?.selectedAt).toBeNull();
    expect(b?.selectedAt).not.toBeNull();
  });

  it('selectCandidate—跨项目候选不可见—MEDIA_CANDIDATE_NOT_FOUND', async () => {
    const fixture = buildFixture();
    await seedSucceededCandidate(fixture.repository, 'cand_a_1');
    const result = await fixture.service.selectCandidate(
      { candidateId: 'cand_a_1', projectId: 'project_other', requestId: 'request_sel_2' },
      'trace_1',
    );
    expect(result).toMatchObject({ error: { code: 'MEDIA_CANDIDATE_NOT_FOUND' }, ok: false });
  });

  it('selectCandidate—不可选候选（PENDING）—MEDIA_CANDIDATE_NOT_SELECTABLE', async () => {
    const fixture = buildFixture();
    await fixture.repository.insertCandidates({
      candidateIds: ['cand_pend_2'],
      generationInputHash: hash64('gen'),
      modelId: 'doubao-seedream-5-0-lite-260128',
      projectId: 'project_1',
      roundNo: 1,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    const result = await fixture.service.selectCandidate(
      { candidateId: 'cand_pend_2', projectId: 'project_1', requestId: 'request_sel_3' },
      'trace_1',
    );
    expect(result).toMatchObject({ error: { code: 'MEDIA_CANDIDATE_NOT_SELECTABLE' }, ok: false });
  });

  it('uploadAssetReference—首次建档+落盘+版本视图—升版走版本链', async () => {
    const fixture = buildFixture();
    const first = await fixture.service.uploadAssetReference(
      {
        assetType: 'CHARACTER',
        bibleRefId: 'char_hero',
        byteSize: 3,
        bytes: Uint8Array.from([1, 2, 3]),
        description: '白裙少女定妆',
        displayName: '少女',
        mimeType: 'image/png',
        projectId: 'project_1',
        requestId: 'request_upload_1',
      },
      'trace_1',
    );
    if (!first.ok) throw new Error('首次上传应成功');
    expect(first.data.version).toMatchObject({ byteSize: 3, provenance: 'UPLOADED', versionNo: 1 });
    expect(first.data.version.assetId).toMatch(/^gen_/u);
    expect(first.data.version.mediaUrl.startsWith('jingxu://media/asset-version/')).toBe(true);
    // 无候选引用旧版本：受影响镜头清单为空但字段恒在（Renderer 决策入口）。
    expect(first.data.affectedShots).toEqual([]);
    const second = await fixture.service.uploadAssetReference(
      {
        assetType: 'CHARACTER',
        bibleRefId: 'char_hero',
        byteSize: 2,
        bytes: Uint8Array.from([9, 9]),
        description: null,
        displayName: '少女',
        mimeType: 'image/png',
        projectId: 'project_1',
        requestId: 'request_upload_2',
      },
      'trace_1',
    );
    expect(second).toMatchObject({ data: { version: { versionNo: 2 } }, ok: true });
    const assets = await fixture.repository.listAssets('project_1');
    expect(assets).toHaveLength(1);
    expect(assets[0]?.versions).toHaveLength(2);
    expect(fixture.writes).toHaveLength(2);
  });

  it('uploadAssetReference—升版传播受影响镜头摘要—映射进返回结果', async () => {
    const fixture = buildFixture({
      ...generationStub(null),
      propagateStaleForAssetChange: () =>
        Promise.resolve({
          data: [{ candidateCount: 4, shotId: 'shot_1' }],
          ok: true,
        } as AppResultDto<readonly MediaStaleAffectedShot[]>),
    });
    const result = await fixture.service.uploadAssetReference(
      {
        assetType: 'SCENE',
        bibleRefId: 'scene_alley',
        byteSize: 3,
        bytes: Uint8Array.from([1, 2, 3]),
        description: null,
        displayName: '雨巷',
        mimeType: 'image/png',
        projectId: 'project_1',
        requestId: 'request_upload_4',
      },
      'trace_1',
    );
    expect(result).toMatchObject({
      data: {
        affectedShots: [{ candidateCount: 4, shotId: 'shot_1' }],
        version: { versionNo: 1 },
      },
      ok: true,
    });
  });

  it('listAssets—currentVersion 指向最新版本—空资产 currentVersion 为 null', async () => {
    const fixture = buildFixture();
    const unitOfWork: MediaUnitOfWorkPort = {
      run: (work) =>
        work({ invocations: new InMemoryMediaInvocationRepository(), media: fixture.repository }),
    };
    const bare = await unitOfWork.run(({ media }) =>
      media.createAsset({
        assetType: 'SCENE',
        bibleRefId: 'scene_alley',
        displayName: '雨巷',
        id: 'asset_bare_1',
        projectId: 'project_1',
      }),
    );
    await fixture.service.uploadAssetReference(
      {
        assetType: 'CHARACTER',
        bibleRefId: 'char_hero',
        byteSize: 3,
        bytes: Uint8Array.from([1, 2, 3]),
        description: null,
        displayName: '少女',
        mimeType: 'image/png',
        projectId: 'project_1',
        requestId: 'request_upload_3',
      },
      'trace_1',
    );
    const result = await fixture.service.listAssets({ projectId: 'project_1' }, 'trace_1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hero = result.data.find((asset) => asset.bibleRefId === 'char_hero');
    expect(hero?.currentVersion?.versionNo).toBe(1);
    const empty = result.data.find((asset) => asset.id === bare.id);
    expect(empty?.currentVersion).toBeNull();
    expect(empty?.versions).toEqual([]);
  });

  it('getMediaTask—命中返回视图—未命中 MEDIA_TASK_NOT_FOUND', async () => {
    const fixture = buildFixture();
    const unitOfWork: MediaUnitOfWorkPort = {
      run: (work) =>
        work({ invocations: new InMemoryMediaInvocationRepository(), media: fixture.repository }),
    };
    await unitOfWork.run(({ media }) =>
      media.insertTask({
        candidateCount: 4,
        generationInputHash: hash64('gen'),
        id: 'task_lookup_1',
        idempotencyKey: 'req_lookup_1',
        projectId: 'project_1',
        shotId: 'shot_1',
        shotVersionId: 'scv_1',
      }),
    );
    const hit = await fixture.service.getMediaTask(
      { projectId: 'project_1', taskId: 'task_lookup_1' },
      'trace_1',
    );
    expect(hit).toMatchObject({ data: { id: 'task_lookup_1', phase: 'SUBMITTED' }, ok: true });
    const miss = await fixture.service.getMediaTask(
      { projectId: 'project_1', taskId: 'task_missing_1' },
      'trace_1',
    );
    expect(miss).toMatchObject({ error: { code: 'MEDIA_TASK_NOT_FOUND' }, ok: false });
  });
});
