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

const videoTimelineIdSchema = idSchema;
const videoTimelineVersionIdSchema = idSchema;
const videoAudioAssetIdSchema = idSchema;
const videoExportJobIdSchema = idSchema;

export const videoTimelineItemSchema = z
  .object({
    candidateId: candidateIdSchema,
    enabled: z.boolean(),
    fileSha256: hashSchema,
    generationInputHash: hashSchema,
    position: z.number().int().nonnegative(),
    shotId: shotIdSchema,
    trimInMs: z.number().int().nonnegative(),
    trimOutMs: z.number().int().positive(),
  })
  .strict();

/**
 * 配音轨条目（v2-voice-audio-timeline design D3）：并行于 items 的第二轨，
 * 每镜头至多一项。offsetMs 为该配音相对镜头起点的偏移；候选三元组
 * （candidateId/fileSha256/generationInputHash）随版本冻结，漂移即拒绝。
 */
export const videoTimelineVoiceItemSchema = z
  .object({
    /**
     * 对齐人工覆盖（design D4；PRD §10.7.1）。缺省 null = 走默认策略；
     * 与偏差类别不构成合法组合时由服务层显式拒绝（不静默改类）。
     */
    alignmentOverride: z.enum(['TRIM_AUDIO', 'FORCE_TRIM', 'EARLY_CUT_NEXT']).nullable().optional(),
    candidateId: candidateIdSchema,
    enabled: z.boolean(),
    fileSha256: hashSchema,
    generationInputHash: hashSchema,
    offsetMs: z.number().int().nonnegative(),
    shotId: shotIdSchema,
    trimInMs: z.number().int().nonnegative(),
    trimOutMs: z.number().int().positive(),
    volume: z.number().min(0).max(1),
  })
  .strict();

/**
 * 冻结的对齐记录（design D4）：四要素（音频实际时长/镜头实际时长/对齐方式/
 * 是否分镜层回退）+ extendedMs + 人工覆盖 + 规则版本，随时间线版本逐镜头一行。
 */
export const videoTimelineAlignmentItemSchema = z
  .object({
    audioDurationMs: z.number().int().positive(),
    category: z.enum(['ALIGNED', 'SLIGHTLY_LONG', 'FAR_LONG', 'SHORTER']),
    dialogueComplete: z.boolean(),
    extendedMs: z.number().int().nonnegative(),
    manualOverride: z.enum(['TRIM_AUDIO', 'FORCE_TRIM', 'EARLY_CUT_NEXT']).nullable(),
    rulesVersion: z.string().min(1).max(128),
    shotDurationMs: z.number().int().positive(),
    shotId: shotIdSchema,
    storyboardFallback: z.boolean(),
    strategy: z.enum([
      'DIRECT_MIX',
      'FREEZE_EXTEND',
      'BLOCK_STORYBOARD_FALLBACK',
      'TAIL_SILENCE',
      'MANUAL_TRIM_AUDIO',
      'FORCE_TRIM_DIALOGUE_INCOMPLETE',
      'EARLY_CUT_NEXT',
    ]),
  })
  .strict();

/**
 * 基础字幕轨条目：文本从镜头 spoken_text 派生（以哈希锚定），仅默认安全区
 * 样式；safeAreaPct 为百分比整数。样式编辑器为非目标（proposal 非目标）。
 */
export const videoTimelineSubtitleItemSchema = z
  .object({
    enabled: z.boolean(),
    safeAreaPct: z.number().int().min(0).max(20),
    shotId: shotIdSchema,
    spokenTextSha256: hashSchema,
  })
  .strict();

export const videoAudioAssetSummarySchema = z
  .object({
    byteSize: z.number().int().positive(),
    fileSha256: hashSchema,
    id: videoAudioAssetIdSchema,
    mimeType: z.enum(['audio/mpeg', 'audio/wav', 'audio/x-m4a', 'audio/mp4']),
    originalFileName: z.string().min(1).max(255),
  })
  .strict();

export const videoTimelineSummarySchema = z
  .object({
    /** 冻结对齐记录（0021；无配音版本为空数组）。 */
    alignmentItems: z.array(videoTimelineAlignmentItemSchema).max(20),
    audioAsset: videoAudioAssetSummarySchema.nullable(),
    /** BGM 音量（0020 数据化；既有版本行读出默认 0.2=旧硬编码等效）。 */
    audioVolume: z.number().min(0).max(1),
    createdAt: isoDateTimeSchema,
    episodeId: idSchema,
    episodeVersionId: idSchema,
    formatProfileId: idSchema,
    id: videoTimelineIdSchema,
    inputHash: hashSchema,
    items: z.array(videoTimelineItemSchema).max(20),
    parentVersionId: videoTimelineVersionIdSchema.nullable(),
    subtitleItems: z.array(videoTimelineSubtitleItemSchema).max(20),
    totalDurationMs: z.number().int().nonnegative(),
    versionNo: z.number().int().positive(),
    voiceItems: z.array(videoTimelineVoiceItemSchema).max(20),
  })
  .strict();

export const videoExportStatusSchema = z.enum([
  'PREPARING',
  'RUNNING',
  'VALIDATING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const videoExportJobSchema = z
  .object({
    byteSize: z.number().int().positive().nullable(),
    createdAt: isoDateTimeSchema,
    errorCode: z.string().min(1).max(64).nullable(),
    fileSha256: hashSchema.nullable(),
    id: videoExportJobIdSchema,
    mediaUrl: z.string().startsWith('jingxu://media/video-export/').nullable(),
    status: videoExportStatusSchema,
    timelineVersionId: videoTimelineVersionIdSchema,
    totalDurationMs: z.number().int().nonnegative().nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === 'SUCCEEDED' &&
      (value.fileSha256 === null || value.byteSize === null || value.mediaUrl === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: '成功导出必须携带文件哈希、字节数和受限媒体 URL。',
      });
    }
    if (value.status !== 'SUCCEEDED' && value.mediaUrl !== null) {
      context.addIssue({ code: 'custom', message: '非成功导出不得携带媒体 URL。' });
    }
  });

export const createVideoTimelineInputSchema = z
  .object({
    episodeId: idSchema,
    expectedEpisodeVersionId: idSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict();
export const getVideoTimelineInputSchema = z
  .object({
    episodeId: idSchema,
    projectId: projectIdSchema,
    timelineVersionId: videoTimelineVersionIdSchema.nullable(),
  })
  .strict();
export const updateVideoTimelineInputSchema = z
  .object({
    audioAssetId: videoAudioAssetIdSchema.nullable(),
    audioVolume: z.number().min(0).max(1).default(0.2),
    episodeId: idSchema,
    expectedVersionId: videoTimelineVersionIdSchema,
    items: z.array(videoTimelineItemSchema).min(1).max(20),
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    subtitleItems: z.array(videoTimelineSubtitleItemSchema).max(20).default([]),
    voiceItems: z.array(videoTimelineVoiceItemSchema).max(20).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    // 两轨条目都必须锚定在时间线视频轨的镜头集合内，且每镜头至多一项。
    const shotIds = new Set(value.items.map((item) => item.shotId));
    for (const [field, entries] of [
      ['subtitleItems', value.subtitleItems] as const,
      ['voiceItems', value.voiceItems] as const,
    ] as const) {
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.shotId)) {
          context.addIssue({
            code: 'custom',
            message: `${field} 的 shotId 不得重复。`,
            path: [field],
          });
          break;
        }
        seen.add(entry.shotId);
        if (!shotIds.has(entry.shotId)) {
          context.addIssue({
            code: 'custom',
            message: `${field} 引用了不在视频轨中的镜头。`,
            path: [field],
          });
          break;
        }
      }
    }
  });
export const importVideoBackgroundMusicInputSchema = z
  .object({ projectId: projectIdSchema, requestId: requestIdSchema })
  .strict();
export const startVideoExportInputSchema = z
  .object({
    episodeId: idSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    timelineVersionId: videoTimelineVersionIdSchema,
  })
  .strict();
export const getVideoExportJobInputSchema = z
  .object({ exportJobId: videoExportJobIdSchema, projectId: projectIdSchema })
  .strict();
export const cancelVideoExportInputSchema = z
  .object({
    exportJobId: videoExportJobIdSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
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
export type VideoTimelineItemDto = z.infer<typeof videoTimelineItemSchema>;
export type VideoTimelineVoiceItemDto = z.infer<typeof videoTimelineVoiceItemSchema>;
export type VideoTimelineAlignmentItemDto = z.infer<typeof videoTimelineAlignmentItemSchema>;
export type VideoTimelineSubtitleItemDto = z.infer<typeof videoTimelineSubtitleItemSchema>;
export type VideoAudioAssetSummaryDto = z.infer<typeof videoAudioAssetSummarySchema>;
export type VideoTimelineSummaryDto = z.infer<typeof videoTimelineSummarySchema>;
export type VideoExportJobDto = z.infer<typeof videoExportJobSchema>;
export type VideoExportStatus = z.infer<typeof videoExportStatusSchema>;
export type CreateVideoTimelineInputDto = z.infer<typeof createVideoTimelineInputSchema>;
export type GetVideoTimelineInputDto = z.infer<typeof getVideoTimelineInputSchema>;
export type UpdateVideoTimelineInputDto = z.infer<typeof updateVideoTimelineInputSchema>;
export type ImportVideoBackgroundMusicInputDto = z.infer<
  typeof importVideoBackgroundMusicInputSchema
>;
export type StartVideoExportInputDto = z.infer<typeof startVideoExportInputSchema>;
export type GetVideoExportJobInputDto = z.infer<typeof getVideoExportJobInputSchema>;
export type CancelVideoExportInputDto = z.infer<typeof cancelVideoExportInputSchema>;

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
  createTimeline(
    input: CreateVideoTimelineInputDto,
  ): Promise<AppResultDto<VideoTimelineSummaryDto>>;
  getTimeline(input: GetVideoTimelineInputDto): Promise<AppResultDto<VideoTimelineSummaryDto>>;
  updateTimeline(
    input: UpdateVideoTimelineInputDto,
  ): Promise<AppResultDto<VideoTimelineSummaryDto>>;
  importBackgroundMusic(
    input: ImportVideoBackgroundMusicInputDto,
  ): Promise<AppResultDto<VideoAudioAssetSummaryDto>>;
  startExport(input: StartVideoExportInputDto): Promise<AppResultDto<VideoExportJobDto>>;
  getExportJob(input: GetVideoExportJobInputDto): Promise<AppResultDto<VideoExportJobDto>>;
  cancelExport(input: CancelVideoExportInputDto): Promise<AppResultDto<VideoExportJobDto>>;
}

export const VIDEO_IPC_CHANNELS = {
  cancelVideoBatch: 'video.cancelVideoBatch',
  generateVideoCandidates: 'video.generateVideoCandidates',
  generateVideosForShots: 'video.generateVideosForShots',
  getVideoTask: 'video.getVideoTask',
  listStoryboardVideoStates: 'video.listStoryboardVideoStates',
  listVideoCandidates: 'video.listVideoCandidates',
  selectVideoCandidate: 'video.selectVideoCandidate',
  cancelExport: 'video.cancelExport',
  createTimeline: 'video.createTimeline',
  getExportJob: 'video.getExportJob',
  getTimeline: 'video.getTimeline',
  importBackgroundMusic: 'video.importBackgroundMusic',
  startExport: 'video.startExport',
  updateTimeline: 'video.updateTimeline',
} as const;
