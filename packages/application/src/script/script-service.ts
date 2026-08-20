import type {
  AppResultDto,
  ConfirmScriptVersionInputDto,
  GetScriptWorkspaceInputDto,
  InitializeOriginalInputDto,
  JobSummaryDto,
  RestoreScriptVersionInputDto,
  SaveScriptDraftInputDto,
  ScriptMutationResultDto,
  ScriptVersionDto,
  ScriptWorkspaceDto,
  StoryboardShotSummaryDto,
  StoryboardVersionSummaryDto,
  StoryboardWorkspaceDto,
} from '@jingxu/contracts';

import type {
  EpisodeVersion,
  ScriptStageWorkspace,
  ScriptWorkspaceQueryPort,
  ScriptWorkspaceSnapshot,
  StoryboardShotSnapshot,
  StoryboardWorkspace,
} from '../ports/script/index';
import type { OriginalInitializationService } from './original-initialization-service';
import { scriptFailure, scriptPersistenceFailure } from './script-service-error';
import type { ScriptVersionService } from './script-version-service';
import type { StoryboardVersionService } from './storyboard-version-service';

export interface ScriptServiceDependencies {
  readonly initialization: OriginalInitializationService;
  readonly storyboard: StoryboardVersionService;
  readonly versions: ScriptVersionService;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
  readonly findCurrentJob: (projectId: string) => Promise<JobSummaryDto | null>;
}

export interface ScriptService {
  initializeOriginal(
    input: InitializeOriginalInputDto,
    traceId: string,
  ): Promise<AppResultDto<ScriptWorkspaceDto>>;
  getWorkspace(
    input: GetScriptWorkspaceInputDto,
    traceId: string,
  ): Promise<AppResultDto<ScriptWorkspaceDto>>;
  saveDraft(
    input: SaveScriptDraftInputDto,
    traceId: string,
  ): Promise<AppResultDto<ScriptVersionDto>>;
  confirmVersion(
    input: ConfirmScriptVersionInputDto,
    traceId: string,
  ): Promise<AppResultDto<ScriptMutationResultDto>>;
  restoreVersion(
    input: RestoreScriptVersionInputDto,
    traceId: string,
  ): Promise<AppResultDto<ScriptMutationResultDto>>;
}

const stageToDto = async (
  projectId: string,
  stage: ScriptStageWorkspace,
  workspaceQuery: ScriptWorkspaceQueryPort,
) => {
  const history = await Promise.all(
    stage.history.map(async (summary): Promise<ScriptVersionDto | null> => {
      const persisted = await workspaceQuery.getVersionDocument(projectId, summary.id);
      if (persisted === null) return null;
      return {
        createdAt: summary.createdAt,
        document: JSON.parse(persisted.document) as ScriptVersionDto['document'],
        documentHash: persisted.documentSha256,
        id: summary.id,
        parentId: summary.parentId,
        projectId,
        source: summary.source,
        status: summary.status,
        versionNo: summary.versionNo,
      };
    }),
  );
  return {
    current:
      stage.current === null
        ? null
        : {
            createdAt: stage.current.createdAt,
            document: JSON.parse(stage.current.document) as ScriptVersionDto['document'],
            documentHash: stage.current.documentSha256,
            id: stage.current.id,
            parentId: stage.current.parentId,
            projectId: stage.current.projectId,
            source: stage.current.source,
            status: stage.current.status,
            versionNo: stage.current.versionNo,
          },
    history: history.filter((version): version is ScriptVersionDto => version !== null),
    prerequisiteReady: stage.stage === 'CONCEPT',
    stage: stage.stage,
  };
};

const storyboardVersionToDto = (
  version: EpisodeVersion,
  shotCount: number,
): StoryboardVersionSummaryDto => ({
  createdAt: version.createdAt,
  episodeId: version.episodeId,
  formatProfileId: version.formatProfileId,
  id: version.id,
  parentId: version.parentId,
  shotCount,
  shotSetHash: version.shotSetHash,
  status: version.status,
  storyBibleVersionId: version.storyBibleVersionId,
  targetDurationSec: version.targetDurationSec,
  versionNo: version.versionNo,
});

// 镜头文档在提交时已通过 ShotContract 1.1.0 FINAL 校验；此处仅做摘要字段提取。
// document/lockedPaths 为 shot-edit-lock D1/D3 数据源：编辑器全文与镜头卡片锁定标识。
const shotSummaryToDto = ({
  sequence,
  shotId,
  version,
}: StoryboardShotSnapshot): StoryboardShotSummaryDto => {
  const document = JSON.parse(version.document) as Readonly<{
    cinematography?: Readonly<{ camera_motion?: unknown; shot_size?: unknown }>;
    locked_paths?: unknown;
    narrative_purpose?: unknown;
  }>;
  return {
    cameraMotion: document.cinematography
      ?.camera_motion as StoryboardShotSummaryDto['cameraMotion'],
    dialogueRenderMode: version.dialogueRenderMode,
    document,
    lockedPaths: Array.isArray(document.locked_paths)
      ? (document.locked_paths as readonly string[]).map(String)
      : [],
    narrativePurpose: document.narrative_purpose as string,
    sequence,
    shotId,
    shotSize: document.cinematography?.shot_size as StoryboardShotSummaryDto['shotSize'],
    targetDurationSec: version.targetDurationSec,
    versionId: version.id,
  };
};

const storyboardToDto = (storyboard: StoryboardWorkspace): StoryboardWorkspaceDto => ({
  current:
    storyboard.current === null
      ? null
      : storyboardVersionToDto(storyboard.current, storyboard.currentShots.length),
  history: storyboard.history.map((entry) =>
    storyboardVersionToDto(entry.version, entry.shotCount),
  ),
  shots: storyboard.currentShots.map(shotSummaryToDto),
  totalDurationSec: storyboard.currentShots.reduce(
    (sum, shot) => sum + shot.version.targetDurationSec,
    0,
  ),
});

const toWorkspaceDto = async (
  snapshot: ScriptWorkspaceSnapshot,
  findCurrentJob: ScriptServiceDependencies['findCurrentJob'],
  workspaceQuery: ScriptWorkspaceQueryPort,
): Promise<ScriptWorkspaceDto | null> => {
  if (snapshot.sourceInput === null || snapshot.episode === null) return null;
  const stages = await Promise.all(
    snapshot.stages.map((stage) => stageToDto(snapshot.projectId, stage, workspaceQuery)),
  );
  const ready = new Set(
    stages.filter((stage) => stage.current?.status === 'READY').map((stage) => stage.stage),
  );
  const requiredByStage = {
    BEAT_SHEET: ['STORY_BIBLE', 'EPISODE_OUTLINE'],
    CONCEPT: [],
    EPISODE_OUTLINE: ['CONCEPT', 'STORY_BIBLE'],
    SCENE_SCRIPT: ['STORY_BIBLE', 'BEAT_SHEET'],
    STORY_BIBLE: ['CONCEPT'],
  } as const;
  const prerequisites = stages.map((stage) => {
    const missing = requiredByStage[stage.stage].filter((required) => !ready.has(required));
    return {
      message:
        missing.length === 0 ? '前置条件已满足' : `请先确认 ${missing.join('、')} READY 版本`,
      ready: missing.length === 0,
      stage: stage.stage,
    };
  });
  return {
    currentJob: await findCurrentJob(snapshot.projectId),
    episode: {
      id: snapshot.episode.id,
      projectId: snapshot.episode.projectId,
      targetDurationSec: snapshot.episode.targetDurationSec,
      title: snapshot.episode.title,
    },
    prerequisites,
    projectId: snapshot.projectId,
    source: {
      characterCount: snapshot.sourceInput.charCount,
      contentHash: snapshot.sourceInput.sha256,
      creativeText: snapshot.sourceInput.content,
      id: snapshot.sourceInput.id,
      projectId: snapshot.sourceInput.projectId,
    },
    storyboard: storyboardToDto(snapshot.storyboard),
    stages,
  };
};

/** SHOT_CONTRACT 命令入参：episodeId 由 DTO superRefine 保证非空（集级阶段）。 */
const storyboardCommand = (
  input: ConfirmScriptVersionInputDto,
): Parameters<StoryboardVersionService['confirmStoryboard']>[0] => {
  if (input.episodeId === null) throw new Error('EPISODE_SCOPE_INVALID');
  return {
    episodeId: input.episodeId,
    expectedVersionId: input.expectedVersionId,
    projectId: input.projectId,
    requestId: input.requestId,
  };
};

export const createScriptService = (dependencies: ScriptServiceDependencies): ScriptService => {
  const getWorkspace: ScriptService['getWorkspace'] = async (input, traceId) => {
    try {
      const snapshot = await dependencies.workspaceQuery.getWorkspace(input.projectId);
      if (snapshot === null) {
        return scriptFailure('SCRIPT_WORKSPACE_NOT_INITIALIZED', '剧本工作区尚未初始化', traceId);
      }
      const dto = await toWorkspaceDto(
        snapshot,
        dependencies.findCurrentJob,
        dependencies.workspaceQuery,
      );
      return dto === null ? scriptPersistenceFailure(traceId) : { data: dto, ok: true };
    } catch {
      return scriptPersistenceFailure(traceId);
    }
  };
  return {
    // D6：以 stage 区分命令路径——SHOT_CONTRACT 走分镜服务（D4），其余走五阶段版本服务。
    confirmVersion: (input, traceId) =>
      input.stage === 'SHOT_CONTRACT'
        ? dependencies.storyboard.confirmStoryboard(storyboardCommand(input), traceId)
        : dependencies.versions.confirmVersion({ ...input, stage: input.stage }, traceId),
    getWorkspace,
    initializeOriginal: async (input, traceId) => {
      const initialized = await dependencies.initialization.initialize(input, traceId);
      if (!initialized.ok) return initialized;
      return getWorkspace({ projectId: input.projectId }, traceId);
    },
    restoreVersion: (input, traceId) =>
      input.stage === 'SHOT_CONTRACT'
        ? dependencies.storyboard.restoreStoryboard(
            { ...storyboardCommand(input), versionId: input.versionId },
            traceId,
          )
        : dependencies.versions.restoreVersion({ ...input, stage: input.stage }, traceId),
    saveDraft: (input, traceId) => dependencies.versions.saveDraft(input, traceId),
  };
};
