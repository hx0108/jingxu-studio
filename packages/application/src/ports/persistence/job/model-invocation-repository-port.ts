import type { ModelInvocation, ModelInvocationStatus } from './job-types';

export interface ResponseEvidence {
  readonly invocationId: string;
  readonly providerRequestId: string | null;
  readonly rawResponse: Uint8Array;
  readonly rawResponseSha256: string;
  readonly responseCompleteAt: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** Transaction-scoped invocation evidence persistence. Raw response bytes remain project data. */
export interface ModelInvocationRepositoryPort {
  findById(id: string): Promise<ModelInvocation | null>;
  listByJobId(jobId: string): Promise<readonly ModelInvocation[]>;
  listRecoveryEvidence(jobIds: readonly string[]): Promise<readonly ModelInvocation[]>;
  insert(invocation: ModelInvocation): Promise<void>;
  markRequestSent(invocationId: string, requestSentAt: string, timeoutAt: string): Promise<boolean>;
  recordResponse(evidence: ResponseEvidence): Promise<boolean>;
  recordLateResponse(
    invocationId: string,
    rawResponseSha256: string,
    lateResponseAt: string,
  ): Promise<boolean>;
  finish(
    invocationId: string,
    status: ModelInvocationStatus,
    finishedAt: string,
    errorCode: string | null,
  ): Promise<boolean>;
}
