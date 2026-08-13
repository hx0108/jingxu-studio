import { executeCandidateContract } from '../candidate-contract/index';

import type {
  CandidateContractDependencies,
  CandidateContractFailure,
} from '../candidate-contract/index';
import type {
  JobRepositories,
  ModelInvocation,
  ModelInvocationAttemptKind,
  NormalizedModelError,
  ScriptStageJob,
  TextGenerationRequest,
  TextGenerationResult,
  TextModelPort,
} from '../../index';

export type JobRunnerOutcome =
  | Readonly<{ status: 'NOT_CLAIMED' | 'SUCCEEDED' | 'CANCELLED' }>
  | Readonly<{ errorCode: string; status: 'FAILED' }>;

export interface JobRunnerUnitOfWorkPort<Repositories extends JobRepositories = JobRepositories> {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

export interface JobCommitHandler<Repositories extends JobRepositories = JobRepositories> {
  /** 在 JobRunner 提供的最终短事务中写业务版本、指针与审计；不得自行提交。 */
  commit(repositories: Repositories, value: unknown, job: ScriptStageJob): Promise<void>;
}

export interface JobStructureRepairRequest {
  readonly failure: CandidateContractFailure;
  readonly rawText: string;
}

export interface JobRunnerDependencies<Repositories extends JobRepositories = JobRepositories> {
  readonly buildContract: (
    job: ScriptStageJob,
    invocationId: string,
  ) => Omit<CandidateContractDependencies, 'commit' | 'repair'>;
  readonly buildRequest: (
    job: ScriptStageJob,
    invocationId: string,
    repair?: JobStructureRepairRequest,
  ) => TextGenerationRequest;
  readonly commitHandler: JobCommitHandler<Repositories>;
  readonly createAbortController?: () => AbortController;
  readonly createInvocationId: (sequence: number) => string;
  readonly createLeaseToken: () => string;
  readonly hash: (value: string) => string;
  readonly model: Readonly<{ id: string; providerProfileId: string; version: string }>;
  readonly now: () => string;
  readonly onAbort?: (jobId: string) => void;
  readonly textModel: TextModelPort;
  readonly unitOfWork: JobRunnerUnitOfWorkPort<Repositories>;
}

export interface JobRunner {
  cancel(jobId: string): Promise<Readonly<{ status: 'CANCELLED' | 'NOT_CANCELLED' }>>;
  run(jobId: string): Promise<JobRunnerOutcome>;
}

const plusMilliseconds = (iso: string, milliseconds: number): string =>
  new Date(Date.parse(iso) + milliseconds).toISOString();

const requireWrite = (written: boolean): void => {
  if (!written) throw new Error('JOB_CONCURRENT_WRITE_REJECTED');
};

const retryableTransport = (error: NormalizedModelError): boolean =>
  error.code === 'MODEL_NETWORK_ERROR' ||
  error.code === 'MODEL_RATE_LIMITED' ||
  error.code === 'MODEL_PROVIDER_ERROR';

class TerminalOutcomeError extends Error {
  public constructor(public readonly outcome: JobRunnerOutcome) {
    super(outcome.status);
  }
}

type InvocationGeneration = Readonly<{
  invocationId: string;
  result: TextGenerationResult;
}>;

/**
 * 创建 Application 层确定性 JobRunner。所有 Provider 调用均在 UnitOfWork 外执行。
 */
export const createJobRunner = <Repositories extends JobRepositories = JobRepositories>(
  dependencies: JobRunnerDependencies<Repositories>,
): JobRunner => {
  const active = new Map<string, Readonly<{ controller: AbortController; invocationId: string }>>();
  let invocationSequence = 0;

  const failJob = async (
    jobId: string,
    expectedStatus: 'RUNNING' | 'VALIDATING',
    errorCode: string,
    transportAttempts: number,
    structureRepairAttempts: number,
  ): Promise<JobRunnerOutcome> => {
    const at = dependencies.now();
    await dependencies.unitOfWork.run(async ({ jobs }) => {
      requireWrite(
        await jobs.transition({
          errorCode,
          errorJson: JSON.stringify({ code: errorCode }),
          expectedStatus,
          finishedAt: at,
          jobId,
          nextStatus: 'FAILED',
          structureRepairAttempts,
          transportAttempts,
        }),
      );
    });
    return Object.freeze({ errorCode, status: 'FAILED' });
  };

  const invoke = async (
    job: ScriptStageJob,
    attemptKind: ModelInvocationAttemptKind,
    transportAttempts: number,
    structureRepairAttempts: number,
    repair?: JobStructureRepairRequest,
  ): Promise<InvocationGeneration | JobRunnerOutcome> => {
    let currentTransportAttempts = transportAttempts;
    let currentKind = attemptKind;
    for (;;) {
      const invocationId = dependencies.createInvocationId(++invocationSequence);
      const at = dependencies.now();
      const request = dependencies.buildRequest(job, invocationId, repair);
      const invocation: ModelInvocation = {
        attemptKind: currentKind,
        currency: null,
        errorCode: null,
        estimatedCostMicros: null,
        finishedAt: null,
        id: invocationId,
        inputTokens: null,
        jobId: job.id,
        lateResponseAt: null,
        modelId: dependencies.model.id,
        modelVersion: dependencies.model.version,
        outputTokens: null,
        parametersJson: JSON.stringify(request.parameters),
        parsedJson: null,
        providerProfileId: dependencies.model.providerProfileId,
        providerRequestId: null,
        rawResponse: null,
        rawResponseSha256: null,
        requestSentAt: null,
        requestSha256: dependencies.hash(JSON.stringify(request)),
        requestSnapshotJson: JSON.stringify(request),
        responseCompleteAt: null,
        startedAt: at,
        status: 'STARTED',
        timeoutAt: null,
        transportAttempt: currentTransportAttempts + 1,
        validationErrorsJson: null,
      };
      await dependencies.unitOfWork.run(async ({ invocations }) => {
        await invocations.insert(invocation);
        requireWrite(
          await invocations.markRequestSent(invocationId, at, plusMilliseconds(at, 120_000)),
        );
      });

      const controller = dependencies.createAbortController?.() ?? new AbortController();
      active.set(job.id, Object.freeze({ controller, invocationId }));
      try {
        const generated = await dependencies.textModel.generate(request, controller.signal);
        const responseAt = dependencies.now();
        const cancelled = await dependencies.unitOfWork.run(async ({ invocations, jobs }) => {
          const latest = await jobs.findById(job.id);
          if (latest?.status === 'CANCELLED' || latest?.cancelRequestedAt !== null) {
            requireWrite(
              await invocations.recordLateResponse(
                invocationId,
                dependencies.hash(generated.rawText),
                responseAt,
              ),
            );
            return true;
          }
          requireWrite(
            await invocations.recordResponse({
              inputTokens: generated.usage.inputTokens,
              invocationId,
              outputTokens: generated.usage.outputTokens,
              providerRequestId: generated.providerRequestId,
              rawResponse: new TextEncoder().encode(generated.rawText),
              rawResponseSha256: dependencies.hash(generated.rawText),
              responseCompleteAt: responseAt,
            }),
          );
          requireWrite(await invocations.finish(invocationId, 'SUCCEEDED', responseAt, null));
          requireWrite(
            await jobs.transition({
              errorCode: null,
              errorJson: null,
              expectedStatus: 'RUNNING',
              finishedAt: null,
              jobId: job.id,
              nextStatus: 'VALIDATING',
              structureRepairAttempts,
              transportAttempts: currentTransportAttempts,
            }),
          );
          return false;
        });
        return cancelled
          ? Object.freeze({ status: 'CANCELLED' as const })
          : Object.freeze({ invocationId, result: generated });
      } catch (unknownError) {
        const failedAt = dependencies.now();
        const cancelled = await dependencies.unitOfWork.run(async ({ invocations, jobs }) => {
          const latest = await jobs.findById(job.id);
          if (
            latest === null ||
            (latest.status !== 'CANCELLED' && latest.cancelRequestedAt === null)
          )
            return false;
          requireWrite(await invocations.finish(invocationId, 'CANCELLED', failedAt, null));
          return true;
        });
        if (cancelled) return Object.freeze({ status: 'CANCELLED' as const });
        const normalized = dependencies.textModel.normalizeError(unknownError);
        if (retryableTransport(normalized) && currentTransportAttempts < 2) {
          currentTransportAttempts += 1;
          await dependencies.unitOfWork.run(async ({ invocations, jobs }) => {
            requireWrite(
              await invocations.finish(invocationId, 'FAILED', failedAt, normalized.code),
            );
            requireWrite(
              await jobs.transition({
                errorCode: normalized.code,
                errorJson: JSON.stringify({ code: normalized.code }),
                expectedStatus: 'RUNNING',
                finishedAt: null,
                jobId: job.id,
                nextStatus: 'RUNNING',
                structureRepairAttempts,
                transportAttempts: currentTransportAttempts,
              }),
            );
          });
          currentKind = 'TRANSPORT_RETRY';
          continue;
        }
        await dependencies.unitOfWork.run(async ({ invocations, jobs }) => {
          requireWrite(await invocations.finish(invocationId, 'FAILED', failedAt, normalized.code));
          requireWrite(
            await jobs.transition({
              errorCode: normalized.code,
              errorJson: JSON.stringify({ code: normalized.code }),
              expectedStatus: 'RUNNING',
              finishedAt: failedAt,
              jobId: job.id,
              nextStatus: 'FAILED',
              structureRepairAttempts,
              transportAttempts: currentTransportAttempts,
            }),
          );
        });
        return Object.freeze({ errorCode: normalized.code, status: 'FAILED' as const });
      } finally {
        if (active.get(job.id)?.invocationId === invocationId) active.delete(job.id);
      }
    }
  };

  return Object.freeze({
    cancel: async (jobId: string) => {
      const at = dependencies.now();
      const cancelled = await dependencies.unitOfWork.run(async ({ jobs }) => {
        const job = await jobs.findById(jobId);
        if (job === null || !['QUEUED', 'RUNNING', 'VALIDATING'].includes(job.status)) return false;
        return jobs.cancel({
          cancelRequestedAt: at,
          expectedStatus: job.status as 'QUEUED' | 'RUNNING' | 'VALIDATING',
          finishedAt: at,
          jobId,
        });
      });
      if (!cancelled) return Object.freeze({ status: 'NOT_CANCELLED' as const });
      const running = active.get(jobId);
      if (running !== undefined) {
        running.controller.abort();
        dependencies.onAbort?.(jobId);
      }
      return Object.freeze({ status: 'CANCELLED' as const });
    },
    run: async (jobId: string) => {
      const at = dependencies.now();
      const claimed = await dependencies.unitOfWork.run(async ({ jobs }) => {
        const won = await jobs.claimQueued({
          deadlineAt: plusMilliseconds(at, 300_000),
          jobId,
          leaseExpiresAt: plusMilliseconds(at, 30_000),
          leaseToken: dependencies.createLeaseToken(),
          startedAt: at,
        });
        return won ? jobs.findById(jobId) : null;
      });
      if (claimed === null) return Object.freeze({ status: 'NOT_CLAIMED' as const });

      const initial = await invoke(claimed, 'INITIAL', 0, 0);
      if (!('result' in initial)) return initial;
      let latestInvocationId = initial.invocationId;
      let activeContract = dependencies.buildContract(claimed, latestInvocationId);
      try {
        const contractResult = await executeCandidateContract(initial.result.rawText, {
          injectSystemFields: (candidate) => activeContract.injectSystemFields(candidate),
          validateCandidate: (candidate) => activeContract.validateCandidate(candidate),
          validateCollection: (value) => activeContract.validateCollection(value),
          validateFinal: (value) => activeContract.validateFinal(value),
          ...(activeContract.validatePreCommit === undefined
            ? {}
            : {
                validatePreCommit: (value: unknown) =>
                  activeContract.validatePreCommit?.(value) ??
                  Object.freeze({ code: 'PRE_COMMIT_VALIDATOR_MISSING', valid: false as const }),
              }),
          commit: (value) =>
            dependencies.unitOfWork.run(async (repositories) => {
              const latest = await repositories.jobs.findById(jobId);
              if (latest?.status !== 'VALIDATING') throw new Error('JOB_NOT_VALIDATING');
              await dependencies.commitHandler.commit(repositories, value, latest);
              requireWrite(
                await repositories.jobs.transition({
                  errorCode: null,
                  errorJson: null,
                  expectedStatus: 'VALIDATING',
                  finishedAt: dependencies.now(),
                  jobId,
                  nextStatus: 'SUCCEEDED',
                  structureRepairAttempts: latest.structureRepairAttempts,
                  transportAttempts: latest.transportAttempts,
                }),
              );
            }),
          repair: async (rawText, failure) => {
            let transportAttempts = 0;
            await dependencies.unitOfWork.run(async ({ jobs }) => {
              const latest = await jobs.findById(jobId);
              if (latest?.status !== 'VALIDATING') throw new Error('JOB_NOT_VALIDATING');
              transportAttempts = latest.transportAttempts;
              requireWrite(
                await jobs.transition({
                  errorCode: failure.code,
                  errorJson: JSON.stringify(failure),
                  expectedStatus: 'VALIDATING',
                  finishedAt: null,
                  jobId,
                  nextStatus: 'RUNNING',
                  structureRepairAttempts: 1,
                  transportAttempts: latest.transportAttempts,
                }),
              );
            });
            const repaired = await invoke(
              claimed,
              'STRUCTURE_REPAIR',
              transportAttempts,
              1,
              Object.freeze({ failure, rawText }),
            );
            if (!('result' in repaired)) throw new TerminalOutcomeError(repaired);
            latestInvocationId = repaired.invocationId;
            activeContract = dependencies.buildContract(claimed, latestInvocationId);
            return repaired.result.rawText;
          },
        });
        if (contractResult.status === 'SUCCEEDED') {
          return Object.freeze({ status: 'SUCCEEDED' as const });
        }
        const latest = await dependencies.unitOfWork.run(({ jobs }) => jobs.findById(jobId));
        if (latest?.status !== 'VALIDATING') throw new Error('JOB_NOT_VALIDATING');
        return await failJob(
          jobId,
          'VALIDATING',
          contractResult.errorCode,
          latest.transportAttempts,
          contractResult.structureRepairAttempts,
        );
      } catch (error) {
        if (error instanceof TerminalOutcomeError) return error.outcome;
        throw error;
      }
    },
  });
};
