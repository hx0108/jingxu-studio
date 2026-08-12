import type {
  ModelInvocation,
  ModelInvocationRepositoryPort,
  ModelInvocationStatus,
  ResponseEvidence,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';
import { mapInvocationRow, type InvocationRow } from './row-mapper';

export const INVOCATION_COLUMNS =
  'id, job_id, status, attempt_kind, transport_attempt, provider_profile_id, provider_request_id, model_id, model_version, parameters_json, request_snapshot_json, request_sha256, request_sent_at, timeout_at, raw_response_blob, raw_response_sha256, response_complete_at, late_response_at, parsed_json, validation_errors_json, input_tokens, output_tokens, estimated_cost_micros, currency, started_at, finished_at, error_code';
const failed = (): never => {
  throw new PersistenceRuntimeError('MODEL_INVOCATION_PERSISTENCE_FAILED');
};
const write = (operation: () => unknown): unknown => {
  try {
    return operation();
  } catch {
    return failed();
  }
};

export class SqliteModelInvocationRepository implements ModelInvocationRepositoryPort {
  public constructor(private readonly database: SqliteDatabase) {}
  public findById(id: string): Promise<ModelInvocation | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(`SELECT ${INVOCATION_COLUMNS} FROM model_invocations WHERE id = ?`)
        .get(id) as InvocationRow | undefined;
      return row === undefined ? null : mapInvocationRow(row);
    });
  }
  public listByJobId(jobId: string): Promise<readonly ModelInvocation[]> {
    return syncToPromise(() =>
      (
        this.database
          .prepare(
            `SELECT ${INVOCATION_COLUMNS} FROM model_invocations WHERE job_id = ? ORDER BY started_at ASC, id ASC LIMIT 100`,
          )
          .all(jobId) as InvocationRow[]
      ).map(mapInvocationRow),
    );
  }
  public listRecoveryEvidence(jobIds: readonly string[]): Promise<readonly ModelInvocation[]> {
    return syncToPromise(() => {
      if (jobIds.length === 0) return [];
      if (jobIds.length > 100) throw new PersistenceRuntimeError('MODEL_INVOCATION_QUERY_INVALID');
      const placeholders = jobIds.map(() => '?').join(', ');
      return (
        this.database
          .prepare(
            `SELECT ${INVOCATION_COLUMNS} FROM model_invocations WHERE job_id IN (${placeholders}) ORDER BY started_at ASC, id ASC LIMIT 300`,
          )
          .all(...jobIds) as InvocationRow[]
      ).map(mapInvocationRow);
    });
  }
  public insert(value: ModelInvocation): Promise<void> {
    return syncToPromise(() => {
      write(() =>
        this.database
          .prepare(
            `INSERT INTO model_invocations (${INVOCATION_COLUMNS}) VALUES (${Array.from({ length: 27 }, () => '?').join(', ')})`,
          )
          .run(
            value.id,
            value.jobId,
            value.status,
            value.attemptKind,
            value.transportAttempt,
            value.providerProfileId,
            value.providerRequestId,
            value.modelId,
            value.modelVersion,
            value.parametersJson,
            value.requestSnapshotJson,
            value.requestSha256,
            value.requestSentAt,
            value.timeoutAt,
            value.rawResponse,
            value.rawResponseSha256,
            value.responseCompleteAt,
            value.lateResponseAt,
            value.parsedJson,
            value.validationErrorsJson,
            value.inputTokens,
            value.outputTokens,
            value.estimatedCostMicros,
            value.currency,
            value.startedAt,
            value.finishedAt,
            value.errorCode,
          ),
      );
    });
  }
  public markRequestSent(id: string, sent: string, timeout: string): Promise<boolean> {
    return this.update(
      `UPDATE model_invocations SET request_sent_at = ?, timeout_at = ? WHERE id = ? AND status = 'STARTED' AND request_sent_at IS NULL`,
      sent,
      timeout,
      id,
    );
  }
  public recordResponse(e: ResponseEvidence): Promise<boolean> {
    return this.update(
      `UPDATE model_invocations SET provider_request_id = ?, raw_response_blob = ?, raw_response_sha256 = ?, response_complete_at = ?, input_tokens = ?, output_tokens = ? WHERE id = ? AND status = 'STARTED' AND request_sent_at IS NOT NULL AND response_complete_at IS NULL`,
      e.providerRequestId,
      e.rawResponse,
      e.rawResponseSha256,
      e.responseCompleteAt,
      e.inputTokens,
      e.outputTokens,
      e.invocationId,
    );
  }
  public recordLateResponse(id: string, hash: string, at: string): Promise<boolean> {
    return this.update(
      `UPDATE model_invocations SET raw_response_sha256 = ?, late_response_at = ? WHERE id = ? AND response_complete_at IS NULL AND late_response_at IS NULL`,
      hash,
      at,
      id,
    );
  }
  public finish(
    id: string,
    status: ModelInvocationStatus,
    finishedAt: string,
    errorCode: string | null,
  ): Promise<boolean> {
    return this.update(
      `UPDATE model_invocations SET status = ?, finished_at = ?, error_code = ? WHERE id = ? AND status = 'STARTED'`,
      status,
      finishedAt,
      errorCode,
      id,
    );
  }
  private update(
    sql: string,
    ...parameters: Parameters<SqliteDatabase['prepare']>[0] extends never
      ? never
      : readonly (null | number | bigint | string | Uint8Array)[]
  ): Promise<boolean> {
    return syncToPromise(() => {
      const result = write(() => this.database.prepare(sql).run(...parameters)) as {
        readonly changes?: number;
      };
      return result.changes === 1;
    });
  }
}
