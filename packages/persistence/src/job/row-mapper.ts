import type { JobOperationType, JobStatus, ScriptStageJob } from '@jingxu/application';
import type { ScriptStage } from '@jingxu/contracts';

import type { SqliteOutputValue } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';

export type JobRow = Readonly<Record<string, SqliteOutputValue>>;

const STATUSES: readonly JobStatus[] = [
  'DRAFT',
  'QUEUED',
  'RUNNING',
  'VALIDATING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
];
const STAGES: readonly ScriptStage[] = [
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
  'SHOT_CONTRACT',
];
const OPERATIONS: readonly JobOperationType[] = [
  'GENERATE',
  'CONTINUE',
  'SHORTEN',
  'REWRITE',
  'STRENGTHEN_CONFLICT',
];

const corrupt = (): never => {
  throw new PersistenceRuntimeError('JOB_ROW_CORRUPT');
};
const string = (row: JobRow, key: string): string => {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : corrupt();
};
const nullableString = (row: JobRow, key: string): string | null => {
  const value = row[key];
  return value === null ? null : typeof value === 'string' ? value : corrupt();
};
const integer = (row: JobRow, key: string, min: number, max: number): number => {
  const value = row[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : corrupt();
};
const enumeration = <T extends string>(row: JobRow, key: string, values: readonly T[]): T => {
  const value = string(row, key);
  return values.includes(value as T) ? (value as T) : corrupt();
};

export const mapJobRow = (row: JobRow): ScriptStageJob => ({
  id: string(row, 'id'),
  projectId: string(row, 'project_id'),
  episodeId: nullableString(row, 'episode_id'),
  stage: enumeration(row, 'stage', STAGES),
  operationType: enumeration(row, 'operation_type', OPERATIONS),
  status: enumeration(row, 'status', STATUSES),
  idempotencyKey: string(row, 'idempotency_key'),
  userOperationId: string(row, 'user_operation_id'),
  inputVersionsJson: string(row, 'input_versions_json'),
  inputVersionSetHash: string(row, 'input_version_set_hash'),
  selectionJson: nullableString(row, 'selection_json'),
  writeSetJson: string(row, 'write_set_json'),
  lockSnapshotHash: string(row, 'lock_snapshot_hash'),
  promptTemplateId: string(row, 'prompt_template_id'),
  transportAttempts: integer(row, 'transport_attempts', 0, 3),
  structureRepairAttempts: integer(row, 'structure_repair_attempts', 0, 1),
  leaseToken: nullableString(row, 'lease_token'),
  leaseExpiresAt: nullableString(row, 'lease_expires_at'),
  deadlineAt: nullableString(row, 'deadline_at'),
  cancelRequestedAt: nullableString(row, 'cancel_requested_at'),
  errorCode: nullableString(row, 'error_code'),
  errorJson: nullableString(row, 'error_json'),
  queuedAt: nullableString(row, 'queued_at'),
  startedAt: nullableString(row, 'started_at'),
  finishedAt: nullableString(row, 'finished_at'),
  createdAt: string(row, 'created_at'),
});
