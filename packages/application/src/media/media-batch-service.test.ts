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
import { computeGenerationInputHash } from './media-generation-prompt';
import { createMediaGenerationService } from './media-generation-service';
import { createMediaBatchService } from './media-batch-service';

const NOW = '2026-08-16T00:00:00.000Z';
const MODEL_ID = 'doubao-seedream-5-0-lite-260128';
const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);

const shotDocument = (): string =>
  JSON.stringify({
    cinematography: { shot_size: 'MEDIUM', camera_angle: 'EYE_LEVEL' },
    content: { action: '走过雨巷', character_ids: ['char_hero'], scene_id: 'scene_alley' },
    continuity: { continuity_mode: 'SCENE_CHANGE' },
    generation_constraints: { image_prompt: '雨巷中的少女' },
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

/** 与服务同口径独立复算 shot_N 的当前世代哈希（无资产绑定 + 9:16 画幅指纹）。 */
const currentGenHash = (index: number): string =>
  computeGenerationInputHash(
    {
      boundAssetVersionIds: [],
      modelId: MODEL_ID,
      parametersFingerprint: parametersFingerprint({ height: 2560, width: 1440 }),
      shotContentHash: hash64(`doc_scv_${String(index)}`),
      shotVersionId: `scv_${String(index)}`,
    },
    hashPayload,
  );

interface Fixture {
  readonly batch: ReturnType<typeof createMediaBatchService>;
  readonly generation: ReturnType<typeof createMediaGenerationService>;
  readonly repository: InMemoryMediaRepository;
  readonly kicked: string[];
  readonly workspaceQuery: { snapshot: ScriptWorkspaceSnapshot | null };
}

const fixture = (
  shots: readonly StoryboardShotSnapshot[],
  status: EpisodeVersion['status'] = 'READY',
): Fixture => {
  const repository = new InMemoryMediaRepository();
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({ invocations: new InMemoryMediaInvocationRepository(), media: repository }),
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
  const generation = createMediaGenerationService({
    candidateCount: 4,
    formatProfiles: { findAllByProject: () => Promise.resolve([formatProfile]) },
    hashPayload,
    mediaUnitOfWork: unitOfWork,
    modelId: MODEL_ID,
    newId,
    parametersFingerprint,
    workspaceQuery,
  });
  const kicked: string[] = [];
  const batch = createMediaBatchService({
    candidateCount: 4,
    formatProfiles: { findAllByProject: () => Promise.resolve([formatProfile]) },
    generation,
    hashPayload,
    kick: (projectId) => {
      kicked.push(projectId);
    },
    mediaUnitOfWork: unitOfWork,
    modelId: MODEL_ID,
    newId,
    parametersFingerprint,
    workspaceQuery,
  });
  return { batch, generation, kicked, repository, workspaceQuery };
};

/** 把某镜头的当前世代候选标记 SUCCEEDED（跳过过滤/就绪计数的种子）。 */
const seedSucceededCurrentGen = async (
  repository: InMemoryMediaRepository,
  index: number,
  count = 1,
): Promise<void> => {
  await repository.insertCandidates({
    candidateIds: Array.from({ length: count }, (_, i) => `c_ok_${String(index)}_${String(i)}`),
    generationInputHash: currentGenHash(index),
    modelId: MODEL_ID,
    projectId: 'project_1',
    roundNo: 1,
    shotId: `shot_${String(index)}`,
    shotVersionId: `scv_${String(index)}`,
  });
  for (let i = 0; i < count; i += 1) {
    await repository.completeCandidateSucceeded(`c_ok_${String(index)}_${String(i)}`, {
      byteSize: 1024,
      fileSha256: hash64(`file_${String(index)}_${String(i)}`),
      height: 64,
      invocationEvidenceRef: `inv_${String(index)}_${String(i)}`,
      mimeType: 'image/png',
      storageRelPath: 'media/c0/c0.img',
      width: 64,
    });
  }
};

describe('MediaBatchService.createBatch', () => {
  it('READY 整集排队—批次行落库且 kick 触发；同 requestId 重放回原批，目标漂移稳定拒绝', async () => {
    const { batch, kicked, repository } = fixture([shotN(1), shotN(2)]);
    const result = await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1', 'shot_2'] },
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
    expect(repository.batches).toHaveLength(1);

    const replay = await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_2', 'shot_1'] },
      'trace_2',
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.data.batchId).toBe(result.data.batchId);
    expect(repository.batches).toHaveLength(1);

    const drift = await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1'] },
      'trace_3',
    );
    expect(drift).toMatchObject({ ok: false });
    if (!drift.ok) expect(drift.error.code).toBe('REQUEST_ID_REUSED');
  });

  it('当前世代已有 SUCCEEDED 候选的镜头被跳过—旧世代成功不误伤，全跳过稳定拒绝且零写入', async () => {
    const { batch, repository } = fixture([shotN(1), shotN(2)]);
    await seedSucceededCurrentGen(repository, 1);
    // 旧世代（哈希不同）的成功候选不构成跳过依据。
    await repository.insertCandidates({
      candidateIds: ['c_old'],
      generationInputHash: hash64('old_generation'),
      modelId: MODEL_ID,
      projectId: 'project_1',
      roundNo: 1,
      shotId: 'shot_2',
      shotVersionId: 'scv_2',
    });
    await repository.completeCandidateSucceeded('c_old', {
      byteSize: 1024,
      fileSha256: hash64('file_old'),
      height: 64,
      invocationEvidenceRef: 'inv_old',
      mimeType: 'image/png',
      storageRelPath: 'media/c0/c0.img',
      width: 64,
    });

    const result = await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.members.map((member) => member.shotId)).toEqual(['shot_2']);
    expect(result.data.skippedShotIds).toEqual(['shot_1']);

    const skippedAll = await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u2', shotIds: ['shot_1'] },
      'trace_2',
    );
    expect(skippedAll).toMatchObject({ ok: false });
    if (!skippedAll.ok) {
      expect(skippedAll.error.code).toBe('MEDIA_BATCH_NO_PENDING_SHOTS');
    }
    expect(repository.batches).toHaveLength(1);
  });

  it('同项目已有 RUNNING 批次/镜头不在 READY 集合/分镜未 READY—各自稳定拒绝', async () => {
    const running = fixture([shotN(1), shotN(2)]);
    await running.batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1'] },
      'trace_1',
    );
    const second = await running.batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u2', shotIds: ['shot_2'] },
      'trace_2',
    );
    expect(second).toMatchObject({ ok: false });
    if (!second.ok) expect(second.error.code).toBe('MEDIA_BATCH_ALREADY_RUNNING');

    const missing = fixture([shotN(1)]);
    const missingResult = await missing.batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_9'] },
      'trace_3',
    );
    expect(missingResult).toMatchObject({ ok: false });
    if (!missingResult.ok) {
      expect(missingResult.error.code).toBe('MEDIA_SHOT_NOT_IN_READY_SET');
    }
    expect(missing.repository.batches).toHaveLength(0);

    const draft = fixture([shotN(1)], 'DRAFT');
    const draftResult = await draft.batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1'] },
      'trace_4',
    );
    expect(draftResult).toMatchObject({ ok: false });
    if (!draftResult.ok) expect(draftResult.error.code).toBe('MEDIA_STORYBOARD_NOT_READY');
  });
});

describe('MediaBatchService.progressBatch', () => {
  it('惰性逐镜头建档—前一成员终态前不建下一镜头，全部成功收尾派生 COMPLETED', async () => {
    const { batch, repository } = fixture([shotN(1), shotN(2)]);
    const created = await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await batch.progressBatch('project_1')).toBe(true);
    expect(repository.tasks).toHaveLength(1);
    const first = repository.tasks[0];
    if (first === undefined) return;
    expect(first.shotId).toBe('shot_1');
    expect(repository.taskBatchIds.get(first.id)).toBe(created.data.batchId);
    expect(repository.batches[0]?.pendingShotIds).toEqual(['shot_2']);

    // 单飞约束：成员 SUBMITTED 未终态 → 不建档下一镜头。
    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(repository.tasks).toHaveLength(1);

    // COMPLETED 任务的真实不变式：同轮候选已终态落位（成败由候选裁决）。
    await seedSucceededCurrentGen(repository, 1);
    await repository.completeTask(first.id);
    expect(await batch.progressBatch('project_1')).toBe(true);
    expect(repository.tasks).toHaveLength(2);
    const second = repository.tasks[1];
    if (second === undefined) return;
    await seedSucceededCurrentGen(repository, 2);
    await repository.completeTask(second.id);

    // 队列耗尽 + 无失败成员 → COMPLETED。
    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(repository.batches[0]?.status).toBe('COMPLETED');
    expect(repository.batches[0]?.pendingShotIds).toEqual([]);
  });

  it('单镜头失败不阻断—后续镜头照常建档，收尾派生 PARTIAL_COMPLETED', async () => {
    const { batch, repository } = fixture([shotN(1), shotN(2)]);
    await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(await batch.progressBatch('project_1')).toBe(true);
    const first = repository.tasks[0];
    if (first === undefined) return;
    await repository.failTask(first.id, 'MODEL_TIMEOUT');
    // 失败成员已终态 → 下一镜头照常建档（失败隔离，design D2）。
    expect(await batch.progressBatch('project_1')).toBe(true);
    const second = repository.tasks[1];
    if (second === undefined) return;
    await seedSucceededCurrentGen(repository, 2);
    await repository.completeTask(second.id);
    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(repository.batches[0]?.status).toBe('PARTIAL_COMPLETED');
  });

  it('候选级全败（任务 COMPLETED、同轮零成功）—按失败成员呈报：PARTIAL + 成员/徽标错误码', async () => {
    const { batch, repository } = fixture([shotN(1), shotN(2)]);
    const created = await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await batch.progressBatch('project_1')).toBe(true);
    const first = repository.tasks[0];
    if (first === undefined) return;
    // Provider 错误候选级全败：任务相位仍 COMPLETED（驱动终态语义），本轮零 SUCCEEDED。
    await repository.insertCandidates({
      candidateIds: ['c_fail_0', 'c_fail_1'],
      generationInputHash: currentGenHash(1),
      modelId: MODEL_ID,
      projectId: 'project_1',
      roundNo: first.roundNo,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    await repository.completeCandidateFailed('c_fail_0', {
      errorCode: 'MODEL_TIMEOUT',
      invocationEvidenceRef: 'inv_fail_0',
    });
    await repository.completeCandidateFailed('c_fail_1', {
      errorCode: 'MODEL_RATE_LIMITED',
      invocationEvidenceRef: 'inv_fail_1',
    });
    await repository.completeTask(first.id);
    // 失败隔离（D2）：候选级全败不阻断，下一镜头照常建档。
    expect(await batch.progressBatch('project_1')).toBe(true);
    const second = repository.tasks[1];
    if (second === undefined) return;
    await seedSucceededCurrentGen(repository, 2);
    await repository.completeTask(second.id);
    // 队列耗尽但存在候选级失败成员 → PARTIAL_COMPLETED（而非静默 COMPLETED）。
    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(repository.batches[0]?.status).toBe('PARTIAL_COMPLETED');

    // 视图同口径：成员按 FAILED + 首个失败候选错误码呈报；镜头 latestTaskErrorCode 一致。
    const states = await batch.listStoryboardImageStates({ projectId: 'project_1' }, 'trace_2');
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
    const { batch, repository, workspaceQuery } = fixture([shotN(1), shotN(2)]);
    await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(await batch.progressBatch('project_1')).toBe(true);
    const first = repository.tasks[0];
    if (first === undefined) return;
    await repository.completeTask(first.id);
    // 重确认分镜后 shot_2 不在新 READY 集合 → 建档被拒 → 批次中止。
    workspaceQuery.snapshot = workspaceOf([shotN(1)]);

    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(repository.tasks).toHaveLength(1);
    expect(repository.batches[0]?.status).toBe('PARTIAL_COMPLETED');
    expect(repository.batches[0]?.errorCode).toBe('MEDIA_SHOT_NOT_IN_READY_SET');
    // 剩余队列保留原序可追溯（design D6：取消/中止不删队列）。
    expect(repository.batches[0]?.pendingShotIds).toEqual(['shot_2']);
  });

  it('崩溃窗口（建档后未出队）—重启推进由幂等重放吸收，绝不重复提交', async () => {
    const { batch, generation, repository } = fixture([shotN(1)]);
    const created = await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1'] },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // 模拟：调度器已建档但未及出队即崩溃。
    const derived = await generation.generateCandidates(
      {
        batchId: created.data.batchId,
        projectId: 'project_1',
        requestId: `${created.data.batchId}_shot_1`,
        shotId: 'shot_1',
      },
      'trace_crash',
    );
    expect(derived.ok).toBe(true);
    expect(repository.batches[0]?.pendingShotIds).toEqual(['shot_1']);
    const task = repository.tasks[0];
    if (task === undefined) return;
    await seedSucceededCurrentGen(repository, 1);
    await repository.completeTask(task.id);

    // 重启后推进：同派生 requestId 重放返回原终态任务，出队即收敛。
    expect(await batch.progressBatch('project_1')).toBe(true);
    expect(repository.tasks).toHaveLength(1);
    expect(repository.batches[0]?.pendingShotIds).toEqual([]);
    expect(await batch.progressBatch('project_1')).toBe(false);
    expect(repository.batches[0]?.status).toBe('COMPLETED');
  });
});

describe('MediaBatchService.cancelBatch', () => {
  it('取消仅停止消费剩余队列—已建成员不动，队列保留可追溯，重复取消幂等', async () => {
    const { batch, repository } = fixture([shotN(1), shotN(2)]);
    const created = await batch.createBatch(
      { projectId: 'project_1', requestId: 'image-batch_u1', shotIds: ['shot_1', 'shot_2'] },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await batch.progressBatch('project_1')).toBe(true);
    const member = repository.tasks[0];
    if (member === undefined) return;

    const cancelled = await batch.cancelBatch(
      { batchId: created.data.batchId, projectId: 'project_1', requestId: 'image-batch_cancel' },
      'trace_2',
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.data.status).toBe('CANCELLED');
    // 在飞成员相位不动（取消不中断已提交任务，design D6-A）。
    expect(repository.tasks[0]?.phase).toBe(member.phase);
    expect(repository.batches[0]?.pendingShotIds).toEqual(['shot_2']);

    const again = await batch.cancelBatch(
      { batchId: created.data.batchId, projectId: 'project_1', requestId: 'image-batch_cancel2' },
      'trace_3',
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.status).toBe('CANCELLED');

    const missing = await batch.cancelBatch(
      { batchId: 'batch_missing', projectId: 'project_1', requestId: 'image-batch_cancel3' },
      'trace_4',
    );
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) expect(missing.error.code).toBe('MEDIA_BATCH_NOT_FOUND');
  });
});

describe('MediaBatchService.listStoryboardImageStates', () => {
  it('聚合视图—批次成员相位、排队/在飞/就绪/失败底座按原始字段派生', async () => {
    const { batch, generation, repository } = fixture([shotN(1), shotN(2), shotN(3)]);
    // shot_3 当前世代已有 2 张成功候选（就绪徽标底座）。
    await seedSucceededCurrentGen(repository, 3, 2);
    // shot_2 独立单镜头任务已失败（失败徽标底座，最新一轮）。
    await generation.generateCandidates(
      { projectId: 'project_1', requestId: 'req_single_shot_2', shotId: 'shot_2' },
      'trace_single',
    );
    const singleTask = repository.tasks[0];
    if (singleTask === undefined) return;
    await repository.failTask(singleTask.id, 'MODEL_TIMEOUT');

    const created = await batch.createBatch(
      {
        projectId: 'project_1',
        requestId: 'image-batch_u1',
        shotIds: ['shot_1', 'shot_2', 'shot_3'],
      },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.skippedShotIds).toEqual(['shot_3']);
    // 推进：shot_1 建档（SUBMITTED 在飞）；shot_2 仍在队列。
    expect(await batch.progressBatch('project_1')).toBe(true);

    const states = await batch.listStoryboardImageStates({ projectId: 'project_1' }, 'trace_2');
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
  });
});
