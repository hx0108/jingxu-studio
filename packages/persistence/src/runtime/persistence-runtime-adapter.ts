import { createHash, randomUUID } from 'node:crypto';

import type {
  FormatProfileRepository,
  JobRepositoryPort,
  JobUnitOfWorkPort,
  MediaUnitOfWorkPort,
  PersistenceCheckResult,
  PersistenceFailure,
  PersistenceRestoreResult,
  PersistenceRuntimePort,
  ProjectUnitOfWorkPort,
  ProviderProfileRepositoryPort,
  ProviderUnitOfWorkPort,
  SchemaManifestUnitOfWorkPort,
  ScriptUnitOfWorkPort,
  ScriptWorkspaceQueryPort,
  TransferUnitOfWorkPort,
} from '@jingxu/application';
import {
  startupErrorCodeSchema,
  type BackupSummaryDto,
  type StartupErrorCode,
  type StartupPhase,
} from '@jingxu/contracts';

import { runDatabaseAudit } from '../audit/database-audit';
import { listVerifiedBackups, performManagedMigration } from '../backup/backup-manager';
import { SqliteMediaUnitOfWork } from '../media/sqlite-media-unit-of-work';
import { loadMigrationSet } from '../migrations/migration-loader';
import { restoreManagedBackup } from '../recovery/recovery-manager';
import { SqliteJobRepository } from '../job/sqlite-job-repository';
import { SqliteJobUnitOfWork } from '../job/sqlite-job-unit-of-work';
import { SqliteFormatProfileRepository } from '../project/sqlite-format-profile-repository';
import { SqliteProjectUnitOfWork } from '../project/sqlite-project-unit-of-work';
import { SqliteProviderProfileRepository } from '../provider/sqlite-provider-profile-repository';
import { SqliteProviderUnitOfWork } from '../provider/sqlite-provider-unit-of-work';
import { SqliteSchemaManifestUnitOfWork } from '../schema-manifest/sqlite-schema-manifest-unit-of-work';
import { SqliteScriptUnitOfWork } from '../script/sqlite-script-unit-of-work';
import { SqliteScriptWorkspaceQuery } from '../script/sqlite-script-workspace-query';
import { SqliteTransferUnitOfWork } from '../transfer/sqlite-transfer-unit-of-work';
import { createManagedDirectories, createManagedPaths, type ManagedPaths } from './managed-paths';
import { PersistenceRuntimeError } from './persistence-error';
import { SqliteConnectionManager, type SqliteConnectionOptions } from './sqlite-connection';
import { SqliteTransactionCoordinator } from './sqlite-transaction-coordinator';

export interface SqlitePersistenceRuntimeAdapterOptions {
  readonly clock: () => string;
  readonly createBackupId?: () => string;
  readonly managedRoot: string;
  readonly migrationDirectory: string;
  /** Testable connection boundary; production composition uses the strict default baseline. */
  readonly sqliteConnectionOptions?: SqliteConnectionOptions;
}

type PersistenceStartupErrorCode = Exclude<StartupErrorCode, `SCHEMA_${string}`>;
type PersistenceStartupPhase = Exclude<StartupPhase, 'SCHEMA_REGISTRY'>;

const SUMMARY_BY_CODE: Readonly<Record<PersistenceStartupErrorCode, string>> = {
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

const NON_RETRYABLE_CODES = new Set<PersistenceStartupErrorCode>([
  'BACKUP_NOT_ALLOWED',
  'DATABASE_UNVERSIONED_SCHEMA',
  'DATABASE_VERSION_TOO_NEW',
  'MIGRATION_CHECKSUM_MISMATCH',
  'MIGRATION_SEQUENCE_INVALID',
]);

const fallbackCodeFor = (phase: PersistenceStartupPhase): PersistenceStartupErrorCode => {
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

const normalizeErrorCode = (
  error: unknown,
  phase: PersistenceStartupPhase,
): PersistenceStartupErrorCode => {
  if (error instanceof PersistenceRuntimeError) {
    const parsed = startupErrorCodeSchema.safeParse(error.code);
    if (parsed.success && !parsed.data.startsWith('SCHEMA_')) {
      return parsed.data as PersistenceStartupErrorCode;
    }
  }
  return fallbackCodeFor(phase);
};

const phaseForErrorCode = (
  errorCode: PersistenceStartupErrorCode,
  fallback: PersistenceStartupPhase,
): PersistenceStartupPhase => {
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
  phase: PersistenceStartupPhase,
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
  #formatProfileRepository: FormatProfileRepository | null = null;
  #projectUnitOfWork: ProjectUnitOfWorkPort | null = null;
  #schemaManifestUnitOfWork: SchemaManifestUnitOfWorkPort | null = null;
  #jobUnitOfWork: JobUnitOfWorkPort | null = null;
  #jobRepository: JobRepositoryPort | null = null;
  #providerUnitOfWork: ProviderUnitOfWorkPort | null = null;
  #providerProfileRepository: ProviderProfileRepositoryPort | null = null;
  #scriptUnitOfWork: ScriptUnitOfWorkPort | null = null;
  #scriptWorkspaceQuery: ScriptWorkspaceQueryPort | null = null;
  #transferUnitOfWork: TransferUnitOfWorkPort | null = null;
  #mediaUnitOfWork: MediaUnitOfWorkPort | null = null;
  #transactionCoordinator: SqliteTransactionCoordinator | null = null;

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
    this.#formatProfileRepository = null;
    this.#projectUnitOfWork = null;
    this.#schemaManifestUnitOfWork = null;
    this.#jobUnitOfWork = null;
    this.#jobRepository = null;
    this.#providerUnitOfWork = null;
    this.#providerProfileRepository = null;
    this.#scriptUnitOfWork = null;
    this.#scriptWorkspaceQuery = null;
    this.#transferUnitOfWork = null;
    this.#mediaUnitOfWork = null;
    this.#transactionCoordinator = null;
    this.#manager.close();
  }

  /** Returns a standalone read-only FormatProfile repository over the audited write connection. */
  public getFormatProfileRepository(): FormatProfileRepository | null {
    return this.#formatProfileRepository;
  }

  /** Returns the single Project UnitOfWork only after the startup audit reached READY. */
  public getProjectUnitOfWork(): ProjectUnitOfWorkPort | null {
    return this.#projectUnitOfWork;
  }

  /** Returns the Schema manifest UnitOfWork backed by the same audited write connection. */
  public getSchemaManifestUnitOfWork(): SchemaManifestUnitOfWorkPort | null {
    return this.#schemaManifestUnitOfWork;
  }

  /** Returns the Job UnitOfWork only after the startup audit reached READY. */
  public getJobUnitOfWork(): JobUnitOfWorkPort | null {
    return this.#jobUnitOfWork;
  }

  /** Returns a standalone Job read Repository over the same audited write connection. */
  public getJobRepository(): JobRepositoryPort | null {
    return this.#jobRepository;
  }

  /** Returns the Provider UnitOfWork only after the startup audit reached READY. */
  public getProviderUnitOfWork(): ProviderUnitOfWorkPort | null {
    return this.#providerUnitOfWork;
  }

  /** Returns a standalone Provider profile read Repository over the same audited write connection. */
  public getProviderProfileRepository(): ProviderProfileRepositoryPort | null {
    return this.#providerProfileRepository;
  }

  public getScriptUnitOfWork(): ScriptUnitOfWorkPort | null {
    return this.#scriptUnitOfWork;
  }

  public getScriptWorkspaceQuery(): ScriptWorkspaceQueryPort | null {
    return this.#scriptWorkspaceQuery;
  }

  /** Returns the Transfer UnitOfWork after READY; shares the process-wide FIFO coordinator. */
  public getTransferUnitOfWork(): TransferUnitOfWorkPort | null {
    return this.#transferUnitOfWork;
  }

  /** Returns the Media UnitOfWork (asset/candidate/task transactions) after READY. */
  public getMediaUnitOfWork(): MediaUnitOfWorkPort | null {
    return this.#mediaUnitOfWork;
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
    let phase: PersistenceStartupPhase = 'DATABASE_OPEN';
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
      this.#transactionCoordinator ??= new SqliteTransactionCoordinator(database);
      const coordinator = this.#transactionCoordinator;
      // 只读直查（不经事务队列）：媒体事务内解析画幅时若经 UoW 排队会在共享 FIFO 上自锁。
      this.#formatProfileRepository ??= new SqliteFormatProfileRepository(database);
      this.#projectUnitOfWork ??= new SqliteProjectUnitOfWork(database, coordinator);
      this.#schemaManifestUnitOfWork ??= new SqliteSchemaManifestUnitOfWork(database, coordinator);
      this.#jobUnitOfWork ??= new SqliteJobUnitOfWork(database, coordinator);
      this.#jobRepository ??= new SqliteJobRepository(database);
      this.#providerUnitOfWork ??= new SqliteProviderUnitOfWork(database, {}, coordinator);
      this.#providerProfileRepository ??= new SqliteProviderProfileRepository(database);
      this.#scriptUnitOfWork ??= new SqliteScriptUnitOfWork(database, coordinator);
      this.#scriptWorkspaceQuery ??= new SqliteScriptWorkspaceQuery(database);
      // Transfer 导入必须与其余写入共用同一 FIFO 队列（同 SqliteTransferUnitOfWork 注释）。
      this.#transferUnitOfWork ??= new SqliteTransferUnitOfWork(database, coordinator);
      // 媒体域必须共用进程级 FIFO 事务队列：自建协调器会与其它 UoW 在同一连接上
      // 交错 BEGIN（"cannot start a transaction within a transaction"，5.3 E2E 实证）。
      this.#mediaUnitOfWork ??= new SqliteMediaUnitOfWork(database, this.#clock, coordinator);
      completedPhases.push('RECOVERY_GATE');
      return { backups, completedPhases, ok: true };
    } catch (error) {
      this.#formatProfileRepository = null;
      this.#projectUnitOfWork = null;
      this.#schemaManifestUnitOfWork = null;
      this.#jobUnitOfWork = null;
      this.#jobRepository = null;
      this.#providerUnitOfWork = null;
      this.#providerProfileRepository = null;
      this.#scriptUnitOfWork = null;
      this.#scriptWorkspaceQuery = null;
      this.#transferUnitOfWork = null;
      this.#mediaUnitOfWork = null;
      this.#transactionCoordinator = null;
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
