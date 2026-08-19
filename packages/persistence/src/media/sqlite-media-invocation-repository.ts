import type {
  MediaInvocationRepository,
  MediaInvocationSegment,
  MediaInvocationStartInput,
  MediaInvocationStatus,
  MediaInvocationTerminalEvidence,
  MediaModelInvocationRecord,
} from '@jingxu/application';

import type { SqliteDatabase, SqliteOutputValue } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';

type Row = Readonly<Record<string, SqliteOutputValue>>;

const MEDIA_INVOCATION_ROW_CORRUPT = 'MEDIA_INVOCATION_ROW_CORRUPT';

const corrupt = (): never => {
  throw new PersistenceRuntimeError(MEDIA_INVOCATION_ROW_CORRUPT);
};

const requiredString = (row: Row, column: string): string => {
  const value = row[column];
  return typeof value === 'string' && value.length > 0 ? value : corrupt();
};

const nullableString = (row: Row, column: string): string | null => {
  const value = row[column];
  if (value === null) return null;
  return typeof value === 'string' ? value : corrupt();
};

const requiredNumber = (row: Row, column: string): number => {
  const value = row[column];
  return typeof value === 'number' && Number.isFinite(value) ? value : corrupt();
};

const nullableNumber = (row: Row, column: string): number | null => {
  const value = row[column];
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : corrupt();
};

const nullableBlob = (row: Row, column: string): Uint8Array | null => {
  const value = row[column];
  if (value === null) return null;
  return value instanceof Uint8Array ? value : corrupt();
};

const mapInvocationRow = (row: Row): MediaModelInvocationRecord => ({
  candidateId: requiredString(row, 'candidate_id'),
  createdAt: requiredString(row, 'created_at'),
  errorCode: nullableString(row, 'error_code'),
  finishedAt: nullableString(row, 'finished_at'),
  id: requiredString(row, 'id'),
  mediaTaskId: requiredString(row, 'media_task_id'),
  modelId: requiredString(row, 'model_id'),
  providerRequestId: nullableString(row, 'provider_request_id'),
  providerReportedGeneratedImages: nullableNumber(row, 'provider_reported_generated_images'),
  providerReportedOutputTokens: nullableNumber(row, 'provider_reported_output_tokens'),
  rawResponseBlob: nullableBlob(row, 'raw_response_blob'),
  rawResponseSha256: nullableString(row, 'raw_response_sha256'),
  rawResponseTruncated: requiredNumber(row, 'raw_response_truncated') === 1,
  requestSha256: requiredString(row, 'request_sha256'),
  requestSnapshotJson: requiredString(row, 'request_snapshot_json'),
  responseHttpStatus: nullableNumber(row, 'response_http_status'),
  segmentKind: requiredString(row, 'segment_kind') as MediaInvocationSegment,
  status: requiredString(row, 'status') as MediaInvocationStatus,
  updatedAt: requiredString(row, 'updated_at'),
});

const INVOCATION_COLUMNS =
  'id, media_task_id, candidate_id, segment_kind, status, model_id, request_snapshot_json, request_sha256, provider_request_id, response_http_status, raw_response_blob, raw_response_truncated, raw_response_sha256, provider_reported_generated_images, provider_reported_output_tokens, error_code, finished_at, created_at, updated_at';

const failed = (): never => {
  throw new PersistenceRuntimeError('MEDIA_INVOCATION_PERSISTENCE_FAILED');
};

const write = (operation: () => unknown): unknown => {
  try {
    return operation();
  } catch {
    return failed();
  }
};

/**
 * media_model_invocations 读写（media-invocation-evidence design D1/D4）：
 * 两段式留证的持久化面——insert 恒 STARTED，finishTerminal 守卫 STARTED 单向
 * 收终态；与媒体仓储同处一个 `BEGIN IMMEDIATE` 事务（SqliteMediaUnitOfWork）。
 */
export class SqliteMediaInvocationRepository implements MediaInvocationRepository {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => string,
  ) {}

  public insert(input: MediaInvocationStartInput): Promise<void> {
    return syncToPromise(() => {
      const now = this.clock();
      write(() =>
        this.database
          .prepare(
            `INSERT INTO media_model_invocations (${INVOCATION_COLUMNS}) VALUES (?, ?, ?, ?, 'STARTED', ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
          )
          .run(
            input.id,
            input.mediaTaskId,
            input.candidateId,
            input.segmentKind,
            input.modelId,
            input.requestSnapshotJson,
            input.requestSha256,
            now,
            now,
          ),
      );
    });
  }

  public finishTerminal(id: string, evidence: MediaInvocationTerminalEvidence): Promise<boolean> {
    return syncToPromise(() => {
      const result = write(() =>
        this.database
          .prepare(
            `UPDATE media_model_invocations
             SET status = ?, provider_request_id = ?, response_http_status = ?, raw_response_blob = ?,
                 raw_response_truncated = ?, raw_response_sha256 = ?,
                 provider_reported_generated_images = ?, provider_reported_output_tokens = ?,
                 error_code = ?, finished_at = ?, updated_at = ?
             WHERE id = ? AND status = 'STARTED'`,
          )
          .run(
            evidence.status,
            evidence.providerRequestId ?? null,
            evidence.responseHttpStatus ?? null,
            evidence.rawResponseBlob ?? null,
            evidence.rawResponseTruncated === true ? 1 : 0,
            evidence.rawResponseSha256 ?? null,
            evidence.providerReportedGeneratedImages ?? null,
            evidence.providerReportedOutputTokens ?? null,
            evidence.errorCode ?? null,
            evidence.finishedAt,
            this.clock(),
            id,
          ),
      ) as { readonly changes?: number };
      return result.changes === 1;
    });
  }

  public findById(id: string): Promise<MediaModelInvocationRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(`SELECT ${INVOCATION_COLUMNS} FROM media_model_invocations WHERE id = ?`)
        .get(id) as Row | undefined;
      return row === undefined ? null : mapInvocationRow(row);
    });
  }

  public listByTaskId(mediaTaskId: string): Promise<readonly MediaModelInvocationRecord[]> {
    return syncToPromise(() =>
      (
        this.database
          .prepare(
            `SELECT ${INVOCATION_COLUMNS} FROM media_model_invocations
             WHERE media_task_id = ? ORDER BY created_at ASC, id ASC LIMIT 400`,
          )
          .all(mediaTaskId) as Row[]
      ).map(mapInvocationRow),
    );
  }
}
