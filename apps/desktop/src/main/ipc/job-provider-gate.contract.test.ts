import { describe, expect, it, vi } from 'vitest';
import { JOB_IPC_CHANNELS, PROVIDER_IPC_CHANNELS } from '@jingxu/contracts';
import { registerJobProviderGate, StartupJobRecoveryGate } from './job-provider-gate';

const trustedEvent = () => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};
const mutation = { expectedVersionId: 'version_12345678', requestId: 'request-123' };

describe('Job Provider 启动门 Contract', () => {
  it('非 READY—调用七个写命令—统一阻断且真实 Service 工厂零构造', async () => {
    const handlers = new Map<
      string,
      (event: ReturnType<typeof trustedEvent>, input: unknown) => Promise<unknown>
    >();
    const createService = vi.fn(() => ({ invoke: vi.fn() }));
    registerJobProviderGate(
      { handle: (channel, listener) => handlers.set(channel, listener) },
      { isWriteReady: () => false },
      createService,
      'jingxu://app/index.html',
    );
    const commands = [
      [
        JOB_IPC_CHANNELS.create,
        {
          episodeId: null,
          expectedInputVersionId: 'source_12345678',
          idempotencyKey: 'idem-12345',
          operationType: 'GENERATE',
          projectId: 'project_12345678',
          requestId: 'request-123',
          stage: 'CONCEPT',
        },
      ],
      [JOB_IPC_CHANNELS.cancel, { ...mutation, jobId: 'job_12345678' }],
      [JOB_IPC_CHANNELS.retry, { ...mutation, jobId: 'job_12345678' }],
      [
        PROVIDER_IPC_CHANNELS.saveProfile,
        { ...mutation, enabled: true, profileId: 'profile_12345678', workspaceId: 'workspace-1' },
      ],
      [
        PROVIDER_IPC_CHANNELS.saveCredential,
        { ...mutation, apiKey: 'secret', profileId: 'profile_12345678' },
      ],
      [PROVIDER_IPC_CHANNELS.testCredential, { ...mutation, profileId: 'profile_12345678' }],
      [PROVIDER_IPC_CHANNELS.deleteCredential, { ...mutation, profileId: 'profile_12345678' }],
    ] as const;
    for (const [channel, input] of commands) {
      await expect(handlers.get(channel)?.(trustedEvent(), input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'STARTUP_WRITE_BLOCKED' },
      });
    }
    expect(createService).not.toHaveBeenCalled();
  });

  it('READY 前—激活恢复—不构造恢复器、不扫描、不调用 Provider', async () => {
    let ready = false;
    const providerCall = vi.fn();
    const recover = vi.fn(() => Promise.resolve());
    const createRecovery = vi.fn(() => ({
      recover: async () => {
        await recover();
        providerCall();
      },
    }));
    const gate = new StartupJobRecoveryGate({ isWriteReady: () => ready }, createRecovery);
    await expect(gate.activate()).resolves.toBe(false);
    expect(createRecovery).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(providerCall).not.toHaveBeenCalled();
    ready = true;
    await expect(gate.activate()).resolves.toBe(true);
    expect(createRecovery).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(providerCall).toHaveBeenCalledOnce();
    await expect(gate.activate()).resolves.toBe(false);
  });
});
