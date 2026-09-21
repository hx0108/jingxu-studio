import type {
  AppResultDto,
  CreatorNextActionResultDto,
  GetCreatorNextActionInputDto,
  ScriptStage,
} from '@jingxu/contracts';

import type {
  CreatorGuideProjectSnapshot,
  CreatorGuideQueryPort,
  CreatorStageStatus,
} from '../ports/creator-guide';

const STAGE_ORDER = [
  ['CONCEPT', '故事概念'],
  ['STORY_BIBLE', '故事设定'],
  ['EPISODE_OUTLINE', '单集大纲'],
  ['BEAT_SHEET', '剧情节拍'],
  ['SCENE_SCRIPT', '场景剧本'],
] as const satisfies readonly [Exclude<ScriptStage, 'SHOT_CONTRACT'>, string][];

export interface CreatorGuideService {
  getNextAction(
    input: GetCreatorNextActionInputDto,
    traceId: string,
  ): Promise<AppResultDto<CreatorNextActionResultDto>>;
}

const chooseProject = (
  projects: readonly { readonly id: string; readonly updatedAt: string }[],
): string | null =>
  [...projects].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  })[0]?.id ?? null;

const stageAction = (
  projectId: string,
  stage: Exclude<ScriptStage, 'SHOT_CONTRACT'>,
  label: string,
  status: CreatorStageStatus,
): CreatorNextActionResultDto | null => {
  if (status === 'READY') return null;
  if (status === 'DRAFT') {
    return {
      action: 'REVIEW_STAGE',
      blocked: false,
      fixAction: null,
      projectId,
      reason: `${label}已经生成，请确认内容后继续`,
      stage,
      target: 'SCRIPT',
      title: `确认${label}`,
    };
  }
  return {
    action: 'GENERATE_STAGE',
    blocked: false,
    fixAction: null,
    projectId,
    reason:
      status === 'STALE_INPUT' ? `上游内容已变化，需要重新生成${label}` : `下一步生成${label}`,
    stage,
    target: 'SCRIPT',
    title: status === 'STALE_INPUT' ? `更新${label}` : `生成${label}`,
  };
};

export const resolveCreatorNextAction = (
  snapshot: CreatorGuideProjectSnapshot,
): CreatorNextActionResultDto => {
  const { projectId } = snapshot;
  if (!snapshot.sourceInputReady) {
    return {
      action: 'ENTER_STORY',
      blocked: false,
      fixAction: null,
      projectId,
      reason: '先写下故事创意或导入已有内容',
      stage: null,
      target: 'SOURCE_INPUT',
      title: '输入本集故事',
    };
  }

  for (const [stage, label] of STAGE_ORDER) {
    const action = stageAction(projectId, stage, label, snapshot.stages[stage]);
    if (action !== null) return action;
  }

  const storyboardStatus = snapshot.stages.SHOT_CONTRACT;
  if (storyboardStatus !== 'READY') {
    const review = storyboardStatus === 'DRAFT';
    return {
      action: review ? 'REVIEW_STORYBOARD' : 'GENERATE_STORYBOARD',
      blocked: false,
      fixAction: null,
      projectId,
      reason: review ? '分镜已经生成，请确认镜头后继续' : '剧本已准备好，可以生成本集分镜',
      stage: 'SHOT_CONTRACT',
      target: 'STORYBOARD',
      title: review ? '确认本集分镜' : '生成本集分镜',
    };
  }

  if (snapshot.consistencyBlocks.includes('STYLE_REFERENCE')) {
    return {
      action: 'ADD_REFERENCES',
      blocked: true,
      fixAction: 'ADD_STYLE_REFERENCE',
      projectId,
      reason: '生成画面前还需要一张画风参考图',
      stage: 'SHOT_CONTRACT',
      target: 'ASSETS',
      title: '补充画风参考',
    };
  }
  if (snapshot.consistencyBlocks.includes('CHARACTER_REFERENCE')) {
    return {
      action: 'ADD_REFERENCES',
      blocked: true,
      fixAction: 'ADD_CHARACTER_REFERENCE',
      projectId,
      reason: '有出场角色缺少参考图',
      stage: 'SHOT_CONTRACT',
      target: 'ASSETS',
      title: '补充角色参考',
    };
  }
  if (!snapshot.imagesReady) {
    return {
      action: 'GENERATE_IMAGES',
      blocked: false,
      fixAction: null,
      projectId,
      reason: '参考素材已准备好，可以生成整集画面',
      stage: 'SHOT_CONTRACT',
      target: 'IMAGE',
      title: '生成本集画面',
    };
  }
  if (!snapshot.videosReady) {
    return {
      action: 'GENERATE_VIDEOS',
      blocked: false,
      fixAction: null,
      projectId,
      reason: '画面已经选好，可以生成视频片段',
      stage: 'SHOT_CONTRACT',
      target: 'VIDEO',
      title: '生成视频片段',
    };
  }
  if (!snapshot.voiceReady) {
    return {
      action: 'GENERATE_VOICE',
      blocked: false,
      fixAction: null,
      projectId,
      reason: '视频片段已准备好，下一步生成配音',
      stage: 'SHOT_CONTRACT',
      target: 'VOICE',
      title: '生成本集配音',
    };
  }
  if (!snapshot.exportReady) {
    return {
      action: 'PREPARE_EXPORT',
      blocked: false,
      fixAction: null,
      projectId,
      reason: '素材已经齐全，可以检查并导出本集',
      stage: 'SHOT_CONTRACT',
      target: 'EXPORT',
      title: '检查并导出',
    };
  }
  return {
    action: 'VIEW_RESULT',
    blocked: false,
    fixAction: null,
    projectId,
    reason: '本集已经完成，可以查看或继续优化',
    stage: null,
    target: 'COMPLETED',
    title: '查看本集成片',
  };
};

export const createCreatorGuideService = (query: CreatorGuideQueryPort): CreatorGuideService => ({
  async getNextAction(input, traceId) {
    const projects = await query.listActiveProjects();
    const projectId = input.projectId ?? chooseProject(projects);
    if (projectId === null) {
      return {
        ok: true,
        data: {
          action: 'CHOOSE_START',
          blocked: false,
          fixAction: 'CREATE_PROJECT',
          projectId: null,
          reason: '还没有作品，可以先体验或创建自己的作品',
          stage: null,
          target: 'START',
          title: '开始制作第一集',
        },
      };
    }
    if (!projects.some((project) => project.id === projectId)) {
      return {
        ok: false,
        error: {
          code: 'CREATOR_GUIDE_PROJECT_NOT_FOUND',
          fieldErrors: null,
          message: '作品不存在或已被删除',
          retryable: false,
          traceId,
          userAction: '请选择其他作品后继续',
        },
      };
    }
    const snapshot = await query.getProjectSnapshot(projectId);
    if (snapshot === null) {
      return {
        ok: false,
        error: {
          code: 'CREATOR_GUIDE_SCOPE_STALE',
          fieldErrors: null,
          message: '作品状态刚刚发生变化',
          retryable: true,
          traceId,
          userAction: '请重新点击继续制作',
        },
      };
    }
    return { ok: true, data: resolveCreatorNextAction(snapshot) };
  },
});
