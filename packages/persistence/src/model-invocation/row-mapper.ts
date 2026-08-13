import type {
  ModelInvocation,
  ModelInvocationAttemptKind,
  ModelInvocationStatus,
} from '@jingxu/application';

import type { SqliteOutputValue } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';

export type InvocationRow = Readonly<Record<string, SqliteOutputValue>>;
const STATUSES: readonly ModelInvocationStatus[] = [
  'STARTED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED_UNKNOWN_OUTCOME',
];
const KINDS: readonly ModelInvocationAttemptKind[] = [
  'INITIAL',
  'TRANSPORT_RETRY',
  'STRUCTURE_REPAIR',
];
const CURRENCIES = ['CNY', 'USD', 'CREDIT'] as const;
const corrupt = (): never => {
  throw new PersistenceRuntimeError('MODEL_INVOCATION_ROW_CORRUPT');
};
const string = (row: InvocationRow, key: string): string => {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : corrupt();
};
const nullableString = (row: InvocationRow, key: string): string | null => {
  const value = row[key];
  return value === null ? null : typeof value === 'string' ? value : corrupt();
};
const enumeration = <T extends string>(
  row: InvocationRow,
  key: string,
  values: readonly T[],
): T => {
  const value = string(row, key);
  return values.includes(value as T) ? (value as T) : corrupt();
};
const nullableNumber = (row: InvocationRow, key: string): number | null => {
  const value = row[key];
  return value === null
    ? null
    : typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : corrupt();
};
const bytes = (row: InvocationRow, key: string): Uint8Array | null => {
  const value = row[key];
  return value === null ? null : value instanceof Uint8Array ? new Uint8Array(value) : corrupt();
};

export const mapInvocationRow = (row: InvocationRow): ModelInvocation => ({
  id: string(row, 'id'),
  jobId: string(row, 'job_id'),
  status: enumeration(row, 'status', STATUSES),
  attemptKind: enumeration(row, 'attempt_kind', KINDS),
  transportAttempt: (() => {
    const value = row.transport_attempt;
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3
      ? value
      : corrupt();
  })(),
  providerProfileId: string(row, 'provider_profile_id'),
  providerRequestId: nullableString(row, 'provider_request_id'),
  modelId: string(row, 'model_id'),
  modelVersion: string(row, 'model_version'),
  parametersJson: string(row, 'parameters_json'),
  requestSnapshotJson: string(row, 'request_snapshot_json'),
  requestSha256: string(row, 'request_sha256'),
  requestSentAt: nullableString(row, 'request_sent_at'),
  timeoutAt: nullableString(row, 'timeout_at'),
  rawResponse: bytes(row, 'raw_response_blob'),
  rawResponseSha256: nullableString(row, 'raw_response_sha256'),
  responseCompleteAt: nullableString(row, 'response_complete_at'),
  lateResponseAt: nullableString(row, 'late_response_at'),
  parsedJson: nullableString(row, 'parsed_json'),
  validationErrorsJson: nullableString(row, 'validation_errors_json'),
  inputTokens: nullableNumber(row, 'input_tokens'),
  outputTokens: nullableNumber(row, 'output_tokens'),
  estimatedCostMicros: nullableNumber(row, 'estimated_cost_micros'),
  currency: row.currency === null ? null : enumeration(row, 'currency', CURRENCIES),
  startedAt: string(row, 'started_at'),
  finishedAt: nullableString(row, 'finished_at'),
  errorCode: nullableString(row, 'error_code'),
});
