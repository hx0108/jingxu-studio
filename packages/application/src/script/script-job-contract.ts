import type { CandidateContractValidation, JobCommitHandler } from '../jobs/index';
import type { ScriptStageJob } from '../ports/persistence/job/index';
import type {
  ScriptAuditEntry,
  ScriptDependency,
  ScriptJobRepositories,
  ScriptVersion,
  StageHead,
  StoryBibleVersion,
} from '../ports/script/index';

export interface ScriptJobContractDependencies {
  readonly newId: () => string;
  readonly now: () => string;
  readonly hashDocument: (value: Readonly<Record<string, unknown>>) => string;
  readonly validateCandidate: (value: unknown) => CandidateContractValidation;
  readonly validateFinal: (value: unknown) => CandidateContractValidation;
  readonly revalidateFrozenInput: (
    repositories: ScriptJobRepositories,
    job: ScriptStageJob,
  ) => Promise<boolean>;
}

export const buildScriptCandidateContract = (
  job: ScriptStageJob,
  invocationId: string,
  dependencies: Pick<ScriptJobContractDependencies, 'validateCandidate' | 'validateFinal'>,
) => ({
  injectSystemFields: (candidate: unknown): unknown => {
    if (typeof candidate !== 'object' || candidate === null || !('data' in candidate)) {
      throw new Error('SYSTEM_FIELD_INJECTION_FAILED');
    }
    return {
      data: (candidate as Readonly<{ data: unknown }>).data,
      episode_id: job.episodeId,
      project_id: job.projectId,
      schema_version: '1.0.0',
      source_invocation_id: invocationId,
      stage: job.stage,
    };
  },
  validateCandidate: dependencies.validateCandidate,
  validateCollection: (): CandidateContractValidation => ({ valid: true }),
  validateFinal: dependencies.validateFinal,
});

/** Writes the generated DRAFT and current pointer inside JobRunner's final transaction. */
export const createScriptCommitHandler = (
  dependencies: ScriptJobContractDependencies,
): JobCommitHandler<ScriptJobRepositories> => ({
  commit: async (repositories, value, job) => {
    if (!(await dependencies.revalidateFrozenInput(repositories, job))) {
      throw new Error('STALE_INPUT');
    }
    if (typeof value !== 'object' || value === null) throw new Error('SCRIPT_SCHEMA_INVALID');
    const documentValue = value as Readonly<Record<string, unknown>>;
    const document = JSON.stringify(documentValue);
    const documentSha256 = dependencies.hashDocument(documentValue);
    const at = dependencies.now();
    const versionId = dependencies.newId();
    if (job.stage === 'SHOT_CONTRACT') throw new Error('SCRIPT_STAGE_UNSUPPORTED');
    const currentHead = await repositories.stageHeads.find(job.projectId, job.episodeId, job.stage);
    if (job.stage === 'STORY_BIBLE') {
      const version: StoryBibleVersion = {
        createdAt: at,
        document,
        documentSha256,
        id: versionId,
        parentId: currentHead?.currentVersionId ?? null,
        projectId: job.projectId,
        source: 'AI',
        sourceInvocationId: String(documentValue.source_invocation_id),
        status: 'DRAFT',
        versionNo: (await repositories.storyBibleVersions.findMaxVersionNo(job.projectId)) + 1,
      };
      await repositories.storyBibleVersions.insert(version);
    } else {
      const version: ScriptVersion = {
        changeSummary: null,
        createdAt: at,
        document,
        documentSha256,
        episodeId: job.episodeId,
        id: versionId,
        parentId: currentHead?.currentVersionId ?? null,
        projectId: job.projectId,
        source: 'AI',
        sourceInputId: null,
        sourceInvocationId: String(documentValue.source_invocation_id),
        stage: job.stage,
        status: 'DRAFT',
        versionNo:
          (await repositories.scriptVersions.findMaxVersionNo(
            job.projectId,
            job.episodeId,
            job.stage,
          )) + 1,
      };
      await repositories.scriptVersions.insert(version);
    }
    const head: StageHead = {
      currentVersionId: versionId,
      currentVersionType: job.stage === 'STORY_BIBLE' ? 'STORY_BIBLE_VERSION' : 'SCRIPT_VERSION',
      episodeId: job.episodeId,
      projectId: job.projectId,
      stage: job.stage,
      updatedAt: at,
    };
    if (!(await repositories.stageHeads.upsert(head, currentHead?.currentVersionId ?? null))) {
      throw new Error('STALE_INPUT');
    }
    const frozen = JSON.parse(job.inputVersionsJson) as Readonly<{
      references?: readonly Readonly<{
        objectId: string;
        objectType: string;
        versionId: string;
      }>[];
    }>;
    const dependenciesToInsert: ScriptDependency[] = (frozen.references ?? [])
      .filter(
        ({ objectType }) =>
          objectType === 'SCRIPT_VERSION' ||
          objectType === 'STORY_BIBLE_VERSION' ||
          objectType === 'SOURCE_INPUT',
      )
      .map((reference) => ({
        createdAt: at,
        dependencyType: 'GENERATED_FROM',
        downstreamId: job.stage,
        downstreamType: job.stage === 'STORY_BIBLE' ? 'STORY_BIBLE_VERSION' : 'SCRIPT_VERSION',
        downstreamVersionId: versionId,
        id: dependencies.newId(),
        projectId: job.projectId,
        upstreamId: reference.objectId,
        upstreamType: reference.objectType as ScriptDependency['upstreamType'],
        upstreamVersionId: reference.versionId,
      }));
    await repositories.dependencies.insertMany(dependenciesToInsert);
    const audit: ScriptAuditEntry = {
      action: 'SCRIPT_VERSION_GENERATED',
      actor: 'AI',
      afterSha256: documentSha256,
      beforeSha256: null,
      createdAt: at,
      id: dependencies.newId(),
      metadata: { jobId: job.id, stage: job.stage },
      objectId: job.stage,
      objectType: 'SCRIPT_STAGE',
      objectVersionId: versionId,
      projectId: job.projectId,
      traceId: job.userOperationId,
    };
    await repositories.audit.record(audit);
  },
});
