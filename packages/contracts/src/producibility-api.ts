import { z } from 'zod';

import type { AppResultDto } from './app-result';
import { projectIdSchema, requestIdSchema } from './project-dto';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
const snapshotIdSchema = z.string().min(1).max(128);
const severitySchema = z.enum(['INFO', 'WARN', 'BLOCK']);
const findingSchema = z
  .object({
    id: idSchema,
    ruleId: z.string().min(1).max(128),
    ruleVersion: z.string().min(1).max(64),
    severity: severitySchema,
    jsonPointer: z
      .string()
      .regex(/^$|^\//u)
      .max(256),
    observation: z.string().min(1).max(280),
    recommendation: z.string().min(1).max(280),
    sourceType: z.enum(['RULE', 'LLM']),
    overridden: z.boolean(),
    overrideReason: z.string().min(1).max(500).nullable(),
  })
  .strict();
export const producibilityRunInputSchema = z
  .object({
    document: z.record(z.string(), z.unknown()),
    episodeId: idSchema,
    expectedVersionId: idSchema,
    projectId: projectIdSchema,
    requestId: requestIdSchema,
  })
  .strict();
export const producibilityGetReportInputSchema = z.object({ reportId: idSchema }).strict();
export const producibilityOverrideFindingInputSchema = z
  .object({
    actor: z.enum(['USER', 'SYSTEM']),
    findingId: idSchema,
    reason: z.string().min(1).max(500),
    requestId: requestIdSchema,
  })
  .strict();
export const producibilityReportSchema = z
  .object({
    id: idSchema,
    capabilitySnapshotId: snapshotIdSchema,
    projectId: projectIdSchema,
    episodeId: idSchema,
    episodeVersionId: idSchema,
    ruleSetVersion: z.literal('jingxu-producibility-rules/1'),
    status: z.enum(['PASS', 'WARN', 'BLOCK']),
    findings: z.array(findingSchema).max(128),
    createdAt: z.iso.datetime({ offset: true }),
    disclaimer: z.string().min(1).max(280),
    referencePriceSnapshotId: snapshotIdSchema.nullable(),
  })
  .strict();
export type ProducibilityRunInputDto = z.infer<typeof producibilityRunInputSchema>;
export type ProducibilityGetReportInputDto = z.infer<typeof producibilityGetReportInputSchema>;
export type ProducibilityOverrideFindingInputDto = z.infer<
  typeof producibilityOverrideFindingInputSchema
>;
export type ProducibilityFindingDto = z.infer<typeof findingSchema>;
export type ProducibilityReportDto = z.infer<typeof producibilityReportSchema>;
export interface ProducibilityApi {
  run(input: ProducibilityRunInputDto): Promise<AppResultDto<ProducibilityReportDto>>;
  getReport(input: ProducibilityGetReportInputDto): Promise<AppResultDto<ProducibilityReportDto>>;
  overrideFinding(
    input: ProducibilityOverrideFindingInputDto,
  ): Promise<AppResultDto<ProducibilityReportDto>>;
}
export const PRODUCIBILITY_IPC_CHANNELS = {
  run: 'producibility.run',
  getReport: 'producibility.getReport',
  overrideFinding: 'producibility.overrideFinding',
} as const;
