import type { StartupService } from '@jingxu/application';
import type { StartupStatusDto } from '@jingxu/contracts';
import { describe, expect, it, vi } from 'vitest';

import { registerRuntimeIpc, RUNTIME_IPC_CHANNELS, type RuntimeIpcEvent } from './runtime-ipc';

const readyStatus: StartupStatusDto = {
  allowedActions: [],
  backups: [],
  completedPhases: [
    'DATABASE_OPEN',
    'CONNECTION_BASELINE',
    'MIGRATION',
    'DATABASE_AUDIT',
    'RECOVERY_GATE',
    'SCHEMA_REGISTRY',
  ],
  currentPhase: null,
  errorCode: null,
  retryable: false,
  revision: 2,
  state: 'READY',
  summary: null,
  writeEnabled: true,
};

const createHarness = (status: StartupStatusDto = readyStatus) => {
  const handlers = new Map<
    string,
    (event: RuntimeIpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const getStatus = vi.fn(() => status);
  const restoreBackup = vi.fn(() => Promise.resolve(status));
  const retryStartup = vi.fn(() => Promise.resolve(status));
  const onStatusChanged = vi.fn();
  const service = {
    getStatus,
    restoreBackup,
    retryStartup,
  } as unknown as StartupService;
  registerRuntimeIpc(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    service,
    'jingxu://app/index.html',
    onStatusChanged,
  );
  return { handlers, onStatusChanged, serviceCalls: { getStatus, restoreBackup, retryStartup } };
};

const trustedEvent = (): RuntimeIpcEvent => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

describe('runtime IPC Contract', () => {
  it('注册 runtime Host—检查频道—只有三条固定白名单', () => {
    const { handlers } = createHarness();

    expect([...handlers.keys()].sort()).toEqual(Object.values(RUNTIME_IPC_CHANNELS).sort());
  });

  it('受信主 frame 调用—校验 DTO—逐方法委托 StartupService 并校验返回状态', async () => {
    const { handlers, onStatusChanged, serviceCalls } = createHarness();
    const retryCommand = { expectedRevision: 2, requestId: 'request-retry-0001' };
    const restoreCommand = {
      backupId: 'backup_12345678',
      expectedRevision: 2,
      requestId: 'request-restore-0001',
    };

    await expect(
      handlers.get(RUNTIME_IPC_CHANNELS.getStartupStatus)?.(trustedEvent()),
    ).resolves.toEqual(readyStatus);
    await expect(
      handlers.get(RUNTIME_IPC_CHANNELS.retryStartup)?.(trustedEvent(), retryCommand),
    ).resolves.toEqual(readyStatus);
    await expect(
      handlers.get(RUNTIME_IPC_CHANNELS.restoreBackup)?.(trustedEvent(), restoreCommand),
    ).resolves.toEqual(readyStatus);
    expect(serviceCalls.retryStartup).toHaveBeenCalledWith(retryCommand);
    expect(serviceCalls.restoreBackup).toHaveBeenCalledWith(restoreCommand);
    expect(onStatusChanged).toHaveBeenCalledTimes(2);
  });

  it('Schema 阶段故障—读取状态—仅透传稳定阶段、错误码与脱敏摘要', async () => {
    const schemaFault: StartupStatusDto = {
      allowedActions: ['RETRY'],
      backups: [],
      completedPhases: readyStatus.completedPhases.filter((phase) => phase !== 'SCHEMA_REGISTRY'),
      currentPhase: 'SCHEMA_REGISTRY',
      errorCode: 'SCHEMA_HASH_MISMATCH',
      retryable: true,
      revision: 3,
      state: 'READ_ONLY_FAULT',
      summary: 'Schema 资源完整性检查未通过，请修复资源后重试。',
      writeEnabled: false,
    };
    const { handlers } = createHarness(schemaFault);

    await expect(
      handlers.get(RUNTIME_IPC_CHANNELS.getStartupStatus)?.(trustedEvent()),
    ).resolves.toEqual(schemaFault);
  });

  it('非主 frame、非受信来源或多余参数—调用 runtime Host—先拒绝且不触发服务', async () => {
    const { handlers, serviceCalls } = createHarness();
    const childFrame = { url: 'jingxu://app/index.html' };
    const mainFrame = { url: 'jingxu://app/index.html' };
    const invalidEvents: RuntimeIpcEvent[] = [
      { sender: { mainFrame }, senderFrame: childFrame },
      {
        sender: { mainFrame: { url: 'https://evil.example/' } },
        senderFrame: { url: 'https://evil.example/' },
      },
    ];

    for (const event of invalidEvents) {
      await expect(
        Promise.resolve().then(() => handlers.get(RUNTIME_IPC_CHANNELS.getStartupStatus)?.(event)),
      ).rejects.toThrow('IPC_SENDER_NOT_ALLOWED');
    }
    await expect(
      Promise.resolve().then(() =>
        handlers.get(RUNTIME_IPC_CHANNELS.retryStartup)?.(trustedEvent(), {
          expectedRevision: 2,
          extra: 'not allowed',
          requestId: 'request-retry-0001',
        }),
      ),
    ).rejects.toThrow('IPC_INVALID_REQUEST');
    await expect(
      Promise.resolve().then(() =>
        handlers.get(RUNTIME_IPC_CHANNELS.retryStartup)?.(trustedEvent(), {
          expectedRevision: -1,
          requestId: 'short',
        }),
      ),
    ).rejects.toThrow('IPC_INVALID_REQUEST');
    await expect(
      Promise.resolve().then(() =>
        handlers.get(RUNTIME_IPC_CHANNELS.getStartupStatus)?.(trustedEvent(), 'extra'),
      ),
    ).rejects.toThrow('IPC_INVALID_REQUEST');
    expect(serviceCalls.getStatus).not.toHaveBeenCalled();
    expect(serviceCalls.retryStartup).not.toHaveBeenCalled();
  });
});
