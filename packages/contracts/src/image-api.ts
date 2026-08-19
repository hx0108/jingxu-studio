import { z } from 'zod';

import type { AppResultDto } from './app-result';
import { projectIdSchema, requestIdSchema } from './project-dto';

/**
 * 图片 IPC 公共契约（shot-first-frame-image-generation design D4）。
 * Renderer/Main/Preload 共享的媒体任务、候选与资产 DTO 单一来源。
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const shotIdSchema = idSchema;
const taskIdSchema = idSchema;
const candidateIdSchema = idSchema;
const assetVersionIdSchema = idSchema;
const batchIdSchema = idSchema;

export const imageCandidateStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'STALE_INPUT']);
export const mediaTaskPhaseSchema = z.enum([
  'SUBMITTED',
  'POLLING',
  'DOWNLOADING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export const assetTypeSchema = z.enum(['CHARACTER', 'SCENE']);
/** 资产参考图上传上限（design D6-4）：单图 ≤20MB，仅 PNG/JPEG/WebP。 */
export const assetReferenceMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export const ASSET_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;

/** 候选/资产版本的受限取图 URL；Renderer 不接触文件系统路径。 */
export const candidateMediaUrl = (candidateId: string): string =>
  `jingxu://media/candidate/${candidateId}`;
export const assetVersionMediaUrl = (versionId: string): string =>
  `jingxu://media/asset-version/${versionId}`;

export const imageCandidateViewSchema = z
  .object({
    byteSize: z.number().int().nonnegative().nullable(),
    createdAt: isoDateTimeSchema,
    errorCode: z.string().min(1).max(64).nullable(),
    generationInputHash: hashSchema,
    height: z.number().int().positive().nullable(),
    id: candidateIdSchema,
    indexInRound: z.number().int().nonnegative(),
    mediaUrl: z.string().startsWith('jingxu://media/').nullable(),
    mimeType: z.string().min(3).max(64).nullable(),
    roundNo: z.number().int().positive(),
    selectedAt: isoDateTimeSchema.nullable(),
    shotId: shotIdSchema,
    shotVersionId: idSchema,
    status: imageCandidateStatusSchema,
    width: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'SUCCEEDED') {
      if (value.mediaUrl === null || value.byteSize === null || value.mimeType === null) {
        context.addIssue({
          code: 'custom',
          message: 'SUCCEEDED 候选必须携带 mediaUrl/byteSize/mimeType。',
          path: ['status'],
        });
      }
    } else if (value.mediaUrl !== null) {
      context.addIssue({
        code: 'custom',
        message: '非 SUCCEEDED 候选不得携带 mediaUrl。',
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

export const mediaTaskViewSchema = z
  .object({
    candidateCount: z.number().int().positive().max(16),
    createdAt: isoDateTimeSchema,
    errorCode: z.string().min(1).max(64).nullable(),
    generationInputHash: hashSchema,
    id: taskIdSchema,
    phase: mediaTaskPhaseSchema,
    shotId: shotIdSchema,
    shotVersionId: idSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const assetVersionViewSchema = z
  .object({
    assetId: idSchema,
    byteSize: z.number().int().positive().max(ASSET_REFERENCE_MAX_BYTES),
    createdAt: isoDateTimeSchema,
    description: z.string().min(1).max(500).nullable(),
    height: z.number().int().positive().nullable(),
    id: assetVersionIdSchema,
    mediaUrl: z.string().startsWith('jingxu://media/'),
    mimeType: assetReferenceMimeSchema,
    provenance: z.literal('UPLOADED'),
    versionNo: z.number().int().positive(),
    width: z.number().int().positive().nullable(),
  })
  .strict();

export const assetViewSchema = z
  .object({
    assetType: assetTypeSchema,
    bibleRefId: idSchema,
    createdAt: isoDateTimeSchema,
    currentVersion: assetVersionViewSchema.nullable(),
    displayName: z.string().min(1).max(200),
    id: idSchema,
    projectId: projectIdSchema,
    updatedAt: isoDateTimeSchema,
    versions: z.array(assetVersionViewSchema).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.currentVersion !== null && value.currentVersion.assetId !== value.id) {
      context.addIssue({
        code: 'custom',
        message: '当前版本归属与资产不一致。',
        path: ['currentVersion'],
      });
    }
    const hasCurrent = value.versions.some(
      (version) => value.currentVersion !== null && version.id === value.currentVersion.id,
    );
    if (value.currentVersion !== null && !hasCurrent) {
      context.addIssue({
        code: 'custom',
        message: '当前版本必须包含在版本列表中。',
        path: ['versions'],
      });
    }
  });

/** 资产升版 STALE 传播的受影响镜头摘要（spec：升版 MUST 支持列出受影响镜头清单）。 */
export const staleAffectedShotSchema = z
  .object({ candidateCount: z.number().int().positive(), shotId: shotIdSchema })
  .strict();
export type StaleAffectedShotDto = z.infer<typeof staleAffectedShotSchema>;

/** 上传结果：新版本视图 + 本次升版触发 STALE 的受影响镜头（无候选受影响则为空数组）。 */
export const uploadAssetReferenceResultSchema = z
  .object({
    affectedShots: z.array(staleAffectedShotSchema).max(180),
    version: assetVersionViewSchema,
  })
  .strict();
export type UploadAssetReferenceResultDto = z.infer<typeof uploadAssetReferenceResultSchema>;

/**
 * 生成输入哈希的输入集（design D3）：哈希对象逐字段对齐服务层计算，
 * 契约层固化字段集防漂移。哈希算法（sha256 拼接顺序）属 application 实现。
 */
export const generationInputDescriptorSchema = z
  .object({
    boundAssetVersionIds: z.array(assetVersionIdSchema).max(14),
    modelId: z.string().min(1).max(128),
    parametersFingerprint: z.string().min(1).max(256),
    shotContentHash: hashSchema,
    shotVersionId: idSchema,
  })
  .strict();

export const generateCandidatesInputSchema = z
  .object({
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    shotId: shotIdSchema,
  })
  .strict();
export const listCandidatesInputSchema = z
  .object({ projectId: projectIdSchema, shotId: shotIdSchema })
  .strict();
export const selectCandidateInputSchema = z
  .object({
    candidateId: candidateIdSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict();
export const listAssetsInputSchema = z.object({ projectId: projectIdSchema }).strict();
export const uploadAssetReferenceInputSchema = z
  .object({
    assetType: assetTypeSchema,
    bibleRefId: idSchema,
    byteSize: z.number().int().positive().max(ASSET_REFERENCE_MAX_BYTES),
    bytes: z.instanceof(Uint8Array),
    description: z.string().min(1).max(500).nullable(),
    displayName: z.string().min(1).max(200),
    mimeType: assetReferenceMimeSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.bytes.byteLength !== value.byteSize) {
      context.addIssue({
        code: 'custom',
        message: 'bytes 长度与 byteSize 不一致。',
        path: ['bytes'],
      });
    }
  });
export const getMediaTaskInputSchema = z
  .object({ projectId: projectIdSchema, taskId: taskIdSchema })
  .strict();

/** 批次硬界对齐分镜镜头硬界（1–20 镜头，AGENTS.md:57）。 */
export const MEDIA_BATCH_MAX_SHOTS = 20;

export const mediaBatchStatusSchema = z.enum([
  'RUNNING',
  'COMPLETED',
  'PARTIAL_COMPLETED',
  'CANCELLED',
]);

/**
 * 批次成员（batch-first-frame-generation design D1-C）：members 按目标镜头排队顺序排列；
 * 排队中镜头（尚未建档）taskId/phase 为 null，已建档镜头携带任务相位摘要。
 * 失败清单/进度由成员相位派生，不在契约层冗余。
 */
export const mediaBatchMemberSchema = z
  .object({
    errorCode: z.string().min(1).max(64).nullable(),
    phase: mediaTaskPhaseSchema.nullable(),
    shotId: shotIdSchema,
    taskId: taskIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.taskId === null && value.phase !== null) {
      context.addIssue({
        code: 'custom',
        message: '排队中成员不得携带任务相位。',
        path: ['phase'],
      });
    }
    if (value.taskId !== null && value.phase === null) {
      context.addIssue({
        code: 'custom',
        message: '已建档成员必须携带任务相位。',
        path: ['phase'],
      });
    }
    if (value.phase !== 'FAILED' && value.errorCode !== null) {
      context.addIssue({
        code: 'custom',
        message: 'errorCode 只在成员任务 FAILED 时携带。',
        path: ['errorCode'],
      });
    }
  });

export const mediaBatchViewSchema = z
  .object({
    batchId: batchIdSchema,
    createdAt: isoDateTimeSchema,
    errorCode: z.string().min(1).max(64).nullable(),
    members: z.array(mediaBatchMemberSchema).min(1).max(MEDIA_BATCH_MAX_SHOTS),
    skippedShotIds: z.array(shotIdSchema).max(MEDIA_BATCH_MAX_SHOTS),
    status: mediaBatchStatusSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

/**
 * 镜头首帧状态底座（design D5）：徽标由 Renderer 从原始字段派生
 * （queuedInBatchId→排队中；activeTaskPhase 非终态→生成中；
 * currentGenSucceededCount>0→就绪；latestTaskErrorCode→失败；否则无候选），
 * 与 first-frame-policy 的世代分组同一「当前世代」定义，由服务端统一计算。
 */
export const shotImageStateSchema = z
  .object({
    activeTaskPhase: mediaTaskPhaseSchema.nullable(),
    currentGenSucceededCount: z.number().int().nonnegative().max(16),
    latestTaskErrorCode: z.string().min(1).max(64).nullable(),
    queuedInBatchId: batchIdSchema.nullable(),
    shotId: shotIdSchema,
  })
  .strict();

/** 列表级聚合查询：活跃与近期批次 + 全部 READY 镜头的首帧状态底座。 */
export const storyboardImageStatesSchema = z
  .object({
    batches: z.array(mediaBatchViewSchema).max(10),
    shots: z.array(shotImageStateSchema).max(MEDIA_BATCH_MAX_SHOTS),
  })
  .strict();

export const generateCandidatesForShotsInputSchema = z
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
export const cancelBatchInputSchema = z
  .object({ batchId: batchIdSchema, projectId: projectIdSchema, requestId: requestIdSchema })
  .strict();
export const listStoryboardImageStatesInputSchema = z
  .object({ projectId: projectIdSchema })
  .strict();

export type ImageCandidateViewDto = z.infer<typeof imageCandidateViewSchema>;
export type MediaTaskViewDto = z.infer<typeof mediaTaskViewSchema>;
export type AssetVersionViewDto = z.infer<typeof assetVersionViewSchema>;
export type AssetViewDto = z.infer<typeof assetViewSchema>;
export type GenerationInputDescriptorDto = z.infer<typeof generationInputDescriptorSchema>;
export type GenerateCandidatesInputDto = z.infer<typeof generateCandidatesInputSchema>;
export type ListCandidatesInputDto = z.infer<typeof listCandidatesInputSchema>;
export type SelectCandidateInputDto = z.infer<typeof selectCandidateInputSchema>;
export type ListAssetsInputDto = z.infer<typeof listAssetsInputSchema>;
export type UploadAssetReferenceInputDto = z.infer<typeof uploadAssetReferenceInputSchema>;
export type GetMediaTaskInputDto = z.infer<typeof getMediaTaskInputSchema>;
export type MediaBatchMemberDto = z.infer<typeof mediaBatchMemberSchema>;
export type MediaBatchViewDto = z.infer<typeof mediaBatchViewSchema>;
export type ShotImageStateDto = z.infer<typeof shotImageStateSchema>;
export type StoryboardImageStatesDto = z.infer<typeof storyboardImageStatesSchema>;
export type GenerateCandidatesForShotsInputDto = z.infer<
  typeof generateCandidatesForShotsInputSchema
>;
export type CancelBatchInputDto = z.infer<typeof cancelBatchInputSchema>;
export type ListStoryboardImageStatesInputDto = z.infer<
  typeof listStoryboardImageStatesInputSchema
>;

export interface ImageApi {
  /** 为单镜头发起一轮候选生成（N=4 次独立请求聚合为一个媒体任务）。 */
  generateCandidates(input: GenerateCandidatesInputDto): Promise<AppResultDto<MediaTaskViewDto>>;
  /**
   * 批量首帧（显式用户动作，design D1-C 惰性逐镜头建档）：为 READY 集合内指定镜头
   * 建立批次并立即为队首镜头建档；当前世代已有 SUCCEEDED 候选的镜头跳过并回告。
   */
  generateCandidatesForShots(
    input: GenerateCandidatesForShotsInputDto,
  ): Promise<AppResultDto<MediaBatchViewDto>>;
  /** 按输入世代分组返回该镜头全部候选（含 STALE_INPUT 历史）。 */
  listCandidates(input: ListCandidatesInputDto): Promise<AppResultDto<ImageCandidateViewDto[]>>;
  /** 人工选择/切换当前首帧；返回该镜头全量候选以刷新选择态。 */
  selectCandidate(input: SelectCandidateInputDto): Promise<AppResultDto<ImageCandidateViewDto[]>>;
  listAssets(input: ListAssetsInputDto): Promise<AppResultDto<AssetViewDto[]>>;
  /** 上传资产参考图（≤20MB PNG/JPEG/WebP），产生新的不可变 AssetVersion 并返回受影响镜头。 */
  uploadAssetReference(
    input: UploadAssetReferenceInputDto,
  ): Promise<AppResultDto<UploadAssetReferenceResultDto>>;
  getMediaTask(input: GetMediaTaskInputDto): Promise<AppResultDto<MediaTaskViewDto>>;
  /** 批次取消（design D6-A）：仅停止消费剩余队列，在飞任务跑完自然终态。 */
  cancelBatch(input: CancelBatchInputDto): Promise<AppResultDto<MediaBatchViewDto>>;
  /** 列表级聚合：批次视图（活跃+近期）与全部 READY 镜头的首帧状态底座。 */
  listStoryboardImageStates(
    input: ListStoryboardImageStatesInputDto,
  ): Promise<AppResultDto<StoryboardImageStatesDto>>;
}

export const IMAGE_IPC_CHANNELS = {
  cancelBatch: 'image.cancelBatch',
  generateCandidates: 'image.generateCandidates',
  generateCandidatesForShots: 'image.generateCandidatesForShots',
  getTask: 'image.getTask',
  listAssets: 'image.listAssets',
  listCandidates: 'image.listCandidates',
  listStoryboardImageStates: 'image.listStoryboardImageStates',
  selectCandidate: 'image.selectCandidate',
  uploadAssetReference: 'image.uploadAssetReference',
} as const;
