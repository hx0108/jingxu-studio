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

/** Transaction-scoped Job persistence; never exposes SQLite rows, statements, or connections. */
export interface JobRepositoryPort {
  findById(id: string): Promise<ScriptStageJob | null>;
  findByIdempotencyKey(projectId: string, idempotencyKey: string): Promise<ScriptStageJob | null>;
  listByStatuses(statuses: readonly JobStatus[], limit: number): Promise<readonly ScriptStageJob[]>;
  insert(job: ScriptStageJob): Promise<void>;
  claimQueued(command: ClaimQueuedJobCommand): Promise<boolean>;
  transition(command: TransitionJobCommand): Promise<boolean>;
}
