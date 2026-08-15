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

export interface ImageApi {
  /** 为单镜头发起一轮候选生成（N=4 次独立请求聚合为一个媒体任务）。 */
  generateCandidates(input: GenerateCandidatesInputDto): Promise<AppResultDto<MediaTaskViewDto>>;
  /** 按输入世代分组返回该镜头全部候选（含 STALE_INPUT 历史）。 */
  listCandidates(input: ListCandidatesInputDto): Promise<AppResultDto<ImageCandidateViewDto[]>>;
  /** 人工选择/切换当前首帧；返回该镜头全量候选以刷新选择态。 */
  selectCandidate(input: SelectCandidateInputDto): Promise<AppResultDto<ImageCandidateViewDto[]>>;
  listAssets(input: ListAssetsInputDto): Promise<AppResultDto<AssetViewDto[]>>;
  /** 上传资产参考图（≤20MB PNG/JPEG/WebP），产生新的不可变 AssetVersion。 */
  uploadAssetReference(
    input: UploadAssetReferenceInputDto,
  ): Promise<AppResultDto<AssetVersionViewDto>>;
  getMediaTask(input: GetMediaTaskInputDto): Promise<AppResultDto<MediaTaskViewDto>>;
}

export const IMAGE_IPC_CHANNELS = {
  generateCandidates: 'image.generateCandidates',
  getTask: 'image.getTask',
  listAssets: 'image.listAssets',
  listCandidates: 'image.listCandidates',
  selectCandidate: 'image.selectCandidate',
  uploadAssetReference: 'image.uploadAssetReference',
} as const;
