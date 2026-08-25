import { z } from 'zod';

import type { AppResultDto } from './app-result';
import { projectIdSchema, requestIdSchema } from './project-dto';
import { storyboardVersionSummarySchema } from './script-api';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
/**
 * 锁指针粗校验：非空、以 `/` 开头、限长。RFC 6901 转义、七根白名单、
 * 路径可解析等完整语义由服务层 validateLockPointer 判定（错误形态
 * SHOT_LOCK_POINTER_INVALID），契约层不复制该算法。
 */
const jsonPointerSchema = z.string().regex(/^\//u).max(256);

export const storyboardEditShotInputSchema = z
  .object({
    /** 编辑后的完整 ShotContract 文档；系统字段以服务端重写为准。 */
    document: z.record(z.string(), z.unknown()),
    episodeId: idSchema,
    expectedVersionId: idSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    shotId: idSchema,
    /** 编辑基线镜头版本 id；与当前集合引用不一致视为并发冲突。 */
    shotVersionId: idSchema,
  })
  .strict();
export const storyboardLockShotInputSchema = z
  .object({
    episodeId: idSchema,
    expectedVersionId: idSchema,
    jsonPointer: jsonPointerSchema,
    /** 锁定备注（可选，纯文本）。 */
    note: z.string().max(200).nullable(),
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    shotId: idSchema,
  })
  .strict();
export const storyboardUnlockShotInputSchema = z
  .object({
    episodeId: idSchema,
    expectedVersionId: idSchema,
    jsonPointer: jsonPointerSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    shotId: idSchema,
  })
  .strict();

const structuralBase = z
  .object({
    episodeId: idSchema,
    expectedVersionId: idSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict();
export const storyboardSplitShotInputSchema = structuralBase.extend({ shotId: idSchema }).strict();
export const storyboardMergeShotsInputSchema = structuralBase
  .extend({ shotIds: z.array(idSchema).length(2) })
  .strict();
export const storyboardCopyShotInputSchema = structuralBase.extend({ shotId: idSchema }).strict();
export const storyboardReorderShotsInputSchema = structuralBase
  .extend({ orderedShotIds: z.array(idSchema).min(1).max(20) })
  .strict();
export const storyboardDeleteShotInputSchema = structuralBase.extend({ shotId: idSchema }).strict();
export const storyboardRestoreShotInputSchema = structuralBase
  .extend({ shotId: idSchema, fromVersionId: idSchema })
  .strict();

/** editShot/lockShot/unlockShot 共用输出：整集摘要 + 镜头当前版本 + 有效锁投影。 */
export const shotEditLockSummarySchema = z
  .object({
    episode: storyboardVersionSummarySchema,
    /** 恒等于 lock_records 有效集合（不变量 13 投影一致性）。 */
    lockedPaths: z.array(jsonPointerSchema).max(32),
    shotVersionId: idSchema,
  })
  .strict();

export type StoryboardEditShotInputDto = z.infer<typeof storyboardEditShotInputSchema>;
export type StoryboardLockShotInputDto = z.infer<typeof storyboardLockShotInputSchema>;
export type StoryboardUnlockShotInputDto = z.infer<typeof storyboardUnlockShotInputSchema>;
export type StoryboardSplitShotInputDto = z.infer<typeof storyboardSplitShotInputSchema>;
export type StoryboardMergeShotsInputDto = z.infer<typeof storyboardMergeShotsInputSchema>;
export type StoryboardCopyShotInputDto = z.infer<typeof storyboardCopyShotInputSchema>;
export type StoryboardReorderShotsInputDto = z.infer<typeof storyboardReorderShotsInputSchema>;
export type StoryboardDeleteShotInputDto = z.infer<typeof storyboardDeleteShotInputSchema>;
export type StoryboardRestoreShotInputDto = z.infer<typeof storyboardRestoreShotInputSchema>;
export type ShotEditLockSummaryDto = z.infer<typeof shotEditLockSummarySchema>;

/**
 * 交付物形态（storyboard-export-deliverables D1）：三值枚举，缺省 EPISODE_JSON
 * 保持旧调用面向后兼容；回执五键格式无关。
 */
export const storyboardExportFormatSchema = z.enum([
  'EPISODE_JSON',
  'MARKDOWN_TABLE',
  'PRODUCIBILITY_REPORT',
]);
export type StoryboardExportFormat = z.infer<typeof storyboardExportFormatSchema>;

/**
 * Σ 软带偏离确认（storyboard-export D5）：服务端是算带事实源，契约层只做
 * 形状粗校验；deviationReason 非空判定在服务层（EXPORT_DURATION_DEVIATION）。
 */
export const storyboardExportEpisodeInputSchema = z
  .object({
    /** 基线整集版本 id；与当前 head 不一致视为并发冲突。 */
    deviationReason: z.string().max(280).nullable().optional(),
    episodeId: idSchema,
    expectedVersionId: idSchema,
    /** 交付物形态；缺省 EPISODE_JSON（旧调用不带 format 仍为 JSON 导出）。 */
    format: storyboardExportFormatSchema.default('EPISODE_JSON'),
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    warnConfirmed: z.boolean().optional(),
  })
  .strict();

/** 导出成功回执：只有哈希与计数，绝不携带文件路径（路径红线）。 */
export const storyboardExportResultSchema = z
  .object({
    byteSize: z.number().int().nonnegative(),
    episodeVersionId: idSchema,
    /** Schema envelope export_id（`export_` 前缀）。 */
    exportId: z.string().min(1).max(128),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    totalDurationSec: z.number().int().nonnegative(),
  })
  .strict();

export type StoryboardExportEpisodeInputDto = z.infer<typeof storyboardExportEpisodeInputSchema>;
export type StoryboardExportResultDto = z.infer<typeof storyboardExportResultSchema>;

export interface StoryboardApi {
  editShot(input: StoryboardEditShotInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
  exportEpisode(
    input: StoryboardExportEpisodeInputDto,
  ): Promise<AppResultDto<StoryboardExportResultDto>>;
  lockShot(input: StoryboardLockShotInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
  unlockShot(input: StoryboardUnlockShotInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
  splitShot(input: StoryboardSplitShotInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
  mergeShots(input: StoryboardMergeShotsInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
  copyShot(input: StoryboardCopyShotInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
  reorderShots(
    input: StoryboardReorderShotsInputDto,
  ): Promise<AppResultDto<ShotEditLockSummaryDto>>;
  deleteShot(input: StoryboardDeleteShotInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
  restoreShot(input: StoryboardRestoreShotInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
}

export const STORYBOARD_IPC_CHANNELS = {
  editShot: 'storyboard.editShot',
  exportEpisode: 'storyboard.exportEpisode',
  lockShot: 'storyboard.lockShot',
  unlockShot: 'storyboard.unlockShot',
  splitShot: 'storyboard.splitShot',
  mergeShots: 'storyboard.mergeShots',
  copyShot: 'storyboard.copyShot',
  reorderShots: 'storyboard.reorderShots',
  deleteShot: 'storyboard.deleteShot',
  restoreShot: 'storyboard.restoreShot',
} as const;
