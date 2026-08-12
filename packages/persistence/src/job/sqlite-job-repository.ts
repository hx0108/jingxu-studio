import {
  assertJobTransition,
  type ClaimQueuedJobCommand,
  type JobRepositoryPort,
  type JobStatus,
  type ScriptStageJob,
  type TransitionJobCommand,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';
import { mapJobRow, type JobRow } from './row-mapper';

export const JOB_COLUMNS =
  'id, project_id, episode_id, stage, operation_type, status, idempotency_key, user_operation_id, input_versions_json, input_version_set_hash, selection_json, write_set_json, lock_snapshot_hash, prompt_template_id, transport_attempts, structure_repair_attempts, lease_token, lease_expires_at, deadline_at, cancel_requested_at, error_code, error_json, queued_at, started_at, finished_at, created_at';

const normalizeWrite = (operation: () => void): void => {
  try {
    operation();
  } catch (error) {
    if (error instanceof PersistenceRuntimeError) throw error;
    if (
      error instanceof Error &&
      error.message.includes(
        'UNIQUE constraint failed: script_stage_jobs.project_id, script_stage_jobs.idempotency_key',
      )
    )
      throw new PersistenceRuntimeError('JOB_IDEMPOTENCY_CONFLICT');
    throw new PersistenceRuntimeError('JOB_PERSISTENCE_FAILED');
  }
};

export class SqliteJobRepository implements JobRepositoryPort {
  public constructor(private readonly database: SqliteDatabase) {}
  public findById(id: string): Promise<ScriptStageJob | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(`SELECT ${JOB_COLUMNS} FROM script_stage_jobs WHERE id = ?`)
        .get(id) as JobRow | undefined;
      return row === undefined ? null : mapJobRow(row);
    });
  }
  public findByIdempotencyKey(
    projectId: string,
    idempotencyKey: string,
  ): Promise<ScriptStageJob | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM script_stage_jobs WHERE project_id = ? AND idempotency_key = ?`,
        )
        .get(projectId, idempotencyKey) as JobRow | undefined;
      return row === undefined ? null : mapJobRow(row);
    });
  }
  public listByStatuses(
    statuses: readonly JobStatus[],
    limit: number,
  ): Promise<readonly ScriptStageJob[]> {
    return syncToPromise(() => {
      if (statuses.length === 0) return [];
      if (statuses.length > 7 || !Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new PersistenceRuntimeError('JOB_QUERY_INVALID');
      const placeholders = statuses.map(() => '?').join(', ');
      return (
        this.database
          .prepare(
            `SELECT ${JOB_COLUMNS} FROM script_stage_jobs WHERE status IN (${placeholders}) ORDER BY created_at ASC, id ASC LIMIT ?`,
          )
          .all(...statuses, limit) as JobRow[]
      ).map(mapJobRow);
    });
  }
  public insert(job: ScriptStageJob): Promise<void> {
    return syncToPromise(() => {
      normalizeWrite(() => {
        this.database
          .prepare(
            `INSERT INTO script_stage_jobs (${JOB_COLUMNS}) VALUES (${Array.from({ length: 26 }, () => '?').join(', ')})`,
          )
          .run(
            job.id,
            job.projectId,
            job.episodeId,
            job.stage,
            job.operationType,
            job.status,
            job.idempotencyKey,
            job.userOperationId,
            job.inputVersionsJson,
            job.inputVersionSetHash,
            job.selectionJson,
            job.writeSetJson,
            job.lockSnapshotHash,
            job.promptTemplateId,
            job.transportAttempts,
            job.structureRepairAttempts,
            job.leaseToken,
            job.leaseExpiresAt,
            job.deadlineAt,
            job.cancelRequestedAt,
            job.errorCode,
            job.errorJson,
            job.queuedAt,
            job.startedAt,
            job.finishedAt,
            job.createdAt,
          );
      });
    });
  }
  public claimQueued(command: ClaimQueuedJobCommand): Promise<boolean> {
    return syncToPromise(() => {
      let changes = 0;
      normalizeWrite(() => {
        const result = this.database
          .prepare(
            `UPDATE script_stage_jobs SET status = 'RUNNING', lease_token = ?, lease_expires_at = ?, started_at = ?, deadline_at = ? WHERE id = ? AND status = 'QUEUED'`,
          )
          .run(
            command.leaseToken,
            command.leaseExpiresAt,
            command.startedAt,
            command.deadlineAt,
            command.jobId,
          ) as { readonly changes?: number };
        changes = result.changes ?? 0;
      });
      return changes === 1;
    });
  }
  public transition(command: TransitionJobCommand): Promise<boolean> {
    return syncToPromise(() => {
      assertJobTransition(
        command.expectedStatus,
        command.nextStatus,
        command.transportAttempts,
        command.structureRepairAttempts,
      );
      let changes = 0;
      normalizeWrite(() => {
        const result = this.database
          .prepare(
            `UPDATE script_stage_jobs SET status = ?, transport_attempts = ?, structure_repair_attempts = ?, finished_at = ?, error_code = ?, error_json = ? WHERE id = ? AND status = ?`,
          )
          .run(
            command.nextStatus,
            command.transportAttempts,
            command.structureRepairAttempts,
            command.finishedAt,
            command.errorCode,
            command.errorJson,
            command.jobId,
            command.expectedStatus,
          ) as { readonly changes?: number };
        changes = result.changes ?? 0;
      });
      return changes === 1;
    });
  }
}
