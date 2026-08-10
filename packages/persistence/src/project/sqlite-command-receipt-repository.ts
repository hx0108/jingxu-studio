import type {
  CommandReceipt,
  CommandReceiptRepository,
  CommandReceiptResultRef,
} from '@jingxu/application';

import type { SqliteDatabase } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';

interface ReceiptRow {
  readonly request_id: unknown;
  readonly command_name: unknown;
  readonly payload_sha256: unknown;
  readonly project_id: unknown;
  readonly result_ref_json: unknown;
  readonly trace_id: unknown;
  readonly committed_at: unknown;
}

const isResultRef = (value: unknown): value is CommandReceiptResultRef => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    Object.keys(ref).length === 4 &&
    Object.keys(ref).every((key) =>
      ['projectId', 'formatProfileId', 'updatedAt', 'changed'].includes(key),
    ) &&
    typeof ref.projectId === 'string' &&
    typeof ref.formatProfileId === 'string' &&
    typeof ref.updatedAt === 'string' &&
    typeof ref.changed === 'boolean'
  );
};

const mapReceipt = (row: ReceiptRow): CommandReceipt => {
  if (
    typeof row.request_id !== 'string' ||
    typeof row.command_name !== 'string' ||
    typeof row.payload_sha256 !== 'string' ||
    (row.project_id !== null && typeof row.project_id !== 'string') ||
    typeof row.result_ref_json !== 'string' ||
    typeof row.trace_id !== 'string' ||
    typeof row.committed_at !== 'string'
  ) {
    throw new PersistenceRuntimeError('COMMAND_RECEIPT_ROW_INVALID');
  }
  let resultRef: unknown;
  try {
    resultRef = JSON.parse(row.result_ref_json);
  } catch {
    throw new PersistenceRuntimeError('COMMAND_RECEIPT_RESULT_REF_INVALID');
  }
  if (!isResultRef(resultRef)) {
    throw new PersistenceRuntimeError('COMMAND_RECEIPT_RESULT_REF_INVALID');
  }
  if (
    row.command_name !== 'CREATE_PROJECT' &&
    row.command_name !== 'UPDATE_PROJECT' &&
    row.command_name !== 'DELETE_PROJECT' &&
    row.command_name !== 'RESTORE_PROJECT'
  ) {
    throw new PersistenceRuntimeError('COMMAND_RECEIPT_COMMAND_INVALID');
  }
  return {
    requestId: row.request_id,
    commandName: row.command_name,
    payloadSha256: row.payload_sha256,
    projectId: row.project_id,
    resultRef,
    traceId: row.trace_id,
    committedAt: row.committed_at,
  };
};

/** SQLite command receipt adapter; only safe result references are serialized. */
export class SqliteCommandReceiptRepository implements CommandReceiptRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public findByRequestId(requestId: string): Promise<CommandReceipt | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT request_id, command_name, payload_sha256, project_id, result_ref_json,
                  trace_id, committed_at
           FROM command_receipts WHERE request_id = ?`,
        )
        .get(requestId) as ReceiptRow | undefined;
      return row === undefined ? null : mapReceipt(row);
    });
  }

  public insert(receipt: CommandReceipt): Promise<void> {
    return syncToPromise(() => {
      this.database
        .prepare(
          `INSERT INTO command_receipts (
            request_id, command_name, payload_sha256, project_id, result_ref_json,
            trace_id, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.requestId,
          receipt.commandName,
          receipt.payloadSha256,
          receipt.projectId,
          JSON.stringify(receipt.resultRef),
          receipt.traceId,
          receipt.committedAt,
        );
    });
  }
}
