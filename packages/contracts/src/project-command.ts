import { z } from 'zod';

import {
  aspectRatioSchema,
  creationModeSchema,
  dialogueRenderModeSchema,
  projectIdSchema,
  projectSummarySchema,
  requestIdSchema,
  subtitleSafeAreaSchema,
} from './project-dto';

const isoDateTime = z.iso.datetime({ offset: true });

/** List/Get 的活动/已删除 scope（Design §7）。 */
export const projectListScopeSchema = z.enum(['ACTIVE', 'DELETED']);
export type ProjectListScope = z.infer<typeof projectListScopeSchema>;

/**
 * Create 命令（Design §2）。只接受用户可控字段；width/height/fps/language/
 * deploymentMode/dataRootRel/ID/时间均由系统派生，调用方无法伪造。
 */
export const createProjectInputSchema = z
  .object({
    requestId: requestIdSchema,
    name: z.string().min(1).max(100),
    genre: z.string().min(1).max(60).nullable(),
    style: z.string().min(1).max(60).nullable(),
    creationMode: creationModeSchema,
    dialogueRenderMode: dialogueRenderModeSchema,
    aspectRatio: aspectRatioSchema,
    subtitleSafeArea: subtitleSafeAreaSchema,
  })
  .strict();
export type CreateProjectInputDto = z.infer<typeof createProjectInputSchema>;

/**
 * Update 命令（Design §2/§6）。发送全量可编辑字段，Application 比较检测变化/no-op；
 * projectId + expectedUpdatedAt 承载乐观并发。
 */
export const updateProjectInputSchema = z
  .object({
    requestId: requestIdSchema,
    projectId: projectIdSchema,
    expectedUpdatedAt: isoDateTime,
    name: z.string().min(1).max(100),
    genre: z.string().min(1).max(60).nullable(),
    style: z.string().min(1).max(60).nullable(),
    dialogueRenderMode: dialogueRenderModeSchema,
    aspectRatio: aspectRatioSchema,
    subtitleSafeArea: subtitleSafeAreaSchema,
  })
  .strict();
export type UpdateProjectInputDto = z.infer<typeof updateProjectInputSchema>;

/** Delete/Restore 共用：projectId + expectedUpdatedAt 乐观并发。 */
export const projectMutationTargetSchema = z
  .object({
    requestId: requestIdSchema,
    projectId: projectIdSchema,
    expectedUpdatedAt: isoDateTime,
  })
  .strict();
export const deleteProjectInputSchema = projectMutationTargetSchema;
export const restoreProjectInputSchema = projectMutationTargetSchema;
export type DeleteProjectInputDto = z.infer<typeof deleteProjectInputSchema>;
export type RestoreProjectInputDto = z.infer<typeof restoreProjectInputSchema>;

/** List 输入：limit 1–100、不透明 cursor、scope、可选搜索文本（Design §7）。 */
export const projectListInputSchema = z
  .object({
    scope: projectListScopeSchema,
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(512).nullable(),
    search: z.string().min(1).max(100).nullable(),
  })
  .strict();
export type ProjectListInputDto = z.infer<typeof projectListInputSchema>;

/** Get 输入：projectId + 明确 scope（区分活动/已删除，Design §7）。 */
export const projectGetInputSchema = z
  .object({
    projectId: projectIdSchema,
    scope: projectListScopeSchema,
  })
  .strict();
export type ProjectGetInputDto = z.infer<typeof projectGetInputSchema>;

/** List 结果：稳定 keyset items + nextCursor + 显式截断标志（Design §7 / R1 搜索）。 */
export const projectListResultSchema = z
  .object({
    items: z.array(projectSummarySchema),
    nextCursor: z.string().min(1).max(512).nullable(),
    truncated: z.boolean(),
  })
  .strict();
export type ProjectListResultDto = z.infer<typeof projectListResultSchema>;
