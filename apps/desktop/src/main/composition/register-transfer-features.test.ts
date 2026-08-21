import { describe, expect, it, vi } from 'vitest';

import { TRANSFER_IPC_CHANNELS } from '@jingxu/contracts';
import type { IpcEvent } from '../ipc/ipc-boundary';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';
import { createTransferFeatureRegistration } from './register-transfer-features';

const trustedEvent = (): IpcEvent => {
  const frame = { url: 'jingxu://app/index.html' };
  return { sender: { mainFrame: frame }, senderFrame: frame };
};

const createHarness = (writeEnabled: boolean, transferAvailable = true) => {
  const handlers = new Map<
    string,
    (event: IpcEvent, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  // run 真正回调 work；transfer.findExportByRequestId 空（无重放）、
  // projects.findById 返回 null → 确定性 PROJECT_NOT_FOUND。
  const unitOfWork = {
    run: vi.fn(
      (
        work: (repositories: {
          projects: { findById: () => Promise<null> };
          transfer: { findExportByRequestId: () => Promise<null> };
        }) => unknown,
      ) =>
        work({
          projects: { findById: () => Promise.resolve(null) },
          transfer: { findExportByRequestId: () => Promise.resolve(null) },
        }),
    ),
  };
  const registry = { schemaIds: [], validate: vi.fn() };
  const file = { readSelectedJson: vi.fn(), writeJsonAtomically: vi.fn() };
  let ready = writeEnabled;
  const runtime = {
    getSchemaRegistry: () => (transferAvailable ? registry : null),
    getTransferUnitOfWork: () => (transferAvailable ? unitOfWork : null),
    startupService: { getStatus: () => ({ writeEnabled: ready }) },
  } as unknown as DesktopPersistenceRuntime;
  const registration = createTransferFeatureRegistration({
    file,
    ipcRegistrar: {
      handle: (channel, listener) => handlers.set(channel, listener),
    },
    newTraceId: () => 'trace-00000001',
    persistenceRuntime: runtime,
    trustedUrl: 'jingxu://app/index.html',
  });
  return {
    channels: [...handlers.keys()],
    file,
    handlers,
    ready,
    registration,
    registry,
    setReady: (value: boolean) => {
      ready = value;
    },
    unitOfWork,
  };
};

const exportInput = {
  episodeId: 'episode_12345678',
  expectedVersionId: 'ev_1234567890',
  overwriteConfirmed: false,
  projectId: 'project_12345678',
  requestId: 'request_export_1',
};

describe('createTransferFeatureRegistration', () => {
  it('条件—READY 且 Transfer Runtime 可用—只注册两个 transfer.* 频道且激活后委托真实 Service', async () => {
    const harness = createHarness(true);
    // 激活前：门已 READY 但 Service 未注入，blocked facade 兜底。
    const before = await harness.handlers.get(TRANSFER_IPC_CHANNELS.exportProject)?.(
      trustedEvent(),
      exportInput,
    );
    expect(before).toMatchObject({ error: { code: 'STARTUP_WRITE_BLOCKED' }, ok: false });

    expect(harness.registration.ensureRegistered()).toBe(true);
    expect(harness.registration.ensureRegistered()).toBe(false);
    expect(harness.channels.sort()).toEqual(Object.values(TRANSFER_IPC_CHANNELS).sort());
    expect(harness.channels.every((channel) => channel.startsWith('transfer.'))).toBe(true);

    // 激活后走真实 application Service（读事务组装在桩 UoW 上得到确定性拒绝）。
    const after = await harness.handlers.get(TRANSFER_IPC_CHANNELS.exportProject)?.(
      trustedEvent(),
      exportInput,
    );
    expect(after).toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' }, ok: false });
    expect(harness.unitOfWork.run).toHaveBeenCalled();
  });

  it.each([
    ['启动未 READY', false, true],
    ['Transfer Runtime 不可用', true, false],
  ])('条件—%s—ensureRegistered 返回 false 且门保持阻断', async (_label, ready, available) => {
    const harness = createHarness(ready, available);
    expect(harness.registration.ensureRegistered()).toBe(false);
    const result = await harness.handlers.get(TRANSFER_IPC_CHANNELS.importProject)?.(
      trustedEvent(),
      {
        importMode: 'NEW_PROJECT',
        requestId: 'request_import_1',
      },
    );
    expect(result).toMatchObject({ error: { code: 'STARTUP_WRITE_BLOCKED' }, ok: false });
    expect(harness.unitOfWork.run).not.toHaveBeenCalled();
  });
});
