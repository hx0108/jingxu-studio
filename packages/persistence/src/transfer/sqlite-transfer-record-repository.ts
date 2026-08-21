import type {
  TransferExportRecord,
  TransferExportResultSummary,
  TransferImportRecord,
  TransferRecordRepositoryPort,
} from '@jingxu/application';
import type { TransferImportResultDto } from '@jingxu/contracts';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';

interface ExportRow {
  readonly id: unknown;
  readonly request_id: unknown;
  readonly project_id: unknown;
  readonly episode_id: unknown;
  readonly episode_version_id: unknown;
  readonly status: unknown;
  readonly payload_sha256: unknown;
  readonly byte_size: unknown;
  readonly target_path: unknown;
  readonly overwrite_policy: unknown;
  readonly error_code: unknown;
  readonly created_at: unknown;
  readonly finished_at: unknown;
  readonly result_json: unknown;
}

interface ImportRow {
  readonly id: unknown;
  readonly request_id: unknown;
  readonly project_id: unknown;
  readonly import_mode: unknown;
  readonly source_sha256: unknown;
  readonly source_path: unknown;
  readonly status: unknown;
  readonly validation_errors_json: unknown;
  readonly id_mapping_json: unknown;
  readonly created_at: unknown;
  readonly finished_at: unknown;
  readonly result_json: unknown;
}

const EXPORT_STATUSES = new Set(['PREPARING', 'FILE_READY', 'SUCCEEDED', 'FAILED']);
const IMPORT_STATUSES = new Set(['STAGING', 'VALIDATING', 'SUCCEEDED', 'FAILED']);
const IMPORT_MODES = new Set(['RETURN_TO_ORIGIN', 'NEW_PROJECT']);

const parseSummary = (raw: unknown, errorCode: string): unknown => {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new PersistenceRuntimeError(errorCode);
  try {
    return JSON.parse(raw);
  } catch {
    throw new PersistenceRuntimeError(errorCode);
  }
};

const mapExportRow = (row: ExportRow): TransferExportRecord => {
  if (
    typeof row.id !== 'string' ||
    typeof row.request_id !== 'string' ||
    typeof row.project_id !== 'string' ||
    typeof row.episode_id !== 'string' ||
    typeof row.episode_version_id !== 'string' ||
    typeof row.status !== 'string' ||
    !EXPORT_STATUSES.has(row.status) ||
    typeof row.payload_sha256 !== 'string' ||
    typeof row.byte_size !== 'number' ||
    typeof row.target_path !== 'string' ||
    (row.overwrite_policy !== 'REJECT' && row.overwrite_policy !== 'CONFIRMED_OVERWRITE') ||
    (row.error_code !== null && typeof row.error_code !== 'string') ||
    typeof row.created_at !== 'string' ||
    (row.finished_at !== null && typeof row.finished_at !== 'string')
  ) {
    throw new PersistenceRuntimeError('TRANSFER_EXPORT_ROW_INVALID');
  }
  return {
    byteSize: row.byte_size,
    createdAt: row.created_at,
    errorCode: row.error_code,
    episodeId: row.episode_id,
    episodeVersionId: row.episode_version_id,
    finishedAt: row.finished_at,
    id: row.id,
    overwritePolicy: row.overwrite_policy,
    payloadSha256: row.payload_sha256,
    projectId: row.project_id,
    requestId: row.request_id,
    resultSummary: parseSummary(
      row.result_json,
      'TRANSFER_EXPORT_RESULT_INVALID',
    ) as TransferExportResultSummary | null,
    status: row.status as TransferExportRecord['status'],
    targetRef: row.target_path,
  };
};

const mapImportRow = (row: ImportRow): TransferImportRecord => {
  if (
    typeof row.id !== 'string' ||
    typeof row.request_id !== 'string' ||
    (row.project_id !== null && typeof row.project_id !== 'string') ||
    typeof row.import_mode !== 'string' ||
    !IMPORT_MODES.has(row.import_mode) ||
    typeof row.source_sha256 !== 'string' ||
    typeof row.source_path !== 'string' ||
    typeof row.status !== 'string' ||
    !IMPORT_STATUSES.has(row.status) ||
    typeof row.created_at !== 'string' ||
    (row.finished_at !== null && typeof row.finished_at !== 'string')
  ) {
    throw new PersistenceRuntimeError('TRANSFER_IMPORT_ROW_INVALID');
  }
  const validationErrorsRaw: unknown = row.validation_errors_json;
  if (validationErrorsRaw !== null && typeof validationErrorsRaw !== 'string') {
    throw new PersistenceRuntimeError('TRANSFER_IMPORT_ROW_INVALID');
  }
  const idMappingRaw: unknown = row.id_mapping_json;
  if (idMappingRaw !== null && typeof idMappingRaw !== 'string') {
    throw new PersistenceRuntimeError('TRANSFER_IMPORT_ROW_INVALID');
  }
  let validationErrors: readonly string[] = [];
  if (typeof validationErrorsRaw === 'string') {
    try {
      validationErrors = JSON.parse(validationErrorsRaw) as string[];
    } catch {
      throw new PersistenceRuntimeError('TRANSFER_IMPORT_ROW_INVALID');
    }
  }
  let idMapping: TransferImportRecord['idMapping'] = null;
  if (typeof idMappingRaw === 'string') {
    try {
      idMapping = JSON.parse(idMappingRaw) as TransferImportRecord['idMapping'];
    } catch {
      throw new PersistenceRuntimeError('TRANSFER_IMPORT_ROW_INVALID');
    }
  }
  return {
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    id: row.id,
    idMapping,
    importMode: row.import_mode as TransferImportRecord['importMode'],
    projectId: row.project_id,
    requestId: row.request_id,
    resultSummary: parseSummary(
      row.result_json,
      'TRANSFER_IMPORT_RESULT_INVALID',
    ) as TransferImportResultDto | null,
    sourceRef: row.source_path,
    sourceSha256: row.source_sha256,
    status: row.status as TransferImportRecord['status'],
    validationErrors,
  };
};

/**
 * SQLite Transfer 记录仓储（export_records/import_records + 0016 request_id）。
 * 路径列（target_path/source_path）只在持久层与应用 opaque ref 间直映射，
 * 不向 Renderer 透出。
 */
export class SqliteTransferRecordRepository implements TransferRecordRepositoryPort {
  public constructor(private readonly database: SqliteDatabase) {}

  public findExportByRequestId(requestId: string): Promise<TransferExportRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT id, request_id, project_id, episode_id, episode_version_id, status,
                  payload_sha256, byte_size, target_path, overwrite_policy, error_code,
                  created_at, finished_at, result_json
           FROM export_records
           WHERE request_id = ? AND status = 'SUCCEEDED'`,
        )
        .get(requestId) as ExportRow | undefined;
      return row === undefined ? null : mapExportRow(row);
    });
  }

  public insertExport(record: TransferExportRecord): Promise<void> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `INSERT INTO export_records (
            id, project_id, episode_id, episode_version_id, export_type, status,
            target_path, overwrite_policy, payload_sha256, byte_size, schema_version,
            lineage_completeness, warning_overrides_json, created_at, finished_at,
            error_code, request_id, result_json
          ) VALUES (?, ?, ?, ?, 'PROJECT_TRANSFER', ?, ?, ?, ?, ?, '1.0.0',
                    'COMPLETE', '[]', ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.projectId,
          record.episodeId,
          record.episodeVersionId,
          record.status,
          record.targetRef,
          record.overwritePolicy,
          record.payloadSha256,
          record.byteSize,
          record.createdAt,
          record.finishedAt,
          record.errorCode,
          record.requestId,
          record.resultSummary === null ? null : JSON.stringify(record.resultSummary),
        );
    });
  }

  public findImportByRequestId(requestId: string): Promise<TransferImportRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT id, request_id, project_id, import_mode, source_sha256, source_path,
                  status, validation_errors_json, id_mapping_json, created_at,
                  finished_at, result_json
           FROM import_records
           WHERE request_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`,
        )
        .get(requestId) as ImportRow | undefined;
      return row === undefined ? null : mapImportRow(row);
    });
  }

  public insertImport(record: TransferImportRecord): Promise<void> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `INSERT INTO import_records (
            id, project_id, import_mode, source_path, source_sha256, status,
            validation_errors_json, id_mapping_json, created_at, finished_at,
            request_id, result_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.projectId,
          record.importMode,
          record.sourceRef,
          record.sourceSha256,
          record.status,
          record.validationErrors.length === 0 ? null : JSON.stringify(record.validationErrors),
          record.idMapping === null ? null : JSON.stringify(record.idMapping),
          record.createdAt,
          record.finishedAt,
          record.requestId,
          record.resultSummary === null ? null : JSON.stringify(record.resultSummary),
        );
    });
  }
}
