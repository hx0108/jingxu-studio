import type { JobStatus, ScriptStageJob } from './job-types';

export interface ClaimQueuedJobCommand {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
}

export interface TransitionJobCommand {
  readonly jobId: string;
  readonly expectedStatus: JobStatus;
  readonly nextStatus: JobStatus;
  readonly transportAttempts: number;
  readonly structureRepairAttempts: number;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
  readonly errorJson: string | null;
}

export interface CancelJobCommand {
  readonly cancelRequestedAt: string;
  readonly expectedStatus: 'QUEUED' | 'RUNNING' | 'VALIDATING';
  readonly finishedAt: string;
  readonly jobId: string;
}

export interface ReleaseUnsentJobForRecoveryCommand {
  readonly jobId: string;
  readonly expectedLeaseToken: string;
  readonly leaseExpiredAt: string;
}

/** Transaction-scoped Job persistence; never exposes SQLite rows, statements, or connections. */
export interface JobRepositoryPort {
  findById(id: string): Promise<ScriptStageJob | null>;
  findByIdempotencyKey(projectId: string, idempotencyKey: string): Promise<ScriptStageJob | null>;
  listByStatuses(statuses: readonly JobStatus[], limit: number): Promise<readonly ScriptStageJob[]>;
  insert(job: ScriptStageJob): Promise<void>;
  claimQueued(command: ClaimQueuedJobCommand): Promise<boolean>;
  /** 原子持久化取消请求与 CANCELLED 终态；调用方只在成功后 abort。 */
  cancel(command: CancelJobCommand): Promise<boolean>;
  /**
   * Releases only an expired RUNNING lease whose persisted invocations prove no request was sent.
   * This recovery-only transition must not be replaced by the normal state transition API.
   */
  releaseUnsentForRecovery(command: ReleaseUnsentJobForRecoveryCommand): Promise<boolean>;
  transition(command: TransitionJobCommand): Promise<boolean>;
}
