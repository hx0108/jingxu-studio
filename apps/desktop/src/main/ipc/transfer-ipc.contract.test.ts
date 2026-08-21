import { describe, expect, it, vi } from 'vitest';

import { TRANSFER_IPC_CHANNELS } from '@jingxu/contracts';

import { registerTransferIpc, type TransferIpcRegistrar } from './transfer-ipc';
import type { IpcEvent } from './ipc-boundary';

describe('transfer ipc boundary', () => {
  it('registers exactly two channels and blocks before READY', () => {
    const listeners = new Map<
      string,
      (event: IpcEvent, ...args: readonly unknown[]) => Promise<unknown>
    >();
    const registrar: TransferIpcRegistrar = {
      handle: (channel, listener) => listeners.set(channel, listener),
    };
    registerTransferIpc(
      registrar,
      { exportProject: vi.fn(), importProject: vi.fn() },
      { isWriteReady: () => false },
      'app://jingxu',
      () => 'trace_1',
    );
    expect([...listeners.keys()]).toEqual([
      TRANSFER_IPC_CHANNELS.exportProject,
      TRANSFER_IPC_CHANNELS.importProject,
    ]);
  });
});
