import { describe, expect, it } from 'vitest';

import type {
  PersistenceCheckResult,
  PersistenceRestoreResult,
  PersistenceRuntimePort,
} from '../ports/persistence/persistence-runtime-port';
import { StartupService } from './startup-service';
import { StartupStateMachine } from './startup-state-machine';

const READY_RESULT: PersistenceCheckResult = {
  backups: [],
  completedPhases: [
    'DATABASE_OPEN',
    'CONNECTION_BASELINE',
    'MIGRATION',
    'DATABASE_AUDIT',
    'RECOVERY_GATE',
  ],
  ok: true,
};

class FakePersistenceRuntime implements PersistenceRuntimePort {
  public closeCalls = 0;
  public prepareCalls = 0;
  public restoreCalls = 0;
  public prepareResult: PersistenceCheckResult = READY_RESULT;
  public restoreResult: PersistenceRestoreResult = { ok: true };
  public waitForPrepare: Promise<void> = Promise.resolve();

  public close(): void {
    this.closeCalls += 1;
  }

  public async prepare(): Promise<PersistenceCheckResult> {
    this.prepareCalls += 1;
    await this.waitForPrepare;
    return this.prepareResult;
  }

  public restoreBackup(): Promise<PersistenceRestoreResult> {
    this.restoreCalls += 1;
    return Promise.resolve(this.restoreResult);
  }
}

const faultResult = (): PersistenceCheckResult => ({
  completedPhases: ['DATABASE_OPEN'],
  failure: {
    allowedActions: ['RETRY', 'RESTORE'],
    backups: [],
    errorCode: 'DATABASE_INVARIANT_FAILED',
    phase: 'DATABASE_AUDIT',
    retryable: true,
    summary: '数据库检查未通过。',
  },
  ok: false,
});

describe('StartupStateMachine', () => {
  it('合法转换—推进状态—revision 单调增加且仅 READY 打开写入门', () => {
    const machine = new StartupStateMachine();
    const booting = {
      allowedActions: [],
      backups: [],
      completedPhases: [],
      currentPhase: null,
      errorCode: null,
      retryable: false,
      revision: 0,
      state: 'BOOTING' as const,
      summary: null,
      writeEnabled: false,
    };

    const checking = machine.transition(booting, 'CHECKING');
    const ready = machine.transition(checking, 'READY');

    expect(checking).toMatchObject({ revision: 1, state: 'CHECKING', writeEnabled: false });
    expect(ready).toMatchObject({ revision: 2, state: 'READY', writeEnabled: true });
  });

  it('终态 READY—尝试回退—拒绝非法转换', () => {
    const machine = new StartupStateMachine();
    const ready = {
      allowedActions: [],
      backups: [],
      completedPhases: [],
      currentPhase: null,
      errorCode: null,
      retryable: false,
      revision: 2,
      state: 'READY' as const,
      summary: null,
      writeEnabled: true,
    };

    expect(() => machine.transition(ready, 'CHECKING')).toThrow('非法启动状态转换');
  });
});

describe('StartupService', () => {
  it('完整检查成功—启动服务—进入 READY 且写入门打开', async () => {
    const port = new FakePersistenceRuntime();
    const service = new StartupService(port);

    await expect(service.start()).resolves.toMatchObject({
      revision: 2,
      state: 'READY',
      writeEnabled: true,
    });
    expect(port.prepareCalls).toBe(1);
  });

  it('检查失败后重试—使用相同 requestId—只执行一次持久化检查', async () => {
    const port = new FakePersistenceRuntime();
    port.prepareResult = faultResult();
    const service = new StartupService(port);
    const fault = await service.start();
    port.prepareResult = READY_RESULT;
    const command = { expectedRevision: fault.revision, requestId: 'request-retry-001' };

    const [first, duplicate] = await Promise.all([
      service.retryStartup(command),
      service.retryStartup(command),
    ]);

    expect(first).toEqual(duplicate);
    expect(first.state).toBe('READY');
    expect(port.prepareCalls).toBe(2);
  });

  it('命令使用过期 revision—请求重试—返回冲突且不执行检查', async () => {
    const port = new FakePersistenceRuntime();
    port.prepareResult = faultResult();
    const service = new StartupService(port);
    await service.start();

    await expect(
      service.retryStartup({ expectedRevision: 0, requestId: 'request-stale-001' }),
    ).resolves.toMatchObject({ errorCode: 'STARTUP_STATE_CONFLICT', retryable: true });
    expect(port.prepareCalls).toBe(1);
  });

  it('恢复与重试同时提交—串行化操作—不会并行执行持久化流程', async () => {
    const port = new FakePersistenceRuntime();
    port.prepareResult = faultResult();
    const service = new StartupService(port);
    const fault = await service.start();

    const restore = service.restoreBackup({
      backupId: 'backup_12345678',
      expectedRevision: fault.revision,
      requestId: 'request-restore-001',
    });
    const retry = service.retryStartup({
      expectedRevision: fault.revision,
      requestId: 'request-retry-002',
    });

    const [restored, retried] = await Promise.all([restore, retry]);
    expect(restored.state).toBe('READ_ONLY_FAULT');
    expect(retried.errorCode).toBe('STARTUP_STATE_CONFLICT');
    expect(port.restoreCalls).toBe(1);
  });
});
