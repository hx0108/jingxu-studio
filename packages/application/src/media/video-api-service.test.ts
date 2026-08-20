import { describe, expect, it } from 'vitest';

import type { AppResultDto, MediaBatchViewDto, MediaTaskViewDto } from '@jingxu/contracts';

import type { MediaUnitOfWorkPort } from '../ports/media/media-repository';
import { InMemoryMediaInvocationRepository } from './in-memory-media-invocation-repository';
import { InMemoryMediaRepository } from './in-memory-media-repository';
import { InMemoryVideoMediaRepository } from './in-memory-video-media-repository';
import type { VideoGenerationService } from './video-generation-service';
import type { VideoApiService } from './video-api-service';
import { createVideoApiService } from './video-api-service';

const NOW = '2026-08-16T00:00:00.000Z';
const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);

/** 生成侧桩：只回放固定任务行，验证 VideoApiService 的编排与映射。 */
const generationStub = (
  task: { readonly id: string; readonly projectId: string } | null,
): Pick<VideoGenerationService, 'generateVideoCandidates'> => ({
  generateVideoCandidates: () =>
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
            candidateCount: 2,
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
});

/** 批量侧桩：记录调用并回放固定批次视图（passthrough 断言用）。 */
const batchStub = (): {
  readonly batchCalls: string[];
  readonly batch: {
    cancelBatch: () => Promise<AppResultDto<MediaBatchViewDto>>;
    createBatch: () => Promise<AppResultDto<MediaBatchViewDto>>;
    listStoryboardVideoStates: () => Promise<
      AppResultDto<{ batches: MediaBatchViewDto[]; shots: [] }>
    >;
  };
} => {
  const batchCalls: string[] = [];
  const view: MediaBatchViewDto = {
    batchId: 'batch_1',
    createdAt: NOW,
    errorCode: null,
    members: [],
    skippedShotIds: [],
    status: 'RUNNING',
    updatedAt: NOW,
  };
  return {
    batchCalls,
    batch: {
      cancelBatch: () => {
        batchCalls.push('cancelBatch');
        return Promise.resolve({ data: { ...view, status: 'CANCELLED' }, ok: true });
      },
      createBatch: () => {
        batchCalls.push('createBatch');
        return Promise.resolve({ data: view, ok: true });
      },
      listStoryboardVideoStates: () => {
        batchCalls.push('listStoryboardVideoStates');
        return Promise.resolve({ data: { batches: [view], shots: [] }, ok: true });
      },
    },
  };
};

interface Fixture {
  readonly batchCalls: string[];
  readonly kicked: string[];
  readonly repository: InMemoryMediaRepository;
  readonly service: VideoApiService;
  readonly videoRepository: InMemoryVideoMediaRepository;
}

const buildFixture = (
  generation: ReturnType<typeof generationStub> = generationStub({
    id: 'task_1',
    projectId: 'project_1',
  }),
  assertCredentialReady?: () => Promise<void>,
): Fixture => {
  const repository = new InMemoryMediaRepository();
  const videoRepository = new InMemoryVideoMediaRepository(repository.candidates);
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({
        invocations: new InMemoryMediaInvocationRepository(),
        media: repository,
        video: videoRepository,
      }),
  };
  const kicked: string[] = [];
  const { batch, batchCalls } = batchStub();
  const service = createVideoApiService({
    ...(assertCredentialReady === undefined ? {} : { assertCredentialReady }),
    batch,
    generation,
    mediaUnitOfWork: unitOfWork,
    scheduler: { kick: (projectId) => kicked.push(projectId) },
  });
  return { batchCalls, kicked, repository, service, videoRepository };
};

/** 落一枚成功视频候选（供选择与 mediaUrl 断言）。 */
const seedSucceededVideoCandidate = async (
  videoRepository: InMemoryVideoMediaRepository,
  candidateId: string,
): Promise<void> => {
  const inserted = await videoRepository.insertCandidates({
    candidateIds: [candidateId],
    firstFrameCandidateId: 'img_1',
    firstFrameFileSha256: hash64('file_1'),
    generationInputHash: hash64('gen'),
    modelId: 'doubao-seedance-1-0-lite-i2v-250428',
    projectId: 'project_1',
    requestedDurationSec: 8,
    roundNo: 1,
    shotId: 'shot_1',
    shotVersionId: 'scv_1',
  });
  const id = inserted[0]?.id;
  if (id === undefined) throw new Error('candidate not seeded');
  await videoRepository.completeCandidateSucceeded(id, {
    actualDurationSec: 8,
    byteSize: 4096,
    fileSha256: hash64(`vfile_${candidateId}`),
    height: 1920,
    invocationEvidenceRef: `inv_${candidateId}`,
    mimeType: 'video/mp4',
    storageRelPath: `projects/project_1/videos/aa/${hash64(`vfile_${candidateId}`)}.mp4`,
    width: 1080,
  });
};

describe('createVideoApiService', () => {
  it('generateVideoCandidates—建档成功后 kick 调度器—任务 DTO 不泄漏幂等键与 providerTaskId', async () => {
    const fixture = buildFixture();
    const result = await fixture.service.generateVideoCandidates(
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

  it('generateVideoCandidates—生成前置失败原样透传—不 kick', async () => {
    const fixture = buildFixture(generationStub(null));
    const result = await fixture.service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'request_12345678', shotId: 'shot_1' },
      'trace_1',
    );
    expect(result).toMatchObject({ error: { code: 'MEDIA_STORYBOARD_NOT_READY' }, ok: false });
    expect(fixture.kicked).toEqual([]);
  });

  it('凭据闸抛错—generateVideosForShots 前置稳定失败—不触建批、kick 与其余方法', async () => {
    let gateCalls = 0;
    const fixture = buildFixture(undefined, () => {
      gateCalls += 1;
      return Promise.reject(new Error('CREDENTIAL_NOT_FOUND'));
    });

    const result = await fixture.service.generateVideosForShots(
      { projectId: 'project_1', requestId: 'request_12345678', shotIds: ['shot_1'] },
      'trace_1',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MODEL_CREDENTIAL_INVALID');
      expect(result.error.userAction).toContain('视频');
    }
    expect(gateCalls).toBe(1);
    expect(fixture.batchCalls).toEqual([]);
    expect(fixture.kicked).toEqual([]);
    // 单镜头闸在生成服务内（组合根同源注入），API 层不重复设闸。
    const single = await fixture.service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'request_12345678', shotId: 'shot_1' },
      'trace_1',
    );
    expect(single.ok).toBe(true);
    // 查询类方法不受凭据闸影响。
    await expect(
      fixture.service.listVideoCandidates({ projectId: 'project_1', shotId: 'shot_1' }, 'trace_1'),
    ).resolves.toMatchObject({ ok: true });
  });

  it('凭据闸通过—generateVideosForShots 透传建批（闸在场不改变行为）', async () => {
    const fixture = buildFixture(undefined, () => Promise.resolve());
    const result = await fixture.service.generateVideosForShots(
      { projectId: 'project_1', requestId: 'request_12345678', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(result).toMatchObject({ data: { batchId: 'batch_1', status: 'RUNNING' }, ok: true });
    expect(fixture.batchCalls).toEqual(['createBatch']);
  });

  it('listVideoCandidates—SUCCEEDED 携带受限 video-candidate URL 与视频域字段—其余状态 mediaUrl null', async () => {
    const fixture = buildFixture();
    await seedSucceededVideoCandidate(fixture.videoRepository, 'vcsucc_1_1');
    await fixture.videoRepository.insertCandidates({
      candidateIds: ['vcpend_1_1'],
      firstFrameCandidateId: 'img_1',
      firstFrameFileSha256: hash64('file_1'),
      generationInputHash: hash64('gen'),
      modelId: 'doubao-seedance-1-0-lite-i2v-250428',
      projectId: 'project_1',
      requestedDurationSec: 8,
      roundNo: 2,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    const result = await fixture.service.listVideoCandidates(
      { projectId: 'project_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    const succeeded = result.data.find((candidate) => candidate.id === 'vcsucc_1_1');
    expect(succeeded).toMatchObject({
      actualDurationSec: 8,
      continuationSegmentCount: 0,
      firstFrameCandidateId: 'img_1',
      mediaUrl: 'jingxu://media/video-candidate/vcsucc_1_1',
      mimeType: 'video/mp4',
      requestedDurationSec: 8,
      status: 'SUCCEEDED',
      trimRange: null,
    });
    // 脱敏面：首帧文件 sha 与 modelId 不进视图（Renderer 不接触存储细节）。
    expect(JSON.stringify(succeeded)).not.toContain(hash64('file_1'));
    expect(JSON.stringify(succeeded)).not.toContain('seedance');
    const pending = result.data.find((candidate) => candidate.id === 'vcpend_1_1');
    expect(pending).toMatchObject({ mediaUrl: null, status: 'PENDING' });
  });

  it('selectVideoCandidate—原子切换并返回全量候选—旧选择被清空', async () => {
    const fixture = buildFixture();
    await seedSucceededVideoCandidate(fixture.videoRepository, 'vc_a_1_1');
    await seedSucceededVideoCandidate(fixture.videoRepository, 'vc_b_1_1');
    await fixture.videoRepository.selectCandidate('shot_1', 'vc_a_1_1');
    const result = await fixture.service.selectVideoCandidate(
      { candidateId: 'vc_b_1_1', projectId: 'project_1', requestId: 'request_select_1' },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.data.find((candidate) => candidate.id === 'vc_a_1_1');
    const b = result.data.find((candidate) => candidate.id === 'vc_b_1_1');
    expect(a?.selectedAt).toBeNull();
    expect(b?.selectedAt).not.toBeNull();
  });

  it('selectVideoCandidate—跨项目候选不可见—MEDIA_CANDIDATE_NOT_FOUND', async () => {
    const fixture = buildFixture();
    await seedSucceededVideoCandidate(fixture.videoRepository, 'vc_a_1_1');
    const result = await fixture.service.selectVideoCandidate(
      { candidateId: 'vc_a_1_1', projectId: 'project_other', requestId: 'request_sel_2' },
      'trace_1',
    );
    expect(result).toMatchObject({ error: { code: 'MEDIA_CANDIDATE_NOT_FOUND' }, ok: false });
  });

  it('selectVideoCandidate—不可选候选（PENDING）—MEDIA_CANDIDATE_NOT_SELECTABLE', async () => {
    const fixture = buildFixture();
    await fixture.videoRepository.insertCandidates({
      candidateIds: ['vc_pend_2_1'],
      firstFrameCandidateId: 'img_1',
      firstFrameFileSha256: hash64('file_1'),
      generationInputHash: hash64('gen'),
      modelId: 'doubao-seedance-1-0-lite-i2v-250428',
      projectId: 'project_1',
      requestedDurationSec: 8,
      roundNo: 1,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    const result = await fixture.service.selectVideoCandidate(
      { candidateId: 'vc_pend_2_1', projectId: 'project_1', requestId: 'request_sel_3' },
      'trace_1',
    );
    expect(result).toMatchObject({ error: { code: 'MEDIA_CANDIDATE_NOT_SELECTABLE' }, ok: false });
  });

  it('getVideoTask—命中返回视图—未命中 MEDIA_TASK_NOT_FOUND', async () => {
    const fixture = buildFixture();
    await fixture.videoRepository.insertTask({
      candidateCount: 2,
      generationInputHash: hash64('gen'),
      id: 'task_lookup_1',
      idempotencyKey: 'req_lookup_1',
      projectId: 'project_1',
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    const hit = await fixture.service.getVideoTask(
      { projectId: 'project_1', taskId: 'task_lookup_1' },
      'trace_1',
    );
    expect(hit).toMatchObject({ data: { id: 'task_lookup_1', phase: 'SUBMITTED' }, ok: true });
    const miss = await fixture.service.getVideoTask(
      { projectId: 'project_1', taskId: 'task_missing_1' },
      'trace_1',
    );
    expect(miss).toMatchObject({ error: { code: 'MEDIA_TASK_NOT_FOUND' }, ok: false });
  });

  it('cancelVideoBatch/listStoryboardVideoStates—编排透传批量服务', async () => {
    const fixture = buildFixture();
    const cancelled = await fixture.service.cancelVideoBatch(
      { batchId: 'batch_1', projectId: 'project_1', requestId: 'request_cancel_1' },
      'trace_1',
    );
    expect(cancelled).toMatchObject({ data: { status: 'CANCELLED' }, ok: true });
    const states = await fixture.service.listStoryboardVideoStates(
      { projectId: 'project_1' },
      'trace_1',
    );
    expect(states.ok).toBe(true);
    if (states.ok) {
      expect(states.data.batches).toHaveLength(1);
      expect(states.data.shots).toEqual([]);
    }
    expect(fixture.batchCalls).toEqual(['cancelBatch', 'listStoryboardVideoStates']);
  });
});
