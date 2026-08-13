import type { ModelInvocation, ScriptStageJob } from '../../ports/persistence/job/index';

export type JobRecoveryDecision =
  | Readonly<{ kind: 'KEEP_QUEUED' }>
  | Readonly<{ invocationId: string; kind: 'REQUEUE_UNSENT' }>
  | Readonly<{ invocationId: string | null; kind: 'KEEP_CANCELLED' }>
  | Readonly<{
      errorCode: 'JOB_DEADLINE_EXCEEDED';
      deadlineAt: string;
      kind: 'FAIL_DEADLINE';
    }>
  | Readonly<{
      errorCode: 'MODEL_TIMEOUT';
      invocationId: string;
      kind: 'FAIL_TIMEOUT';
      providerRequestId: string | null;
      timeoutAt: string;
    }>
  | Readonly<{
      errorCode: 'INTERRUPTED_UNKNOWN_OUTCOME';
      invocationId: string;
      kind: 'FAIL_UNKNOWN_OUTCOME';
    }>
  | Readonly<{ invocationId: string; kind: 'RESUME_VALIDATION' }>
  | Readonly<{ errorCode: 'RECOVERY_EVIDENCE_INVALID'; kind: 'FAIL_INVALID_EVIDENCE' }>;

const latestInvocation = (items: readonly ModelInvocation[]): ModelInvocation | null =>
  items.length === 0
    ? null
    : ([...items].sort((left, right) => {
        const started = left.startedAt.localeCompare(right.startedAt);
        return started === 0 ? left.id.localeCompare(right.id) : started;
      })[items.length - 1] ?? null);

const isExpired = (value: string | null, now: string): value is string =>
  value !== null && Date.parse(value) <= Date.parse(now);

/**
 * 按持久化证据选择恢复动作。此函数不创建时间、不修改证据，也不把未知结果重新排队。
 */
export const decideJobRecovery = (
  job: ScriptStageJob,
  invocations: readonly ModelInvocation[],
  now: string,
  responseHashMatches: (invocation: ModelInvocation) => boolean = () => false,
): JobRecoveryDecision => {
  const invocation = latestInvocation(invocations);
  const hasCompleteResponse =
    invocation?.responseCompleteAt !== null &&
    invocation?.responseCompleteAt !== undefined &&
    invocation.rawResponse !== null &&
    invocation.rawResponseSha256 !== null;

  if (job.cancelRequestedAt !== null || job.status === 'CANCELLED') {
    return Object.freeze({ invocationId: invocation?.id ?? null, kind: 'KEEP_CANCELLED' });
  }
  if (isExpired(job.deadlineAt, now)) {
    return Object.freeze({
      deadlineAt: job.deadlineAt,
      errorCode: 'JOB_DEADLINE_EXCEEDED',
      kind: 'FAIL_DEADLINE',
    });
  }
  if (job.status === 'QUEUED' && invocation === null) return Object.freeze({ kind: 'KEEP_QUEUED' });
  if (invocation === null) {
    return Object.freeze({ errorCode: 'RECOVERY_EVIDENCE_INVALID', kind: 'FAIL_INVALID_EVIDENCE' });
  }
  if (invocation.requestSentAt === null) {
    return Object.freeze({ invocationId: invocation.id, kind: 'REQUEUE_UNSENT' });
  }
  if (isExpired(invocation.timeoutAt, now) && invocation.responseCompleteAt === null) {
    return Object.freeze({
      errorCode: 'MODEL_TIMEOUT',
      invocationId: invocation.id,
      kind: 'FAIL_TIMEOUT',
      providerRequestId: invocation.providerRequestId,
      timeoutAt: invocation.timeoutAt,
    });
  }
  if (invocation.responseCompleteAt === null) {
    return Object.freeze({
      errorCode: 'INTERRUPTED_UNKNOWN_OUTCOME',
      invocationId: invocation.id,
      kind: 'FAIL_UNKNOWN_OUTCOME',
    });
  }
  if (hasCompleteResponse && responseHashMatches(invocation)) {
    return Object.freeze({ invocationId: invocation.id, kind: 'RESUME_VALIDATION' });
  }
  return Object.freeze({ errorCode: 'RECOVERY_EVIDENCE_INVALID', kind: 'FAIL_INVALID_EVIDENCE' });
};
