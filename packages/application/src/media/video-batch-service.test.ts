import { describe, expect, it } from 'vitest';

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
import { InMemoryVideoMediaRepository } from './in-memory-video-media-repository';
import { createVideoBatchService } from './video-batch-service';
import {
  buildVideoParametersFingerprint,
  computeVideoGenerationInputHash,
} from './video-generation-input';
import { createVideoGenerationService } from './video-generation-service';
import type { VideoGenerationService } from './video-generation-service';

const NOW = '2026-08-16T00:00:00.000Z';
const VIDEO_MODEL_ID = 'doubao-seedance-1-0-lite-i2v-250428';
const IMAGE_MODEL_ID = 'doubao-seedream-5-0-lite-260128';
const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);
const VIDEO_SIZE = { height: 1920, width: 1080 };
const DURATION_RANGE = { maxSec: 10, minSec: 5 };

const shotDocument = (): string =>
  JSON.stringify({
    cinematography: { camera_angle: 'EYE_LEVEL', camera_motion: 'DOLLY', shot_size: 'MEDIUM' },
    content: { action: '少女撑伞走过雨巷', character_ids: [], emotion: '怅惘', scene_id: null },
    continuity: { continuity_mode: 'SCENE_CHANGE' },
    narrative_purpose: '建立雨巷氛围',
  });

const shotN = (index: number): StoryboardShotSnapshot => ({
  sequence: index,
  shotId: `shot_${String(index)}`,
  version: {
    createdAt: NOW,
    dialogueRenderMode: 'NARRATION_FIRST',
    document: shotDocument(),
    documentSha256: hash64(`doc_scv_${String(index)}`),
    externalParentVersionId: null,
    formatProfileId: 'fp_1',
    id: `scv_${String(index)}`,
    lineageResolutionStatus: 'LOCAL_VERIFIED',
    parentId: null,
    sequence: index,
    shotId: `shot_${String(index)}`,
    sourceInvocationId: null,
    targetDurationSec: 8,
    versionNo: 1,
    versionStatus: 'READY',
  } satisfies ShotContractVersion,
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

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  hash64(JSON.stringify(value));

const firstFrameSha = (index: number): string => hash64(`file_${String(index)}`);

/** 与服务同口径独立复算 shot_N 的当前视频世代哈希（首帧 sha + 8s 档 + 1080x1920）。 */
const currentGenHash = (index: number): string =>
  computeVideoGenerationInputHash(
    {
      firstFrameFileSha256: firstFrameSha(index),
      modelId: VIDEO_MODEL_ID,
      parametersFingerprint: buildVideoParametersFingerprint({
        durationSec: 8,
        firstFrameFileSha256: firstFrameSha(index),
        modelId: VIDEO_MODEL_ID,
        size: VIDEO_SIZE,
      }),
      shotContentHash: hash64(`doc_scv_${String(index)}`),
      shotVersionId: `scv_${String(index)}`,
    },
    hashPayload,
  );

interface Fixture {
  readonly batch: ReturnType<typeof createVideoBatchService>;
  readonly generation: VideoGenerationService;
  readonly kicked: string[];
  readonly repository: InMemoryMediaRepository;
  readonly videoRepository: InMemoryVideoMediaRepository;
  readonly workspaceQuery: { snapshot: ScriptWorkspaceSnapshot | null };
}

const fixture = (
  shots: readonly StoryboardShotSnapshot[],
  status: EpisodeVersion['status'] = 'READY',
): Fixture => {
  const repository = new InMemoryMediaRepository();
  // 视频仓以 image 候选数组为 lens：建档解析读取选中首帧指针同事务可见。
  const videoRepository = new InMemoryVideoMediaRepository(repository.candidates);
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({
        invocations: new InMemoryMediaInvocationRepository(),
        media: repository,
        video: videoRepository,
      }),
  };
  const workspaceQuery: ScriptWorkspaceQueryPort & {
    snapshot: ScriptWorkspaceSnapshot | null;
  } = {
    snapshot: workspaceOf(shots, status),
    getWorkspace: () => Promise.resolve(workspaceQuery.snapshot),
    getVersionDocument: () => Promise.resolve(null),
  };
  let counter = 0;
  const newId = () => `id_${String((counter += 1))}`;
  const generation = createVideoGenerationService({
    candidateCount: 2,
    durationRange: DURATION_RANGE,
    hashPayload,
    mediaUnitOfWork: unitOfWork,
    modelId: VIDEO_MODEL_ID,
    newId,
    workspaceQuery,
  });
  const kicked: string[] = [];
  const batch = createVideoBatchService({
    durationRange: DURATION_RANGE,
    generation,
    hashPayload,
    kick: (projectId) => {
      kicked.push(projectId);
    },
    mediaUnitOfWork: unitOfWork,
    modelId: VIDEO_MODEL_ID,
    newId,
    workspaceQuery,
  });
  return { batch, generation, kicked, repository, videoRepository, workspaceQuery };
};

/** 已选首帧种子（image round 1 SUCCEEDED + selectedAt，尺寸 1440x2560）。 */
const seedFirstFrame = async (
  repository: InMemoryMediaRepository,
  index: number,
): Promise<void> => {
  await repository.insertCandidates({
    candidateIds: [`img_${String(index)}`],
    generationInputHash: hash64(`igen_${String(index)}`),
    modelId: IMAGE_MODEL_ID,
    projectId: 'project_1',
    roundNo: 1,
    shotId: `shot_${String(index)}`,
    shotVersionId: `scv_${String(index)}`,
  });
  await repository.completeCandidateSucceeded(`img_${String(index)}`, {
    byteSize: 2048,
    fileSha256: firstFrameSha(index),
    height: 2560,
    invocationEvidenceRef: `inv_img_${String(index)}`,
    mimeType: 'image/png',
    storageRelPath: `projects/project_1/images/aa/${firstFrameSha(index)}.png`,
    width: 1440,
  });
  await repository.selectCandidate(`shot_${String(index)}`, `img_${String(index)}`);
};

/** 当前世代 SUCCEEDED 视频候选种子（跳过过滤/就绪计数的底座）。 */
const seedSucceededVideoCurrentGen = async (
  videoRepository: InMemoryVideoMediaRepository,
  index: number,
  count = 1,
): Promise<void> => {
  const inserted = await videoRepository.insertCandidates({
    candidateIds: Array.from({ length: count }, (_, i) => `vc_ok_${String(index)}_${String(i)}`),
    firstFrameCandidateId: `img_${String(index)}`,
    firstFrameFileSha256: firstFrameSha(index),
    generationInputHash: currentGenHash(index),
    modelId: VIDEO_MODEL_ID,
    projectId: 'project_1',
    requestedDurationSec: 8,
    roundNo: 1,
    shotId: `shot_${String(index)}`,
    shotVersionId: `scv_${String(index)}`,
  });
  for (const candidate of inserted) {
    await videoRepository.completeCandidateSucceeded(candidate.id, {
      actualDurationSec: 8,
      byteSize: 4096,
      fileSha256: hash64(`vfile_${candidate.id}`),
      height: 1920,
      invocationEvidenceRef: `inv_${candidate.id}`,
      mimeType: 'video/mp4',
      storageRelPath: `projects/project_1/videos/aa/${hash64(`vfile_${candidate.id}`)}.mp4`,
      width: 1080,
    });
  }
};

/** 任务轮候选全部 SUCCEEDED 并收尾任务（驱动终态的测试捷径）。 */
const completeRoundSucceeded = async (
  videoRepository: InMemoryVideoMediaRepository,
  task: MediaTaskRecord,
): Promise<void> => {
  const round = videoRepository.candidates.filter(
    (candidate) => candidate.shotId === task.shotId && candidate.roundNo === task.roundNo,
  );
  for (const candidate of round) {
    await videoRepository.completeCandidateSucceeded(candidate.id, {
      actualDurationSec: 8,
      byteSize: 4096,
      fileSha256: hash64(`vfile_${candidate.id}`),
      height: 1920,
      invocationEvidenceRef: `inv_${candidate.id}`,
      mimeType: 'video/mp4',
      storageRelPath: `projects/project_1/videos/aa/v.mp4`,
      width: 1080,
    });
  }
  await videoRepository.completeTask(task.id);
};

describe('VideoBatchService.createBatch', () => {
  it('已选首帧整集排队—批次行落库且 kick 触发；同 requestId 重放回原批，目标漂移稳定拒绝', async () => {
    const { batch, kicked, repository, videoRepository } = fixture([shotN(1), shotN(2)]);
    await seedFirstFrame(repository, 1);
    await seedFirstFrame(repository, 2);
    const result = await batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('RUNNING');
    expect(result.data.members).toEqual([
      { errorCode: null, phase: null, shotId: 'shot_1', taskId: null },
      { errorCode: null, phase: null, shotId: 'shot_2', taskId: null },
    ]);
    expect(result.data.skippedShotIds).toEqual([]);
    expect(kicked).toEqual(['project_1']);
    expect(videoRepository.batches).toHaveLength(1);

    const replay = await batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_2', 'shot_1'] },
      'trace_2',
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.data.batchId).toBe(result.data.batchId);
    expect(videoRepository.batches).toHaveLength(1);

    const drift = await batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_1'] },
      'trace_3',
    );
    expect(drift).toMatchObject({ ok: false });
    if (!drift.ok) expect(drift.error.code).toBe('REQUEST_ID_REUSED');
  });

  it('无已选首帧/当前世代已有 SUCCEEDED 视频候选被跳过—旧世代成功不误伤，全跳过稳定拒绝', async () => {
    const { batch, repository, videoRepository } = fixture([shotN(1), shotN(2), shotN(3)]);
    // shot_1 无已选首帧（视频目标口径第一跳过因）。
    await seedFirstFrame(repository, 2);
    await seedSucceededVideoCurrentGen(videoRepository, 2);
    // shot_3 旧世代（哈希不同）的成功视频候选不构成跳过依据。
    await seedFirstFrame(repository, 3);
    await videoRepository.insertCandidates({
      candidateIds: ['vc_old'],
      firstFrameCandidateId: 'img_3',
      firstFrameFileSha256: firstFrameSha(3),
      generationInputHash: hash64('old_generation'),
      modelId: VIDEO_MODEL_ID,
      projectId: 'project_1',
      requestedDurationSec: 8,
      roundNo: 1,
      shotId: 'shot_3',
      shotVersionId: 'scv_3',
    });
    await videoRepository.completeCandidateSucceeded('vc_old', {
      actualDurationSec: 8,
      byteSize: 4096,
      fileSha256: hash64('vfile_old'),
      height: 1920,
      invocationEvidenceRef: 'inv_old',
      mimeType: 'video/mp4',
      storageRelPath: 'projects/project_1/videos/aa/old.mp4',
      width: 1080,
    });

    const result = await batch.createBatch(
      {
        projectId: 'project_1',
        requestId: 'video-batch_u1',
        shotIds: ['shot_1', 'shot_2', 'shot_3'],
      },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.members.map((member) => member.shotId)).toEqual(['shot_3']);
    expect(result.data.skippedShotIds).toEqual(['shot_1', 'shot_2']);

    const skippedAll = await batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u2', shotIds: ['shot_1', 'shot_2'] },
      'trace_2',
    );
    expect(skippedAll).toMatchObject({ ok: false });
    if (!skippedAll.ok) {
      expect(skippedAll.error.code).toBe('MEDIA_BATCH_NO_PENDING_SHOTS');
    }
    expect(videoRepository.batches).toHaveLength(1);
  });

  it('同项目已有 RUNNING 批次/镜头不在 READY 集合/分镜未 READY—各自稳定拒绝', async () => {
    const running = fixture([shotN(1), shotN(2)]);
    await seedFirstFrame(running.repository, 1);
    await seedFirstFrame(running.repository, 2);
    await running.batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_1'] },
      'trace_1',
    );
    const second = await running.batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u2', shotIds: ['shot_2'] },
      'trace_2',
    );
    expect(second).toMatchObject({ ok: false });
    if (!second.ok) expect(second.error.code).toBe('MEDIA_BATCH_ALREADY_RUNNING');

    const missing = fixture([shotN(1)]);
    await seedFirstFrame(missing.repository, 1);
    const missingResult = await missing.batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_9'] },
      'trace_3',
    );
    expect(missingResult).toMatchObject({ ok: false });
    if (!missingResult.ok) {
      expect(missingResult.error.code).toBe('MEDIA_SHOT_NOT_IN_READY_SET');
    }
    expect(missing.videoRepository.batches).toHaveLength(0);

    const draft = fixture([shotN(1)], 'DRAFT');
    await seedFirstFrame(draft.repository, 1);
    const draftResult = await draft.batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_1'] },
      'trace_4',
    );
    expect(draftResult).toMatchObject({ ok: false });
    if (!draftResult.ok) expect(draftResult.error.code).toBe('MEDIA_STORYBOARD_NOT_READY');
  });
});

describe('VideoBatchService.progressBatch', () => {
  it('惰性逐镜头建档—前一成员终态前不建下一镜头，全部成功收尾派生 COMPLETED', async () => {
    const { batch, repository, videoRepository } = fixture([shotN(1), shotN(2)]);
    await seedFirstFrame(repository, 1);
    await seedFirstFrame(repository, 2);
    const created = await batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await batch.progressBatch('project_1')).toBe(true);
    expect(videoRepository.tasks).toHaveLength(1);
    const first = videoRepository.tasks[0];
    if (first === undefined) return;
    expect(first.shotId).toBe('shot_1');
    expect(videoRepository.taskBatchIds.get(first.id)).toBe(created.data.batchId);
    expect(videoRepository.batches[0]?.pendingShotIds).toEqual(['shot_2']);
    // 建档候选带首帧锚点对与档位时长（视频域特征随批次成员落位）。
    expect(
      videoRepository.candidates
        .filter((candidate) => candidate.roundNo === first.roundNo)
        .every(
          (candidate) =>
            candidate.firstFrameCandidateId === 'img_1' &&
            candidate.firstFrameFileSha256 === firstFrameSha(1) &&
            candidate.requestedDurationSec === 8,
        ),
    ).toBe(true);

    // 单飞约束：成员 SUBMITTED 未终态 → 不建档下一镜头。
    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(videoRepository.tasks).toHaveLength(1);

    await completeRoundSucceeded(videoRepository, first);
    expect(await batch.progressBatch('project_1')).toBe(true);
    expect(videoRepository.tasks).toHaveLength(2);
    const second = videoRepository.tasks[1];
    if (second === undefined) return;
    await completeRoundSucceeded(videoRepository, second);

    // 队列耗尽 + 无失败成员 → COMPLETED。
    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(videoRepository.batches[0]?.status).toBe('COMPLETED');
    expect(videoRepository.batches[0]?.pendingShotIds).toEqual([]);
  });

  it('单镜头失败不阻断—后续镜头照常建档，收尾派生 PARTIAL_COMPLETED', async () => {
    const { batch, repository, videoRepository } = fixture([shotN(1), shotN(2)]);
    await seedFirstFrame(repository, 1);
    await seedFirstFrame(repository, 2);
    await batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(await batch.progressBatch('project_1')).toBe(true);
    const first = videoRepository.tasks[0];
    if (first === undefined) return;
    await videoRepository.failTask(first.id, 'MODEL_TIMEOUT');
    // 失败成员已终态 → 下一镜头照常建档（失败隔离）。
    expect(await batch.progressBatch('project_1')).toBe(true);
    const second = videoRepository.tasks[1];
    if (second === undefined) return;
    await completeRoundSucceeded(videoRepository, second);
    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(videoRepository.batches[0]?.status).toBe('PARTIAL_COMPLETED');
  });

  it('候选级全败（任务 COMPLETED、同轮零成功）—按失败成员呈报：PARTIAL + 成员/徽标错误码', async () => {
    const { batch, repository, videoRepository } = fixture([shotN(1), shotN(2)]);
    await seedFirstFrame(repository, 1);
    await seedFirstFrame(repository, 2);
    const created = await batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await batch.progressBatch('project_1')).toBe(true);
    const first = videoRepository.tasks[0];
    if (first === undefined) return;
    // Provider 错误候选级全败：任务相位仍 COMPLETED，本轮零 SUCCEEDED。
    const round = videoRepository.candidates.filter(
      (candidate) => candidate.shotId === 'shot_1' && candidate.roundNo === first.roundNo,
    );
    const codes = ['MODEL_TIMEOUT', 'MODEL_RATE_LIMITED'];
    for (const [index, candidate] of round.entries()) {
      await videoRepository.completeCandidateFailed(candidate.id, {
        errorCode: codes[index] ?? 'MODEL_UNKNOWN',
        invocationEvidenceRef: `inv_${candidate.id}`,
      });
    }
    await videoRepository.completeTask(first.id);
    // 失败隔离：候选级全败不阻断，下一镜头照常建档。
    expect(await batch.progressBatch('project_1')).toBe(true);
    const second = videoRepository.tasks[1];
    if (second === undefined) return;
    await completeRoundSucceeded(videoRepository, second);
    // 队列耗尽但存在候选级失败成员 → PARTIAL_COMPLETED（而非静默 COMPLETED）。
    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(videoRepository.batches[0]?.status).toBe('PARTIAL_COMPLETED');

    // 视图同口径：成员按 FAILED + 首个失败候选错误码呈报；镜头 latestTaskErrorCode 一致。
    const states = await batch.listStoryboardVideoStates({ projectId: 'project_1' }, 'trace_2');
    expect(states.ok).toBe(true);
    if (!states.ok) return;
    const view = states.data.batches[0];
    if (view === undefined) return;
    expect(view.members[0]).toMatchObject({ errorCode: 'MODEL_TIMEOUT', phase: 'FAILED' });
    expect(view.members[1]).toMatchObject({ errorCode: null, phase: 'COMPLETED' });
    const byShot = new Map(states.data.shots.map((state) => [state.shotId, state]));
    expect(byShot.get('shot_1')?.latestTaskErrorCode).toBe('MODEL_TIMEOUT');
    expect(byShot.get('shot_2')?.latestTaskErrorCode).toBeNull();
  });

  it('成员建档失败（镜头被移出 READY 集合）—批次中止 PARTIAL + 批次级错误码，剩余队列保留', async () => {
    const { batch, repository, videoRepository, workspaceQuery } = fixture([shotN(1), shotN(2)]);
    await seedFirstFrame(repository, 1);
    await seedFirstFrame(repository, 2);
    await batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(await batch.progressBatch('project_1')).toBe(true);
    const first = videoRepository.tasks[0];
    if (first === undefined) return;
    await completeRoundSucceeded(videoRepository, first);
    // 重确认分镜后 shot_2 不在新 READY 集合 → 建档被拒 → 批次中止。
    workspaceQuery.snapshot = workspaceOf([shotN(1)]);

    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(videoRepository.tasks).toHaveLength(1);
    expect(videoRepository.batches[0]?.status).toBe('PARTIAL_COMPLETED');
    expect(videoRepository.batches[0]?.errorCode).toBe('MEDIA_SHOT_NOT_IN_READY_SET');
    // 剩余队列保留原序可追溯（取消/中止不删队列）。
    expect(videoRepository.batches[0]?.pendingShotIds).toEqual(['shot_2']);
  });

  it('崩溃窗口（建档后未出队）—重启推进由幂等重放吸收，绝不重复提交', async () => {
    const { batch, generation, repository, videoRepository } = fixture([shotN(1)]);
    await seedFirstFrame(repository, 1);
    const created = await batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_1'] },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // 模拟：调度器已建档但未及出队即崩溃。
    const derived = await generation.generateVideoCandidates(
      {
        batchId: created.data.batchId,
        projectId: 'project_1',
        requestId: `${created.data.batchId}_shot_1`,
        shotId: 'shot_1',
      },
      'trace_crash',
    );
    expect(derived.ok).toBe(true);
    expect(videoRepository.batches[0]?.pendingShotIds).toEqual(['shot_1']);
    const task = videoRepository.tasks[0];
    if (task === undefined) return;
    await completeRoundSucceeded(videoRepository, task);

    // 重启后推进：同派生 requestId 重放返回原终态任务，出队即收敛。
    expect(await batch.progressBatch('project_1')).toBe(true);
    expect(videoRepository.tasks).toHaveLength(1);
    expect(videoRepository.batches[0]?.pendingShotIds).toEqual([]);
    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(videoRepository.batches[0]?.status).toBe('COMPLETED');
  });
});

describe('VideoBatchService.cancelBatch', () => {
  it('取消仅停止消费剩余队列—已建成员不动，队列保留可追溯，重复取消幂等', async () => {
    const { batch, repository, videoRepository } = fixture([shotN(1), shotN(2)]);
    await seedFirstFrame(repository, 1);
    await seedFirstFrame(repository, 2);
    const created = await batch.createBatch(
      { projectId: 'project_1', requestId: 'video-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await batch.progressBatch('project_1')).toBe(true);
    const member = videoRepository.tasks[0];
    if (member === undefined) return;

    const cancelled = await batch.cancelBatch(
      { batchId: created.data.batchId, projectId: 'project_1', requestId: 'video-batch_cancel' },
      'trace_2',
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.data.status).toBe('CANCELLED');
    // 在飞成员相位不动（取消不中断已提交任务）。
    expect(videoRepository.tasks[0]?.phase).toBe(member.phase);
    expect(videoRepository.batches[0]?.pendingShotIds).toEqual(['shot_2']);

    const again = await batch.cancelBatch(
      { batchId: created.data.batchId, projectId: 'project_1', requestId: 'video-batch_cancel2' },
      'trace_3',
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.status).toBe('CANCELLED');

    const missing = await batch.cancelBatch(
      { batchId: 'batch_missing', projectId: 'project_1', requestId: 'video-batch_cancel3' },
      'trace_4',
    );
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) expect(missing.error.code).toBe('MEDIA_BATCH_NOT_FOUND');
  });
});

describe('VideoBatchService.listStoryboardVideoStates', () => {
  it('聚合视图—无首帧镜头世代底座如实 0；排队/在飞/就绪/失败底座按原始字段派生', async () => {
    const { batch, generation, repository, videoRepository } = fixture([
      shotN(1),
      shotN(2),
      shotN(3),
      shotN(4),
    ]);
    await seedFirstFrame(repository, 1);
    await seedFirstFrame(repository, 2);
    await seedFirstFrame(repository, 3);
    // shot_4 无已选首帧（世代底座 0，仍如实列出）。
    // shot_3 当前世代已有 2 条成功视频候选（就绪徽标底座）。
    await seedSucceededVideoCurrentGen(videoRepository, 3, 2);
    // shot_2 独立单镜头任务已失败（失败徽标底座，最新一轮）。
    await generation.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_single_shot_2', shotId: 'shot_2' },
      'trace_single',
    );
    const singleTask = videoRepository.tasks[0];
    if (singleTask === undefined) return;
    await videoRepository.failTask(singleTask.id, 'MODEL_TIMEOUT');

    const created = await batch.createBatch(
      {
        projectId: 'project_1',
        requestId: 'video-batch_u1',
        shotIds: ['shot_1', 'shot_2', 'shot_3'],
      },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.skippedShotIds).toEqual(['shot_3']);
    // 推进：shot_1 建档（SUBMITTED 在飞）；shot_2 仍在队列。
    expect(await batch.progressBatch('project_1')).toBe(true);

    const states = await batch.listStoryboardVideoStates({ projectId: 'project_1' }, 'trace_2');
    expect(states.ok).toBe(true);
    if (!states.ok) return;
    expect(states.data.batches).toHaveLength(1);
    const view = states.data.batches[0];
    if (view === undefined) return;
    expect(view.members.map((member) => member.shotId)).toEqual(['shot_1', 'shot_2']);
    expect(view.members[0]?.phase).toBe('SUBMITTED');
    expect(view.members[1]).toMatchObject({ phase: null, taskId: null });

    const byShot = new Map(states.data.shots.map((state) => [state.shotId, state]));
    expect(byShot.get('shot_1')).toMatchObject({
      activeTaskPhase: 'SUBMITTED',
      currentGenSucceededCount: 0,
      queuedInBatchId: null,
    });
    expect(byShot.get('shot_2')).toMatchObject({
      latestTaskErrorCode: 'MODEL_TIMEOUT',
      queuedInBatchId: created.data.batchId,
    });
    expect(byShot.get('shot_3')).toMatchObject({
      currentGenSucceededCount: 2,
      latestTaskErrorCode: null,
      queuedInBatchId: null,
    });
    expect(byShot.get('shot_4')).toMatchObject({
      activeTaskPhase: null,
      currentGenSucceededCount: 0,
      queuedInBatchId: null,
    });
  });
});
