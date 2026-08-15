import type { ScriptStage } from '@jingxu/contracts';

import type { CandidateContractValidation, JobCommitHandler } from '../jobs/index';
import type { ScriptStageJob } from '../ports/persistence/job/index';
import type {
  DialogueRenderMode,
  EpisodeVersion,
  EpisodeVersionShot,
  ScriptAuditEntry,
  ScriptDependency,
  ScriptJobRepositories,
  ScriptVersion,
  Shot,
  ShotContractVersion,
  StageHead,
  StageVersionType,
  StoryBibleVersion,
} from '../ports/script/index';
import { computeShotSetHash, type ShotSetHashEntry } from './shot-set-hash';
import {
  type ShotCollectionStoryBibleIds,
  validateShotSetCollection,
} from './shot-collection-validator';
import { injectShotSystemFields } from './shot-system-fields';

export interface ScriptJobContractDependencies {
  readonly newId: () => string;
  readonly now: () => string;
  readonly hashDocument: (value: Readonly<Record<string, unknown>>) => string;
  readonly hashText: (value: string) => string;
  readonly shotCollection?: ShotCollectionStoryBibleIds | null;
  readonly validateCandidate: (value: unknown) => CandidateContractValidation;
  readonly validateFinal: (value: unknown) => CandidateContractValidation;
  readonly revalidateFrozenInput: (
    repositories: ScriptJobRepositories,
    job: ScriptStageJob,
  ) => Promise<boolean>;
}

const headVersionTypeOf = (stage: ScriptStage): StageVersionType =>
  stage === 'STORY_BIBLE'
    ? 'STORY_BIBLE_VERSION'
    : stage === 'SHOT_CONTRACT'
      ? 'EPISODE_VERSION'
      : 'SCRIPT_VERSION';

interface FrozenReference {
  readonly objectId: string;
  readonly objectType: string;
  readonly versionId: string;
}

const parseFrozenReferences = (job: ScriptStageJob): readonly FrozenReference[] => {
  const frozen = JSON.parse(job.inputVersionsJson) as Readonly<{
    references?: readonly Readonly<FrozenReference>[];
  }>;
  return frozen.references ?? [];
};

const frozenFormatProfileId = (job: ScriptStageJob): string => {
  const reference = parseFrozenReferences(job).find(
    ({ objectType }) => objectType === 'FORMAT_PROFILE',
  );
  if (reference === undefined) throw new Error('SYSTEM_FIELD_INJECTION_FAILED');
  return reference.versionId;
};

export const buildScriptCandidateContract = (
  job: ScriptStageJob,
  invocationId: string,
  dependencies: Pick<
    ScriptJobContractDependencies,
    'newId' | 'shotCollection' | 'validateCandidate' | 'validateFinal'
  >,
) => ({
  injectSystemFields: (candidate: unknown): unknown => {
    if (job.stage === 'SHOT_CONTRACT') {
      // D2：逐镜头注入标识/版本/溯源/派生常量；previous_shot_id 等系统字段以注入为准。
      return injectShotSystemFields(candidate, {
        formatProfileId: frozenFormatProfileId(job),
        invocationId,
        newShotId: () => `shot_${dependencies.newId()}`,
        newVersionId: () => `scv_${dependencies.newId()}_v1`,
      });
    }
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
  validateCollection: (value: unknown): CandidateContractValidation => {
    if (dependencies.shotCollection === undefined) return { valid: true };
    if (dependencies.shotCollection === null) return { code: 'STALE_INPUT', valid: false };
    return validateShotSetCollection(value, dependencies.shotCollection);
  },
  validateFinal: dependencies.validateFinal,
});

const stringField = (document: Readonly<Record<string, unknown>>, key: string): string => {
  const value = document[key];
  if (typeof value !== 'string') throw new Error('SCRIPT_SCHEMA_INVALID');
  return value;
};

const numberField = (document: Readonly<Record<string, unknown>>, key: string): number => {
  const value = document[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('SCRIPT_SCHEMA_INVALID');
  }
  return value;
};

const DIALOGUE_RENDER_MODES: readonly string[] = [
  'NARRATION_FIRST',
  'WEAK_LIP_SYNC',
  'PRECISE_LIP_SYNC',
  'SUBTITLE_ONLY',
];

const dialogueRenderModeOf = (document: Readonly<Record<string, unknown>>): DialogueRenderMode => {
  const dialogue = document.dialogue;
  if (typeof dialogue !== 'object' || dialogue === null) throw new Error('SCRIPT_SCHEMA_INVALID');
  const mode = (dialogue as Readonly<Record<string, unknown>>).dialogue_render_mode;
  if (typeof mode !== 'string' || !DIALOGUE_RENDER_MODES.includes(mode)) {
    throw new Error('SCRIPT_SCHEMA_INVALID');
  }
  return mode as DialogueRenderMode;
};

const sourceInvocationIdOf = (document: Readonly<Record<string, unknown>>): string | null => {
  const provenance = document.provenance;
  if (typeof provenance !== 'object' || provenance === null) return null;
  const value = (provenance as Readonly<Record<string, unknown>>).source_invocation_id;
  return typeof value === 'string' ? value : null;
};

/** 冻结 EPISODE_OUTLINE 的整集时长（episode_versions.target_duration_sec 来源，D1）。 */
const frozenOutlineDurationSec = async (
  repositories: ScriptJobRepositories,
  job: ScriptStageJob,
): Promise<number> => {
  const references = parseFrozenReferences(job).filter(
    ({ objectType }) => objectType === 'SCRIPT_VERSION',
  );
  for (const reference of references) {
    const version = await repositories.scriptVersions.findById(reference.versionId);
    if (version?.stage !== 'EPISODE_OUTLINE') continue;
    const parsed = JSON.parse(version.document) as Readonly<{
      data?: Readonly<{ target_duration_sec?: unknown }>;
    }>;
    const duration = parsed.data?.target_duration_sec;
    if (typeof duration !== 'number' || !Number.isFinite(duration)) {
      throw new Error('STALE_INPUT');
    }
    return duration;
  }
  throw new Error('STALE_INPUT');
};

/** D1：一次 GENERATE 的 commit 在 JobRunner 最终短事务内写入整集分镜集合。 */
const commitShotContractSet = async (
  repositories: ScriptJobRepositories,
  documents: readonly Readonly<Record<string, unknown>>[],
  job: ScriptStageJob,
  dependencies: Pick<ScriptJobContractDependencies, 'hashDocument' | 'hashText' | 'newId' | 'now'>,
  currentHead: StageHead | null,
): Promise<Readonly<{ episodeVersionId: string; shotSetHash: string }>> => {
  if (job.episodeId === null) throw new Error('SCRIPT_STAGE_PREREQUISITE_MISSING');
  const at = dependencies.now();
  const storyBibleRef = parseFrozenReferences(job).find(
    ({ objectType }) => objectType === 'STORY_BIBLE_VERSION',
  );
  if (storyBibleRef === undefined) throw new Error('STALE_INPUT');
  const formatProfileId = frozenFormatProfileId(job);
  const targetDurationSec = await frozenOutlineDurationSec(repositories, job);

  const shotRows: Shot[] = [];
  const contractRows: ShotContractVersion[] = [];
  const hashEntries: ShotSetHashEntry[] = [];
  for (const document of documents) {
    const shotId = stringField(document, 'shot_id');
    const versionId = stringField(document, 'version_id');
    const sequence = numberField(document, 'sequence');
    const documentJson = JSON.stringify(document);
    const documentSha256 = dependencies.hashDocument(document);
    shotRows.push({
      createdAt: at,
      currentVersionId: versionId,
      deletedAt: null,
      episodeId: job.episodeId,
      id: shotId,
      lifecycleStatus: 'ACTIVE',
      updatedAt: at,
    });
    contractRows.push({
      createdAt: at,
      dialogueRenderMode: dialogueRenderModeOf(document),
      document: documentJson,
      documentSha256,
      externalParentVersionId: null,
      formatProfileId,
      id: versionId,
      lineageResolutionStatus: 'ROOT',
      parentId: null,
      sequence,
      shotId,
      sourceInvocationId: sourceInvocationIdOf(document),
      targetDurationSec: numberField(document, 'target_duration_sec'),
      versionNo: 1,
      versionStatus: 'DRAFT',
    });
    hashEntries.push({ documentSha256, sequence, shotId, shotVersionId: versionId });
  }

  const shotSetHash = computeShotSetHash(hashEntries, dependencies.hashText);
  const episodeVersionId = dependencies.newId();
  const episodeVersion: EpisodeVersion = {
    createdAt: at,
    episodeId: job.episodeId,
    formatProfileId,
    id: episodeVersionId,
    parentId:
      currentHead?.currentVersionType === 'EPISODE_VERSION' ? currentHead.currentVersionId : null,
    shotSetHash,
    storyBibleVersionId: storyBibleRef.versionId,
    status: 'DRAFT',
    targetDurationSec,
    versionNo: (await repositories.episodeVersions.findMaxVersionNo(job.episodeId)) + 1,
  };
  const shotLinks: readonly EpisodeVersionShot[] = hashEntries
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry) => ({
      episodeVersionId,
      sequence: entry.sequence,
      shotId: entry.shotId,
      shotVersionId: entry.shotVersionId,
    }));

  await repositories.shots.insertMany(shotRows);
  await repositories.shotContractVersions.insertMany(contractRows);
  await repositories.episodeVersions.insert(episodeVersion);
  await repositories.episodeVersions.insertShotLinks(shotLinks);
  return { episodeVersionId, shotSetHash };
};

/** Writes the generated DRAFT and current pointer inside JobRunner's final transaction. */
export const createScriptCommitHandler = (
  dependencies: Pick<
    ScriptJobContractDependencies,
    'hashDocument' | 'hashText' | 'newId' | 'now' | 'revalidateFrozenInput'
  >,
): JobCommitHandler<ScriptJobRepositories> => ({
  commit: async (repositories, value, job) => {
    if (!(await dependencies.revalidateFrozenInput(repositories, job))) {
      throw new Error('STALE_INPUT');
    }
    const at = dependencies.now();
    const currentHead = await repositories.stageHeads.find(job.projectId, job.episodeId, job.stage);
    let versionId: string;
    let afterSha256: string | null;
    if (job.stage === 'SHOT_CONTRACT') {
      if (!Array.isArray(value) || value.length === 0) throw new Error('SCRIPT_SCHEMA_INVALID');
      const documents = value as readonly Readonly<Record<string, unknown>>[];
      const committed = await commitShotContractSet(
        repositories,
        documents,
        job,
        dependencies,
        currentHead,
      );
      versionId = committed.episodeVersionId;
      afterSha256 = committed.shotSetHash;
    } else if (job.stage === 'STORY_BIBLE') {
      if (typeof value !== 'object' || value === null) throw new Error('SCRIPT_SCHEMA_INVALID');
      const documentValue = value as Readonly<Record<string, unknown>>;
      const document = JSON.stringify(documentValue);
      const documentSha256 = dependencies.hashDocument(documentValue);
      versionId = dependencies.newId();
      afterSha256 = documentSha256;
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
      if (typeof value !== 'object' || value === null) throw new Error('SCRIPT_SCHEMA_INVALID');
      const documentValue = value as Readonly<Record<string, unknown>>;
      const document = JSON.stringify(documentValue);
      const documentSha256 = dependencies.hashDocument(documentValue);
      versionId = dependencies.newId();
      afterSha256 = documentSha256;
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
      currentVersionType: headVersionTypeOf(job.stage),
      episodeId: job.episodeId,
      projectId: job.projectId,
      stage: job.stage,
      updatedAt: at,
    };
    if (!(await repositories.stageHeads.upsert(head, currentHead?.currentVersionId ?? null))) {
      throw new Error('STALE_INPUT');
    }
    const dependenciesToInsert: ScriptDependency[] = parseFrozenReferences(job)
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
        downstreamType: headVersionTypeOf(job.stage),
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
      afterSha256,
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
