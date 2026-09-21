import { z } from 'zod';

import type { AppResultDto } from './app-result';
import { projectIdSchema, requestIdSchema } from './project-dto';
import { scriptStageSchema } from './stage';

export const creatorNextActionSchema = z.enum([
  'CHOOSE_START',
  'ENTER_STORY',
  'GENERATE_STAGE',
  'REVIEW_STAGE',
  'GENERATE_STORYBOARD',
  'REVIEW_STORYBOARD',
  'ADD_REFERENCES',
  'GENERATE_IMAGES',
  'GENERATE_VIDEOS',
  'GENERATE_VOICE',
  'PREPARE_EXPORT',
  'VIEW_RESULT',
] as const);

export const creatorGuideTargetSchema = z.enum([
  'START',
  'SOURCE_INPUT',
  'SCRIPT',
  'STORYBOARD',
  'ASSETS',
  'IMAGE',
  'VIDEO',
  'VOICE',
  'EXPORT',
  'COMPLETED',
] as const);

export const creatorGuideFixActionSchema = z.enum([
  'CREATE_PROJECT',
  'OPEN_GENERATION_SERVICES',
  'ADD_CHARACTER_REFERENCE',
  'ADD_STYLE_REFERENCE',
  'SELECT_IMAGE_CANDIDATE',
  'SELECT_VIDEO_CANDIDATE',
  'CONFIGURE_VOICE',
  'RETURN_TO_WORKSPACE',
] as const);

export const getCreatorNextActionInputSchema = z
  .object({ projectId: projectIdSchema.nullable() })
  .strict();

export const creatorNextActionResultSchema = z
  .object({
    action: creatorNextActionSchema,
    blocked: z.boolean(),
    fixAction: creatorGuideFixActionSchema.nullable(),
    projectId: projectIdSchema.nullable(),
    reason: z.string().min(1).max(280),
    stage: scriptStageSchema.nullable(),
    target: creatorGuideTargetSchema,
    title: z.string().min(1).max(100),
  })
  .strict();

export const creatorPreparationOperationSchema = z.enum([
  'IMAGE',
  'VIDEO',
  'VOICE',
  'EXPORT',
] as const);
export const creatorPreparationStatusSchema = z.enum(['READY', 'WARN', 'BLOCK'] as const);
export const creatorPreparationCostStatusSchema = z.enum([
  'AVAILABLE',
  'UNKNOWN',
  'STALE',
] as const);

export const getCreatorPreparationInputSchema = z
  .object({
    episodeId: z
      .string()
      .regex(/^episode_[A-Za-z0-9_-]+$/u)
      .nullable(),
    operation: creatorPreparationOperationSchema,
    projectId: projectIdSchema,
    shotIds: z.array(z.string().regex(/^shot_[A-Za-z0-9_-]+$/u)).max(20),
  })
  .strict();

export const creatorPreparationItemSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/u),
    detail: z.string().min(1).max(280),
    fixAction: creatorGuideFixActionSchema.nullable(),
    label: z.string().min(1).max(100),
    status: creatorPreparationStatusSchema,
  })
  .strict();

export const creatorPreparationCostSchema = z
  .object({
    currency: z.string().min(1).max(16).nullable(),
    effectiveAt: z.iso.datetime({ offset: true }).nullable(),
    max: z.number().nonnegative().nullable(),
    min: z.number().nonnegative().nullable(),
    status: creatorPreparationCostStatusSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const complete =
      value.currency !== null &&
      value.effectiveAt !== null &&
      value.min !== null &&
      value.max !== null;
    if (value.status === 'AVAILABLE' && !complete) {
      context.addIssue({ code: 'custom', message: '可用参考成本必须包含完整区间与日期。' });
    }
    if (value.min !== null && value.max !== null && value.min > value.max) {
      context.addIssue({ code: 'custom', message: '参考成本下限不得高于上限。' });
    }
  });

export const creatorPreparationResultSchema = z
  .object({
    canProceed: z.boolean(),
    cost: creatorPreparationCostSchema,
    estimatedDurationSec: z.number().nonnegative().nullable(),
    isDemo: z.boolean(),
    items: z.array(creatorPreparationItemSchema).min(1).max(50),
    operation: creatorPreparationOperationSchema,
    preparationRevision: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
    projectId: projectIdSchema,
    shotIds: z.array(z.string().regex(/^shot_[A-Za-z0-9_-]+$/u)).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const hasBlock = value.items.some((item) => item.status === 'BLOCK');
    if (value.canProceed === hasBlock) {
      context.addIssue({ code: 'custom', message: 'canProceed 必须与 BLOCK 检查项一致。' });
    }
    if (value.isDemo && value.cost.status === 'AVAILABLE') {
      context.addIssue({ code: 'custom', message: '演示模式不得显示真实参考成本。' });
    }
  });

export const startCreatorDemoInputSchema = z.object({ requestId: requestIdSchema }).strict();
export const creatorDemoResultSchema = z
  .object({
    isDemo: z.literal(true),
    projectId: projectIdSchema,
    resumed: z.boolean(),
    summary: z.string().min(1).max(240),
  })
  .strict();

export type CreatorDemoResultDto = z.infer<typeof creatorDemoResultSchema>;
export type CreatorGuideFixAction = z.infer<typeof creatorGuideFixActionSchema>;
export type CreatorGuideTarget = z.infer<typeof creatorGuideTargetSchema>;
export type CreatorNextAction = z.infer<typeof creatorNextActionSchema>;
export type CreatorNextActionResultDto = z.infer<typeof creatorNextActionResultSchema>;
export type CreatorPreparationOperation = z.infer<typeof creatorPreparationOperationSchema>;
export type CreatorPreparationResultDto = z.infer<typeof creatorPreparationResultSchema>;
export type GetCreatorNextActionInputDto = z.infer<typeof getCreatorNextActionInputSchema>;
export type GetCreatorPreparationInputDto = z.infer<typeof getCreatorPreparationInputSchema>;
export type StartCreatorDemoInputDto = z.infer<typeof startCreatorDemoInputSchema>;

export interface CreatorGuideApi {
  getNextAction(
    input: GetCreatorNextActionInputDto,
  ): Promise<AppResultDto<CreatorNextActionResultDto>>;
  getPreparation(
    input: GetCreatorPreparationInputDto,
  ): Promise<AppResultDto<CreatorPreparationResultDto>>;
  startDemo(input: StartCreatorDemoInputDto): Promise<AppResultDto<CreatorDemoResultDto>>;
}

export const CREATOR_GUIDE_IPC_CHANNELS = {
  getNextAction: 'creatorGuide.getNextAction',
  getPreparation: 'creatorGuide.getPreparation',
  startDemo: 'creatorGuide.startDemo',
} as const;
