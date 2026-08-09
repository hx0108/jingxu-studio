import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { JingxuApi } from '@jingxu/contracts';

import { createJingxuApi, RUNTIME_IPC_CHANNELS } from './jingxu-api';

describe('window.jingxu 白名单 Contract', () => {
  it('SQLite runtime Change—创建公开 API—只得到冻结的 runtime 三方法白名单', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        allowedActions: [],
        backups: [],
        completedPhases: [
          'DATABASE_OPEN',
          'CONNECTION_BASELINE',
          'MIGRATION',
          'DATABASE_AUDIT',
          'RECOVERY_GATE',
        ],
        currentPhase: null,
        errorCode: null,
        retryable: false,
        revision: 2,
        state: 'READY',
        summary: null,
        writeEnabled: true,
      }),
    );
    const api = createJingxuApi(invoke);

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.runtime)).toBe(true);
    expect(Object.isFrozen(api.project)).toBe(true);
    expect(Object.keys(api)).toEqual(['runtime', 'project']);
    expect(Object.keys(api.runtime).sort()).toEqual([
      'getStartupStatus',
      'restoreBackup',
      'retryStartup',
    ]);
    expectTypeOf(api).toEqualTypeOf<JingxuApi>();

    const retry = { expectedRevision: 1, requestId: 'request-retry-0001' };
    const restore = {
      backupId: 'backup_12345678',
      expectedRevision: 1,
      requestId: 'request-restore-0001',
    };
    await api.runtime.getStartupStatus();
    await api.runtime.retryStartup(retry);
    await api.runtime.restoreBackup(restore);
    expect(invoke.mock.calls).toEqual([
      [RUNTIME_IPC_CHANNELS.getStartupStatus],
      [RUNTIME_IPC_CHANNELS.retryStartup, retry],
      [RUNTIME_IPC_CHANNELS.restoreBackup, restore],
    ]);
  });

  it.each(['send', 'on', 'once', 'invoke'])(
    '检查 %s—Preload 与 runtime 命名空间均不提供通用频道入口',
    (methodName) => {
      const api = createJingxuApi(vi.fn());
      expect(Reflect.has(api, methodName)).toBe(false);
      expect(Reflect.has(api.runtime, methodName)).toBe(false);
    },
  );
});
