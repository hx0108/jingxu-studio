import type { StartupErrorCode, StartupPhase } from '@jingxu/contracts';
import { describe, expect, it } from 'vitest';

import { PersistenceRuntimeError } from './persistence-error';
import { toPersistenceFailure } from './persistence-runtime-adapter';

const ERROR_CASES: readonly (readonly [StartupErrorCode, StartupPhase])[] = [
  ['DATABASE_OPEN_FAILED', 'DATABASE_OPEN'],
  ['DATABASE_PRAGMA_FAILED', 'CONNECTION_BASELINE'],
  ['MIGRATION_SEQUENCE_INVALID', 'MIGRATION'],
  ['MIGRATION_CHECKSUM_MISMATCH', 'MIGRATION'],
  ['DATABASE_UNVERSIONED_SCHEMA', 'MIGRATION'],
  ['DATABASE_VERSION_TOO_NEW', 'MIGRATION'],
  ['DATABASE_BACKUP_FAILED', 'MIGRATION'],
  ['MIGRATION_APPLY_FAILED', 'MIGRATION'],
  ['DATABASE_INVARIANT_FAILED', 'DATABASE_AUDIT'],
  ['BACKUP_NOT_ALLOWED', 'RECOVERY_GATE'],
  ['DATABASE_RESTORE_FAILED', 'RECOVERY_GATE'],
  ['STARTUP_STATE_CONFLICT', 'RECOVERY_GATE'],
];

describe('Persistence runtime 错误映射', () => {
  it.each(ERROR_CASES)('%s—映射公开失败—保留稳定错误码与正确阶段', (errorCode, phase) => {
    const failure = toPersistenceFailure(
      new PersistenceRuntimeError(errorCode),
      'RECOVERY_GATE',
      [],
    );

    expect(failure).toMatchObject({ errorCode, phase });
    expect(failure.summary.length).toBeGreaterThan(0);
  });

  it('原始异常含 SQL、路径与堆栈—映射公开失败—DTO 不泄漏原始细节', () => {
    const raw = new Error('SELECT * FROM secret at C:\\Users\\person\\private.sqlite');
    raw.stack = `Error: leaked\n at C:\\source\\database.ts:1:1`;

    const failure = toPersistenceFailure(raw, 'MIGRATION', []);
    const serialized = JSON.stringify(failure);

    expect(failure.errorCode).toBe('MIGRATION_APPLY_FAILED');
    expect(serialized).not.toContain('SELECT');
    expect(serialized).not.toContain('private.sqlite');
    expect(serialized).not.toContain('database.ts');
  });
});
