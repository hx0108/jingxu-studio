/**
 * MediaBatchService（batch-first-frame-generation 任务 3.1–3.4，design D1-C/D2/D3/D5/D6）。
 *
 * 单集内用户显式发起的批量首帧排队：批次行持久化目标/跳过/待建档队列，
 * 成员任务惰性逐镜头建档（同一时刻至多一个在飞成员），由调度器排空钩子推进。
 * 关键不变式：
 * - 批次创建幂等（IPC requestId）；重放按目标集合比对，漂移即 REQUEST_ID_REUSED；
 * - 成员建档 requestId 由批次 id 派生——崩溃窗口（建档后未出队）由重放吸收，绝不重复提交；
 * - 单镜头失败不阻断后续镜头（D2）；成员建档失败才中止批次（PARTIAL + 批次级错误码）；
 * - 取消仅停止消费剩余队列（D6-A），在飞任务照常跑完；
 * - 重启恢复 = 对 RUNNING 批次项目 kick，排空钩子继续消费 pending 队列；
 *   已建档任务由既有 recover 按「有证据才恢复」分类，本服务不重发。
 */

import type {
  AppResultDto,
  CancelBatchInputDto,
  GenerateCandidatesForShotsInputDto,
  ListStoryboardImageStatesInputDto,
  MediaBatchMemberDto,
  MediaBatchViewDto,
  StoryboardImageStatesDto,
} from '@jingxu/contracts';

import type {
  MediaBatchRecord,
  MediaRepository,
  MediaTaskRecord,
} from '../ports/media/media-repository';
import type {
  MediaGenerationService,
  MediaGenerationServiceDependencies,
} from './media-generation-service';
import { resolveGenerationInput } from './media-generation-service';
import { mediaFailure, mediaPersistenceFailure } from './media-service-error';

/** 批次推进（内部钩子路径）的稳定 trace 标识。 */
const MEDIA_BATCH_PROGRESS_TRACE = 'media_batch_progress';

/** currentGenSucceededCount 契约上限（徽标展示用途；跨轮同世代候选可超过即按上限回告）。 */
const MAX_CURRENT_GEN_SUCCEEDED = 16;

/**
 * 失败派生（与两仓 finalizeBatch 同一「失败成员定义」）：任务 FAILED → 任务错误码；
 * 任务 COMPLETED 但同轮零 SUCCEEDED 候选（Provider 错误候选级全败，任务相位仍
 * COMPLETED）→ 首个失败候选错误码 ?? MODEL_UNKNOWN；其余（有成功/非终态/CANCELLED）
 * → null。批次成员与镜头 latestTaskErrorCode 共用，保证失败清单与徽标口径一致。
 */
const failureErrorCodeOf = async (
  media: MediaRepository,
  task: MediaTaskRecord,
): Promise<string | null> => {
  if (task.phase === 'FAILED') return task.errorCode;
  if (task.phase !== 'COMPLETED') return null;
  const candidates = await media.listCandidates(task.shotId);
  if (candidates.some((c) => c.roundNo === task.roundNo && c.status === 'SUCCEEDED')) return null;
  return (
    candidates.find((c) => c.roundNo === task.roundNo && c.status === 'FAILED')?.errorCode ??
    'MODEL_UNKNOWN'
  );
};

/** 依赖 = 单镜头建档同源解析底座 + 建档入口 + 排空触发（组合根晚绑定调度器）。 */
export interface MediaBatchServiceDependencies extends Pick<
  MediaGenerationServiceDependencies,
  | 'candidateCount'
  | 'formatProfiles'
  | 'hashPayload'
  | 'mediaUnitOfWork'
  | 'modelId'
  | 'newId'
  | 'parametersFingerprint'
  | 'workspaceQuery'
> {
  readonly generation: Pick<MediaGenerationService, 'generateCandidates'>;
  /** 建批后触发项目排空；组合根以晚绑定引用注入以解开与调度器的循环依赖。 */
  readonly kick: (projectId: string) => void;
}

export interface MediaBatchService {
  /** 建批（design D3：服务端按当前世代哈希跳过已就绪镜头，无 force 语义）。 */
  createBatch(
    input: GenerateCandidatesForShotsInputDto,
    traceId: string,
  ): Promise<AppResultDto<MediaBatchViewDto>>;
  /** 取消：仅停止消费剩余队列（D6-A）；在飞成员照常跑完。 */
  cancelBatch(
    input: CancelBatchInputDto,
    traceId: string,
  ): Promise<AppResultDto<MediaBatchViewDto>>;
  /** 列表级聚合：活跃与近期批次 + 全部 READY 镜头状态底座（D5）。 */
  listStoryboardImageStates(
    input: ListStoryboardImageStatesInputDto,
    traceId: string,
  ): Promise<AppResultDto<StoryboardImageStatesDto>>;
  /** 调度器排空钩子（任务 3.2）：推进 RUNNING 批次；返回 true = 已建档新成员任务。 */
  progressBatch(projectId: string): Promise<boolean>;
}

/** 成员视图：按 targetShotIds 顺序组合；排队中镜头 taskId/phase/errorCode 为 null。 */
const buildBatchView = async (
  media: MediaRepository,
  batch: MediaBatchRecord,
): Promise<MediaBatchViewDto> => {
  const tasks = await media.listBatchMemberTasks(batch.id);
  const byShot = new Map<string, MediaTaskRecord>(tasks.map((task) => [task.shotId, task]));
  const members = await Promise.all(
    batch.targetShotIds.map(async (shotId): Promise<MediaBatchMemberDto> => {
      const task = byShot.get(shotId);
      if (task === undefined) {
        return { errorCode: null, phase: null, shotId, taskId: null };
      }
      // 候选级全败（任务 COMPLETED 但同轮零成功）按 FAILED 成员呈报，失败清单/重试才可见。
      const errorCode = await failureErrorCodeOf(media, task);
      return {
        errorCode,
        phase: errorCode === null ? task.phase : 'FAILED',
        shotId,
        taskId: task.id,
      };
    }),
  );
  return {
    batchId: batch.id,
    createdAt: batch.createdAt,
    errorCode: batch.errorCode,
    members,
    skippedShotIds: [...batch.skippedShotIds],
    status: batch.status,
    updatedAt: batch.updatedAt,
  };
};

/** 建批时的目标过滤结果：invalid = 镜头不在 READY 集合（整单拒绝）。 */
type BatchTargetFilter =
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'ok';
      readonly skipped: readonly string[];
      readonly targets: readonly string[];
    };

export const createMediaBatchService = (
  dependencies: MediaBatchServiceDependencies,
): MediaBatchService => {
  const { mediaUnitOfWork } = dependencies;

  const toBatchViewById = async (
    projectId: string,
    batchId: string,
  ): Promise<MediaBatchViewDto> => {
    const batch = await mediaUnitOfWork.run(({ media }) => media.findBatchById(projectId, batchId));
    if (batch === null) throw new Error('MEDIA_BATCH_NOT_FOUND');
    return mediaUnitOfWork.run(({ media }) => buildBatchView(media, batch));
  };

  return {
    createBatch: async (input, traceId) => {
      try {
        const workspace = await dependencies.workspaceQuery.getWorkspace(input.projectId);
        if (workspace === null) {
          return mediaFailure(
            'SCRIPT_WORKSPACE_NOT_INITIALIZED',
            '剧本工作区尚未初始化，无法批量生成首帧',
            traceId,
          );
        }
        const storyboard = workspace.storyboard;
        if (storyboard.current?.status !== 'READY') {
          return mediaFailure(
            'MEDIA_STORYBOARD_NOT_READY',
            '分镜尚未确认 READY，无法批量生成首帧',
            traceId,
          );
        }
        // 幂等重放：同 requestId 批次直接回视图；目标集合漂移视为 requestId 复用。
        const replay = await mediaUnitOfWork.run(({ media }) =>
          media.findBatchByIdempotencyKey(input.projectId, input.requestId),
        );
        if (replay !== null) {
          const replaySet = new Set([...replay.targetShotIds, ...replay.skippedShotIds]);
          const inputSet = new Set(input.shotIds);
          const sameShots =
            replaySet.size === inputSet.size && input.shotIds.every((id) => replaySet.has(id));
          if (!sameShots) {
            return mediaFailure('REQUEST_ID_REUSED', 'requestId 已用于不同批次', traceId);
          }
          return { data: await toBatchViewById(input.projectId, replay.id), ok: true };
        }
        // 当前世代跳过过滤（D3）：与首帧选择策略同一世代定义，SUCCEEDED 即跳过。
        const filter = await mediaUnitOfWork.run<BatchTargetFilter>(async ({ media }) => {
          const succeededKeys = new Set(
            (await media.listSucceededCandidateShotHashes(input.projectId)).map(
              (entry) => `${entry.shotId}:${entry.generationInputHash}`,
            ),
          );
          const targets: string[] = [];
          const skipped: string[] = [];
          for (const shotId of input.shotIds) {
            const shot = storyboard.currentShots.find((entry) => entry.shotId === shotId);
            if (shot === undefined) return { kind: 'invalid' };
            const resolved = await resolveGenerationInput(
              media,
              dependencies,
              input.projectId,
              shot,
            );
            if (succeededKeys.has(`${shotId}:${resolved.generationInputHash}`)) {
              skipped.push(shotId);
            } else {
              targets.push(shotId);
            }
          }
          return { kind: 'ok', skipped, targets };
        });
        if (filter.kind === 'invalid') {
          return mediaFailure(
            'MEDIA_SHOT_NOT_IN_READY_SET',
            '镜头不在当前 READY 分镜集合中，请刷新后重试',
            traceId,
          );
        }
        if (filter.targets.length === 0) {
          return mediaFailure(
            'MEDIA_BATCH_NO_PENDING_SHOTS',
            '所选镜头当前世代均已有首帧，无需重新生成',
            traceId,
            false,
            '如需重新生成，请在镜头详情中单独发起（已有候选不会被覆盖）。',
          );
        }
        const running = await mediaUnitOfWork.run(({ media }) =>
          media.findRunningBatchByProject(input.projectId),
        );
        if (running !== null) {
          return mediaFailure(
            'MEDIA_BATCH_ALREADY_RUNNING',
            '当前项目已有批量首帧任务进行中，请等待完成或先取消',
            traceId,
          );
        }
        const batch = await mediaUnitOfWork.run(({ media }) =>
          media.insertBatch({
            id: dependencies.newId(),
            idempotencyKey: input.requestId,
            projectId: input.projectId,
            skippedShotIds: filter.skipped,
            targetShotIds: filter.targets,
          }),
        );
        // 排空钩子消费队首建档；kick 触发后台排空（幂等）。
        dependencies.kick(input.projectId);
        return { data: await toBatchViewById(input.projectId, batch.id), ok: true };
      } catch {
        return mediaPersistenceFailure(traceId);
      }
    },

    cancelBatch: async (input, traceId) => {
      try {
        const batch = await mediaUnitOfWork.run(({ media }) =>
          media.findBatchById(input.projectId, input.batchId),
        );
        if (batch === null) {
          return mediaFailure('MEDIA_BATCH_NOT_FOUND', '批次不存在或不属于该项目', traceId);
        }
        const cancelled = await mediaUnitOfWork.run(({ media }) =>
          media.cancelBatch(input.batchId),
        );
        return { data: await toBatchViewById(input.projectId, cancelled.id), ok: true };
      } catch {
        return mediaPersistenceFailure(traceId);
      }
    },

    listStoryboardImageStates: async (input, traceId) => {
      try {
        const workspace = await dependencies.workspaceQuery.getWorkspace(input.projectId);
        if (workspace === null) {
          return mediaFailure('SCRIPT_WORKSPACE_NOT_INITIALIZED', '剧本工作区尚未初始化', traceId);
        }
        const storyboard = workspace.storyboard;
        if (storyboard.current?.status !== 'READY') {
          return mediaFailure('MEDIA_STORYBOARD_NOT_READY', '分镜尚未确认 READY', traceId);
        }
        const states = await mediaUnitOfWork.run(async ({ media }) => {
          const batchRecords = await media.listBatchesByProject(input.projectId, 10);
          const batches = await Promise.all(
            batchRecords.map((batch) => buildBatchView(media, batch)),
          );
          const succeeded = await media.listSucceededCandidateShotHashes(input.projectId);
          const latest = await media.listLatestTaskPerShot(input.projectId);
          const unfinished = await media.listUnfinishedTasks(input.projectId);
          const running = await media.findRunningBatchByProject(input.projectId);
          const activeByShot = new Map(unfinished.map((task) => [task.shotId, task.phase]));
          const latestByShot = new Map(latest.map((task) => [task.shotId, task]));
          const runningPending = new Set(running?.pendingShotIds ?? []);
          const shots = [];
          for (const shot of storyboard.currentShots) {
            const resolved = await resolveGenerationInput(
              media,
              dependencies,
              input.projectId,
              shot,
            );
            const currentGenSucceededCount = succeeded
              .filter(
                (entry) =>
                  entry.shotId === shot.shotId &&
                  entry.generationInputHash === resolved.generationInputHash,
              )
              .reduce((sum, entry) => sum + entry.succeededCount, 0);
            const latestTask = latestByShot.get(shot.shotId);
            shots.push({
              activeTaskPhase: activeByShot.get(shot.shotId) ?? null,
              currentGenSucceededCount: Math.min(
                currentGenSucceededCount,
                MAX_CURRENT_GEN_SUCCEEDED,
              ),
              latestTaskErrorCode:
                latestTask === undefined ? null : await failureErrorCodeOf(media, latestTask),
              queuedInBatchId: runningPending.has(shot.shotId) ? (running?.id ?? null) : null,
              shotId: shot.shotId,
            });
          }
          return { batches, shots };
        });
        return { data: states, ok: true };
      } catch {
        return mediaPersistenceFailure(traceId);
      }
    },

    progressBatch: async (projectId) => {
      const batch = await mediaUnitOfWork.run(({ media }) =>
        media.findRunningBatchByProject(projectId),
      );
      if (batch === null) return false;
      // 单飞约束（D1-C）：前一成员未终态不建档下一镜头。
      const unfinished = await mediaUnitOfWork.run(({ media }) =>
        media.countUnfinishedBatchTasks(batch.id),
      );
      if (unfinished > 0) return false;
      const head = batch.pendingShotIds[0];
      if (head === undefined) {
        // 队列耗尽：收尾派生 COMPLETED / PARTIAL_COMPLETED（repo 层统一判定）。
        await mediaUnitOfWork.run(({ media }) => media.finalizeBatch(batch.id));
        return false;
      }
      // 先建档再出队：requestId 由批次派生（确定性），崩溃窗口由幂等重放吸收。
      const created = await dependencies.generation.generateCandidates(
        { batchId: batch.id, projectId, requestId: `${batch.id}_${head}`, shotId: head },
        MEDIA_BATCH_PROGRESS_TRACE,
      );
      if (!created.ok) {
        // 成员建档失败 → 中止批次（D2）：PARTIAL + 批次级错误码，剩余队列保留可追溯。
        await mediaUnitOfWork.run(({ media }) => media.finalizeBatch(batch.id, created.error.code));
        return false;
      }
      const popped = await mediaUnitOfWork.run(({ media }) => media.takeNextPendingShot(batch.id));
      if (popped === null) {
        // 建档与取消/收尾竞态：批次已非 RUNNING，补偿取消刚建档任务（SUBMITTED 可安全落 CANCELLED）。
        await mediaUnitOfWork
          .run(({ media }) => media.cancelTask(created.data.id))
          .catch(() => undefined);
        return false;
      }
      return true;
    },
  };
};
