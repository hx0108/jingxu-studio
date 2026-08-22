import { z } from 'zod';

import type { AppResultDto } from './app-result';
import { dialogueRenderModeSchema, projectIdSchema, requestIdSchema } from './project-dto';
import { scriptStageSchema } from './stage';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
/** 带时区偏移的 ISO-8601 时间戳（与 project-dto 同款，列表排序稳定）。 */
const isoDateTime = z.iso.datetime({ offset: true });
/** 与 0001 evaluation_samples.sample_type CHECK 对齐。 */
export const evaluationSampleTypeSchema = z.enum([
  'SCRIPT_STAGE',
  'SHOT_CONTRACT',
  'EPISODE_STORYBOARD',
]);
export type EvaluationSampleType = z.infer<typeof evaluationSampleTypeSchema>;

/** 与 0001 evaluation_samples.authorization_status CHECK 对齐。 */
export const evaluationAuthorizationSchema = z.enum(['AUTHORIZED', 'PUBLIC_DOMAIN', 'SYNTHETIC']);
export type EvaluationAuthorization = z.infer<typeof evaluationAuthorizationSchema>;

/**
 * 与 0001 evaluation_samples.dataset_split CHECK 对齐；PRD §11.7 四拆分映射：
 * TRAIN=Development、VALIDATION=Validation、TEST=Holdout；Regression Set 属 V2+ 非目标。
 */
export const evaluationDatasetSplitSchema = z.enum(['TRAIN', 'VALIDATION', 'TEST']);
export type EvaluationDatasetSplit = z.infer<typeof evaluationDatasetSplitSchema>;

/**
 * 规则命中/期望的问题类型稳定码。前九个对应 PRD §9.9 要求覆盖的九类问题；
 * SCHEMA_INVALID/PRODUCIBILITY_WARN 为引擎级补充命中（如正脸长对白 WARN）。
 */
export const evaluationIssueCodeSchema = z.enum([
  'EVAL_ISSUE_MISSING_REQUIRED',
  'EVAL_ISSUE_ENUM_INVALID',
  'EVAL_ISSUE_DURATION_DEVIATION',
  'EVAL_ISSUE_CHARACTER_OVERFLOW',
  'EVAL_ISSUE_COMPLEX_ACTION',
  'EVAL_ISSUE_DIALOGUE_MODE_CONFLICT',
  'EVAL_ISSUE_CONTINUITY_INVALID',
  'EVAL_ISSUE_CAPABILITY_UNKNOWN',
  'EVAL_ISSUE_LOCK_CONFLICT',
  'EVAL_ISSUE_SCHEMA_INVALID',
  'EVAL_ISSUE_PRODUCIBILITY_WARN',
]);
export type EvaluationIssueCode = z.infer<typeof evaluationIssueCodeSchema>;

/** 第一版标注指南版本（PRD §9.9；文档随包受控资源发布）。 */
export const EVALUATION_GUIDELINE_VERSION = 'jingxu-annotation-guideline/1';
export const evaluationGuidelineVersionSchema = z
  .string()
  .regex(/^jingxu-annotation-guideline\/\d+$/u);

/**
 * 派生键固定为 derive:<projectId>:<episodeVersionId>:<shotId>；三个带前缀 UUID
 * 的本地标识合计可超过 96 字符，故上限必须覆盖该确定性、可回放格式。
 */
export const evaluationDedupKeySchema = z.string().regex(/^[\w:.-]{3,192}$/u);

export const evaluationCandidateSchema = z
  .object({
    document: z.record(z.string(), z.unknown()),
    kind: evaluationSampleTypeSchema,
    /** 仅 SCRIPT_STAGE 候选需要：被检阶段标识。 */
    stage: scriptStageSchema.nullish(),
  })
  .strict();
export type EvaluationCandidateDto = z.infer<typeof evaluationCandidateSchema>;

/** 最小上下文：足以离线复跑确定性规则（按 kind 裁剪，语义校验在引擎层）。 */
export const evaluationContextSchema = z
  .object({
    characters: z.array(z.string().min(1).max(128)).max(64).nullish(),
    dialogueRenderMode: dialogueRenderModeSchema.nullish(),
    previousShotSummary: z.string().min(1).max(512).nullish(),
    scenes: z.array(z.string().min(1).max(128)).max(64).nullish(),
    targetDurationSec: z.number().int().min(30).max(180).nullish(),
  })
  .strict();
export type EvaluationContextDto = z.infer<typeof evaluationContextSchema>;

export const evaluationSampleInputSchema = z
  .object({
    candidate: evaluationCandidateSchema,
    context: evaluationContextSchema,
  })
  .strict();
export type EvaluationSampleInputDto = z.infer<typeof evaluationSampleInputSchema>;

export const evaluationExpectedSchema = z
  .object({
    acceptable: z.boolean(),
    expectedIssueCodes: z.array(evaluationIssueCodeSchema).max(16),
    referenceContract: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type EvaluationExpectedDto = z.infer<typeof evaluationExpectedSchema>;

export const evaluationRuleHitSchema = z
  .object({
    code: evaluationIssueCodeSchema,
    detail: z.string().min(1).max(280),
    path: z.string().min(1).max(160).nullable(),
  })
  .strict();
export type EvaluationRuleHitDto = z.infer<typeof evaluationRuleHitSchema>;

export const evaluationAnnotationLabelSchema = z
  .object({
    issueCodes: z.array(evaluationIssueCodeSchema).max(16),
    severity: z.enum(['BLOCK', 'WARN', 'ADVISORY']).nullable(),
    verdict: z.enum(['ACCEPTABLE', 'PROBLEM']),
  })
  .strict();
export type EvaluationAnnotationLabelDto = z.infer<typeof evaluationAnnotationLabelSchema>;

export const evaluationAnnotationSchema = z
  .object({
    annotator: z.string().min(1).max(64),
    createdAt: isoDateTime,
    guidelineVersion: evaluationGuidelineVersionSchema,
    id: idSchema,
    label: evaluationAnnotationLabelSchema,
    rationale: z.string().min(1).max(2000),
    sampleId: idSchema,
  })
  .strict();
export type EvaluationAnnotationDto = z.infer<typeof evaluationAnnotationSchema>;

export const evaluationSampleSummarySchema = z
  .object({
    acceptable: z.boolean(),
    authorization: evaluationAuthorizationSchema,
    createdAt: isoDateTime,
    datasetSplit: evaluationDatasetSplitSchema,
    dedupKey: evaluationDedupKeySchema,
    hitCodes: z.array(evaluationIssueCodeSchema),
    latestAnnotation: evaluationAnnotationSchema.nullable(),
    projectId: projectIdSchema.nullable(),
    sampleId: idSchema,
    sampleType: evaluationSampleTypeSchema,
  })
  .strict();
export type EvaluationSampleSummaryDto = z.infer<typeof evaluationSampleSummarySchema>;

export const evaluationSampleDetailSchema = evaluationSampleSummarySchema
  .extend({
    annotations: z.array(evaluationAnnotationSchema),
    expected: evaluationExpectedSchema,
    hits: z.array(evaluationRuleHitSchema),
    input: evaluationSampleInputSchema,
    ruleVersion: z.string().min(1).max(64),
  })
  .strict();
export type EvaluationSampleDetailDto = z.infer<typeof evaluationSampleDetailSchema>;

export const evaluationListSamplesInputSchema = z
  .object({
    datasetSplit: evaluationDatasetSplitSchema.nullish(),
    projectId: projectIdSchema.nullish(),
    sampleType: evaluationSampleTypeSchema.nullish(),
    scope: z.enum(['ALL', 'GLOBAL', 'PROJECT']),
  })
  .strict();
export type EvaluationListSamplesInputDto = z.infer<typeof evaluationListSamplesInputSchema>;

export const evaluationGetSampleInputSchema = z.object({ sampleId: idSchema }).strict();
export type EvaluationGetSampleInputDto = z.infer<typeof evaluationGetSampleInputSchema>;

export const evaluationListSamplesResultSchema = z
  .object({ samples: z.array(evaluationSampleSummarySchema) })
  .strict();
export type EvaluationListSamplesResultDto = z.infer<typeof evaluationListSamplesResultSchema>;

export const evaluationCreateSampleInputSchema = z
  .object({
    authorization: evaluationAuthorizationSchema,
    datasetSplit: evaluationDatasetSplitSchema,
    dedupKey: evaluationDedupKeySchema,
    expected: evaluationExpectedSchema,
    input: evaluationSampleInputSchema,
    projectId: projectIdSchema.nullish(),
  })
  .strict();
export type EvaluationCreateSampleInputDto = z.infer<typeof evaluationCreateSampleInputSchema>;

export const evaluationCreateFromEpisodeInputSchema = z
  .object({
    authorization: evaluationAuthorizationSchema,
    datasetSplit: evaluationDatasetSplitSchema,
    expectedVersionId: idSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    shotIndexes: z.array(z.number().int().min(0).max(63)).max(64).nullish(),
  })
  .strict();
export type EvaluationCreateFromEpisodeInputDto = z.infer<
  typeof evaluationCreateFromEpisodeInputSchema
>;

export const evaluationCreateFromEpisodeResultSchema = z
  .object({ samples: z.array(evaluationSampleSummarySchema) })
  .strict();
export type EvaluationCreateFromEpisodeResultDto = z.infer<
  typeof evaluationCreateFromEpisodeResultSchema
>;

export const evaluationImportBatchInputSchema = z.object({ requestId: requestIdSchema }).strict();
export type EvaluationImportBatchInputDto = z.infer<typeof evaluationImportBatchInputSchema>;

export const evaluationImportOutcomeSchema = z.enum(['CREATED', 'DUPLICATE', 'REJECTED']);
export type EvaluationImportOutcome = z.infer<typeof evaluationImportOutcomeSchema>;

export const evaluationImportItemResultSchema = z
  .object({
    dedupKey: evaluationDedupKeySchema.nullable(),
    reason: z.string().min(1).max(280).nullable(),
    sampleId: idSchema.nullable(),
    status: evaluationImportOutcomeSchema,
  })
  .strict();
export type EvaluationImportItemResultDto = z.infer<typeof evaluationImportItemResultSchema>;

export const evaluationImportBatchResultSchema = z
  .object({ items: z.array(evaluationImportItemResultSchema).max(256) })
  .strict();
export type EvaluationImportBatchResultDto = z.infer<typeof evaluationImportBatchResultSchema>;

export const evaluationDeleteSampleInputSchema = z
  .object({ requestId: requestIdSchema, sampleId: idSchema })
  .strict();
export type EvaluationDeleteSampleInputDto = z.infer<typeof evaluationDeleteSampleInputSchema>;

export const evaluationDeleteSampleResultSchema = z
  .object({ deletedAnnotations: z.number().int().nonnegative(), sampleId: idSchema })
  .strict();
export type EvaluationDeleteSampleResultDto = z.infer<typeof evaluationDeleteSampleResultSchema>;

export const evaluationAddAnnotationInputSchema = z
  .object({
    annotator: z.string().min(1).max(64),
    guidelineVersion: evaluationGuidelineVersionSchema,
    label: evaluationAnnotationLabelSchema,
    rationale: z.string().min(1).max(2000),
    requestId: requestIdSchema,
    sampleId: idSchema,
  })
  .strict();
export type EvaluationAddAnnotationInputDto = z.infer<typeof evaluationAddAnnotationInputSchema>;

export const evaluationAddAnnotationResultSchema = z
  .object({ annotations: z.array(evaluationAnnotationSchema) })
  .strict();
export type EvaluationAddAnnotationResultDto = z.infer<typeof evaluationAddAnnotationResultSchema>;

export interface EvaluationApi {
  addAnnotation(
    input: EvaluationAddAnnotationInputDto,
  ): Promise<AppResultDto<Readonly<{ annotations: readonly EvaluationAnnotationDto[] }>>>;
  createFromEpisode(
    input: EvaluationCreateFromEpisodeInputDto,
  ): Promise<AppResultDto<EvaluationCreateFromEpisodeResultDto>>;
  createSample(
    input: EvaluationCreateSampleInputDto,
  ): Promise<AppResultDto<EvaluationSampleSummaryDto>>;
  deleteSample(
    input: EvaluationDeleteSampleInputDto,
  ): Promise<AppResultDto<EvaluationDeleteSampleResultDto>>;
  getSample(
    input: Readonly<{ sampleId: string }>,
  ): Promise<AppResultDto<EvaluationSampleDetailDto>>;
  importBatch(
    input: EvaluationImportBatchInputDto,
  ): Promise<AppResultDto<EvaluationImportBatchResultDto>>;
  listSamples(
    input: EvaluationListSamplesInputDto,
  ): Promise<AppResultDto<EvaluationListSamplesResultDto>>;
}

export const EVALUATION_IPC_CHANNELS = {
  addAnnotation: 'evaluation.addAnnotation',
  createFromEpisode: 'evaluation.createFromEpisode',
  createSample: 'evaluation.createSample',
  deleteSample: 'evaluation.deleteSample',
  getSample: 'evaluation.getSample',
  importBatch: 'evaluation.importBatch',
  listSamples: 'evaluation.listSamples',
} as const;
