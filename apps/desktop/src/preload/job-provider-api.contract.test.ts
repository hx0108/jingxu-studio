import { describe, expect, it, vi } from 'vitest';

import { EVENTS_IPC_CHANNELS, JOB_IPC_CHANNELS, PROVIDER_IPC_CHANNELS } from '@jingxu/contracts';
import { createJingxuApi } from './jingxu-api';

describe('Job Provider Events Preload Contract', () => {
  it('创建 API—冻结三个逐方法 namespace—无通用 invoke/send/on', () => {
    const api = createJingxuApi(vi.fn());
    expect(Object.keys(api).sort()).toEqual([
      'events',
      'image',
      'job',
      'project',
      'provider',
      'runtime',
      'script',
    ]);
    expect(Object.keys(api.job).sort()).toEqual(['cancel', 'create', 'get', 'list', 'retry']);
    expect(Object.keys(api.provider).sort()).toEqual([
      'deleteCredential',
      'getProfile',
      'saveCredential',
      'saveProfile',
      'testCredential',
    ]);
    expect(Object.keys(api.events)).toEqual(['subscribeJobUpdates']);
    for (const value of [api, api.job, api.provider, api.events]) {
      expect(Object.isFrozen(value)).toBe(true);
      for (const name of ['invoke', 'send', 'on']) expect(Reflect.has(value, name)).toBe(false);
    }
  });

  it('合法输入—逐方法—只调用固定 channel', async () => {
    const job = {
      errorCode: null,
      id: 'job_12345678',
      projectId: 'project_12345678',
      status: 'QUEUED',
      versionId: 'version_12345678',
    };
    const profile = {
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
    const invoke = vi.fn((channel: string) =>
      Promise.resolve({
        ok: true,
        data: channel.startsWith('provider.')
          ? profile
          : channel === EVENTS_IPC_CHANNELS.subscribeJobUpdates
            ? { subscriptionId: 'subscription_12345678' }
            : channel === JOB_IPC_CHANNELS.list
              ? [job]
              : job,
      }),
    );
    const api = createJingxuApi(invoke);
    const mutation = {
      expectedVersionId: 'version_12345678',
      requestId: 'request-123',
      jobId: job.id,
    };
    await api.job.cancel(mutation);
    await api.job.retry(mutation);
    const providerMutation = {
      expectedVersionId: 'version_12345678',
      profileId: 'profile_12345678',
      requestId: 'request-123',
    };
    await api.provider.testCredential(providerMutation);
    await api.provider.deleteCredential(providerMutation);
    await api.events.subscribeJobUpdates({ projectId: job.projectId });
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      JOB_IPC_CHANNELS.cancel,
      JOB_IPC_CHANNELS.retry,
      PROVIDER_IPC_CHANNELS.testCredential,
      PROVIDER_IPC_CHANNELS.deleteCredential,
      EVENTS_IPC_CHANNELS.subscribeJobUpdates,
    ]);
  });

  it('未知字段或缺并发字段—Preload strict 输入校验—invoke 零调用', async () => {
    const invoke = vi.fn();
    const api = createJingxuApi(invoke);
    await expect(
      api.job.cancel({ jobId: 'job_12345678', requestId: 'request-123' } as never),
    ).rejects.toThrow();
    await expect(
      api.provider.saveCredential({
        apiKey: 'secret',
        expectedVersionId: 'version_12345678',
        profileId: 'profile_12345678',
        requestId: 'request-123',
        sql: 'SELECT',
      } as never),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
