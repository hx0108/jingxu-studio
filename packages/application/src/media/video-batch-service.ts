/**
 * VideoBatchService（shot-video-generation 任务 3.4，design A2/D1-C 同款二次实例化）。
 *
 * 单集视频段批量排队：结构与 MediaBatchService 同构——批次行持久化目标/跳过/
 * 待建档队列，成员任务惰性逐镜头建档（同一时刻至多一个在飞成员），由调度器
 * 排空钩子推进。视频目标口径（design A2）：已选首帧 且 当前世代无 SUCCEEDED
 * 视频候选；无首帧/已有均入跳过清单如实回告。关键不变式与图片域一致：
 * 幂等建批（requestId 漂移即 REQUEST_ID_REUSED）、成员 requestId 由批次 id 派生
 * （崩溃窗口由重放吸收，绝不重复提交）、单镜头失败不阻断、成员建档失败才中止
 * （PARTIAL + 批次级错误码）、取消仅停止消费剩余队列、重启恢复对 RUNNING 批次
 * 项目 kick。
 */

import type {
  AppResultDto,
  CancelVideoBatchInputDto,
  GenerateVideosForShotsInputDto,
  ListStoryboardVideoStatesInputDto,
  MediaBatchMemberDto,
  MediaBatchViewDto,
  StoryboardVideoStatesDto,
} from '@jingxu/contracts';

import type {
  MediaBatchRecord,
  MediaRepository,
  MediaTaskRecord,
  VideoMediaRepository,
} from '../ports/media/media-repository';
import { mediaFailure, mediaPersistenceFailure } from './media-service-error';
import type {
  VideoGenerationService,
  VideoGenerationServiceDependencies,
} from './video-generation-service';
import { resolveVideoGenerationInput } from './video-generation-service';

/** 批次推进（内部钩子路径）的稳定 trace 标识。 */
const VIDEO_BATCH_PROGRESS_TRACE = 'video_batch_progress';

/** currentGenSucceededCount 契约上限（徽标展示用途；跨轮同世代候选可超过即按上限回告）。 */
const MAX_CURRENT_GEN_SUCCEEDED = 16;

/**
 * 失败派生（与 video 仓 finalizeBatch 同一「失败成员定义」，口径复用图片域）：
 * 任务 FAILED → 任务错误码；任务 COMPLETED 但同轮零 SUCCEEDED 候选（候选级全败，
 * 任务相位仍 COMPLETED）→ 首个失败候选错误码 ?? MODEL_UNKNOWN；其余 → null。
 * 批次成员与镜头 latestTaskErrorCode 共用，失败清单与徽标口径一致。
 */
const failureErrorCodeOf = async (
  video: VideoMediaRepository,
  task: MediaTaskRecord,
): Promise<string | null> => {
  if (task.phase === 'FAILED') return task.errorCode;
  if (task.phase !== 'COMPLETED') return null;
  const candidates = await video.listCandidates(task.shotId);
  if (candidates.some((c) => c.roundNo === task.roundNo && c.status === 'SUCCEEDED')) return null;
  return (
    candidates.find((c) => c.roundNo === task.roundNo && c.status === 'FAILED')?.errorCode ??
    'MODEL_UNKNOWN'
  );
};

/** 依赖 = 单镜头建档同源解析底座（视频版）+ 建档入口 + 排空触发（组合根晚绑定调度器）。 */
export interface VideoBatchServiceDependencies extends Pick<
  VideoGenerationServiceDependencies,
  | 'durationRange'
  | 'hashPayload'
  | 'mediaUnitOfWork'
  | 'modelId'
  | 'newId'
  | 'resolveModel'
  | 'workspaceQuery'
> {
  readonly generation: Pick<VideoGenerationService, 'generateVideoCandidates'>;
  /** 建批后触发项目排空；组合根以晚绑定引用注入以解开与调度器的循环依赖。 */
  readonly kick: (projectId: string) => void;
}

export interface VideoBatchService {
  /** 建批：目标=已选首帧且当前世代无 SUCCEEDED 视频候选；无首帧/已有入跳过清单。 */
  createBatch(
    input: GenerateVideosForShotsInputDto,
    traceId: string,
  ): Promise<AppResultDto<MediaBatchViewDto>>;
  /** 取消：仅停止消费剩余队列；在飞成员照常跑完。 */
  cancelBatch(
    input: CancelVideoBatchInputDto,
    traceId: string,
  ): Promise<AppResultDto<MediaBatchViewDto>>;
  /** 列表级聚合：活跃与近期视频批次 + 全部 READY 镜头视频状态底座。 */
  listStoryboardVideoStates(
    input: ListStoryboardVideoStatesInputDto,
    traceId: string,
  ): Promise<AppResultDto<StoryboardVideoStatesDto>>;
  /** 调度器排空钩子：推进 RUNNING 批次；返回 true = 已建档新成员任务。 */
  progressBatch(projectId: string): Promise<boolean>;
}

/** 成员视图：按 targetShotIds 顺序组合；排队中镜头 taskId/phase/errorCode 为 null。 */
const buildBatchView = async (
  video: VideoMediaRepository,
  batch: MediaBatchRecord,
): Promise<MediaBatchViewDto> => {
  const tasks = await video.listBatchMemberTasks(batch.id);
  const byShot = new Map<string, MediaTaskRecord>(tasks.map((task) => [task.shotId, task]));
  const members = await Promise.all(
    batch.targetShotIds.map(async (shotId): Promise<MediaBatchMemberDto> => {
      const task = byShot.get(shotId);
      if (task === undefined) {
        return { errorCode: null, phase: null, shotId, taskId: null };
      }
      // 候选级全败（任务 COMPLETED 但同轮零成功）按 FAILED 成员呈报，失败清单/重试才可见。
      const errorCode = await failureErrorCodeOf(video, task);
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

/** 当前世代解析（无已选首帧返回 null——批量过滤入跳过、状态列表世代底座为 0）。 */
const currentGenerationHashOf = async (
  media: MediaRepository,
  dependencies: VideoBatchServiceDependencies,
  shot: Parameters<typeof resolveVideoGenerationInput>[2],
): Promise<string | null> => {
  try {
    const model =
      dependencies.resolveModel === undefined
        ? { modelId: dependencies.modelId }
        : await dependencies.resolveModel();
    return (await resolveVideoGenerationInput(media, { ...dependencies, ...model }, shot))
      .generationInputHash;
  } catch {
    // MEDIA_FIRST_FRAME_NOT_SELECTED（批量跳过主因）或锚点异常：状态底座如实为 0。
    return null;
  }
};

export const createVideoBatchService = (
  dependencies: VideoBatchServiceDependencies,
): VideoBatchService => {
  const { mediaUnitOfWork } = dependencies;

  const toBatchViewById = async (
    projectId: string,
    batchId: string,
  ): Promise<MediaBatchViewDto> => {
    const batch = await mediaUnitOfWork.run(({ video }) => video.findBatchById(projectId, batchId));
    if (batch === null) throw new Error('MEDIA_BATCH_NOT_FOUND');
    return mediaUnitOfWork.run(({ video }) => buildBatchView(video, batch));
  };

  return {
    createBatch: async (input, traceId) => {
      try {
        const workspace = await dependencies.workspaceQuery.getWorkspace(input.projectId);
        if (workspace === null) {
          return mediaFailure(
            'SCRIPT_WORKSPACE_NOT_INITIALIZED',
            '剧本工作区尚未初始化，无法批量生成视频段',
            traceId,
          );
        }
        const storyboard = workspace.storyboard;
        if (storyboard.current?.status !== 'READY') {
          return mediaFailure(
            'MEDIA_STORYBOARD_NOT_READY',
            '分镜尚未确认 READY，无法批量生成视频段',
            traceId,
          );
        }
        // 幂等重放：同 requestId 批次直接回视图；目标集合漂移视为 requestId 复用。
        const replay = await mediaUnitOfWork.run(({ video }) =>
          video.findBatchByIdempotencyKey(input.projectId, input.requestId),
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
        // 视频目标口径（design A2）：已选首帧 且 当前世代无 SUCCEEDED 视频候选；
        // 无首帧/已有均跳过并如实回告（skippedShotIds）。
        const filter = await mediaUnitOfWork.run<BatchTargetFilter>(async ({ media, video }) => {
          const succeededKeys = new Set(
            (await video.listSucceededCandidateShotHashes(input.projectId)).map(
              (entry) => `${entry.shotId}:${entry.generationInputHash}`,
            ),
          );
          const targets: string[] = [];
          const skipped: string[] = [];
          for (const shotId of input.shotIds) {
            const shot = storyboard.currentShots.find((entry) => entry.shotId === shotId);
            if (shot === undefined) return { kind: 'invalid' };
            const resolved = await currentGenerationHashOf(media, dependencies, shot);
            // 无首帧（resolved=null）与当前世代已有 SUCCEEDED 均跳过：若误入队，
            // 推进建档会撞 MEDIA_FIRST_FRAME_NOT_SELECTED 中止整批——跳过才是如实回告。
            if (resolved === null || succeededKeys.has(`${shotId}:${resolved}`)) {
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
            '所选镜头均无已选首帧或当前世代已有视频段，无需重新生成',
            traceId,
            false,
            '如需重新生成，请在镜头视频面板中单独发起（已有候选不会被覆盖）。',
          );
        }
        const running = await mediaUnitOfWork.run(({ video }) =>
          video.findRunningBatchByProject(input.projectId),
        );
        if (running !== null) {
          return mediaFailure(
            'MEDIA_BATCH_ALREADY_RUNNING',
            '当前项目已有批量视频任务进行中，请等待完成或先取消',
            traceId,
          );
        }
        const batch = await mediaUnitOfWork.run(({ video }) =>
          video.insertBatch({
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
        const batch = await mediaUnitOfWork.run(({ video }) =>
          video.findBatchById(input.projectId, input.batchId),
        );
        if (batch === null) {
          return mediaFailure('MEDIA_BATCH_NOT_FOUND', '批次不存在或不属于该项目', traceId);
        }
        const cancelled = await mediaUnitOfWork.run(({ video }) =>
          video.cancelBatch(input.batchId),
        );
        return { data: await toBatchViewById(input.projectId, cancelled.id), ok: true };
      } catch {
        return mediaPersistenceFailure(traceId);
      }
    },

    listStoryboardVideoStates: async (input, traceId) => {
      try {
        const workspace = await dependencies.workspaceQuery.getWorkspace(input.projectId);
        if (workspace === null) {
          return mediaFailure('SCRIPT_WORKSPACE_NOT_INITIALIZED', '剧本工作区尚未初始化', traceId);
        }
        const storyboard = workspace.storyboard;
        if (storyboard.current?.status !== 'READY') {
          return mediaFailure('MEDIA_STORYBOARD_NOT_READY', '分镜尚未确认 READY', traceId);
        }
        const states = await mediaUnitOfWork.run(async ({ media, video }) => {
          const batchRecords = await video.listBatchesByProject(input.projectId, 10);
          const batches = await Promise.all(
            batchRecords.map((batch) => buildBatchView(video, batch)),
          );
          const succeeded = await video.listSucceededCandidateShotHashes(input.projectId);
          const latest = await video.listLatestTaskPerShot(input.projectId);
          const unfinished = await video.listUnfinishedTasks(input.projectId);
          const running = await video.findRunningBatchByProject(input.projectId);
          const activeByShot = new Map(unfinished.map((task) => [task.shotId, task.phase]));
          const latestByShot = new Map(latest.map((task) => [task.shotId, task]));
          const runningPending = new Set(running?.pendingShotIds ?? []);
          const shots = [];
          for (const shot of storyboard.currentShots) {
            const generationInputHash = await currentGenerationHashOf(media, dependencies, shot);
            const currentGenSucceededCount = succeeded
              .filter(
                (entry) =>
                  entry.shotId === shot.shotId && entry.generationInputHash === generationInputHash,
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
                latestTask === undefined ? null : await failureErrorCodeOf(video, latestTask),
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
      const batch = await mediaUnitOfWork.run(({ video }) =>
        video.findRunningBatchByProject(projectId),
      );
      if (batch === null) return false;
      // 单飞约束（D1-C 同款）：前一成员未终态不建档下一镜头。
      const unfinished = await mediaUnitOfWork.run(({ video }) =>
        video.countUnfinishedBatchTasks(batch.id),
      );
      if (unfinished > 0) return false;
      const head = batch.pendingShotIds[0];
      if (head === undefined) {
        // 队列耗尽：收尾派生 COMPLETED / PARTIAL_COMPLETED（repo 层统一判定）。
        await mediaUnitOfWork.run(({ video }) => video.finalizeBatch(batch.id));
        return false;
      }
      // 先建档再出队：requestId 由批次派生（确定性），崩溃窗口由幂等重放吸收。
      const created = await dependencies.generation.generateVideoCandidates(
        { batchId: batch.id, projectId, requestId: `${batch.id}_${head}`, shotId: head },
        VIDEO_BATCH_PROGRESS_TRACE,
      );
      if (!created.ok) {
        // 成员建档失败 → 中止批次：PARTIAL + 批次级错误码，剩余队列保留可追溯。
        await mediaUnitOfWork.run(({ video }) => video.finalizeBatch(batch.id, created.error.code));
        return false;
      }
      const popped = await mediaUnitOfWork.run(({ video }) => video.takeNextPendingShot(batch.id));
      if (popped === null) {
        // 建档与取消/收尾竞态：批次已非 RUNNING，补偿取消刚建档任务（SUBMITTED 可安全落 CANCELLED）。
        await mediaUnitOfWork
          .run(({ video }) => video.cancelTask(created.data.id))
          .catch(() => undefined);
        return false;
      }
      return true;
    },
  };
};
