export type CandidateContractLayer =
  | 'JSON_PARSE'
  | 'CANDIDATE_SCHEMA'
  | 'SYSTEM_FIELDS'
  | 'FINAL_SCHEMA'
  | 'COLLECTION'
  | 'PRE_COMMIT';

export type CandidateContractValidation =
  Readonly<{ valid: true }> | Readonly<{ code: string; details?: readonly string[]; valid: false }>;

export interface CandidateContractFailure {
  readonly code: string;
  /** 字段级失败明细（如 JSON Schema instancePath:messageCode）；仅结构元数据，不含模型输出实例值。 */
  readonly details?: readonly string[];
  readonly layer: CandidateContractLayer;
}

/** 明细上限：防止全量字段失败时 error_json 被长列表淹没。 */
const MAX_FAILURE_DETAILS = 10;

export interface CandidateContractDependencies<TResult = unknown> {
  readonly commit: (value: unknown) => Promise<TResult>;
  /** 每次候选尝试均由调用方生成新的系统字段；不得信任模型响应中的同名字段。 */
  readonly injectSystemFields: (candidate: unknown) => unknown;
  readonly repair?: (rawText: string, failure: CandidateContractFailure) => Promise<string>;
  readonly validateCandidate: (candidate: unknown) => CandidateContractValidation;
  readonly validateCollection: (value: unknown) => CandidateContractValidation;
  readonly validateFinal: (value: unknown) => CandidateContractValidation;
  readonly validatePreCommit?: (value: unknown) => CandidateContractValidation;
}

export type CandidateContractResult<TResult> =
  | Readonly<{
      committed: TResult;
      status: 'SUCCEEDED';
      structureRepairAttempts: 0 | 1;
    }>
  | Readonly<{
      errorCode: 'CONTRACT_VALIDATION_FAILED' | 'STRUCTURE_REPAIR_FAILED';
      failure: CandidateContractFailure;
      status: 'FAILED';
      structureRepairAttempts: 0 | 1;
    }>;

const failure = (
  layer: CandidateContractLayer,
  code: string,
  details?: readonly string[],
): CandidateContractFailure =>
  Object.freeze(
    details === undefined || details.length === 0
      ? { code, layer }
      : { code, details: Object.freeze(details.slice(0, MAX_FAILURE_DETAILS)), layer },
  );

const parseCandidate = (
  rawText: string,
):
  | Readonly<{ failure: CandidateContractFailure; ok: false }>
  | Readonly<{ ok: true; value: unknown }> => {
  try {
    const value: unknown = JSON.parse(rawText);
    return Object.freeze({ ok: true, value });
  } catch {
    return Object.freeze({ failure: failure('JSON_PARSE', 'MODEL_INVALID_JSON'), ok: false });
  }
};

const validate = (
  layer: CandidateContractLayer,
  validator: (value: unknown) => CandidateContractValidation,
  value: unknown,
): CandidateContractFailure | null => {
  const result = validator(value);
  return result.valid ? null : failure(layer, result.code, result.details);
};

const evaluateAttempt = (
  rawText: string,
  dependencies: CandidateContractDependencies,
):
  | Readonly<{ failure: CandidateContractFailure; ok: false }>
  | Readonly<{ ok: true; value: unknown }> => {
  const parsed = parseCandidate(rawText);
  if (!parsed.ok) return parsed;

  const candidateFailure = validate(
    'CANDIDATE_SCHEMA',
    dependencies.validateCandidate,
    parsed.value,
  );
  if (candidateFailure !== null) return Object.freeze({ failure: candidateFailure, ok: false });

  let finalValue: unknown;
  try {
    finalValue = dependencies.injectSystemFields(parsed.value);
  } catch {
    return Object.freeze({
      failure: failure('SYSTEM_FIELDS', 'SYSTEM_FIELD_INJECTION_FAILED'),
      ok: false,
    });
  }

  const finalFailure = validate('FINAL_SCHEMA', dependencies.validateFinal, finalValue);
  if (finalFailure !== null) return Object.freeze({ failure: finalFailure, ok: false });
  const collectionFailure = validate('COLLECTION', dependencies.validateCollection, finalValue);
  if (collectionFailure !== null) return Object.freeze({ failure: collectionFailure, ok: false });
  if (dependencies.validatePreCommit !== undefined) {
    const preCommitFailure = validate('PRE_COMMIT', dependencies.validatePreCommit, finalValue);
    if (preCommitFailure !== null) return Object.freeze({ failure: preCommitFailure, ok: false });
  }
  return Object.freeze({ ok: true, value: finalValue });
};

const isRepairable = (layer: CandidateContractLayer): boolean =>
  layer === 'JSON_PARSE' || layer === 'CANDIDATE_SCHEMA';

/**
 * 执行模型候选到正式业务对象的确定性边界。只有所有校验层通过后才允许调用 commit。
 */
export const executeCandidateContract = async <TResult>(
  rawText: string,
  dependencies: CandidateContractDependencies<TResult>,
): Promise<CandidateContractResult<TResult>> => {
  let currentText = rawText;
  let repairAttempts: 0 | 1 = 0;

  for (;;) {
    const attempt = evaluateAttempt(currentText, dependencies);
    if (attempt.ok) {
      const committed = await dependencies.commit(attempt.value);
      return Object.freeze({
        committed,
        status: 'SUCCEEDED',
        structureRepairAttempts: repairAttempts,
      });
    }

    if (
      repairAttempts === 0 &&
      isRepairable(attempt.failure.layer) &&
      dependencies.repair !== undefined
    ) {
      currentText = await dependencies.repair(currentText, attempt.failure);
      repairAttempts = 1;
      continue;
    }

    return Object.freeze({
      errorCode: repairAttempts === 1 ? 'STRUCTURE_REPAIR_FAILED' : 'CONTRACT_VALIDATION_FAILED',
      failure: attempt.failure,
      status: 'FAILED',
      structureRepairAttempts: repairAttempts,
    });
  }
};
