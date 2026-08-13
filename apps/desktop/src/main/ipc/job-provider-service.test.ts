import type { ProviderProfileView } from '@jingxu/application';
import {
  EVENTS_IPC_CHANNELS,
  JOB_IPC_CHANNELS,
  PROVIDER_IPC_CHANNELS,
  type JobCreateInputDto,
  type JobGetInputDto,
  type JobListInputDto,
  type JobMutationInputDto,
  type JobSummaryDto,
  type ProviderCredentialCommandDto,
  type ProviderGetInputDto,
  type ProviderMutationInputDto,
  type ProviderProfileCommandDto,
  type ProviderProfileDto,
} from '@jingxu/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { JobService } from '../jobs/job-service';
import type { ProviderService } from '@jingxu/application';
import { createJobProviderIpcService } from './job-provider-service';

const TRACE_ID = 'trace_job_provider_0001';
const SUBSCRIPTION_ID = 'sub_12345678';

const configuredView: ProviderProfileView = {
  configured: true,
  enabled: true,
  last4: '4321',
  lastValidatedAt: '2026-08-10T01:00:00.000Z',
  modelId: 'qwen-plus',
  modelSnapshotDate: '2026-08-01',
  provider: 'QWEN',
  region: 'cn-beijing',
  versionId: 'profile_12345678',
  workspaceId: 'workspace-1',
};
const defaultView: ProviderProfileView = {
  configured: false,
  enabled: true,
  last4: null,
  lastValidatedAt: null,
  modelId: 'qwen-plus',
  modelSnapshotDate: '2026-08-01',
  provider: 'QWEN',
  region: 'cn-beijing',
  versionId: 'profile_12345678',
  workspaceId: 'workspace-1',
};

const expectedDto = (view: ProviderProfileView): ProviderProfileDto => ({
  configured: view.configured,
  enabled: view.enabled,
  last4: view.last4,
  modelId: view.modelId,
  provider: view.provider,
  region: view.region,
  validated: view.lastValidatedAt !== null,
  versionId: view.versionId,
  workspaceId: view.workspaceId,
});

const jobSummary: JobSummaryDto = {
  errorCode: null,
  id: 'job_12345678',
  projectId: 'project_12345678',
  status: 'QUEUED',
  versionId: 'job_12345678',
};

const jobCreateInput: JobCreateInputDto = {
  episodeId: null,
  expectedInputVersionId: 'source_12345678',
  idempotencyKey: 'idem-12345',
  operationType: 'GENERATE',
  projectId: 'project_12345678',
  requestId: 'request-create-0001',
  stage: 'CONCEPT',
};
const jobGetInput: JobGetInputDto = { jobId: 'job_12345678' };
const jobListInput: JobListInputDto = { limit: 20, projectId: 'project_12345678' };
const jobMutationInput: JobMutationInputDto = {
  expectedVersionId: 'job_12345678',
  jobId: 'job_12345678',
  requestId: 'request-mutate-0001',
};
const providerGetInput: ProviderGetInputDto = { profileId: 'profile_12345678' };
const providerSaveProfileInput: ProviderProfileCommandDto = {
  enabled: true,
  expectedVersionId: 'profile_12345678',
  profileId: 'profile_12345678',
  requestId: 'request-save-profile',
  workspaceId: 'workspace-1',
};
const providerSaveCredentialInput: ProviderCredentialCommandDto = {
  apiKey: 'sk-secret-1234567890',
  expectedVersionId: 'profile_12345678',
  profileId: 'profile_12345678',
  requestId: 'request-save-credential',
};
const providerMutationInput: ProviderMutationInputDto = {
  expectedVersionId: 'profile_12345678',
  profileId: 'profile_12345678',
  requestId: 'request-provider-mutate',
};

const createHarness = () => {
  const jobCreate = vi.fn(() => Promise.resolve({ data: jobSummary, ok: true }));
  const jobGet = vi.fn(() => Promise.resolve({ data: jobSummary, ok: true }));
  const jobList = vi.fn(() => Promise.resolve({ data: [jobSummary], ok: true }));
  const jobCancel = vi.fn(() => Promise.resolve({ data: jobSummary, ok: true }));
  const jobRetry = vi.fn(() => Promise.resolve({ data: jobSummary, ok: true }));
  const getProfile = vi.fn(() => Promise.resolve(configuredView));
  const saveProfile = vi.fn(() => Promise.resolve(configuredView));
  const saveCredential = vi.fn(() => Promise.resolve(configuredView));
  const testCredential = vi.fn(() => Promise.resolve({ ok: true }));
  const deleteCredential = vi.fn(() => Promise.resolve(defaultView));

  const jobs = {
    create: jobCreate,
    get: jobGet,
    list: jobList,
    cancel: jobCancel,
    retry: jobRetry,
  } as unknown as JobService;
  const provider = {
    getProfile,
    saveProfile,
    saveCredential,
    testCredential,
    deleteCredential,
  } as unknown as ProviderService;

  const service = createJobProviderIpcService({
    jobs,
    newSubscriptionId: () => SUBSCRIPTION_ID,
    newTraceId: () => TRACE_ID,
    provider,
  });
  return {
    deleteCredential,
    getProfile,
    jobCancel,
    jobCreate,
    jobGet,
    jobList,
    jobRetry,
    saveCredential,
    saveProfile,
    service,
    testCredential,
  };
};

describe('createJobProviderIpcService — 边界 Host', () => {
  it('Job 频道路由—五个命令委托 JobService 并注入 traceId，结果原样投影', async () => {
    const h = createHarness();

    await expect(h.service.invoke(JOB_IPC_CHANNELS.create, jobCreateInput)).resolves.toEqual({
      data: jobSummary,
      ok: true,
    });
    await expect(h.service.invoke(JOB_IPC_CHANNELS.get, jobGetInput)).resolves.toEqual({
      data: jobSummary,
      ok: true,
    });
    await expect(h.service.invoke(JOB_IPC_CHANNELS.list, jobListInput)).resolves.toEqual({
      data: [jobSummary],
      ok: true,
    });
    await expect(h.service.invoke(JOB_IPC_CHANNELS.cancel, jobMutationInput)).resolves.toEqual({
      data: jobSummary,
      ok: true,
    });
    await expect(h.service.invoke(JOB_IPC_CHANNELS.retry, jobMutationInput)).resolves.toEqual({
      data: jobSummary,
      ok: true,
    });

    expect(h.jobCreate).toHaveBeenCalledWith(jobCreateInput, TRACE_ID);
    expect(h.jobGet).toHaveBeenCalledWith(jobGetInput.jobId, TRACE_ID);
    expect(h.jobList).toHaveBeenCalledWith(jobListInput, TRACE_ID);
    expect(h.jobCancel).toHaveBeenCalledWith(
      jobMutationInput.jobId,
      jobMutationInput.expectedVersionId,
      TRACE_ID,
    );
    expect(h.jobRetry).toHaveBeenCalledWith(
      jobMutationInput.jobId,
      jobMutationInput.expectedVersionId,
      TRACE_ID,
    );
  });

  it('Provider 频道路由—view→DTO 投影注入 versionId，五个命令委托正确方法', async () => {
    const h = createHarness();

    await expect(
      h.service.invoke(PROVIDER_IPC_CHANNELS.getProfile, providerGetInput),
    ).resolves.toEqual({
      data: expectedDto(configuredView),
      ok: true,
    });
    await expect(
      h.service.invoke(PROVIDER_IPC_CHANNELS.saveProfile, providerSaveProfileInput),
    ).resolves.toEqual({ data: expectedDto(configuredView), ok: true });
    await expect(
      h.service.invoke(PROVIDER_IPC_CHANNELS.saveCredential, providerSaveCredentialInput),
    ).resolves.toEqual({ data: expectedDto(configuredView), ok: true });
    await expect(
      h.service.invoke(PROVIDER_IPC_CHANNELS.testCredential, providerMutationInput),
    ).resolves.toEqual({ data: expectedDto(configuredView), ok: true });
    await expect(
      h.service.invoke(PROVIDER_IPC_CHANNELS.deleteCredential, providerMutationInput),
    ).resolves.toEqual({ data: expectedDto(defaultView), ok: true });

    expect(h.getProfile).toHaveBeenCalledWith(providerGetInput.profileId);
    expect(h.saveProfile).toHaveBeenCalledWith(
      providerSaveProfileInput.profileId,
      providerSaveProfileInput.workspaceId,
      providerSaveProfileInput.enabled,
    );
    expect(h.saveCredential).toHaveBeenCalledWith(
      providerSaveCredentialInput.profileId,
      providerSaveCredentialInput.apiKey,
    );
    expect(h.testCredential).toHaveBeenCalledWith(providerMutationInput.profileId);
    expect(h.deleteCredential).toHaveBeenCalledWith(providerMutationInput.profileId);
  });

  it('未配置 profile—getProfile 返回虚拟默认视图—DTO configured:false / last4:null', async () => {
    const h = createHarness();
    h.getProfile.mockResolvedValueOnce(defaultView);

    const result = await h.service.invoke(PROVIDER_IPC_CHANNELS.getProfile, providerGetInput);

    expect(result).toEqual({ data: expectedDto(defaultView), ok: true });
    expect((result as { data: ProviderProfileDto }).data.configured).toBe(false);
    expect((result as { data: ProviderProfileDto }).data.last4).toBeNull();
  });

  it('testCredential 连通性失败—check.ok=false—归一化为 PROVIDER_CALL_FAILED', async () => {
    const h = createHarness();
    h.testCredential.mockResolvedValueOnce({ ok: false });

    const result = (await h.service.invoke(
      PROVIDER_IPC_CHANNELS.testCredential,
      providerMutationInput,
    )) as { ok: false; error: { code: string; traceId: string } };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_CALL_FAILED');
    expect(result.error.traceId).toBe(TRACE_ID);
  });

  it('ProviderService 抛标记错误—PROVIDER_PROFILE_NOT_FOUND—稳定 code 透传', async () => {
    const h = createHarness();
    h.testCredential.mockRejectedValueOnce(new Error('PROVIDER_PROFILE_NOT_FOUND'));

    const result = (await h.service.invoke(
      PROVIDER_IPC_CHANNELS.testCredential,
      providerMutationInput,
    )) as { ok: false; error: { code: string } };

    expect(result.error.code).toBe('PROVIDER_PROFILE_NOT_FOUND');
  });

  it('ProviderService 抛含 Key/Authorization/SQL 的原始错误—归一化且零泄漏', async () => {
    const h = createHarness();
    h.saveCredential.mockRejectedValueOnce(
      new Error(
        'Authorization: Bearer sk-leak-123456789; sqlite3 C:\\Users\\ASUS\\secrets.db SELECT credential_ref FROM provider_profiles',
      ),
    );

    const result = (await h.service.invoke(
      PROVIDER_IPC_CHANNELS.saveCredential,
      providerSaveCredentialInput,
    )) as { ok: false; error: { code: string } };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PROVIDER_CREDENTIAL_UNAVAILABLE');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk-leak');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('SELECT');
    expect(serialized).not.toContain('C:');
    expect(serialized).not.toContain('credential_ref');
    expect(serialized).not.toContain('sqlite');
  });

  it('JobService 返回畸形结果—输出校验失败—归一化为 JOB_PERSISTENCE_FAILED 零泄漏', async () => {
    const h = createHarness();
    // 故意注入超出 schema 的畸形字段（多余 sql、缺 errorCode），验证输出校验归一化而非透传
    h.jobGet.mockResolvedValueOnce({
      data: {
        id: 'job_12345678',
        projectId: 'project_12345678',
        sql: 'SELECT secret',
        status: 'QUEUED',
        versionId: 'job_12345678',
      },
      ok: true,
    } as never);

    const result = (await h.service.invoke(JOB_IPC_CHANNELS.get, jobGetInput)) as {
      ok: false;
      error: { code: string; retryable: boolean };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('JOB_PERSISTENCE_FAILED');
    expect(result.error.retryable).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SELECT');
  });

  it('相同 requestId + 相同 signature 并发—singleflight—Provider 只执行一次且共享结果', async () => {
    const h = createHarness();
    let release:
      ((value: ProviderProfileView | PromiseLike<ProviderProfileView>) => void) | undefined;
    h.saveProfile.mockImplementationOnce(
      () =>
        new Promise<ProviderProfileView>((resolve) => {
          release = resolve;
        }),
    );

    const first = h.service.invoke(PROVIDER_IPC_CHANNELS.saveProfile, providerSaveProfileInput);
    const second = h.service.invoke(PROVIDER_IPC_CHANNELS.saveProfile, providerSaveProfileInput);
    await Promise.resolve();
    expect(h.saveProfile).toHaveBeenCalledTimes(1);
    release?.(configuredView);

    await expect(first).resolves.toEqual({ data: expectedDto(configuredView), ok: true });
    await expect(second).resolves.toEqual({ data: expectedDto(configuredView), ok: true });
  });

  it('相同 requestId + 不同 signature 并发—协调器—第二次 REQUEST_ID_REUSED 且不执行', async () => {
    const h = createHarness();
    let release:
      ((value: ProviderProfileView | PromiseLike<ProviderProfileView>) => void) | undefined;
    h.saveProfile.mockImplementationOnce(
      () =>
        new Promise<ProviderProfileView>((resolve) => {
          release = resolve;
        }),
    );
    const conflictingInput: ProviderProfileCommandDto = {
      ...providerSaveProfileInput,
      profileId: 'profile_87654321',
    };

    const first = h.service.invoke(PROVIDER_IPC_CHANNELS.saveProfile, providerSaveProfileInput);
    const conflict = (await h.service.invoke(
      PROVIDER_IPC_CHANNELS.saveProfile,
      conflictingInput,
    )) as { ok: false; error: { code: string; traceId: string } };

    expect(conflict.ok).toBe(false);
    expect(conflict.error.code).toBe('REQUEST_ID_REUSED');
    expect(conflict.error.traceId).toBe(TRACE_ID);
    expect(h.saveProfile).toHaveBeenCalledTimes(1);
    release?.(configuredView);
    await expect(first).resolves.toEqual({ data: expectedDto(configuredView), ok: true });
  });

  it('事件订阅—返回新 subscriptionId 且通过输出校验', async () => {
    const h = createHarness();
    await expect(
      h.service.invoke(EVENTS_IPC_CHANNELS.subscribeJobUpdates, { projectId: 'project_12345678' }),
    ).resolves.toEqual({ data: { subscriptionId: SUBSCRIPTION_ID }, ok: true });
  });

  it('未知频道—归一化为 IPC_INVALID_REQUEST', async () => {
    const h = createHarness();
    const result = (await h.service.invoke('provider.unknown', providerGetInput)) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('IPC_INVALID_REQUEST');
  });
});
