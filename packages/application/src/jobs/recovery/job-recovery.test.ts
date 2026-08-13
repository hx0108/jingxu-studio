import { describe, expect, it } from 'vitest';

import { decideJobRecovery } from './job-recovery';

import type { ModelInvocation, ScriptStageJob } from '../../ports/persistence/job/index';

const job = (overrides: Partial<ScriptStageJob> = {}): ScriptStageJob => ({
  id: 'job_1',
  projectId: 'project_1',
  episodeId: null,
  stage: 'CONCEPT',
  operationType: 'GENERATE',
  status: 'RUNNING',
  idempotencyKey: 'key',
  userOperationId: 'operation',
  inputVersionsJson: '[]',
  inputVersionSetHash: 'hash',
  selectionJson: null,
  writeSetJson: '[]',
  lockSnapshotHash: 'lock',
  promptTemplateId: 'prompt',
  transportAttempts: 0,
  structureRepairAttempts: 0,
  leaseToken: 'lease',
  leaseExpiresAt: '2026-08-12T00:00:30.000Z',
  deadlineAt: '2026-08-12T00:05:00.000Z',
  cancelRequestedAt: null,
  errorCode: null,
  errorJson: null,
  queuedAt: '2026-08-12T00:00:00.000Z',
  startedAt: '2026-08-12T00:00:00.000Z',
  finishedAt: null,
  createdAt: '2026-08-12T00:00:00.000Z',
  ...overrides,
});

const invocation = (overrides: Partial<ModelInvocation> = {}): ModelInvocation => ({
  id: 'invocation_1',
  jobId: 'job_1',
  status: 'STARTED',
  attemptKind: 'INITIAL',
  transportAttempt: 0,
  providerProfileId: 'provider_1',
  providerRequestId: 'provider-request-1',
  modelId: 'model',
  modelVersion: 'v1',
  parametersJson: '{}',
  requestSnapshotJson: '{}',
  requestSha256: 'request-hash',
  requestSentAt: '2026-08-12T00:00:01.000Z',
  timeoutAt: '2026-08-12T00:02:01.000Z',
  rawResponse: null,
  rawResponseSha256: null,
  responseCompleteAt: null,
  lateResponseAt: null,
  parsedJson: null,
  validationErrorsJson: null,
  inputTokens: null,
  outputTokens: null,
  estimatedCostMicros: null,
  currency: null,
  startedAt: '2026-08-12T00:00:00.000Z',
  finishedAt: null,
  errorCode: null,
  ...overrides,
});

const now = '2026-08-12T00:01:00.000Z';

describe('decideJobRecovery', () => {
  it('QUEUED 且无 Invocation 时保持可领取，不生成新 deadline/timeout', () => {
    expect(decideJobRecovery(job({ status: 'QUEUED', deadlineAt: null }), [], now)).toEqual({
      kind: 'KEEP_QUEUED',
    });
  });

  it('Invocation 已创建但未发送时只请求释放 lease 并重新排队', () => {
    const unsent = invocation({ providerRequestId: null, requestSentAt: null, timeoutAt: null });
    expect(decideJobRecovery(job(), [unsent], now)).toEqual({
      invocationId: unsent.id,
      kind: 'REQUEUE_UNSENT',
    });
  });

  it('已发送未完成进入 unknown outcome，禁止重发', () => {
    expect(decideJobRecovery(job(), [invocation()], now)).toEqual({
      errorCode: 'INTERRUPTED_UNKNOWN_OUTCOME',
      invocationId: 'invocation_1',
      kind: 'FAIL_UNKNOWN_OUTCOME',
    });
  });

  it('完整响应且 hash 正确时恢复校验，不创建新 Invocation', () => {
    expect(
      decideJobRecovery(
        job(),
        [
          invocation({
            rawResponse: new Uint8Array([1]),
            rawResponseSha256: 'response-hash',
            responseCompleteAt: now,
          }),
        ],
        now,
        () => true,
      ),
    ).toEqual({
      invocationId: 'invocation_1',
      kind: 'RESUME_VALIDATION',
    });
  });

  it('取消证据优先，保持 CANCELLED 且后续响应按迟到处理', () => {
    expect(decideJobRecovery(job({ cancelRequestedAt: now }), [invocation()], now)).toEqual({
      invocationId: 'invocation_1',
      kind: 'KEEP_CANCELLED',
    });
  });

  it('超过 Job deadline 时失败且保留原 deadline', () => {
    const expired = job({ deadlineAt: '2026-08-12T00:00:59.000Z' });
    expect(decideJobRecovery(expired, [], now)).toEqual({
      deadlineAt: expired.deadlineAt,
      errorCode: 'JOB_DEADLINE_EXCEEDED',
      kind: 'FAIL_DEADLINE',
    });
  });

  it('超过 Invocation timeout 时失败且保留原 timeout 与 Provider request id', () => {
    const evidence = invocation({ timeoutAt: '2026-08-12T00:00:59.000Z' });
    expect(decideJobRecovery(job(), [evidence], now)).toEqual({
      errorCode: 'MODEL_TIMEOUT',
      invocationId: evidence.id,
      kind: 'FAIL_TIMEOUT',
      providerRequestId: evidence.providerRequestId,
      timeoutAt: evidence.timeoutAt,
    });
  });
});
