import { z } from 'zod';

import { ASPECT_RATIOS, CREATION_MODES, DIALOGUE_RENDER_MODES } from '@jingxu/domain';

/** 系统生成 ID 的安全字符集：禁止路径分隔符、SQL 与空白，杜绝注入面。 */
const idRegex = /^[A-Za-z0-9_-]{12,64}$/u;
const requestIdRegex = /^[A-Za-z0-9_-]{8,128}$/u;

export const projectIdSchema = z.string().regex(idRegex);
export const formatProfileIdSchema = z.string().regex(idRegex);
export const requestIdSchema = z.string().regex(requestIdRegex);
export const traceIdSchema = z.string().regex(requestIdRegex);

/** 带时区偏移的 ISO-8601 时间戳，保证列表排序与乐观并发比对稳定。 */
const isoDateTime = z.iso.datetime({ offset: true });

/** 画幅/创作/对白枚举以 Domain 为唯一源，Contract 不复制字面量。 */
export const aspectRatioSchema = z.enum(ASPECT_RATIOS);
export const creationModeSchema = z.enum(CREATION_MODES);
export const dialogueRenderModeSchema = z.enum(DIALOGUE_RENDER_MODES);

export const subtitleSafeAreaSchema = z
  .object({
    top: z.number().finite().min(0).max(30),
    right: z.number().finite().min(0).max(30),
    bottom: z.number().finite().min(0).max(30),
    left: z.number().finite().min(0).max(30),
  })
  .strict();
export type SubtitleSafeAreaDto = z.infer<typeof subtitleSafeAreaSchema>;

export const formatProfileSchema = z
  .object({
    id: formatProfileIdSchema,
    projectId: projectIdSchema,
    versionNo: z.number().int().nonnegative(),
    parentId: formatProfileIdSchema.nullable(),
    aspectRatio: aspectRatioSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    language: z.string().min(1).max(16),
    subtitleSafeArea: subtitleSafeAreaSchema,
    isCurrent: z.boolean(),
    createdAt: isoDateTime,
  })
  .strict();
export type FormatProfileDto = z.infer<typeof formatProfileSchema>;

/** 列表项：Project 列 + 当前 FormatProfile 的画幅摘要（Design §7）。 */
export const projectSummarySchema = z
  .object({
    id: projectIdSchema,
    name: z.string().min(1).max(100),
    genre: z.string().min(1).max(60).nullable(),
    style: z.string().min(1).max(60).nullable(),
    creationMode: creationModeSchema,
    dialogueRenderMode: dialogueRenderModeSchema,
    aspectRatio: aspectRatioSchema,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable(),
  })
  .strict();
export type ProjectSummaryDto = z.infer<typeof projectSummarySchema>;

/** 详情：Project 元数据 + 当前 FormatProfile 完整规格 + 历史版本（不含当前）。 */
export const projectDetailSchema = z
  .object({
    id: projectIdSchema,
    name: z.string().min(1).max(100),
    genre: z.string().min(1).max(60).nullable(),
    style: z.string().min(1).max(60).nullable(),
    creationMode: creationModeSchema,
    dialogueRenderMode: dialogueRenderModeSchema,
    deploymentMode: z.literal('LOCAL_DEMO'),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable(),
    currentFormatProfile: formatProfileSchema,
    formatProfileHistory: z.array(formatProfileSchema),
  })
  .strict();
export type ProjectDetailDto = z.infer<typeof projectDetailSchema>;
