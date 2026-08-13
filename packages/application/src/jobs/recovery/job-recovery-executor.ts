import { decideJobRecovery, type JobRecoveryDecision } from './job-recovery';

import type {
  JobUnitOfWorkPort,
  ModelInvocation,
  ScriptStageJob,
} from '../../ports/persistence/job/index';

export interface JobRecoveryExecutorDependencies {
  readonly now: () => string;
  readonly responseHashMatches: (invocation: ModelInvocation) => boolean;
  /** Handler SHALL be idempotent and perform deterministic validation/commit without Provider calls. */
  readonly revalidate: (job: ScriptStageJob, invocation: ModelInvocation) => Promise<void>;
}

export interface ExecutedJobRecovery {
  readonly decision: JobRecoveryDecision;
  readonly jobId: string;
  readonly kind: JobRecoveryDecision['kind'];
}

const failureErrorJson = (decision: JobRecoveryDecision): string | null => {
  switch (decision.kind) {
    case 'FAIL_DEADLINE':
      return JSON.stringify({ deadlineAt: decision.deadlineAt });
    case 'FAIL_TIMEOUT':
      return JSON.stringify({
        invocationId: decision.invocationId,
        providerRequestId: decision.providerRequestId,
        timeoutAt: decision.timeoutAt,
      });
    case 'FAIL_UNKNOWN_OUTCOME':
      return JSON.stringify({ invocationId: decision.invocationId });
    default:
      return null;
  }
};

const terminalizeRecoveryFailure = async (
  unitOfWork: JobUnitOfWorkPort,
  job: ScriptStageJob,
  errorCode: string,
  errorJson: string | null,
  finishedAt: string,
): Promise<void> => {
  await unitOfWork.run(async ({ jobs }) => {
    const transitioned = await jobs.transition({
      errorCode,
      errorJson,
      expectedStatus: job.status,
      finishedAt,
      jobId: job.id,
      nextStatus: 'FAILED',
      structureRepairAttempts: job.structureRepairAttempts,
      transportAttempts: job.transportAttempts,
    });
    if (!transitioned) throw new Error('RECOVERY_CONCURRENT_WRITE');
  });
};

/** Executes startup recovery from persisted evidence without issuing Provider requests. */
export const recoverPendingJobs = async (
  unitOfWork: JobUnitOfWorkPort,
  dependencies: JobRecoveryExecutorDependencies,
): Promise<readonly ExecutedJobRecovery[]> => {
  const snapshot = await unitOfWork.run(async ({ invocations, jobs }) => {
    const pendingJobs = await jobs.listByStatuses(['QUEUED', 'RUNNING', 'VALIDATING'], 100);
    const evidence = await invocations.listRecoveryEvidence(pendingJobs.map((job) => job.id));
    return { evidence, pendingJobs };
  });
  const evidenceByJob = new Map<string, ModelInvocation[]>();
  for (const invocation of snapshot.evidence) {
    const values = evidenceByJob.get(invocation.jobId) ?? [];
    values.push(invocation);
    evidenceByJob.set(invocation.jobId, values);
  }

  const results: ExecutedJobRecovery[] = [];
  for (const job of snapshot.pendingJobs) {
    const invocations = evidenceByJob.get(job.id) ?? [];
    const recoveryNow = dependencies.now();
    const decision = decideJobRecovery(
      job,
      invocations,
      recoveryNow,
      dependencies.responseHashMatches,
    );

    if (decision.kind === 'REQUEUE_UNSENT') {
      const expectedLeaseToken = job.leaseToken;
      if (expectedLeaseToken !== null) {
        await unitOfWork.run(({ jobs }) =>
          jobs.releaseUnsentForRecovery({
            expectedLeaseToken,
            jobId: job.id,
            leaseExpiredAt: recoveryNow,
          }),
        );
      }
    } else if (
      decision.kind === 'FAIL_DEADLINE' ||
      decision.kind === 'FAIL_TIMEOUT' ||
      decision.kind === 'FAIL_UNKNOWN_OUTCOME' ||
      decision.kind === 'FAIL_INVALID_EVIDENCE'
    ) {
      await terminalizeRecoveryFailure(
        unitOfWork,
        job,
        decision.errorCode,
        failureErrorJson(decision),
        recoveryNow,
      );
    } else if (decision.kind === 'RESUME_VALIDATION') {
      const invocation = invocations.find((item) => item.id === decision.invocationId);
      if (invocation !== undefined) {
        try {
          await dependencies.revalidate(job, invocation);
        } catch (error) {
          const errorCode =
            error instanceof Error && error.message === 'STALE_INPUT'
              ? 'STALE_INPUT'
              : 'JOB_COMMIT_FAILED';
          await terminalizeRecoveryFailure(
            unitOfWork,
            job,
            errorCode,
            JSON.stringify({ code: errorCode }),
            recoveryNow,
          );
        }
      }
    }

    results.push(Object.freeze({ decision, jobId: job.id, kind: decision.kind }));
  }
  return Object.freeze(results);
};
