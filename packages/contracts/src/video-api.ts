import { z } from 'zod';

import type { AppResultDto } from './app-result';
import { MEDIA_BATCH_MAX_SHOTS, mediaBatchViewSchema, mediaTaskPhaseSchema } from './image-api';
import type { MediaBatchViewDto, MediaTaskViewDto } from './image-api';
import { projectIdSchema, requestIdSchema } from './project-dto';

/**
 * 视频 IPC 公共契约（shot-video-generation design A5）。
 * 首帧图生视频的候选视图为视频专属形态；任务/批次视图与图片域同构，
 * 复用 image-api 的共享媒体视图 schema（相位机/批次不变式单一来源）。
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const shotIdSchema = idSchema;
const taskIdSchema = idSchema;
const candidateIdSchema = idSchema;
const batchIdSchema = idSchema;

export const videoCandidateStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'STALE_INPUT']);

/** 视频候选的受限取流 URL；Renderer 不接触文件系统路径。 */
export const videoCandidateMediaUrl = (candidateId: string): string =>
  `jingxu://media/video-candidate/${candidateId}`;

export const videoCandidateViewSchema = z
  .object({
    /** Provider 回报的实际时长（秒）；未回报则 null 如实记录，不得伪造估算。 */
    actualDurationSec: z.number().positive().nullable(),
    byteSize: z.number().int().nonnegative().nullable(),
    /** 续写段数：本切片不续写，恒 0（后续续写切片再放开字面量）。 */
    continuationSegmentCount: z.literal(0),
    createdAt: isoDateTimeSchema,
    errorCode: z.string().min(1).max(64).nullable(),
    /** 本候选生成时绑定的已选首帧候选（STALE 追溯锚点）。 */
    firstFrameCandidateId: candidateIdSchema,
    generationInputHash: hashSchema,
    height: z.number().int().positive().nullable(),
    id: candidateIdSchema,
    indexInRound: z.number().int().nonnegative(),
    mediaUrl: z.string().startsWith('jingxu://media/video-candidate/').nullable(),
    mimeType: z.literal('video/mp4').nullable(),
    /** 按能力快照档位就近映射后的请求时长（秒）。 */
    requestedDurationSec: z.number().int().positive(),
    roundNo: z.number().int().positive(),
    selectedAt: isoDateTimeSchema.nullable(),
    shotId: shotIdSchema,
    shotVersionId: idSchema,
    status: videoCandidateStatusSchema,
    /** 裁剪区间：本切片不裁剪，恒 null。 */
    trimRange: z.null(),
    width: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'SUCCEEDED') {
      if (value.mediaUrl === null || value.byteSize === null || value.mimeType === null) {
        context.addIssue({
          code: 'custom',
          message: 'SUCCEEDED 视频候选必须携带 mediaUrl/byteSize/mimeType。',
          path: ['status'],
        });
      }
    } else if (value.mediaUrl !== null) {
      context.addIssue({
        code: 'custom',
        message: '非 SUCCEEDED 视频候选不得携带 mediaUrl。',
        path: ['mediaUrl'],
      });
    }
    if (value.status !== 'FAILED' && value.errorCode !== null) {
      context.addIssue({
        code: 'custom',
        message: 'errorCode 只在 FAILED 状态携带。',
        path: ['errorCode'],
      });
    }
  });

/**
 * 镜头视频状态底座：徽标由 Renderer 从原始字段派生（与图片
 * shotImageStateSchema 同构，activeTaskPhase 非终态→生成中等），
 * 「当前世代」定义由服务端统一计算。
 */
export const shotVideoStateSchema = z
  .object({
    activeTaskPhase: mediaTaskPhaseSchema.nullable(),
    currentGenSucceededCount: z.number().int().nonnegative().max(16),
    latestTaskErrorCode: z.string().min(1).max(64).nullable(),
    queuedInBatchId: batchIdSchema.nullable(),
    shotId: shotIdSchema,
  })
  .strict();

/** 列表级聚合查询：活跃与近期视频批次 + 全部 READY 镜头的视频状态底座。 */
export const storyboardVideoStatesSchema = z
  .object({
    batches: z.array(mediaBatchViewSchema).max(10),
    shots: z.array(shotVideoStateSchema).max(MEDIA_BATCH_MAX_SHOTS),
  })
  .strict();

export const generateVideoCandidatesInputSchema = z
  .object({
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    shotId: shotIdSchema,
  })
  .strict();
export const listVideoCandidatesInputSchema = z
  .object({ projectId: projectIdSchema, shotId: shotIdSchema })
  .strict();
export const selectVideoCandidateInputSchema = z
  .object({
    candidateId: candidateIdSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict();
export const getVideoTaskInputSchema = z
  .object({ projectId: projectIdSchema, taskId: taskIdSchema })
  .strict();
export const generateVideosForShotsInputSchema = z
  .object({
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    shotIds: z.array(shotIdSchema).min(1).max(MEDIA_BATCH_MAX_SHOTS),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.shotIds).size !== value.shotIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'shotIds 不得重复。',
        path: ['shotIds'],
      });
    }
  });
export const cancelVideoBatchInputSchema = z
  .object({ batchId: batchIdSchema, projectId: projectIdSchema, requestId: requestIdSchema })
  .strict();
export const listStoryboardVideoStatesInputSchema = z
  .object({ projectId: projectIdSchema })
  .strict();

export type VideoCandidateViewDto = z.infer<typeof videoCandidateViewSchema>;
export type ShotVideoStateDto = z.infer<typeof shotVideoStateSchema>;
export type StoryboardVideoStatesDto = z.infer<typeof storyboardVideoStatesSchema>;
export type GenerateVideoCandidatesInputDto = z.infer<typeof generateVideoCandidatesInputSchema>;
export type ListVideoCandidatesInputDto = z.infer<typeof listVideoCandidatesInputSchema>;
export type SelectVideoCandidateInputDto = z.infer<typeof selectVideoCandidateInputSchema>;
export type GetVideoTaskInputDto = z.infer<typeof getVideoTaskInputSchema>;
export type GenerateVideosForShotsInputDto = z.infer<typeof generateVideosForShotsInputSchema>;
export type CancelVideoBatchInputDto = z.infer<typeof cancelVideoBatchInputSchema>;
export type ListStoryboardVideoStatesInputDto = z.infer<
  typeof listStoryboardVideoStatesInputSchema
>;

export interface VideoApi {
  /** 为单镜头发起一轮视频候选生成（N=2 次独立异步请求聚合为一个媒体任务）。 */
  generateVideoCandidates(
    input: GenerateVideoCandidatesInputDto,
  ): Promise<AppResultDto<MediaTaskViewDto>>;
  /**
   * 整集视频批量（显式用户动作，惰性逐镜头建档）：目标=已选首帧且当前
   * 输入世代无 SUCCEEDED 视频候选的镜头；无已选首帧/已有世代成片者跳过并回告。
   */
  generateVideosForShots(
    input: GenerateVideosForShotsInputDto,
  ): Promise<AppResultDto<MediaBatchViewDto>>;
  /** 按输入世代分组返回该镜头全部视频候选（含 STALE_INPUT 历史）。 */
  listVideoCandidates(
    input: ListVideoCandidatesInputDto,
  ): Promise<AppResultDto<VideoCandidateViewDto[]>>;
  /** 人工选择/切换当前视频段；返回该镜头全量候选以刷新选择态。 */
  selectVideoCandidate(
    input: SelectVideoCandidateInputDto,
  ): Promise<AppResultDto<VideoCandidateViewDto[]>>;
  getVideoTask(input: GetVideoTaskInputDto): Promise<AppResultDto<MediaTaskViewDto>>;
  /** 批次取消：仅停止消费剩余队列，在飞任务跑完自然终态。 */
  cancelVideoBatch(input: CancelVideoBatchInputDto): Promise<AppResultDto<MediaBatchViewDto>>;
  /** 列表级聚合：视频批次视图（活跃+近期）与全部 READY 镜头的视频状态底座。 */
  listStoryboardVideoStates(
    input: ListStoryboardVideoStatesInputDto,
  ): Promise<AppResultDto<StoryboardVideoStatesDto>>;
}

export const VIDEO_IPC_CHANNELS = {
  cancelVideoBatch: 'video.cancelVideoBatch',
  generateVideoCandidates: 'video.generateVideoCandidates',
  generateVideosForShots: 'video.generateVideosForShots',
  getVideoTask: 'video.getVideoTask',
  listStoryboardVideoStates: 'video.listStoryboardVideoStates',
  listVideoCandidates: 'video.listVideoCandidates',
  selectVideoCandidate: 'video.selectVideoCandidate',
} as const;
