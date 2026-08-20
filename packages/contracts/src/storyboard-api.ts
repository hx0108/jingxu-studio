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
export type ShotEditLockSummaryDto = z.infer<typeof shotEditLockSummarySchema>;

export interface StoryboardApi {
  editShot(input: StoryboardEditShotInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
  lockShot(input: StoryboardLockShotInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
  unlockShot(input: StoryboardUnlockShotInputDto): Promise<AppResultDto<ShotEditLockSummaryDto>>;
}

export const STORYBOARD_IPC_CHANNELS = {
  editShot: 'storyboard.editShot',
  lockShot: 'storyboard.lockShot',
  unlockShot: 'storyboard.unlockShot',
} as const;
