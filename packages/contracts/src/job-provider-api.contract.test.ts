import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  EVENTS_IPC_CHANNELS,
  JOB_IPC_CHANNELS,
  PROVIDER_IPC_CHANNELS,
  jobCreateInputSchema,
  jobMutationInputSchema,
  providerCredentialCommandSchema,
  providerProfileSchema,
  type EventsApi,
  type JobApi,
  type ProviderApi,
} from './job-provider-api';

describe('Job Provider Events IPC Contract', () => {
  it('频道白名单—枚举—恰有五个 Job、五个 Provider 与一个 Events 方法', () => {
    expect(Object.values(JOB_IPC_CHANNELS).sort()).toEqual([
      'job.cancel',
      'job.create',
      'job.get',
      'job.list',
      'job.retry',
    ]);
    expect(Object.values(PROVIDER_IPC_CHANNELS).sort()).toEqual([
      'provider.deleteCredential',
      'provider.getProfile',
      'provider.saveCredential',
      'provider.saveProfile',
      'provider.testCredential',
    ]);
    expect(Object.values(EVENTS_IPC_CHANNELS)).toEqual(['events.subscribeJobUpdates']);
    expectTypeOf<JobApi>().toBeObject();
    expectTypeOf<ProviderApi>().toBeObject();
    expectTypeOf<EventsApi>().toBeObject();
  });

  it('Command DTO—未知字段或缺 requestId/expectedVersionId—strict 双端契约拒绝', () => {
    const job = {
      expectedVersionId: 'version_12345678',
      jobId: 'job_12345678',
      requestId: 'request-123',
    };
    expect(jobMutationInputSchema.safeParse(job).success).toBe(true);
    expect(jobMutationInputSchema.safeParse({ ...job, sql: 'SELECT' }).success).toBe(false);
    expect(
      jobMutationInputSchema.safeParse({ jobId: job.jobId, requestId: job.requestId }).success,
    ).toBe(false);
    expect(
      jobCreateInputSchema.safeParse({
        episodeId: null,
        expectedInputVersionId: 'source_12345678',
        idempotencyKey: 'idem-12345',
        operationType: 'GENERATE',
        projectId: 'project_12345678',
        stage: 'CONCEPT',
      }).success,
    ).toBe(false);
    expect(
      providerCredentialCommandSchema.safeParse({
        apiKey: 'secret',
        profileId: 'profile_12345678',
        requestId: 'request-123',
      }).success,
    ).toBe(false);
  });

  it('Project ID—系统生成 UUID 以数字开头—Job create 接受并保持路径安全字符集', () => {
    const input = {
      idempotencyKey: 'idem-12345',
      episodeId: null,
      expectedInputVersionId: 'source_12345678',
      projectId: '12345678-abcd-4abc-8abc-1234567890ab',
      requestId: 'request-123',
      operationType: 'GENERATE',
      stage: 'CONCEPT',
    };
    expect(jobCreateInputSchema.safeParse(input).success).toBe(true);
    expect(
      jobCreateInputSchema.safeParse({ ...input, projectId: '../unsafe/project' }).success,
    ).toBe(false);
  });

  it('Job create—项目级与集级 episode 规则—接受六阶段 GENERATE（含 SHOT_CONTRACT 集级）', () => {
    const input = {
      episodeId: null,
      expectedInputVersionId: 'source_12345678',
      idempotencyKey: 'idem-12345',
      operationType: 'GENERATE',
      projectId: 'project_12345678',
      requestId: 'request-123',
      stage: 'CONCEPT',
    };
    expect(jobCreateInputSchema.safeParse(input).success).toBe(true);
    expect(
      jobCreateInputSchema.safeParse({ ...input, episodeId: 'episode_12345678' }).success,
    ).toBe(false);
    expect(
      jobCreateInputSchema.safeParse({
        ...input,
        episodeId: 'episode_12345678',
        expectedInputVersionId: 'version_12345678',
        stage: 'EPISODE_OUTLINE',
      }).success,
    ).toBe(true);
    // SHOT_CONTRACT 为集级阶段：必须携带 episodeId（D6 放行，operation 仍限 GENERATE）。
    expect(
      jobCreateInputSchema.safeParse({
        ...input,
        episodeId: 'episode_12345678',
        expectedInputVersionId: 'version_12345678',
        stage: 'SHOT_CONTRACT',
      }).success,
    ).toBe(true);
    expect(jobCreateInputSchema.safeParse({ ...input, stage: 'SHOT_CONTRACT' }).success).toBe(
      false,
    );
    expect(jobCreateInputSchema.safeParse({ ...input, operationType: 'REWRITE' }).success).toBe(
      false,
    );
    expect(jobCreateInputSchema.safeParse({ ...input, inputVersions: [] }).success).toBe(false);
  });

  it('Provider 输出—完整 Key/Auth/未知字段—strict 输出契约拒绝', () => {
    const view = {
      configured: true,
      enabled: true,
      last4: '7890',
      modelId: 'qwen3.7-plus-2026-05-26',
      provider: 'QWEN',
      region: 'cn-beijing',
      validated: true,
      versionId: 'version_12345678',
      workspaceId: 'workspace-1',
    };
    expect(providerProfileSchema.safeParse(view).success).toBe(true);
    expect(providerProfileSchema.safeParse({ ...view, apiKey: 'secret' }).success).toBe(false);
    expect(
      providerProfileSchema.safeParse({ ...view, authorization: 'Bearer secret' }).success,
    ).toBe(false);
  });

  it('Provider 输出—图片档（VOLCARK_SEEDREAM）round-trip 与未知 provider 拒绝', () => {
    // DB workspace_id NOT NULL 决定图片档沿用非空占位（design D1 Apply 期修订）。
    const view = {
      configured: false,
      enabled: true,
      last4: null,
      modelId: 'doubao-seedream-5-0-lite-260128',
      provider: 'VOLCARK_SEEDREAM',
      region: 'cn-beijing',
      validated: false,
      versionId: 'version_12345678',
      workspaceId: 'ark',
    };
    expect(providerProfileSchema.safeParse(view).success).toBe(true);
    expect(providerProfileSchema.parse(view).provider).toBe('VOLCARK_SEEDREAM');
    expect(providerProfileSchema.safeParse({ ...view, provider: 'OPENAI' }).success).toBe(false);
    expect(providerProfileSchema.safeParse({ ...view, apiKey: 'secret' }).success).toBe(false);
  });

  it('Provider 输出—配音档（QWEN_TTS）round-trip、脱敏面不变', () => {
    const view = {
      configured: true,
      enabled: true,
      last4: '4321',
      modelId: 'qwen3-tts-instruct-flash',
      provider: 'QWEN_TTS',
      region: 'cn-beijing',
      validated: true,
      versionId: 'version_12345678',
      workspaceId: 'dashscope',
    };
    expect(providerProfileSchema.safeParse(view).success).toBe(true);
    expect(providerProfileSchema.parse(view).provider).toBe('QWEN_TTS');
    expect(providerProfileSchema.safeParse({ ...view, apiKey: 'secret' }).success).toBe(false);
    expect(providerProfileSchema.safeParse({ ...view, provider: 'ARK_TTS' }).success).toBe(false);
  });
});
