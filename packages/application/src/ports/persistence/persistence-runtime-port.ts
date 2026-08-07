import type { BackupSummaryDto, StartupErrorCode, StartupPhase } from '@jingxu/contracts';

export interface PersistenceFailure {
  readonly allowedActions: readonly ('RETRY' | 'RESTORE')[];
  readonly backups: readonly BackupSummaryDto[];
  readonly errorCode: StartupErrorCode;
  readonly phase: StartupPhase;
  readonly retryable: boolean;
  readonly summary: string;
}

export type PersistenceCheckResult =
  | Readonly<{
      backups: readonly BackupSummaryDto[];
      completedPhases: readonly StartupPhase[];
      ok: true;
    }>
  | Readonly<{
      completedPhases: readonly StartupPhase[];
      failure: PersistenceFailure;
      ok: false;
    }>;

export type PersistenceRestoreResult =
  Readonly<{ ok: true }> | Readonly<{ failure: PersistenceFailure; ok: false }>;

/** Application 启动编排所需的持久化生命周期抽象。 */
export interface PersistenceRuntimePort {
  /** 关闭当前数据库句柄；重复调用必须安全。 */
  close(): void;
  /** 从数据库打开阶段执行完整检查、迁移和审计。 */
  prepare(): Promise<PersistenceCheckResult>;
  /** 从受管理备份恢复；不得接受文件路径。 */
  restoreBackup(backupId: string, operationId: string): Promise<PersistenceRestoreResult>;
}
