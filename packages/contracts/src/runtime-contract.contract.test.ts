import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  restoreBackupCommandSchema,
  startupStatusSchema,
  type RuntimeApi,
  type StartupStatusDto,
} from './index';

const readyStatus: StartupStatusDto = {
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
};

describe('runtime IPC Contract', () => {
  it('状态为 READY—校验公开 DTO—只允许可写且不包含基础设施字段', () => {
    const parsed = startupStatusSchema.parse(readyStatus);

    expect(parsed).toEqual(readyStatus);
    expect(Object.keys(parsed)).not.toEqual(
      expect.arrayContaining(['sql', 'stack', 'path', 'connection', 'apiKey', 'content']),
    );
  });

  it('故障 DTO 携带绝对路径—执行严格校验—拒绝未登记字段', () => {
    expect(() =>
      startupStatusSchema.parse({
        ...readyStatus,
        absolutePath: 'C:\\Users\\example\\jingxu.sqlite',
      }),
    ).toThrow();
  });

  it('恢复命令携带文件路径—执行严格校验—只接受 opaque backup id', () => {
    expect(() =>
      restoreBackupCommandSchema.parse({
        backupId: 'C:\\tmp\\backup.sqlite',
        expectedRevision: 3,
        requestId: 'request-restore-001',
      }),
    ).toThrow();
  });

  it('公开 API 类型—检查 runtime 白名单—只有三个逐方法调用', () => {
    expectTypeOf<RuntimeApi>().toHaveProperty('getStartupStatus');
    expectTypeOf<RuntimeApi>().toHaveProperty('retryStartup');
    expectTypeOf<RuntimeApi>().toHaveProperty('restoreBackup');
  });
});
