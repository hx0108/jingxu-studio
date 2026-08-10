import { createHash, randomUUID } from 'node:crypto';

import type {
  PersistenceCheckResult,
  PersistenceFailure,
  PersistenceRestoreResult,
  PersistenceRuntimePort,
  ProjectUnitOfWorkPort,
} from '@jingxu/application';
import {
  startupErrorCodeSchema,
  type BackupSummaryDto,
  type StartupErrorCode,
  type StartupPhase,
} from '@jingxu/contracts';

import { runDatabaseAudit } from '../audit/database-audit';
import { listVerifiedBackups, performManagedMigration } from '../backup/backup-manager';
import { loadMigrationSet } from '../migrations/migration-loader';
import { restoreManagedBackup } from '../recovery/recovery-manager';
import { SqliteProjectUnitOfWork } from '../project/sqlite-project-unit-of-work';
import { createManagedDirectories, createManagedPaths, type ManagedPaths } from './managed-paths';
import { PersistenceRuntimeError } from './persistence-error';
import { SqliteConnectionManager, type SqliteConnectionOptions } from './sqlite-connection';

export interface SqlitePersistenceRuntimeAdapterOptions {
  readonly clock: () => string;
  readonly createBackupId?: () => string;
  readonly managedRoot: string;
  readonly migrationDirectory: string;
  /** Testable connection boundary; production composition uses the strict default baseline. */
  readonly sqliteConnectionOptions?: SqliteConnectionOptions;
}

const SUMMARY_BY_CODE: Readonly<Record<StartupErrorCode, string>> = {
  BACKUP_NOT_ALLOWED: '所选备份不可用，请从受管理备份清单中重新选择。',
  DATABASE_BACKUP_FAILED: '数据库升级前备份失败，原数据库未执行迁移。',
  DATABASE_INVARIANT_FAILED: '数据库自检未通过，当前仅允许只读恢复操作。',
  DATABASE_OPEN_FAILED: '数据库无法打开，请检查本机存储后重试。',
  DATABASE_PRAGMA_FAILED: '数据库安全连接基线未能建立。',
  DATABASE_RESTORE_FAILED: '数据库恢复失败，当前数据与诊断证据已保留。',
  DATABASE_UNVERSIONED_SCHEMA: '检测到未受版本管理的数据库结构。',
  DATABASE_VERSION_TOO_NEW: '数据库版本高于当前应用支持范围。',
  MIGRATION_APPLY_FAILED: '数据库升级未能完成，变更已回滚。',
  MIGRATION_CHECKSUM_MISMATCH: '数据库迁移校验和与当前应用不一致。',
  MIGRATION_SEQUENCE_INVALID: '数据库迁移文件编号不连续或存在重复。',
  STARTUP_STATE_CONFLICT: '启动状态已经变化，请刷新后重试。',
};

const NON_RETRYABLE_CODES = new Set<StartupErrorCode>([
  'BACKUP_NOT_ALLOWED',
  'DATABASE_UNVERSIONED_SCHEMA',
  'DATABASE_VERSION_TOO_NEW',
  'MIGRATION_CHECKSUM_MISMATCH',
  'MIGRATION_SEQUENCE_INVALID',
]);

const fallbackCodeFor = (phase: StartupPhase): StartupErrorCode => {
  switch (phase) {
    case 'DATABASE_OPEN':
      return 'DATABASE_OPEN_FAILED';
    case 'CONNECTION_BASELINE':
      return 'DATABASE_PRAGMA_FAILED';
    case 'MIGRATION':
      return 'MIGRATION_APPLY_FAILED';
    case 'DATABASE_AUDIT':
      return 'DATABASE_INVARIANT_FAILED';
    case 'RECOVERY_GATE':
      return 'DATABASE_RESTORE_FAILED';
  }
};

const normalizeErrorCode = (error: unknown, phase: StartupPhase): StartupErrorCode => {
  if (error instanceof PersistenceRuntimeError) {
    const parsed = startupErrorCodeSchema.safeParse(error.code);
    if (parsed.success) return parsed.data;
  }
  return fallbackCodeFor(phase);
};

const phaseForErrorCode = (errorCode: StartupErrorCode, fallback: StartupPhase): StartupPhase => {
  switch (errorCode) {
    case 'DATABASE_OPEN_FAILED':
      return 'DATABASE_OPEN';
    case 'DATABASE_PRAGMA_FAILED':
      return 'CONNECTION_BASELINE';
    case 'DATABASE_BACKUP_FAILED':
    case 'DATABASE_UNVERSIONED_SCHEMA':
    case 'DATABASE_VERSION_TOO_NEW':
    case 'MIGRATION_APPLY_FAILED':
    case 'MIGRATION_CHECKSUM_MISMATCH':
    case 'MIGRATION_SEQUENCE_INVALID':
      return 'MIGRATION';
    case 'DATABASE_INVARIANT_FAILED':
      return 'DATABASE_AUDIT';
    case 'BACKUP_NOT_ALLOWED':
    case 'DATABASE_RESTORE_FAILED':
      return 'RECOVERY_GATE';
    case 'STARTUP_STATE_CONFLICT':
      return fallback;
  }
};

/** Maps infrastructure failures to a stable, redacted Application failure. */
export const toPersistenceFailure = (
  error: unknown,
  phase: StartupPhase,
  backups: readonly BackupSummaryDto[],
): PersistenceFailure => {
  const errorCode = normalizeErrorCode(error, phase);
  const retryable = !NON_RETRYABLE_CODES.has(errorCode);
  return {
    allowedActions: [
      ...(retryable ? (['RETRY'] as const) : []),
      ...(backups.length > 0 ? (['RESTORE'] as const) : []),
    ],
    backups: [...backups],
    errorCode,
    phase: phaseForErrorCode(errorCode, phase),
    retryable,
    summary: SUMMARY_BY_CODE[errorCode],
  };
};

const restoreOperationId = (requestId: string): string =>
  `restore_${createHash('sha256').update(requestId).digest('hex').slice(0, 24)}`;

export class SqlitePersistenceRuntimeAdapter implements PersistenceRuntimePort {
  readonly #clock: () => string;
  readonly #createBackupId: () => string;
  readonly #manager: SqliteConnectionManager;
  readonly #migrationDirectory: string;
  readonly #paths: ManagedPaths;
  #operationTail: Promise<void> = Promise.resolve();
  #projectUnitOfWork: ProjectUnitOfWorkPort | null = null;

  public constructor({
    clock,
    createBackupId = () => `backup_${randomUUID().replaceAll('-', '')}`,
    managedRoot,
    migrationDirectory,
    sqliteConnectionOptions,
  }: SqlitePersistenceRuntimeAdapterOptions) {
    this.#clock = clock;
    this.#createBackupId = createBackupId;
    this.#migrationDirectory = migrationDirectory;
    this.#paths = createManagedPaths(managedRoot);
    this.#manager = new SqliteConnectionManager(this.#paths.databasePath, sqliteConnectionOptions);
  }

  public close(): void {
    this.#projectUnitOfWork = null;
    this.#manager.close();
  }

  /** Returns the single Project UnitOfWork only after the startup audit reached READY. */
  public getProjectUnitOfWork(): ProjectUnitOfWorkPort | null {
    return this.#projectUnitOfWork;
  }

  public prepare(): Promise<PersistenceCheckResult> {
    return this.#runExclusive(async () => this.#prepareUnsafe());
  }

  public restoreBackup(backupId: string, operationId: string): Promise<PersistenceRestoreResult> {
    return this.#runExclusive(async () => {
      try {
        await restoreManagedBackup({
          backupId,
          connectionManager: this.#manager,
          operationId: restoreOperationId(operationId),
          paths: this.#paths,
        });
        const check = await this.#prepareUnsafe();
        if (!check.ok) {
          return {
            failure: toPersistenceFailure(
              new PersistenceRuntimeError('DATABASE_RESTORE_FAILED'),
              'RECOVERY_GATE',
              check.failure.backups,
            ),
            ok: false,
          };
        }
        return { ok: true };
      } catch (error) {
        const backups = await this.#listBackupsWithoutThrowing();
        return {
          failure: toPersistenceFailure(error, 'RECOVERY_GATE', backups),
          ok: false,
        };
      }
    });
  }

  async #listBackupsWithoutThrowing(): Promise<readonly BackupSummaryDto[]> {
    try {
      return await listVerifiedBackups(this.#paths);
    } catch {
      return [];
    }
  }

  async #prepareUnsafe(): Promise<PersistenceCheckResult> {
    const completedPhases: StartupPhase[] = [];
    let phase: StartupPhase = 'DATABASE_OPEN';
    try {
      await createManagedDirectories(this.#paths);
      const migrations = await loadMigrationSet(this.#migrationDirectory);
      const database = this.#manager.open();
      completedPhases.push('DATABASE_OPEN', 'CONNECTION_BASELINE');

      phase = 'MIGRATION';
      await performManagedMigration({
        backupId: this.#createBackupId(),
        clock: this.#clock,
        database,
        migrations,
        paths: this.#paths,
      });
      completedPhases.push('MIGRATION');

      phase = 'DATABASE_AUDIT';
      const audit = runDatabaseAudit(database);
      if (!audit.ok) throw new PersistenceRuntimeError('DATABASE_INVARIANT_FAILED');
      completedPhases.push('DATABASE_AUDIT');

      phase = 'RECOVERY_GATE';
      const backups = await listVerifiedBackups(this.#paths);
      this.#projectUnitOfWork ??= new SqliteProjectUnitOfWork(database);
      completedPhases.push('RECOVERY_GATE');
      return { backups, completedPhases, ok: true };
    } catch (error) {
      this.#projectUnitOfWork = null;
      this.#manager.close();
      const backups = await this.#listBackupsWithoutThrowing();
      return {
        completedPhases,
        failure: toPersistenceFailure(error, phase, backups),
        ok: false,
      };
    }
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
