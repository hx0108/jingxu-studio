import type {
  CreatorGuideProjectSnapshot,
  CreatorGuideQueryPort,
  CreatorStageStatus,
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

    return {
      consistencyBlocks: [],
      exportReady: false,
      imagesReady: false,
      projectId,
      sourceInputReady: workspace.sourceInput !== null,
      stages,
      videosReady: false,
      voiceReady: false,
    };
  },
});
