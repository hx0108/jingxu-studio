import {
  createJobRunner,
  recoverPendingJobs,
  type CandidateContractValidation,
  type JobRunner,
} from '../jobs/index';
import type { ModelInvocation, ScriptStageJob } from '../ports/persistence/job/index';
import type { ScriptJobRepositories, ScriptUnitOfWorkPort } from '../ports/script/index';
import type { TextModelPort } from '../ports/text-model/index';
import { buildScriptCandidateContract, createScriptCommitHandler } from './script-job-contract';
import {
  type ShotCollectionStoryBibleIds,
  extractShotCollectionBibleKeys,
} from './shot-collection-validator';
import { freezeScriptJobInput } from './script-input-freezer';
import { createScriptJobRequestBuilder, type ScriptPromptSnapshot } from './script-job-request';
import { createScriptRecoveryRevalidator } from './script-job-recovery';
import { createScriptJobScheduler } from './script-job-scheduler';
import {
  createScriptJobSubmission,
  resolvePrimaryInputVersionId,
  type ScriptJobSubmissionPort,
} from './script-job-submission';

export interface ScriptGenerationRuntimeDependencies {
  readonly createInvocationId: (sequence: number) => string;
  readonly createLeaseToken: () => string;
  /** 五阶段为 ScriptStageOutput；SHOT_CONTRACT 为逐镜头 ShotContract（组合根映射）。 */
  readonly finalSchemaId: (stage: ScriptStageJob['stage']) => string;
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly hashText: (value: string) => string;
  readonly loadPromptSnapshot: (job: ScriptStageJob) => Promise<ScriptPromptSnapshot>;
  readonly model: Readonly<{ id: string; providerProfileId: string; version: string }>;
  readonly newId: () => string;
  readonly now: () => string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly promptTemplateId: (stage: ScriptStageJob['stage']) => string;
  readonly textModel: TextModelPort;
  readonly unitOfWork: ScriptUnitOfWorkPort;
  readonly validateCandidate: (job: ScriptStageJob, value: unknown) => CandidateContractValidation;
  readonly validateFinal: (job: ScriptStageJob, value: unknown) => CandidateContractValidation;
}

export interface ScriptGenerationRuntime {
  readonly runner: JobRunner;
  readonly submission: ScriptJobSubmissionPort;
  start(): Promise<void>;
  stop(): Promise<void>;
  whenIdle(): Promise<void>;
}

const responseHashMatches = (
  invocation: ModelInvocation,
  hashText: (value: string) => string,
): boolean =>
  invocation.rawResponse !== null &&
  invocation.rawResponseSha256 !== null &&
  hashText(new TextDecoder().decode(invocation.rawResponse)) === invocation.rawResponseSha256;

const revalidateFrozenInput = async (
  repositories: ScriptJobRepositories,
  job: ScriptStageJob,
  hashPayload: (value: Readonly<Record<string, unknown>>) => string,
): Promise<boolean> => {
  try {
    const current = await freezeScriptJobInput(
      repositories,
      {
        episodeId: job.episodeId,
        expectedInputVersionId: resolvePrimaryInputVersionId(job),
        projectId: job.projectId,
        stage: job.stage,
      },
      hashPayload,
    );
    return current.inputVersionSetHash === job.inputVersionSetHash;
  } catch {
    return false;
  }
};

/** 集合校验所需的冻结 STORY_BIBLE ID 集合；读取失败返回 null（→ COLLECTION 层 STALE_INPUT）。 */
const loadShotCollectionBibleKeys = async (
  unitOfWork: ScriptUnitOfWorkPort,
  job: ScriptStageJob,
): Promise<ShotCollectionStoryBibleIds | null> => {
  try {
    const frozen = JSON.parse(job.inputVersionsJson) as Readonly<{
      references?: readonly Readonly<{
        objectType?: unknown;
        versionId?: unknown;
      }>[];
    }>;
    const bibleRef = (frozen.references ?? []).find(
      ({ objectType }) => objectType === 'STORY_BIBLE_VERSION',
    );
    const bibleVersionId = bibleRef?.versionId;
    if (typeof bibleVersionId !== 'string') return null;
    const version = await unitOfWork.run(({ storyBibleVersions }) =>
      storyBibleVersions.findById(bibleVersionId),
    );
    if (version === null) return null;
    return extractShotCollectionBibleKeys(JSON.parse(version.document));
  } catch {
    return null;
  }
};

/**
 * Owns the complete Script generation lifecycle. Infrastructure only supplies Ports and pure
 * deterministic functions; recovery always finishes before queued work is scheduled.
 */
export const createScriptGenerationRuntime = (
  dependencies: ScriptGenerationRuntimeDependencies,
): ScriptGenerationRuntime => {
  const buildContract = async (job: ScriptStageJob, invocationId: string) =>
    buildScriptCandidateContract(job, invocationId, {
      newId: dependencies.newId,
      validateCandidate: (value) => dependencies.validateCandidate(job, value),
      validateFinal: (value) => dependencies.validateFinal(job, value),
      ...(job.stage === 'SHOT_CONTRACT'
        ? { shotCollection: await loadShotCollectionBibleKeys(dependencies.unitOfWork, job) }
        : {}),
    });
  const commitHandler = createScriptCommitHandler({
    hashDocument: dependencies.hashPayload,
    hashText: dependencies.hashText,
    newId: dependencies.newId,
    now: dependencies.now,
    revalidateFrozenInput: (repositories, job) =>
      revalidateFrozenInput(repositories, job, dependencies.hashPayload),
  });
  const buildRequest = createScriptJobRequestBuilder({
    finalSchemaId: dependencies.finalSchemaId,
    loadPromptSnapshot: dependencies.loadPromptSnapshot,
    parameters: dependencies.parameters,
  });
  const runner = createJobRunner<ScriptJobRepositories>({
    buildContract,
    buildRequest,
    commitHandler,
    createInvocationId: dependencies.createInvocationId,
    createLeaseToken: dependencies.createLeaseToken,
    hash: dependencies.hashText,
    model: dependencies.model,
    now: dependencies.now,
    textModel: dependencies.textModel,
    unitOfWork: dependencies.unitOfWork,
  });
  const scheduler = createScriptJobScheduler(dependencies.unitOfWork, runner);
  let recoveryComplete = false;
  let startPromise: Promise<void> | null = null;
  let stopped = false;
  const submission = createScriptJobSubmission({
    hashPayload: dependencies.hashPayload,
    newId: dependencies.newId,
    now: dependencies.now,
    onQueued: () => {
      if (recoveryComplete) scheduler.kick();
    },
    promptTemplateId: dependencies.promptTemplateId,
    unitOfWork: dependencies.unitOfWork,
  });
  const revalidate = createScriptRecoveryRevalidator({
    buildContract,
    commitHandler,
    now: dependencies.now,
    unitOfWork: dependencies.unitOfWork,
  });

  const start = (): Promise<void> => {
    if (stopped) return Promise.reject(new Error('SCRIPT_RUNTIME_STOPPED'));
    startPromise ??= recoverPendingJobs(dependencies.unitOfWork, {
      now: dependencies.now,
      responseHashMatches: (invocation) => responseHashMatches(invocation, dependencies.hashText),
      revalidate,
    }).then(() => {
      recoveryComplete = true;
      if (!stopped) {
        scheduler.kick();
      }
    });
    return startPromise;
  };

  return Object.freeze({
    runner,
    start,
    stop: async () => {
      stopped = true;
      await (startPromise ?? Promise.resolve());
      await scheduler.stop();
    },
    submission,
    whenIdle: () => scheduler.whenIdle(),
  });
};
