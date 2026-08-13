import { describe, expect, it, vi } from 'vitest';

import { recoverPendingJobs } from './job-recovery-executor';

import type {
  JobRepositories,
  JobUnitOfWorkPort,
  ModelInvocation,
  ScriptStageJob,
  TransitionJobCommand,
} from '../../ports/persistence/job/index';

const job = (
  id: string,
  status: ScriptStageJob['status'],
  overrides: Partial<ScriptStageJob> = {},
): ScriptStageJob => ({
  id,
  projectId: `project_${id}`,
  episodeId: null,
  stage: 'CONCEPT',
  operationType: 'GENERATE',
  status,
  idempotencyKey: `key_${id}`,
  userOperationId: `operation_${id}`,
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

const invocation = (jobId: string, overrides: Partial<ModelInvocation> = {}): ModelInvocation => ({
  id: `inv_${jobId}`,
  jobId,
  status: 'STARTED',
  attemptKind: 'INITIAL',
  transportAttempt: 0,
  providerProfileId: 'provider',
  providerRequestId: 'provider-request',
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

const setup = (jobs: readonly ScriptStageJob[], invocations: readonly ModelInvocation[]) => {
  const transition = vi.fn<(command: TransitionJobCommand) => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  const releaseUnsentForRecovery = vi.fn(() => Promise.resolve(true));
  const repositories = {
    jobs: {
      listByStatuses: vi.fn(() => Promise.resolve(jobs)),
      transition,
      releaseUnsentForRecovery,
    },
    invocations: { listRecoveryEvidence: vi.fn(() => Promise.resolve(invocations)) },
  } as unknown as JobRepositories;
  const unitOfWork: JobUnitOfWorkPort = { run: (work) => work(repositories) };
  return { releaseUnsentForRecovery, transition, unitOfWork };
};

describe('recoverPendingJobs', () => {
  it('逐条执行未知结果、timeout 与 deadline 终态，且绝不重新排队', async () => {
    const unknown = job('unknown', 'RUNNING');
    const timedOut = job('timeout', 'RUNNING');
    const deadline = job('deadline', 'RUNNING', { deadlineAt: '2026-08-12T00:00:59.000Z' });
    const { transition, unitOfWork } = setup(
      [unknown, timedOut, deadline],
      [invocation(unknown.id), invocation(timedOut.id, { timeoutAt: '2026-08-12T00:00:59.000Z' })],
    );

    const results = await recoverPendingJobs(unitOfWork, {
      now: () => '2026-08-12T00:01:00.000Z',
      responseHashMatches: () => false,
      revalidate: vi.fn(),
    });

    expect(results.map((item) => item.kind)).toEqual([
      'FAIL_UNKNOWN_OUTCOME',
      'FAIL_TIMEOUT',
      'FAIL_DEADLINE',
    ]);
    expect(transition).toHaveBeenCalledTimes(3);
    expect(transition.mock.calls.map(([value]) => value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ errorCode: 'INTERRUPTED_UNKNOWN_OUTCOME', nextStatus: 'FAILED' }),
        expect.objectContaining({ errorCode: 'MODEL_TIMEOUT', nextStatus: 'FAILED' }),
        expect.objectContaining({ errorCode: 'JOB_DEADLINE_EXCEEDED', nextStatus: 'FAILED' }),
      ]),
    );
    expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'QUEUED' }));
  });

  it('完整响应只走注入的幂等 revalidate handler', async () => {
    const validating = job('validating', 'VALIDATING');
    const complete = invocation(validating.id, {
      rawResponse: new Uint8Array([1]),
      rawResponseSha256: 'response-hash',
      responseCompleteAt: '2026-08-12T00:00:10.000Z',
    });
    const { transition, unitOfWork } = setup([validating], [complete]);
    const revalidate = vi.fn(() => Promise.resolve());

    await recoverPendingJobs(unitOfWork, {
      now: () => '2026-08-12T00:01:00.000Z',
      responseHashMatches: () => true,
      revalidate,
    });

    expect(revalidate).toHaveBeenCalledWith(validating, complete);
    expect(transition).not.toHaveBeenCalled();
  });

  it('条件—完整响应 hash 不匹配—不重校验并终态为证据无效', async () => {
    const validating = job('hash-mismatch', 'VALIDATING');
    const complete = invocation(validating.id, {
      rawResponse: new Uint8Array([1]),
      rawResponseSha256: 'persisted-hash',
      responseCompleteAt: '2026-08-12T00:00:10.000Z',
    });
    const { transition, unitOfWork } = setup([validating], [complete]);
    const revalidate = vi.fn(() => Promise.resolve());

    const results = await recoverPendingJobs(unitOfWork, {
      now: () => '2026-08-12T00:01:00.000Z',
      responseHashMatches: () => false,
      revalidate,
    });

    expect(results[0]?.kind).toBe('FAIL_INVALID_EVIDENCE');
    expect(revalidate).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'RECOVERY_EVIDENCE_INVALID', nextStatus: 'FAILED' }),
    );
  });

  it.each([
    ['STALE_INPUT', 'STALE_INPUT'],
    ['SCRIPT_SCHEMA_INVALID', 'JOB_COMMIT_FAILED'],
  ] as const)(
    '条件—恢复重校验抛 %s—不得卡在 VALIDATING 并以 %s 终态化',
    async (message, expectedCode) => {
      const validating = job(`revalidate-${message}`, 'VALIDATING');
      const complete = invocation(validating.id, {
        rawResponse: new Uint8Array([1]),
        rawResponseSha256: 'response-hash',
        responseCompleteAt: '2026-08-12T00:00:10.000Z',
      });
      const { transition, unitOfWork } = setup([validating], [complete]);

      await recoverPendingJobs(unitOfWork, {
        now: () => '2026-08-12T00:01:00.000Z',
        responseHashMatches: () => true,
        revalidate: () => Promise.reject(new Error(message)),
      });

      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: expectedCode, nextStatus: 'FAILED' }),
      );
    },
  );

  it('取消保持不写；未发送仅调用专用 release 且保留原 deadline/timeout', async () => {
    const cancelled = job('cancelled', 'RUNNING', {
      cancelRequestedAt: '2026-08-12T00:00:30.000Z',
    });
    const unsent = job('unsent', 'RUNNING');
    const unsentInvocation = invocation(unsent.id, { requestSentAt: null, timeoutAt: null });
    const { releaseUnsentForRecovery, transition, unitOfWork } = setup(
      [cancelled, unsent],
      [invocation(cancelled.id), unsentInvocation],
    );

    await recoverPendingJobs(unitOfWork, {
      now: () => '2026-08-12T00:01:00.000Z',
      responseHashMatches: () => false,
      revalidate: vi.fn(),
    });

    expect(transition).not.toHaveBeenCalled();
    expect(releaseUnsentForRecovery).toHaveBeenCalledWith({
      expectedLeaseToken: unsent.leaseToken,
      jobId: unsent.id,
      leaseExpiredAt: '2026-08-12T00:01:00.000Z',
    });
  });
});
