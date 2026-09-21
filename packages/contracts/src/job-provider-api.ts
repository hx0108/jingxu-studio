import { z } from 'zod';

import type { AppResultDto } from './app-result';
import { projectIdSchema, requestIdSchema } from './project-dto';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
const mutationSchema = z
  .object({ expectedVersionId: idSchema, requestId: requestIdSchema })
  .strict();

export const jobStatusSchema = z.enum([
  'DRAFT',
  'QUEUED',
  'RUNNING',
  'VALIDATING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
export const jobSummarySchema = z
  .object({
    errorCode: z.string().min(1).max(80).nullable(),
    id: idSchema,
    projectId: projectIdSchema,
    status: jobStatusSchema,
    versionId: idSchema,
  })
  .strict();
export const jobCreateInputSchema = z
  .object({
    episodeId: idSchema.nullable(),
    expectedInputVersionId: idSchema,
    idempotencyKey: z.string().min(8).max(128),
    operationType: z.literal('GENERATE'),
    projectId: projectIdSchema,
    requestId: requestIdSchema,
    stage: z.enum([
      'CONCEPT',
      'STORY_BIBLE',
      'EPISODE_OUTLINE',
      'BEAT_SHEET',
      'SCENE_SCRIPT',
      'SHOT_CONTRACT',
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const projectStage = value.stage === 'CONCEPT' || value.stage === 'STORY_BIBLE';
    if ((projectStage && value.episodeId !== null) || (!projectStage && value.episodeId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'episodeId 与阶段层级不匹配。',
        path: ['episodeId'],
      });
    }
  });
export const jobGetInputSchema = z.object({ jobId: idSchema }).strict();
export const jobListInputSchema = z
  .object({ limit: z.number().int().min(1).max(100), projectId: projectIdSchema })
  .strict();
export const jobMutationInputSchema = mutationSchema.extend({ jobId: idSchema }).strict();

export const providerProfileSchema = z
  .object({
    configured: z.boolean(),
    enabled: z.boolean(),
    last4: z.string().length(4).nullable(),
    modelId: z.string().min(1).max(128),
    provider: z.enum([
      'QWEN',
      'QWEN_TTS',
      'VOLCARK_SEEDREAM',
      'VOLCARK_SEEDANCE',
      'AGNES_VIDEO',
      'AGNES_IMAGE',
    ]),
    region: z.string().min(2),
    validated: z.boolean(),
    versionId: idSchema,
    workspaceId: z.string().regex(/^[A-Za-z0-9-]+$/u),
  })
  .strict();
export const providerGetInputSchema = z.object({ profileId: idSchema }).strict();
export const providerProfileCommandSchema = mutationSchema
  .extend({
    enabled: z.boolean(),
    modelId: z.string().min(1).max(128).optional(),
    profileId: idSchema,
    workspaceId: z.string().regex(/^[A-Za-z0-9-]+$/u),
  })
  .strict();
export const providerCredentialCommandSchema = mutationSchema
  .extend({
    apiKey: z.string().min(1).max(512),
    profileId: idSchema,
  })
  .strict();
export const providerMutationInputSchema = mutationSchema.extend({ profileId: idSchema }).strict();
export const jobUpdatesSubscriptionSchema = z.object({ projectId: projectIdSchema }).strict();
export const subscriptionResultSchema = z.object({ subscriptionId: idSchema }).strict();
/** 视频当前 Provider 偏好（low-cost D2/D7）：受限 mode 与固定 Profile 映射，无 URL/密钥。 */
export const videoProviderSelectionModeSchema = z.enum(['SEEDANCE', 'AGNES']);
export const videoProviderSelectionSchema = z
  .object({
    mode: videoProviderSelectionModeSchema,
    providerProfileId: idSchema,
    updatedAt: z.string().min(1),
  })
  .strict();
export const videoProviderSelectionGetInputSchema = z
  .object({ requestId: requestIdSchema })
  .strict();
export const videoProviderSelectionSaveInputSchema = z
  .object({
    expectedUpdatedAt: z.string().min(1).nullable(),
    mode: videoProviderSelectionModeSchema,
    requestId: requestIdSchema,
  })
  .strict();

export type JobSummaryDto = z.infer<typeof jobSummarySchema>;
export type JobCreateInputDto = z.infer<typeof jobCreateInputSchema>;
export type JobGetInputDto = z.infer<typeof jobGetInputSchema>;
export type JobListInputDto = z.infer<typeof jobListInputSchema>;
export type JobMutationInputDto = z.infer<typeof jobMutationInputSchema>;
export type ProviderProfileDto = z.infer<typeof providerProfileSchema>;
export type ProviderGetInputDto = z.infer<typeof providerGetInputSchema>;
export type ProviderProfileCommandDto = z.infer<typeof providerProfileCommandSchema>;
export type ProviderCredentialCommandDto = z.infer<typeof providerCredentialCommandSchema>;
export type ProviderMutationInputDto = z.infer<typeof providerMutationInputSchema>;
export type JobUpdatesSubscriptionDto = z.infer<typeof jobUpdatesSubscriptionSchema>;
export type SubscriptionResultDto = z.infer<typeof subscriptionResultSchema>;
export type VideoProviderSelectionDto = z.infer<typeof videoProviderSelectionSchema>;
export type VideoProviderSelectionGetInputDto = z.infer<
  typeof videoProviderSelectionGetInputSchema
>;
export type VideoProviderSelectionSaveInputDto = z.infer<
  typeof videoProviderSelectionSaveInputSchema
>;

export interface JobApi {
  create(input: JobCreateInputDto): Promise<AppResultDto<JobSummaryDto>>;
  get(input: JobGetInputDto): Promise<AppResultDto<JobSummaryDto>>;
  list(input: JobListInputDto): Promise<AppResultDto<readonly JobSummaryDto[]>>;
  cancel(input: JobMutationInputDto): Promise<AppResultDto<JobSummaryDto>>;
  retry(input: JobMutationInputDto): Promise<AppResultDto<JobSummaryDto>>;
}
export interface ProviderApi {
  getProfile(input: ProviderGetInputDto): Promise<AppResultDto<ProviderProfileDto>>;
  saveProfile(input: ProviderProfileCommandDto): Promise<AppResultDto<ProviderProfileDto>>;
  saveCredential(input: ProviderCredentialCommandDto): Promise<AppResultDto<ProviderProfileDto>>;
  testCredential(input: ProviderMutationInputDto): Promise<AppResultDto<ProviderProfileDto>>;
  deleteCredential(input: ProviderMutationInputDto): Promise<AppResultDto<ProviderProfileDto>>;
  getVideoProviderSelection(
    input: VideoProviderSelectionGetInputDto,
  ): Promise<AppResultDto<VideoProviderSelectionDto>>;
  saveVideoProviderSelection(
    input: VideoProviderSelectionSaveInputDto,
  ): Promise<AppResultDto<VideoProviderSelectionDto>>;
}
export interface EventsApi {
  subscribeJobUpdates(
    input: JobUpdatesSubscriptionDto,
  ): Promise<AppResultDto<SubscriptionResultDto>>;
}

export const JOB_IPC_CHANNELS = {
  cancel: 'job.cancel',
  create: 'job.create',
  get: 'job.get',
  list: 'job.list',
  retry: 'job.retry',
} as const;
export const PROVIDER_IPC_CHANNELS = {
  deleteCredential: 'provider.deleteCredential',
  getProfile: 'provider.getProfile',
  getVideoProviderSelection: 'provider.getVideoProviderSelection',
  saveCredential: 'provider.saveCredential',
  saveProfile: 'provider.saveProfile',
  saveVideoProviderSelection: 'provider.saveVideoProviderSelection',
  testCredential: 'provider.testCredential',
} as const;
export const EVENTS_IPC_CHANNELS = { subscribeJobUpdates: 'events.subscribeJobUpdates' } as const;
