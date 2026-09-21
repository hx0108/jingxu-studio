import type {
  AppResultDto,
  CreatorNextActionResultDto,
  GetCreatorNextActionInputDto,
} from '@jingxu/contracts';

export interface CreatorGuideClient {
  getNextAction(
    input: GetCreatorNextActionInputDto,
  ): Promise<AppResultDto<CreatorNextActionResultDto>>;
}

export const getCreatorGuideClient = (): CreatorGuideClient => window.jingxu.creatorGuide;

export interface CreatorWorkspaceRoute {
  readonly mediaStep: 'storyboard' | 'image' | 'video' | 'composition' | null;
  readonly screen: 'assets' | 'script';
  readonly stage: 'CONCEPT' | 'STORY_BIBLE' | 'EPISODE_OUTLINE' | 'BEAT_SHEET' | 'SCENE_SCRIPT';
}

/** 把 Application 返回的稳定业务目标映射到现有页面，不重复判断业务完成状态。 */
export const routeForCreatorAction = (
  action: CreatorNextActionResultDto,
): CreatorWorkspaceRoute | null => {
  if (action.target === 'START') return null;
  if (action.target === 'SOURCE_INPUT') {
    return { mediaStep: null, screen: 'script', stage: 'CONCEPT' };
  }
  if (action.target === 'ASSETS') {
    return { mediaStep: null, screen: 'assets', stage: 'SCENE_SCRIPT' };
  }
  if (action.target === 'SCRIPT') {
    return {
      mediaStep: null,
      screen: 'script',
      stage: action.stage === null || action.stage === 'SHOT_CONTRACT' ? 'CONCEPT' : action.stage,
    };
  }
  const mediaStep =
    action.target === 'IMAGE'
      ? 'image'
      : action.target === 'VIDEO'
        ? 'video'
        : action.target === 'VOICE' || action.target === 'EXPORT' || action.target === 'COMPLETED'
          ? 'composition'
          : 'storyboard';
  return { mediaStep, screen: 'script', stage: 'SCENE_SCRIPT' };
};
