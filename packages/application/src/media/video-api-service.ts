/**
 * VideoApi 应用服务（shot-video-generation 任务 3.5，design A5）。
 *
 * 视频 IPC 七方法的用例编排层：Repository 记录 → 契约 DTO 映射、生成建档后
 * kick 调度器、批量编排前置凭据闸（单镜头闸在 VideoGenerationService 内，组合根
 * 同源注入）。不含 SQL、文件系统路径或 Provider 原文；候选取流一律输出受限
 * `jingxu://media/video-candidate/` URL；续写段数/裁剪区间本切片恒 0/null。
 */

import type {
  AppResultDto,
  CancelVideoBatchInputDto,
  GenerateVideoCandidatesInputDto,
  GenerateVideosForShotsInputDto,
  GetVideoTaskInputDto,
  ListStoryboardVideoStatesInputDto,
  ListVideoCandidatesInputDto,
  MediaBatchViewDto,
  MediaTaskViewDto,
  SelectVideoCandidateInputDto,
  StoryboardVideoStatesDto,
  VideoCandidateViewDto,
} from '@jingxu/contracts';
import { videoCandidateMediaUrl } from '@jingxu/contracts';

import type {
  MediaTaskRecord,
  MediaUnitOfWorkPort,
  VideoCandidateRecord,
} from '../ports/media/media-repository';
import type { VideoBatchService } from './video-batch-service';
import type { VideoGenerationService } from './video-generation-service';
import { mediaFailure, mediaPersistenceFailure } from './media-service-error';

export interface VideoApiService {
  generateVideoCandidates(
    input: GenerateVideoCandidatesInputDto,
    traceId: string,
  ): Promise<AppResultDto<MediaTaskViewDto>>;
  listVideoCandidates(
    input: ListVideoCandidatesInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoCandidateViewDto[]>>;
  selectVideoCandidate(
    input: SelectVideoCandidateInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoCandidateViewDto[]>>;
  getVideoTask(
    input: GetVideoTaskInputDto,
    traceId: string,
  ): Promise<AppResultDto<MediaTaskViewDto>>;
  generateVideosForShots(
    input: GenerateVideosForShotsInputDto,
    traceId: string,
  ): Promise<AppResultDto<MediaBatchViewDto>>;
  cancelVideoBatch(
    input: CancelVideoBatchInputDto,
    traceId: string,
  ): Promise<AppResultDto<MediaBatchViewDto>>;
  listStoryboardVideoStates(
    input: ListStoryboardVideoStatesInputDto,
    traceId: string,
  ): Promise<AppResultDto<StoryboardVideoStatesDto>>;
}

export interface VideoApiServiceDependencies {
  /** 建批前置凭据闸（批量服务自身无闸；单镜头闸由生成服务内置，组合根同源注入）。 */
  readonly assertCredentialReady?: (() => Promise<void>) | undefined;
  /** 视频批量编排（progressBatch 由调度器钩子驱动）。 */
  readonly batch: Pick<
    VideoBatchService,
    'createBatch' | 'cancelBatch' | 'listStoryboardVideoStates'
  >;
  readonly generation: Pick<VideoGenerationService, 'generateVideoCandidates'>;
  readonly mediaUnitOfWork: MediaUnitOfWorkPort;
  /** 生成建档成功后触发该项目后台排空（幂等；重放旧任务时无可排空即空转）。 */
  readonly scheduler: { readonly kick: (projectId: string) => void };
}

const toTaskView = (task: MediaTaskRecord): MediaTaskViewDto => ({
  candidateCount: task.candidateCount,
  createdAt: task.createdAt,
  errorCode: task.errorCode,
  generationInputHash: task.generationInputHash,
  id: task.id,
  phase: task.phase,
  shotId: task.shotId,
  shotVersionId: task.shotVersionId,
  updatedAt: task.updatedAt,
});

/** mediaUrl 仅 SUCCEEDED 候选携带（契约 superRefine 同一不变式）。 */
const toVideoCandidateView = (candidate: VideoCandidateRecord): VideoCandidateViewDto => {
  // 契约只认 video/mp4；坏行（历史篡改/手改库）按稳定标记失败，不静默降级。
  if (candidate.mimeType !== null && candidate.mimeType !== 'video/mp4') {
    throw new Error('MEDIA_ROW_CORRUPT');
  }
  return {
    actualDurationSec: candidate.actualDurationSec,
    byteSize: candidate.byteSize,
    continuationSegmentCount: 0,
    createdAt: candidate.createdAt,
    errorCode: candidate.errorCode,
    firstFrameCandidateId: candidate.firstFrameCandidateId,
    generationInputHash: candidate.generationInputHash,
    height: candidate.height,
    id: candidate.id,
    indexInRound: candidate.indexInRound,
    mediaUrl: candidate.status === 'SUCCEEDED' ? videoCandidateMediaUrl(candidate.id) : null,
    mimeType: candidate.mimeType,
    requestedDurationSec: candidate.requestedDurationSec,
    roundNo: candidate.roundNo,
    selectedAt: candidate.selectedAt,
    shotId: candidate.shotId,
    shotVersionId: candidate.shotVersionId,
    status: candidate.status,
    trimRange: null,
    width: candidate.width,
  };
};

export const createVideoApiService = (
  dependencies: VideoApiServiceDependencies,
): VideoApiService => {
  const { mediaUnitOfWork } = dependencies;
  return {
    generateVideoCandidates: async (input, traceId) => {
      const created = await dependencies.generation.generateVideoCandidates(input, traceId);
      if (!created.ok) return created;
      dependencies.scheduler.kick(input.projectId);
      return { data: toTaskView(created.data), ok: true };
    },

    listVideoCandidates: async (input, traceId) => {
      try {
        const candidates = await mediaUnitOfWork.run(({ video }) =>
          video.listCandidates(input.shotId),
        );
        return { data: candidates.map(toVideoCandidateView), ok: true };
      } catch {
        return mediaPersistenceFailure(traceId);
      }
    },

    selectVideoCandidate: async (input, traceId) => {
      try {
        const updated = await mediaUnitOfWork.run(async ({ video }) => {
          const candidate = await video.findCandidateById(input.projectId, input.candidateId);
          if (candidate === null) throw new Error('MEDIA_CANDIDATE_NOT_FOUND');
          await video.selectCandidate(candidate.shotId, input.candidateId);
          return video.listCandidates(candidate.shotId);
        });
        return { data: updated.map(toVideoCandidateView), ok: true };
      } catch (caught: unknown) {
        const marker = caught instanceof Error ? caught.message : '';
        if (marker === 'MEDIA_CANDIDATE_NOT_FOUND') {
          return mediaFailure('MEDIA_CANDIDATE_NOT_FOUND', '视频候选不存在或不在该项目中', traceId);
        }
        if (marker === 'MEDIA_CANDIDATE_NOT_SELECTABLE') {
          return mediaFailure(
            'MEDIA_CANDIDATE_NOT_SELECTABLE',
            '仅成功候选可设为当前视频段',
            traceId,
          );
        }
        return mediaPersistenceFailure(traceId);
      }
    },

    getVideoTask: async (input, traceId) => {
      try {
        const task = await mediaUnitOfWork.run(({ video }) =>
          video.findTaskById(input.projectId, input.taskId),
        );
        if (task === null) {
          return mediaFailure('MEDIA_TASK_NOT_FOUND', '视频任务不存在', traceId);
        }
        return { data: toTaskView(task), ok: true };
      } catch {
        return mediaPersistenceFailure(traceId);
      }
    },

    generateVideosForShots: async (input, traceId) => {
      // 与单镜头同源凭据闸（A5）：未配置/不可解密先于建批稳定失败，指向视频配置入口。
      if (dependencies.assertCredentialReady !== undefined) {
        try {
          await dependencies.assertCredentialReady();
        } catch {
          return mediaFailure(
            'MODEL_CREDENTIAL_INVALID',
            '视频 Provider 凭据未配置或密文不可解密。',
            traceId,
            false,
            '在剧本工作区「Provider 设置」的视频卡片中保存 ARK API Key 后重试。',
          );
        }
      }
      return dependencies.batch.createBatch(input, traceId);
    },

    cancelVideoBatch: (input, traceId) => dependencies.batch.cancelBatch(input, traceId),

    listStoryboardVideoStates: (input, traceId) =>
      dependencies.batch.listStoryboardVideoStates(input, traceId),
  };
};
