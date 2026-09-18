/**
 * 首帧生成请求蓝图（shot-first-frame-image-generation 任务 4.2）。
 *
 * 调度器驱动 PENDING 候选前，按冻结任务行重建 Provider 请求的公共部分：
 * Prompt（镜头创意字段 + STORY_BIBLE 描述）、显式尺寸（镜头版本自带画幅）、
 * 参考图字节（绑定资产当前版本——STALE 传播保证 PENDING 候选的哈希仍与
 * 当前重算一致，故驱动时重解析与建档时同源）。invocationId 由调度器按候选落位。
 *
 * 输入不完整时抛 MEDIA_BLUEPRINT_* 稳定 message 标记，由调度器归一为
 * 任务级 MEDIA_REQUEST_BUILD_FAILED——不在本层决定任务命运。
 */

import type { FormatProfileRepository } from '../ports/project/format-profile-repository';
import type { MediaTaskRecord, MediaUnitOfWorkPort } from '../ports/media/media-repository';
import type {
  ImageGenerationRequest,
  ImageReferencePayload,
} from '../ports/image-model/image-model-types';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import {
  buildFirstFramePrompt,
  extractShotCreativeFields,
  resolveImageSize,
} from './media-generation-prompt';
import { parseStoryBibleDescriptions } from './story-bible-descriptions';

/**
 * 调度器提交计划（shot-video-generation 任务 1.2 泛化）：请求载荷与证据快照
 * 由域构建器产出——调度器只按候选落位 invocationId，不感知图片/视频专属字段。
 */
export interface MediaRequestBlueprint<R = ImageGenerationRequest> {
  readonly modelId: string;
  /** 逐候选 Provider 请求（invocationId 由调度器注入＝SUBMIT 证据行 id）。 */
  readonly buildRequest: (invocationId: string) => R;
  /** submit 段证据快照（确定性 JSON；只含参数/哈希，不含字节与凭据）。 */
  readonly submitSnapshotJson: string;
}

/**
 * 资产参考图字节读取：内容寻址路径由持久化层按 (projectId, sha256, mime) 派生，
 * Application 不感知目录布局；读取时复算哈希校验（损坏即抛）。
 */
export interface MediaReferenceImageReader {
  readonly readReference: (input: {
    readonly fileSha256: string;
    readonly mimeType: string;
    readonly projectId: string;
  }) => Promise<Uint8Array>;
}

export interface MediaRequestBlueprintBuilder {
  readonly build: (task: MediaTaskRecord) => Promise<MediaRequestBlueprint>;
}

export interface MediaRequestBlueprintBuilderDependencies {
  readonly formatProfiles: Pick<FormatProfileRepository, 'findAllByProject'>;
  readonly mediaUnitOfWork: MediaUnitOfWorkPort;
  readonly referenceImages: MediaReferenceImageReader;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export const createMediaRequestBlueprintBuilder = (
  dependencies: MediaRequestBlueprintBuilderDependencies,
): MediaRequestBlueprintBuilder => ({
  build: async (task) => {
    const workspace = await dependencies.workspaceQuery.getWorkspace(task.projectId);
    if (workspace === null) throw new Error('MEDIA_BLUEPRINT_WORKSPACE_MISSING');
    const shot = workspace.storyboard.currentShots.find((entry) => entry.shotId === task.shotId);
    if (shot?.version.id !== task.shotVersionId) {
      // 分镜已前进——正常路径下候选已被 STALE 传播标记；到达这里说明数据不一致。
      throw new Error('MEDIA_BLUEPRINT_SHOT_VERSION_MISMATCH');
    }
    const creative = extractShotCreativeFields(shot.version.document);
    if (creative === null) throw new Error('MEDIA_BLUEPRINT_SHOT_INVALID');
    const profiles = await dependencies.formatProfiles.findAllByProject(task.projectId);
    const profile = profiles.find((entry) => entry.id === shot.version.formatProfileId);
    const size = profile === undefined ? null : resolveImageSize(profile.spec.aspectRatio);
    if (size === null) throw new Error('MEDIA_BLUEPRINT_SIZE_INVALID');

    const candidates = await dependencies.mediaUnitOfWork.run(({ media }) =>
      media.listCandidates(task.shotId),
    );
    const modelId = candidates.find((candidate) => candidate.roundNo === task.roundNo)?.modelId;
    if (modelId === undefined) throw new Error('MEDIA_BLUEPRINT_CANDIDATES_MISSING');

    const bibleResult = parseStoryBibleDescriptions(
      workspace.stages.find((stage) => stage.stage === 'STORY_BIBLE')?.current?.document ?? null,
    );
    if (bibleResult.kind === 'invalid') {
      throw new Error('MEDIA_CONSISTENCY_STORY_BIBLE_INVALID');
    }
    const bible = bibleResult.descriptions;
    const boundCharacters = creative.characterIds
      .map((id) => bible.characters[id])
      .filter(
        (entry): entry is Readonly<{ appearance: string; name: string }> => entry !== undefined,
      );
    const scene = creative.sceneId === null ? null : (bible.scenes[creative.sceneId] ?? null);

    // 绑定解析与建档同源：缺失资产跳过不阻断；防御性上限 14（契约同限）。
    const characterIds = [...new Set(creative.characterIds)];
    const bindings: readonly {
      bibleRefId: string;
      required: boolean;
      type: 'CHARACTER' | 'SCENE' | 'STYLE';
    }[] = [
      { bibleRefId: 'project-style', required: true, type: 'STYLE' },
      ...characterIds.map((bibleRefId) => ({
        bibleRefId,
        required: true,
        type: 'CHARACTER' as const,
      })),
      ...(creative.sceneId === null
        ? []
        : [{ bibleRefId: creative.sceneId, required: false, type: 'SCENE' as const }]),
    ];
    const referenceImages: ImageReferencePayload[] = [];
    const referenceImageSha256s: string[] = [];
    const referenceDescriptors: {
      assetVersionId: string;
      bibleRefId: string;
      kind: 'CHARACTER' | 'SCENE' | 'STYLE';
      sha256: string;
    }[] = [];
    let style: { description: string; name: string } | null = null;
    for (const binding of bindings) {
      const version = await dependencies.mediaUnitOfWork.run(({ media }) =>
        media.findCurrentAssetVersion(task.projectId, binding.type, binding.bibleRefId),
      );
      if (version === null) {
        if (binding.required) {
          throw new Error(
            binding.type === 'STYLE'
              ? 'MEDIA_CONSISTENCY_STYLE_REQUIRED'
              : 'MEDIA_CONSISTENCY_CHARACTER_REFERENCE_REQUIRED',
          );
        }
        continue;
      }
      if (binding.type === 'STYLE') {
        if (version.description === null || version.description.trim() === '') {
          throw new Error('MEDIA_CONSISTENCY_STYLE_REQUIRED');
        }
        style = { description: version.description, name: '项目画风' };
      }
      if (referenceImages.length >= 14) {
        if (binding.required) throw new Error('MEDIA_CONSISTENCY_REFERENCE_LIMIT_EXCEEDED');
        continue;
      }
      const bytes = await dependencies.referenceImages.readReference({
        fileSha256: version.fileSha256,
        mimeType: version.mimeType,
        projectId: task.projectId,
      });
      referenceImages.push({ bytes, mimeType: version.mimeType });
      referenceImageSha256s.push(version.fileSha256);
      referenceDescriptors.push({
        assetVersionId: version.id,
        bibleRefId: binding.bibleRefId,
        kind: binding.type,
        sha256: version.fileSha256,
      });
    }
    if (style === null) throw new Error('MEDIA_CONSISTENCY_STYLE_REQUIRED');

    const prompt = buildFirstFramePrompt({ boundCharacters, creative, scene, style });
    return {
      buildRequest: (invocationId) => ({
        invocationId,
        modelId,
        prompt,
        referenceImages,
        size,
      }),
      modelId,
      // 字段序冻结（requestSha256 稳定性）：modelId/prompt/参考图哈希/responseFormat/size/watermark。
      submitSnapshotJson: JSON.stringify({
        modelId,
        prompt,
        referenceImages: referenceDescriptors,
        referenceImageSha256s,
        responseFormat: 'url',
        size,
        watermark: true,
      }),
    };
  },
});
