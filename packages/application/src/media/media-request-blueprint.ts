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
import type { ImageReferencePayload } from '../ports/image-model/image-model-types';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import {
  buildFirstFramePrompt,
  extractShotCreativeFields,
  resolveImageSize,
} from './media-generation-prompt';

/** 调度器按候选落位的 Provider 请求公共部分（design D2：业务层组装，Adapter 只映射）。 */
export interface MediaRequestBlueprint {
  readonly modelId: string;
  readonly prompt: string;
  /** 参考图 CAS 身份清单（与 referenceImages 同序）——证据快照只存哈希不存字节（D3）。 */
  readonly referenceImageSha256s: readonly string[];
  readonly referenceImages: readonly ImageReferencePayload[];
  readonly size: Readonly<{ height: number; width: number }>;
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

/** STORY_BIBLE 文档中 Prompt 需要的描述子集；缺失/损坏时降级为空（不阻断）。 */
interface BibleDescriptions {
  readonly characters: Readonly<Record<string, Readonly<{ appearance: string; name: string }>>>;
  readonly scenes: Readonly<Record<string, Readonly<{ description: string; name: string }>>>;
}

const EMPTY_BIBLE: BibleDescriptions = { characters: {}, scenes: {} };

const sectionOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : null;

const parseBibleDescriptions = (document: string | null): BibleDescriptions => {
  if (document === null) return EMPTY_BIBLE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return EMPTY_BIBLE;
  }
  const root = sectionOf(parsed);
  const characters: Record<string, Readonly<{ appearance: string; name: string }>> = {};
  for (const [id, entry] of Object.entries(sectionOf(root?.characters) ?? {})) {
    const character = sectionOf(entry);
    const name = character?.name;
    const appearance = character?.appearance;
    if (typeof name === 'string' && typeof appearance === 'string' && name.length > 0) {
      characters[id] = { appearance, name };
    }
  }
  const scenes: Record<string, Readonly<{ description: string; name: string }>> = {};
  for (const [id, entry] of Object.entries(sectionOf(root?.scenes) ?? {})) {
    const scene = sectionOf(entry);
    const name = scene?.name;
    const description = scene?.description;
    if (typeof name === 'string' && typeof description === 'string' && name.length > 0) {
      scenes[id] = { description, name };
    }
  }
  return { characters, scenes };
};

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

    const bible = parseBibleDescriptions(
      workspace.stages.find((stage) => stage.stage === 'STORY_BIBLE')?.current?.document ?? null,
    );
    const boundCharacters = creative.characterIds
      .map((id) => bible.characters[id])
      .filter(
        (entry): entry is Readonly<{ appearance: string; name: string }> => entry !== undefined,
      );
    const scene = creative.sceneId === null ? null : (bible.scenes[creative.sceneId] ?? null);

    // 绑定解析与建档同源：缺失资产跳过不阻断；防御性上限 14（契约同限）。
    const bindings: readonly { bibleRefId: string; type: 'CHARACTER' | 'SCENE' }[] = [
      ...creative.characterIds.map((bibleRefId) => ({ bibleRefId, type: 'CHARACTER' as const })),
      ...(creative.sceneId === null
        ? []
        : [{ bibleRefId: creative.sceneId, type: 'SCENE' as const }]),
    ];
    const referenceImages: ImageReferencePayload[] = [];
    const referenceImageSha256s: string[] = [];
    for (const binding of bindings.slice(0, 14)) {
      const version = await dependencies.mediaUnitOfWork.run(({ media }) =>
        media.findCurrentAssetVersion(task.projectId, binding.type, binding.bibleRefId),
      );
      if (version === null) continue;
      const bytes = await dependencies.referenceImages.readReference({
        fileSha256: version.fileSha256,
        mimeType: version.mimeType,
        projectId: task.projectId,
      });
      referenceImages.push({ bytes, mimeType: version.mimeType });
      referenceImageSha256s.push(version.fileSha256);
    }

    return {
      modelId,
      prompt: buildFirstFramePrompt({ boundCharacters, creative, scene }),
      referenceImageSha256s,
      referenceImages,
      size,
    };
  },
});
