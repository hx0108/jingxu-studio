import type { ScriptStage } from '@jingxu/contracts';

import type { ScriptJobRepositories, StagedScriptStage } from '../ports/script/index';

export interface FreezeScriptInputCommand {
  readonly episodeId: string | null;
  readonly expectedInputVersionId: string;
  readonly projectId: string;
  readonly stage: ScriptStage;
}

export interface FrozenInputReference {
  readonly objectType:
    'EPISODE' | 'FORMAT_PROFILE' | 'SOURCE_INPUT' | 'SCRIPT_VERSION' | 'STORY_BIBLE_VERSION';
  readonly objectId: string;
  readonly versionId: string;
  readonly sha256: string;
}

export interface FrozenScriptInput {
  readonly references: readonly FrozenInputReference[];
  readonly inputVersionsJson: string;
  readonly inputVersionSetHash: string;
}

export class ScriptPrerequisiteError extends Error {
  public constructor(
    public readonly code:
      'SCRIPT_STAGE_PREREQUISITE_MISSING' | 'SCRIPT_STAGE_NOT_READY' | 'STALE_INPUT',
  ) {
    super(code);
    this.name = 'ScriptPrerequisiteError';
  }
}

const requireReadyStage = async (
  repositories: ScriptJobRepositories,
  projectId: string,
  episodeId: string | null,
  stage: StagedScriptStage,
): Promise<FrozenInputReference> => {
  const head = await repositories.stageHeads.find(projectId, episodeId, stage);
  if (head === null) throw new ScriptPrerequisiteError('SCRIPT_STAGE_PREREQUISITE_MISSING');
  const version =
    stage === 'STORY_BIBLE'
      ? await repositories.storyBibleVersions.findById(head.currentVersionId)
      : await repositories.scriptVersions.findById(head.currentVersionId);
  if (version?.projectId !== projectId) {
    throw new ScriptPrerequisiteError('SCRIPT_STAGE_PREREQUISITE_MISSING');
  }
  if (version.status !== 'READY') throw new ScriptPrerequisiteError('SCRIPT_STAGE_NOT_READY');
  if (
    stage !== 'STORY_BIBLE' &&
    (!('episodeId' in version) ||
      !('stage' in version) ||
      version.stage !== stage ||
      version.episodeId !== episodeId)
  ) {
    throw new ScriptPrerequisiteError('SCRIPT_STAGE_PREREQUISITE_MISSING');
  }
  return {
    objectId: version.id,
    objectType: stage === 'STORY_BIBLE' ? 'STORY_BIBLE_VERSION' : 'SCRIPT_VERSION',
    sha256: version.documentSha256,
    versionId: version.id,
  };
};

/** Reads every prerequisite through the same Script UoW used to create the queued Job. */
export const freezeScriptJobInput = async (
  repositories: ScriptJobRepositories,
  command: FreezeScriptInputCommand,
  hashPayload: (value: Readonly<Record<string, unknown>>) => string,
): Promise<FrozenScriptInput> => {
  const source = await repositories.sourceInputs.findCreativeByProjectId(command.projectId);
  const episode =
    command.episodeId === null ? null : await repositories.episodes.findById(command.episodeId);
  const requiresEpisode =
    command.stage === 'EPISODE_OUTLINE' ||
    command.stage === 'BEAT_SHEET' ||
    command.stage === 'SCENE_SCRIPT' ||
    command.stage === 'SHOT_CONTRACT';
  if (
    source === null ||
    (requiresEpisode && episode === null) ||
    (episode !== null && (episode.projectId !== command.projectId || episode.deletedAt !== null))
  ) {
    throw new ScriptPrerequisiteError('SCRIPT_STAGE_PREREQUISITE_MISSING');
  }

  const formatProfile = await repositories.formatProfiles.findCurrent(command.projectId);
  if (formatProfile === null) {
    throw new ScriptPrerequisiteError('SCRIPT_STAGE_PREREQUISITE_MISSING');
  }

  const concept =
    command.stage === 'CONCEPT'
      ? null
      : await requireReadyStage(repositories, command.projectId, null, 'CONCEPT');
  const storyBible =
    command.stage === 'CONCEPT' || command.stage === 'STORY_BIBLE'
      ? null
      : await requireReadyStage(repositories, command.projectId, null, 'STORY_BIBLE');
  const outline =
    command.stage === 'BEAT_SHEET' || command.stage === 'SHOT_CONTRACT'
      ? await requireReadyStage(
          repositories,
          command.projectId,
          command.episodeId,
          'EPISODE_OUTLINE',
        )
      : null;
  const beat =
    command.stage === 'SCENE_SCRIPT'
      ? await requireReadyStage(repositories, command.projectId, command.episodeId, 'BEAT_SHEET')
      : null;
  const sceneScript =
    command.stage === 'SHOT_CONTRACT'
      ? await requireReadyStage(repositories, command.projectId, command.episodeId, 'SCENE_SCRIPT')
      : null;

  const primaryId =
    command.stage === 'CONCEPT'
      ? source.id
      : command.stage === 'STORY_BIBLE'
        ? concept?.versionId
        : command.stage === 'EPISODE_OUTLINE'
          ? storyBible?.versionId
          : command.stage === 'BEAT_SHEET'
            ? outline?.versionId
            : command.stage === 'SHOT_CONTRACT'
              ? sceneScript?.versionId
              : beat?.versionId;
  if (primaryId !== command.expectedInputVersionId) {
    throw new ScriptPrerequisiteError('STALE_INPUT');
  }

  const references: FrozenInputReference[] = [];
  if (command.stage === 'CONCEPT') {
    references.push({
      objectId: source.id,
      objectType: 'SOURCE_INPUT',
      sha256: source.sha256,
      versionId: source.id,
    });
    references.push({
      objectId: formatProfile.id,
      objectType: 'FORMAT_PROFILE',
      sha256: hashPayload({
        createdAt: formatProfile.createdAt,
        objectId: formatProfile.id,
        objectType: 'FORMAT_PROFILE',
        parentId: formatProfile.parentId,
        projectId: formatProfile.projectId,
        spec: formatProfile.spec,
        versionId: formatProfile.id,
        versionNo: formatProfile.versionNo,
      }),
      versionId: formatProfile.id,
    });
  } else if (command.stage === 'STORY_BIBLE' && concept !== null) {
    references.push(concept);
  } else if (command.stage === 'EPISODE_OUTLINE' && concept !== null && storyBible !== null) {
    if (episode === null) throw new ScriptPrerequisiteError('SCRIPT_STAGE_PREREQUISITE_MISSING');
    references.push(concept, storyBible, {
      objectId: episode.id,
      objectType: 'EPISODE',
      sha256: hashPayload({
        currentVersionId: episode.currentVersionId,
        deletedAt: episode.deletedAt,
        objectId: episode.id,
        objectType: 'EPISODE',
        projectId: episode.projectId,
        targetDurationSec: episode.targetDurationSec,
        title: episode.title,
        updatedAt: episode.updatedAt,
        versionId: episode.id,
      }),
      versionId: episode.id,
    });
  } else if (command.stage === 'BEAT_SHEET' && outline !== null && storyBible !== null) {
    references.push(outline, storyBible);
  } else if (command.stage === 'SCENE_SCRIPT' && beat !== null && storyBible !== null) {
    references.push(beat, storyBible, {
      objectId: formatProfile.id,
      objectType: 'FORMAT_PROFILE',
      sha256: hashPayload({
        createdAt: formatProfile.createdAt,
        objectId: formatProfile.id,
        objectType: 'FORMAT_PROFILE',
        parentId: formatProfile.parentId,
        projectId: formatProfile.projectId,
        spec: formatProfile.spec,
        versionId: formatProfile.id,
        versionNo: formatProfile.versionNo,
      }),
      versionId: formatProfile.id,
    });
  } else if (
    command.stage === 'SHOT_CONTRACT' &&
    sceneScript !== null &&
    storyBible !== null &&
    outline !== null
  ) {
    // D5：冻结集合 = READY 的 STORY_BIBLE + EPISODE_OUTLINE + SCENE_SCRIPT + 当前 format_profile；
    // commit 写三条 GENERATED_FROM（FormatProfile 不建边，由 episode_versions FK 守卫覆盖）。
    references.push(sceneScript, storyBible, outline, {
      objectId: formatProfile.id,
      objectType: 'FORMAT_PROFILE',
      sha256: hashPayload({
        createdAt: formatProfile.createdAt,
        objectId: formatProfile.id,
        objectType: 'FORMAT_PROFILE',
        parentId: formatProfile.parentId,
        projectId: formatProfile.projectId,
        spec: formatProfile.spec,
        versionId: formatProfile.id,
        versionNo: formatProfile.versionNo,
      }),
      versionId: formatProfile.id,
    });
  }

  const canonical = { references };
  return {
    inputVersionsJson: JSON.stringify(canonical),
    inputVersionSetHash: hashPayload(canonical),
    references,
  };
};
