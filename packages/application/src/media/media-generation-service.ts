/**
 * MediaGenerationService（shot-first-frame-image-generation 任务 4.1）。
 *
 * 职责：首帧生成请求的前置校验与任务建档——冻结镜头版本解析、资产绑定解析、
 * generation_input_hash 计算、requestId 幂等、N 个 PENDING 候选预落库。
 * Provider 调用与轮询/下载驱动属任务 4.2 的调度器，不在本服务内。
 */

import type { AppResultDto, GenerateCandidatesInputDto } from '@jingxu/contracts';

import type { FormatProfileRepository } from '../ports/project/format-profile-repository';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import type {
  MediaAssetType,
  MediaRepository,
  MediaStaleAffectedShot,
  MediaTaskRecord,
  MediaUnitOfWorkPort,
} from '../ports/media/media-repository';
import type { StoryboardShotSnapshot } from '../ports/script/script-types';
import {
  computeGenerationInputHash,
  extractShotCreativeFields,
  resolveImageSize,
  type ShotCreativeFields,
} from './media-generation-prompt';
import { mediaFailure, mediaPersistenceFailure } from './media-service-error';

export interface MediaGenerationServiceDependencies {
  /** 每轮候选数 N（design D6-1：方舟无 n 参数，N 次独立请求聚合为一个任务行）。 */
  readonly candidateCount: number;
  readonly formatProfiles: Pick<FormatProfileRepository, 'findAllByProject'>;
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly mediaUnitOfWork: MediaUnitOfWorkPort;
  /** 0.2 锁定的 Seedream model id（组合根从 profile 读取，服务不自行猜测）。 */
  readonly modelId: string;
  readonly newId: () => string;
  /** 归一化参数指纹（快照 client_defaults + 画幅派生尺寸），随尺寸变化。 */
  readonly parametersFingerprint: (size: Readonly<{ height: number; width: number }>) => string;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export interface MediaGenerationService {
  /**
   * 单镜头建档（幂等）。batchId 仅由批次推进钩子携带（成员任务归属，
   * batch-first-frame-generation design D1-C）；IPC 单镜头路径不传。
   */
  generateCandidates(
    input: GenerateCandidatesInputDto & { readonly batchId?: string },
    traceId: string,
  ): Promise<AppResultDto<MediaTaskRecord>>;
  /** 新 ShotContract READY 确认后的 STALE 传播（按旧镜头版本定位）。 */
  propagateStaleForShotVersion(
    shotVersionId: string,
    traceId: string,
  ): Promise<AppResultDto<readonly MediaStaleAffectedShot[]>>;
  /** 资产参考图升版后的 STALE 传播：重算受绑定镜头的当前世代哈希，旧世代标记失效。 */
  propagateStaleForAssetChange(
    input: { readonly bibleRefId: string; readonly projectId: string },
    traceId: string,
  ): Promise<AppResultDto<readonly MediaStaleAffectedShot[]>>;
}

/** 单镜头的解析结果：创意字段 + 当前世代描述符输入。 */
export interface ResolvedGenerationInput {
  readonly boundAssetVersionIds: readonly string[];
  readonly creative: ShotCreativeFields;
  readonly generationInputHash: string;
}

/**
 * 单镜头当前世代解析（冻结镜头版本 → 资产绑定 → 世代哈希）。
 * 批次跳过过滤与镜头状态视图复用同一函数——「当前世代」定义与单镜头建档一致。
 */
export const resolveGenerationInput = async (
  media: MediaRepository,
  dependencies: MediaGenerationServiceDependencies,
  projectId: string,
  shot: StoryboardShotSnapshot,
): Promise<ResolvedGenerationInput> => {
  const creative = extractShotCreativeFields(shot.version.document);
  if (creative === null) throw new Error('SHOT_DOCUMENT_INVALID');
  const size = await resolveShotSize(dependencies, projectId, shot);
  const references: readonly { bibleRefId: string; type: MediaAssetType }[] = [
    ...creative.characterIds.map((bibleRefId) => ({ bibleRefId, type: 'CHARACTER' as const })),
    ...(creative.sceneId === null
      ? []
      : [{ bibleRefId: creative.sceneId, type: 'SCENE' as const }]),
  ];
  const boundAssetVersionIds: string[] = [];
  for (const reference of references) {
    // 绑定解析不因资产缺失而阻断（spec：缺失项跳过）。
    const version = await media.findCurrentAssetVersion(
      projectId,
      reference.type,
      reference.bibleRefId,
    );
    if (version !== null) boundAssetVersionIds.push(version.id);
  }
  // 防御性上限：契约 boundAssetVersionIds ≤14（方舟参考图同限）。
  const sorted = [...boundAssetVersionIds].sort().slice(0, 14);
  return {
    boundAssetVersionIds: sorted,
    creative,
    generationInputHash: computeGenerationInputHash(
      {
        boundAssetVersionIds: sorted,
        modelId: dependencies.modelId,
        parametersFingerprint: dependencies.parametersFingerprint(size),
        shotContentHash: shot.version.documentSha256,
        shotVersionId: shot.version.id,
      },
      dependencies.hashPayload,
    ),
  };
};

/** 镜头版本自带 formatProfileId → 画幅 → 显式尺寸（确认时冻结，不随当前 profile 漂移）。 */
const resolveShotSize = async (
  dependencies: MediaGenerationServiceDependencies,
  projectId: string,
  shot: StoryboardShotSnapshot,
): Promise<Readonly<{ height: number; width: number }>> => {
  const profiles = await dependencies.formatProfiles.findAllByProject(projectId);
  const profile = profiles.find((entry) => entry.id === shot.version.formatProfileId);
  if (profile === undefined) throw new Error('FORMAT_PROFILE_MISSING');
  const size = resolveImageSize(profile.spec.aspectRatio);
  if (size === null) throw new Error('FORMAT_PROFILE_INVALID');
  return size;
};

export const createMediaGenerationService = (
  dependencies: MediaGenerationServiceDependencies,
): MediaGenerationService => ({
  generateCandidates: async (input, traceId) => {
    try {
      const workspace = await dependencies.workspaceQuery.getWorkspace(input.projectId);
      if (workspace === null) {
        return mediaFailure(
          'SCRIPT_WORKSPACE_NOT_INITIALIZED',
          '剧本工作区尚未初始化，无法生成首帧',
          traceId,
        );
      }
      const storyboard = workspace.storyboard;
      if (storyboard.current?.status !== 'READY') {
        return mediaFailure(
          'MEDIA_STORYBOARD_NOT_READY',
          '分镜尚未确认 READY，无法生成首帧',
          traceId,
        );
      }
      const shot = storyboard.currentShots.find((entry) => entry.shotId === input.shotId);
      if (shot === undefined) {
        return mediaFailure(
          'MEDIA_SHOT_NOT_IN_READY_SET',
          '镜头不在当前 READY 分镜集合中，请刷新后重试',
          traceId,
        );
      }
      const task = await dependencies.mediaUnitOfWork.run(async (media) => {
        const prior = await media.findTaskByIdempotencyKey(input.projectId, input.requestId);
        if (prior !== null) {
          if (prior.shotId !== input.shotId) throw new Error('REQUEST_ID_REUSED');
          return prior;
        }
        const resolved = await resolveGenerationInput(media, dependencies, input.projectId, shot);
        const inserted = await media.insertTask({
          batchId: input.batchId ?? null,
          candidateCount: dependencies.candidateCount,
          generationInputHash: resolved.generationInputHash,
          id: dependencies.newId(),
          idempotencyKey: input.requestId,
          projectId: input.projectId,
          shotId: input.shotId,
          shotVersionId: shot.version.id,
        });
        await media.insertCandidates({
          candidateIds: Array.from({ length: dependencies.candidateCount }, () =>
            dependencies.newId(),
          ),
          generationInputHash: resolved.generationInputHash,
          modelId: dependencies.modelId,
          projectId: input.projectId,
          roundNo: inserted.roundNo,
          shotId: input.shotId,
          shotVersionId: shot.version.id,
        });
        return inserted;
      });
      return { data: task, ok: true };
    } catch (caught: unknown) {
      const marker = caught instanceof Error ? caught.message : '';
      if (marker === 'REQUEST_ID_REUSED') {
        return mediaFailure('REQUEST_ID_REUSED', 'requestId 已用于不同镜头', traceId);
      }
      if (marker === 'MEDIA_TASK_IDEMPOTENCY_CONFLICT') {
        return mediaFailure('REQUEST_ID_REUSED', 'requestId 已被并发使用', traceId);
      }
      return mediaPersistenceFailure(traceId);
    }
  },

  propagateStaleForShotVersion: async (shotVersionId, traceId) => {
    try {
      const affected = await dependencies.mediaUnitOfWork.run((media) =>
        media.markCandidatesStaleByShotVersion(shotVersionId),
      );
      return { data: affected, ok: true };
    } catch {
      return mediaPersistenceFailure(traceId);
    }
  },

  propagateStaleForAssetChange: async (input, traceId) => {
    try {
      const workspace = await dependencies.workspaceQuery.getWorkspace(input.projectId);
      if (workspace === null) return { data: [], ok: true };
      const storyboard = workspace.storyboard;
      if (storyboard.current === null) return { data: [], ok: true };
      const affected = await dependencies.mediaUnitOfWork.run(async (media) => {
        const summaries: MediaStaleAffectedShot[] = [];
        for (const shot of storyboard.currentShots) {
          const resolved = await resolveGenerationInput(media, dependencies, input.projectId, shot);
          const bindsRef =
            resolved.creative.sceneId === input.bibleRefId ||
            resolved.creative.characterIds.includes(input.bibleRefId);
          if (!bindsRef) continue;
          const candidates = await media.listCandidates(shot.shotId);
          const staleHashes = new Set(
            candidates
              .filter(
                (candidate) =>
                  candidate.status !== 'STALE_INPUT' &&
                  candidate.generationInputHash !== resolved.generationInputHash,
              )
              .map((candidate) => candidate.generationInputHash),
          );
          for (const hash of staleHashes) {
            summaries.push(...(await media.markCandidatesStaleByGenerationInputHash(hash)));
          }
        }
        return summaries;
      });
      return { data: affected, ok: true };
    } catch {
      return mediaPersistenceFailure(traceId);
    }
  },
});
