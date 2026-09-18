import type {
  AppResultDto,
  ConsistencyPreflightDto,
  GetConsistencyPreflightInputDto,
} from '@jingxu/contracts';
import { MEDIA_REFERENCE_MAX_COUNT, PROJECT_STYLE_BIBLE_REF_ID } from '@jingxu/contracts';

import type { MediaRepository, MediaUnitOfWorkPort } from '../ports/media/media-repository';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import { extractShotCreativeFields } from './media-generation-prompt';
import { mediaFailure, mediaPersistenceFailure } from './media-service-error';
import { parseStoryBibleDescriptions } from './story-bible-descriptions';

export interface MediaConsistencyServiceDependencies {
  readonly mediaUnitOfWork: MediaUnitOfWorkPort;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export interface MediaConsistencyService {
  getPreflight(
    input: GetConsistencyPreflightInputDto,
    traceId: string,
  ): Promise<AppResultDto<ConsistencyPreflightDto>>;
}

const buildPreflight = async (
  media: MediaRepository,
  dependencies: MediaConsistencyServiceDependencies,
  input: GetConsistencyPreflightInputDto,
): Promise<ConsistencyPreflightDto> => {
  const workspace = await dependencies.workspaceQuery.getWorkspace(input.projectId);
  if (workspace === null) throw new Error('SCRIPT_WORKSPACE_NOT_INITIALIZED');
  if (workspace.storyboard.current?.status !== 'READY') {
    throw new Error('MEDIA_STORYBOARD_NOT_READY');
  }
  const bibleResult = parseStoryBibleDescriptions(
    workspace.stages.find((stage) => stage.stage === 'STORY_BIBLE')?.current?.document ?? null,
  );
  if (bibleResult.kind === 'invalid') {
    return {
      missingItems: [],
      ready: false,
      shots: [],
      storyBibleValid: false,
      styleAssetVersionId: null,
      warnings: [],
    };
  }
  const styleVersion = await media.findCurrentAssetVersion(
    input.projectId,
    'STYLE',
    PROJECT_STYLE_BIBLE_REF_ID,
  );
  const missing = new Map<
    string,
    { bibleRefId: string; displayName: string; kind: 'STYLE' | 'CHARACTER' }
  >();
  if (styleVersion === null || styleVersion.description?.trim() === '') {
    missing.set('STYLE:project-style', {
      bibleRefId: PROJECT_STYLE_BIBLE_REF_ID,
      displayName: '项目画风',
      kind: 'STYLE',
    });
  }
  const warnings: string[] = [];
  const shots: ConsistencyPreflightDto['shots'][number][] = [];
  for (const shotId of input.shotIds) {
    const shot = workspace.storyboard.currentShots.find((entry) => entry.shotId === shotId);
    if (shot === undefined) throw new Error('MEDIA_SHOT_NOT_IN_READY_SET');
    const creative = extractShotCreativeFields(shot.version.document);
    if (creative === null) throw new Error('SHOT_DOCUMENT_INVALID');
    const characterIds = [...new Set(creative.characterIds)];
    let shotReady = styleVersion !== null && styleVersion.description?.trim() !== '';
    for (const characterId of characterIds) {
      const version = await media.findCurrentAssetVersion(
        input.projectId,
        'CHARACTER',
        characterId,
      );
      if (version === null) {
        shotReady = false;
        missing.set(`CHARACTER:${characterId}`, {
          bibleRefId: characterId,
          displayName: bibleResult.descriptions.characters[characterId]?.name ?? characterId,
          kind: 'CHARACTER',
        });
      }
    }
    const requiredCount = 1 + characterIds.length;
    if (requiredCount > MEDIA_REFERENCE_MAX_COUNT) {
      shotReady = false;
      warnings.push(`镜头 ${shotId} 的画风与角色参考图共 ${String(requiredCount)} 张，超过上限。`);
    } else if (creative.sceneId !== null && requiredCount === MEDIA_REFERENCE_MAX_COUNT) {
      warnings.push(`镜头 ${shotId} 已占满必需参考图名额，场景参考图将被省略。`);
    }
    shots.push({ characterIds, ready: shotReady, shotId });
  }
  return {
    missingItems: [...missing.values()],
    ready:
      missing.size === 0 &&
      warnings.every((warning) => !warning.includes('超过上限')) &&
      shots.every((shot) => shot.ready),
    shots,
    storyBibleValid: true,
    styleAssetVersionId: styleVersion?.id ?? null,
    warnings,
  };
};

export const consistencyPreflightFailure = <T>(
  preflight: ConsistencyPreflightDto,
  traceId: string,
): AppResultDto<T> => {
  if (!preflight.storyBibleValid) {
    return mediaFailure(
      'MEDIA_CONSISTENCY_STORY_BIBLE_INVALID',
      '故事圣经结构无效，无法建立角色一致性输入。',
      traceId,
      false,
      '修复并确认 STORY_BIBLE 后重试。',
    );
  }
  if (preflight.warnings.some((warning) => warning.includes('超过上限'))) {
    return mediaFailure(
      'MEDIA_CONSISTENCY_REFERENCE_LIMIT_EXCEEDED',
      '画风与角色参考图数量超过当前图片模型上限。',
      traceId,
      false,
      '减少同一镜头出场角色或拆分镜头后重试。',
    );
  }
  if (preflight.missingItems.some((item) => item.kind === 'STYLE')) {
    return mediaFailure(
      'MEDIA_CONSISTENCY_STYLE_REQUIRED',
      '缺少项目画风锚点。',
      traceId,
      false,
      '上传画风参考图并填写画风描述后重试。',
    );
  }
  return mediaFailure(
    'MEDIA_CONSISTENCY_CHARACTER_REFERENCE_REQUIRED',
    '存在缺少参考图的出场角色。',
    traceId,
    false,
    '为缺失角色上传标准参考图后重试。',
  );
};

export const createMediaConsistencyService = (
  dependencies: MediaConsistencyServiceDependencies,
): MediaConsistencyService => ({
  getPreflight: async (input, traceId) => {
    try {
      const data = await dependencies.mediaUnitOfWork.run(({ media }) =>
        buildPreflight(media, dependencies, input),
      );
      return { data, ok: true };
    } catch (caught: unknown) {
      const marker = caught instanceof Error ? caught.message : '';
      if (marker === 'SCRIPT_WORKSPACE_NOT_INITIALIZED') {
        return mediaFailure(marker, '剧本工作区尚未初始化。', traceId);
      }
      if (marker === 'MEDIA_STORYBOARD_NOT_READY') {
        return mediaFailure(marker, '分镜尚未确认 READY。', traceId);
      }
      if (marker === 'MEDIA_SHOT_NOT_IN_READY_SET') {
        return mediaFailure(marker, '镜头不在当前 READY 分镜集合中。', traceId);
      }
      return mediaPersistenceFailure(traceId);
    }
  },
});
