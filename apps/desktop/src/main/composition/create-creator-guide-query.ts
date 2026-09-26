import type {
  CreatorGuideProjectSnapshot,
  CreatorGuideQueryPort,
  CreatorStageStatus,
  MediaConsistencyService,
  MediaUnitOfWorkPort,
  ProjectUnitOfWorkPort,
  ScriptWorkspaceQueryPort,
} from '@jingxu/application';
import type { ScriptStage } from '@jingxu/contracts';

const SCRIPT_STAGES = [
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
] as const satisfies readonly Exclude<ScriptStage, 'SHOT_CONTRACT'>[];

const missingStages = (): Record<ScriptStage, CreatorStageStatus> => ({
  BEAT_SHEET: 'MISSING',
  CONCEPT: 'MISSING',
  EPISODE_OUTLINE: 'MISSING',
  SCENE_SCRIPT: 'MISSING',
  SHOT_CONTRACT: 'MISSING',
  STORY_BIBLE: 'MISSING',
});

/** 以现有只读 Port 组合首页导航投影，不保存任何状态。 */
export const createCreatorGuideQuery = (deps: {
  readonly consistency?: MediaConsistencyService;
  readonly media?: MediaUnitOfWorkPort;
  readonly projects: ProjectUnitOfWorkPort;
  readonly scripts: ScriptWorkspaceQueryPort;
}): CreatorGuideQueryPort => ({
  async listActiveProjects() {
    const projects: { id: string; updatedAt: string }[] = [];
    let after: { id: string; updatedAt: string } | null = null;
    do {
      const page = await deps.projects.run(({ projects: repository }) =>
        repository.listPage({ after, limit: 100, scope: 'ACTIVE' }),
      );
      projects.push(
        ...page.items.map(({ project }) => ({ id: project.id, updatedAt: project.updatedAt })),
      );
      after = page.nextAfter;
    } while (after !== null);
    return projects;
  },

  async getProjectSnapshot(projectId): Promise<CreatorGuideProjectSnapshot | null> {
    const projectExists = await deps.projects.run(
      async ({ projects }) => (await projects.findById(projectId, 'ACTIVE')) !== null,
    );
    if (!projectExists) return null;

    const workspace = await deps.scripts.getWorkspace(projectId);
    if (workspace === null) {
      // 项目存在但尚未初始化剧本工作区：不是过期状态，而是「输入本集故事」这一步本身。
      return {
        consistencyBlocks: [],
        exportReady: false,
        imagesReady: false,
        projectId,
        sourceInputReady: false,
        stages: missingStages(),
        videosReady: false,
        voiceReady: false,
      };
    }
    const stages = missingStages();
    for (const stage of SCRIPT_STAGES) {
      const current = workspace.stages.find((entry) => entry.stage === stage)?.current ?? null;
      stages[stage] = current?.status ?? 'MISSING';
    }
    stages.SHOT_CONTRACT = workspace.storyboard.current?.status ?? 'MISSING';

    const shotIds = workspace.storyboard.currentShots.map((shot) => shot.shotId);
    let consistencyBlocks: CreatorGuideProjectSnapshot['consistencyBlocks'] = [];
    if (
      workspace.storyboard.current?.status === 'READY' &&
      shotIds.length > 0 &&
      deps.consistency !== undefined
    ) {
      const preflight = await deps.consistency.getPreflight(
        { projectId, shotIds },
        `creator-guide-${projectId}`,
      );
      if (preflight.ok) {
        const kinds = new Set(preflight.data.missingItems.map((item) => item.kind));
        consistencyBlocks = [
          ...(kinds.has('STYLE') ? (['STYLE_REFERENCE'] as const) : []),
          ...(kinds.has('CHARACTER') ? (['CHARACTER_REFERENCE'] as const) : []),
        ];
      }
    }

    let imagesReady = false;
    let videosReady = false;
    let voiceReady = false;
    let exportReady = false;
    if (
      workspace.storyboard.current?.status === 'READY' &&
      shotIds.length > 0 &&
      consistencyBlocks.length === 0 &&
      deps.media !== undefined
    ) {
      ({ exportReady, imagesReady, videosReady, voiceReady } = await deps.media.run(
        async ({ composition, media, video, voice }) => {
          const selectedForVersion = (
            candidates: readonly {
              readonly selectedAt: string | null;
              readonly shotVersionId: string;
              readonly status: string;
            }[],
            versionId: string,
          ): boolean =>
            candidates.some(
              (candidate) =>
                candidate.status === 'SUCCEEDED' &&
                candidate.selectedAt !== null &&
                candidate.shotVersionId === versionId,
            );
          const imageStates = await Promise.all(
            workspace.storyboard.currentShots.map(async (shot) =>
              selectedForVersion(await media.listCandidates(shot.shotId), shot.version.id),
            ),
          );
          const videoStates = await Promise.all(
            workspace.storyboard.currentShots.map(async (shot) =>
              selectedForVersion(await video.listCandidates(shot.shotId), shot.version.id),
            ),
          );
          const spokenShots = workspace.storyboard.currentShots.filter((shot) => {
            try {
              const document = JSON.parse(shot.version.document) as {
                readonly content?: { readonly spoken_text?: unknown };
              };
              return (
                typeof document.content?.spoken_text === 'string' &&
                document.content.spoken_text.trim() !== ''
              );
            } catch {
              return true;
            }
          });
          const voiceStates =
            spokenShots.length === 0
              ? []
              : voice === undefined
                ? spokenShots.map(() => false)
                : await Promise.all(
                    spokenShots.map(async (shot) =>
                      selectedForVersion(
                        await voice.generation.listCandidatesByShot(shot.shotId),
                        shot.version.id,
                      ),
                    ),
                  );
          const succeededExport =
            composition === undefined || workspace.episode === null
              ? null
              : await composition.composition.findLatestSucceededExport(
                  projectId,
                  workspace.episode.id,
                );
          return {
            exportReady: succeededExport !== null,
            imagesReady: imageStates.every(Boolean),
            videosReady: videoStates.every(Boolean),
            voiceReady: voiceStates.every(Boolean),
          };
        },
      ));
    }

    return {
      consistencyBlocks,
      exportReady,
      imagesReady,
      projectId,
      sourceInputReady: workspace.sourceInput !== null,
      stages,
      videosReady,
      voiceReady,
    };
  },
});
