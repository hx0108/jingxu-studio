import type { ScriptStage } from '@jingxu/contracts';

export type JobStatus =
  'DRAFT' | 'QUEUED' | 'RUNNING' | 'VALIDATING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export type JobOperationType =
  'GENERATE' | 'CONTINUE' | 'SHORTEN' | 'REWRITE' | 'STRENGTHEN_CONFLICT';

export interface ScriptStageJob {
  readonly id: string;
  readonly projectId: string;
  readonly episodeId: string | null;
  readonly stage: ScriptStage;
  readonly operationType: JobOperationType;
  readonly status: JobStatus;
  readonly idempotencyKey: string;
  readonly userOperationId: string;
  readonly inputVersionsJson: string;
  readonly inputVersionSetHash: string;
  readonly selectionJson: string | null;
  readonly writeSetJson: string;
  readonly lockSnapshotHash: string;
  readonly promptTemplateId: string;
  readonly transportAttempts: number;
  readonly structureRepairAttempts: number;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly deadlineAt: string | null;
  readonly cancelRequestedAt: string | null;
  readonly errorCode: string | null;
  readonly errorJson: string | null;
  readonly queuedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

export type ModelInvocationStatus =
  'STARTED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED_UNKNOWN_OUTCOME';

export type ModelInvocationAttemptKind = 'INITIAL' | 'TRANSPORT_RETRY' | 'STRUCTURE_REPAIR';

export interface ModelInvocation {
  readonly id: string;
  readonly jobId: string;
  readonly status: ModelInvocationStatus;
  readonly attemptKind: ModelInvocationAttemptKind;
  readonly transportAttempt: number;
  readonly providerProfileId: string;
  readonly providerRequestId: string | null;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly parametersJson: string;
  readonly requestSnapshotJson: string;
  readonly requestSha256: string;
  readonly requestSentAt: string | null;
  readonly timeoutAt: string | null;
  readonly rawResponse: Uint8Array | null;
  readonly rawResponseSha256: string | null;
  readonly responseCompleteAt: string | null;
  readonly lateResponseAt: string | null;
  readonly parsedJson: string | null;
  readonly validationErrorsJson: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCostMicros: number | null;
  readonly currency: 'CNY' | 'USD' | 'CREDIT' | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
}
