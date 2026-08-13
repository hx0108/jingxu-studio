import type { JobCreateInputDto } from '@jingxu/contracts';

import type { ScriptStageJob } from '../ports/persistence/job/index';
import type { ScriptUnitOfWorkPort, StagedScriptStage } from '../ports/script/index';
import { freezeScriptJobInput, ScriptPrerequisiteError } from './script-input-freezer';

export interface ScriptJobSubmissionDependencies {
  readonly unitOfWork: ScriptUnitOfWorkPort;
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly newId: () => string;
  readonly now: () => string;
  readonly promptTemplateId: (stage: JobCreateInputDto['stage']) => string;
  readonly onQueued?: (jobId: string) => void;
}

export interface ScriptJobSubmissionPort {
  submit(input: JobCreateInputDto, traceId: string): Promise<ScriptStageJob>;
  requeue(jobId: string, traceId: string): Promise<ScriptStageJob>;
}

export class ScriptJobSubmissionError extends Error {
  public constructor(
    public readonly code:
      | ScriptPrerequisiteError['code']
      | 'JOB_NOT_FOUND'
      | 'JOB_VERSION_CONFLICT'
      | 'SCRIPT_STAGE_UNSUPPORTED',
  ) {
    super(code);
    this.name = 'ScriptJobSubmissionError';
  }
}

const STAGED_SCRIPT_STAGES = new Set<string>([
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
]);

const isStagedScriptStage = (value: string): value is StagedScriptStage =>
  STAGED_SCRIPT_STAGES.has(value);

const requireSupported: (
  value: Readonly<{ operationType: string; stage: string }>,
) => asserts value is Readonly<{ operationType: 'GENERATE'; stage: StagedScriptStage }> = (
  value,
) => {
  if (value.operationType !== 'GENERATE' || !isStagedScriptStage(value.stage)) {
    throw new ScriptJobSubmissionError('SCRIPT_STAGE_UNSUPPORTED');
  }
};

const primaryInputVersionId = (job: ScriptStageJob): string => {
  let parsed: unknown;
  try {
    const value: unknown = JSON.parse(job.inputVersionsJson);
    parsed = value;
  } catch {
    throw new ScriptJobSubmissionError('JOB_VERSION_CONFLICT');
  }
  if (typeof parsed !== 'object' || parsed === null || !('references' in parsed)) {
    throw new ScriptJobSubmissionError('JOB_VERSION_CONFLICT');
  }
  const references = (parsed as Readonly<{ references?: unknown }>).references;
  if (!Array.isArray(references)) throw new ScriptJobSubmissionError('JOB_VERSION_CONFLICT');
  const primary = references.find((candidate: unknown) => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const reference = candidate as Readonly<{ kind?: unknown; stage?: unknown }>;
    switch (job.stage) {
      case 'CONCEPT':
        return reference.kind === 'SOURCE_INPUT';
      case 'STORY_BIBLE':
        return reference.kind === 'STAGE_VERSION' && reference.stage === 'CONCEPT';
      case 'EPISODE_OUTLINE':
        return reference.kind === 'STAGE_VERSION' && reference.stage === 'STORY_BIBLE';
      case 'BEAT_SHEET':
        return reference.kind === 'STAGE_VERSION' && reference.stage === 'EPISODE_OUTLINE';
      case 'SCENE_SCRIPT':
        return reference.kind === 'STAGE_VERSION' && reference.stage === 'BEAT_SHEET';
      default:
        return false;
    }
  });
  const id =
    typeof primary === 'object' && primary !== null && 'id' in primary
      ? (primary as Readonly<{ id?: unknown }>).id
      : null;
  if (typeof id !== 'string') throw new ScriptJobSubmissionError('JOB_VERSION_CONFLICT');
  return id;
};

/** Freezes current prerequisites and inserts QUEUED in the same short transaction. */
export const createScriptJobSubmission = (
  dependencies: ScriptJobSubmissionDependencies,
): ScriptJobSubmissionPort => {
  const submit: ScriptJobSubmissionPort['submit'] = async (input, traceId) => {
    requireSupported(input);
    const stage = input.stage;
    try {
      const job = await dependencies.unitOfWork.run(async (repositories) => {
        const existing = await repositories.jobs.findByIdempotencyKey(
          input.projectId,
          input.idempotencyKey,
        );
        if (existing !== null) return existing;
        const frozen = await freezeScriptJobInput(repositories, input, dependencies.hashPayload);
        const at = dependencies.now();
        const candidate: ScriptStageJob = {
          cancelRequestedAt: null,
          createdAt: at,
          deadlineAt: null,
          episodeId: input.episodeId,
          errorCode: null,
          errorJson: null,
          finishedAt: null,
          id: dependencies.newId(),
          idempotencyKey: input.idempotencyKey,
          inputVersionSetHash: frozen.inputVersionSetHash,
          inputVersionsJson: frozen.inputVersionsJson,
          leaseExpiresAt: null,
          leaseToken: null,
          lockSnapshotHash: dependencies.hashPayload({ locks: [] }),
          operationType: 'GENERATE',
          projectId: input.projectId,
          promptTemplateId: dependencies.promptTemplateId(stage),
          queuedAt: at,
          selectionJson: null,
          stage,
          startedAt: null,
          status: 'QUEUED',
          structureRepairAttempts: 0,
          transportAttempts: 0,
          userOperationId: traceId,
          writeSetJson: JSON.stringify(['/data']),
        };
        await repositories.jobs.insert(candidate);
        return candidate;
      });
      dependencies.onQueued?.(job.id);
      return job;
    } catch (caught: unknown) {
      if (caught instanceof ScriptPrerequisiteError) {
        throw new ScriptJobSubmissionError(caught.code);
      }
      throw caught;
    }
  };

  const requeue: ScriptJobSubmissionPort['requeue'] = async (jobId, traceId) => {
    try {
      const job = await dependencies.unitOfWork.run(async (repositories) => {
        const failed = await repositories.jobs.findById(jobId);
        if (failed === null) throw new ScriptJobSubmissionError('JOB_NOT_FOUND');
        if (failed.status !== 'FAILED') {
          throw new ScriptJobSubmissionError('JOB_VERSION_CONFLICT');
        }
        requireSupported(failed);
        const stage = failed.stage;
        const retryIdempotencyKey = `${failed.idempotencyKey}:retry:${failed.id}`;
        const existing = await repositories.jobs.findByIdempotencyKey(
          failed.projectId,
          retryIdempotencyKey,
        );
        if (existing !== null) return existing;

        const frozen = await freezeScriptJobInput(
          repositories,
          {
            episodeId: failed.episodeId,
            expectedInputVersionId: primaryInputVersionId(failed),
            projectId: failed.projectId,
            stage,
          },
          dependencies.hashPayload,
        );
        const at = dependencies.now();
        const retry: ScriptStageJob = {
          ...failed,
          cancelRequestedAt: null,
          createdAt: at,
          deadlineAt: null,
          errorCode: null,
          errorJson: null,
          finishedAt: null,
          id: dependencies.newId(),
          idempotencyKey: retryIdempotencyKey,
          inputVersionSetHash: frozen.inputVersionSetHash,
          inputVersionsJson: frozen.inputVersionsJson,
          leaseExpiresAt: null,
          leaseToken: null,
          lockSnapshotHash: dependencies.hashPayload({ locks: [] }),
          promptTemplateId: dependencies.promptTemplateId(stage),
          queuedAt: at,
          selectionJson: null,
          startedAt: null,
          status: 'QUEUED',
          structureRepairAttempts: 0,
          transportAttempts: 0,
          userOperationId: traceId,
          writeSetJson: JSON.stringify(['/data']),
        };
        await repositories.jobs.insert(retry);
        return retry;
      });
      dependencies.onQueued?.(job.id);
      return job;
    } catch (caught: unknown) {
      if (caught instanceof ScriptPrerequisiteError) {
        throw new ScriptJobSubmissionError(caught.code);
      }
      throw caught;
    }
  };
  return { requeue, submit };
};
