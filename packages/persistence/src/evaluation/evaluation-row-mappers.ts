import type { EvaluationAnnotationRecord, EvaluationSampleRecord } from '@jingxu/application';
import type {
  EvaluationAnnotationLabelDto,
  EvaluationExpectedDto,
  EvaluationRuleHitDto,
  EvaluationSampleInputDto,
} from '@jingxu/contracts';

import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { SqliteOutputValue } from '../runtime/sqlite-database';

export type EvaluationRow = Readonly<Record<string, SqliteOutputValue>>;

const SAMPLE_TYPES = new Set(['SCRIPT_STAGE', 'SHOT_CONTRACT', 'EPISODE_STORYBOARD']);
const AUTHORIZATIONS = new Set(['AUTHORIZED', 'PUBLIC_DOMAIN', 'SYNTHETIC']);
const DATASET_SPLITS = new Set(['TRAIN', 'VALIDATION', 'TEST']);

const SAMPLE_INVALID = 'EVALUATION_SAMPLE_ROW_INVALID';
const ANNOTATION_INVALID = 'EVALUATION_ANNOTATION_ROW_INVALID';

const invalid = (code: string): never => {
  throw new PersistenceRuntimeError(code);
};

const text = (row: EvaluationRow, key: string, errorCode: string): string => {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : invalid(errorCode);
};

const nullableText = (row: EvaluationRow, key: string, errorCode: string): string | null => {
  const value = row[key];
  if (value === null) return null;
  return typeof value === 'string' && value.length > 0 ? value : invalid(errorCode);
};

/**
 * JSON 列在持久层边界解析；写侧已过 zod/DDL json_valid，但 json_valid 不约束形状
 * （合法 JSON 的错误形状同样按行损坏归一化，PersistenceRuntimeError 不透传 SQL）。
 */
const parseJsonOfShape = (
  row: EvaluationRow,
  key: string,
  errorCode: string,
  matches: (parsed: unknown) => boolean,
): unknown => {
  const raw = row[key];
  if (typeof raw !== 'string' || raw.length === 0) return invalid(errorCode);
  try {
    const parsed: unknown = JSON.parse(raw);
    return matches(parsed) ? parsed : invalid(errorCode);
  } catch {
    return invalid(errorCode);
  }
};

const jsonObject = (row: EvaluationRow, key: string, errorCode: string): Record<string, unknown> =>
  parseJsonOfShape(
    row,
    key,
    errorCode,
    (parsed) => typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
  ) as Record<string, unknown>;

const jsonArray = (row: EvaluationRow, key: string, errorCode: string): readonly unknown[] =>
  parseJsonOfShape(row, key, errorCode, Array.isArray) as readonly unknown[];

const enumText = (
  row: EvaluationRow,
  key: string,
  allowed: ReadonlySet<string>,
  errorCode: string,
): string => {
  const value = text(row, key, errorCode);
  return allowed.has(value) ? value : invalid(errorCode);
};

export const mapEvaluationSampleRow = (row: EvaluationRow): EvaluationSampleRecord => ({
  authorization: enumText(
    row,
    'authorization_status',
    AUTHORIZATIONS,
    SAMPLE_INVALID,
  ) as EvaluationSampleRecord['authorization'],
  createdAt: text(row, 'created_at', SAMPLE_INVALID),
  datasetSplit: enumText(
    row,
    'dataset_split',
    DATASET_SPLITS,
    SAMPLE_INVALID,
  ) as EvaluationSampleRecord['datasetSplit'],
  dedupKey: text(row, 'dedup_key', SAMPLE_INVALID),
  expected: jsonObject(row, 'expected_json', SAMPLE_INVALID) as EvaluationExpectedDto,
  id: text(row, 'id', SAMPLE_INVALID),
  input: jsonObject(row, 'input_json', SAMPLE_INVALID) as EvaluationSampleInputDto,
  projectId: nullableText(row, 'project_id', SAMPLE_INVALID),
  ruleHits:
    row.rule_hits_json === null
      ? null
      : (jsonArray(row, 'rule_hits_json', SAMPLE_INVALID) as readonly EvaluationRuleHitDto[]),
  ruleVersion: nullableText(row, 'rule_version', SAMPLE_INVALID),
  sampleType: enumText(
    row,
    'sample_type',
    SAMPLE_TYPES,
    SAMPLE_INVALID,
  ) as EvaluationSampleRecord['sampleType'],
});

export const mapEvaluationAnnotationRow = (row: EvaluationRow): EvaluationAnnotationRecord => ({
  annotator: text(row, 'annotator', ANNOTATION_INVALID),
  createdAt: text(row, 'created_at', ANNOTATION_INVALID),
  guidelineVersion: text(row, 'guideline_version', ANNOTATION_INVALID),
  id: text(row, 'id', ANNOTATION_INVALID),
  label: jsonObject(row, 'label_json', ANNOTATION_INVALID) as EvaluationAnnotationLabelDto,
  rationale: text(row, 'rationale', ANNOTATION_INVALID),
  sampleId: text(row, 'sample_id', ANNOTATION_INVALID),
});
