/**
 * VideoGenerationService（shot-video-generation 任务 3.2，design A2/A4/A5）。
 *
 * 职责：视频段生成请求的前置门禁与任务建档——凭据闸（MODEL_CREDENTIAL_INVALID
 * 指向视频配置入口）、已选首帧门禁（MEDIA_FIRST_FRAME_NOT_SELECTED，不落任何
 * 任务/候选行）、冻结输入解析（选中首帧 sha → 短边就近分辨率档 + 时长档位就近
 * 映射 → 参数指纹 → generation_input_hash）、requestId 幂等（重放不产生第二轮）、
 * N 个 PENDING 候选预落库（首帧锚点对成对固化）。Provider 提交/轮询/下载属任务
 * 3.3 的调度器；STALE 双传播与视频选择指针在本服务内（与图片域
 * MediaGenerationService 同构二次实例化）。
 */

import type {
  AppResultDto,
  GenerateVideoCandidatesInputDto,
  SelectVideoCandidateInputDto,
} from '@jingxu/contracts';

import type {
  MediaRepository,
  MediaStaleAffectedShot,
  MediaTaskRecord,
  MediaUnitOfWorkPort,
  VideoCandidateRecord,
} from '../ports/media/media-repository';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import type { StoryboardShotSnapshot } from '../ports/script/script-types';
import { mediaFailure, mediaPersistenceFailure } from './media-service-error';
import {
  buildVideoParametersFingerprint,
  computeVideoGenerationInputHash,
  resolveVideoDurationTier,
  resolveVideoSize,
  type VideoDurationRange,
} from './video-generation-input';

export interface VideoGenerationServiceDependencies {
  /** 生成前置凭据闸（design A5）：抛错即以稳定 MODEL_CREDENTIAL_INVALID 拒绝（Mock 档不注入）。 */
  readonly assertCredentialReady?: (() => Promise<void>) | undefined;
  /** 每轮候选数 N（拍板 D3：组合根注入常量 2）。 */
  readonly candidateCount: number;
  /** 能力快照 request.duration_range（组合根读快照注入；Seedance 预期 [5,10]）。 */
  readonly durationRange: VideoDurationRange;
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly mediaUnitOfWork: MediaUnitOfWorkPort;
  /** 视频档 Seedance model id（组合根从视频 profile 读取，服务不自行猜测）。 */
  readonly modelId: string;
  readonly newId: () => string;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export interface VideoGenerationService {
  /** 单镜头建档（幂等）。batchId 仅由批次推进钩子携带（3.4）；IPC 单镜头路径不传。 */
  generateVideoCandidates(
    input: GenerateVideoCandidatesInputDto & { readonly batchId?: string },
    traceId: string,
  ): Promise<AppResultDto<MediaTaskRecord>>;
  /** 新 ShotContract READY 确认后的 STALE 传播（按旧镜头版本定位，video 表）。 */
  propagateStaleForShotVersion(
    shotVersionId: string,
    traceId: string,
  ): Promise<AppResultDto<readonly MediaStaleAffectedShot[]>>;
  /** 已选首帧变化后的 STALE 传播（按候选 first_frame_file_sha256 join 判定）。 */
  propagateStaleForFirstFrameChange(
    input: { readonly shotId: string },
    traceId: string,
  ): Promise<AppResultDto<readonly MediaStaleAffectedShot[]>>;
  /** 人工选择/切换当前视频段（先清后设）；返回该镜头全量候选以刷新选择态。 */
  selectCandidate(
    input: SelectVideoCandidateInputDto,
    traceId: string,
  ): Promise<AppResultDto<readonly VideoCandidateRecord[]>>;
}

/** 单镜头的解析结果：首帧锚点对 + 请求时长档位 + 当前世代哈希。 */
export interface ResolvedVideoGenerationInput {
  readonly durationSec: number;
  readonly firstFrameCandidateId: string;
  readonly firstFrameFileSha256: string;
  readonly generationInputHash: string;
}

/**
 * 单镜头当前世代解析（冻结镜头版本 → 已选首帧锚点 → 分辨率/时长档位 → 世代哈希）。
 * 批次目标判定（3.4）复用同一函数——「当前世代」定义与单镜头建档一致。
 * 超档标注（exceededMax）由 requested_duration_sec 落列如实承载：Renderer 对比
 * 镜头 target_duration_sec 派生提示，不在本层续写或拆镜。
 */
export const resolveVideoGenerationInput = async (
  media: MediaRepository,
  dependencies: Pick<
    VideoGenerationServiceDependencies,
    'durationRange' | 'hashPayload' | 'modelId'
  >,
  shot: StoryboardShotSnapshot,
): Promise<ResolvedVideoGenerationInput> => {
  const imageCandidates = await media.listCandidates(shot.shotId);
  const selected = imageCandidates.find((candidate) => candidate.selectedAt !== null);
  if (selected === undefined) throw new Error('MEDIA_FIRST_FRAME_NOT_SELECTED');
  const size = resolveVideoSize({ height: selected.height, width: selected.width });
  // 选择指针只落在 SUCCEEDED 行（文件四元组齐备）；sha/尺寸缺失即行级数据异常。
  if (size === null || selected.fileSha256 === null) {
    throw new Error('MEDIA_FIRST_FRAME_ANCHOR_INVALID');
  }
  const tier = resolveVideoDurationTier(shot.version.targetDurationSec, dependencies.durationRange);
  const parametersFingerprint = buildVideoParametersFingerprint({
    durationSec: tier.durationSec,
    firstFrameFileSha256: selected.fileSha256,
    modelId: dependencies.modelId,
    size,
  });
  return {
    durationSec: tier.durationSec,
    firstFrameCandidateId: selected.id,
    firstFrameFileSha256: selected.fileSha256,
    generationInputHash: computeVideoGenerationInputHash(
      {
        firstFrameFileSha256: selected.fileSha256,
        modelId: dependencies.modelId,
        parametersFingerprint,
        shotContentHash: shot.version.documentSha256,
        shotVersionId: shot.version.id,
      },
      dependencies.hashPayload,
    ),
  };
};

export const createVideoGenerationService = (
  dependencies: VideoGenerationServiceDependencies,
): VideoGenerationService => ({
  generateVideoCandidates: async (input, traceId) => {
    try {
      // 凭据前置闸（design A5）：未配置/不可解密先于建档稳定失败，指向视频配置入口。
      if (dependencies.assertCredentialReady !== undefined) {
        try {
          await dependencies.assertCredentialReady();
        } catch {
          return mediaFailure(
            'MODEL_CREDENTIAL_INVALID',
            '视频 Provider 凭据未配置或密文不可解密。',
            traceId,
            false,
            '在剧本工作区「Provider 设置」的视频卡片中保存 ARK API Key 后重试。',
          );
        }
      }
      const workspace = await dependencies.workspaceQuery.getWorkspace(input.projectId);
      if (workspace === null) {
        return mediaFailure(
          'SCRIPT_WORKSPACE_NOT_INITIALIZED',
          '剧本工作区尚未初始化，无法生成视频段',
          traceId,
        );
      }
      const storyboard = workspace.storyboard;
      if (storyboard.current?.status !== 'READY') {
        return mediaFailure(
          'MEDIA_STORYBOARD_NOT_READY',
          '分镜尚未确认 READY，无法生成视频段',
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
      const task = await dependencies.mediaUnitOfWork.run(async ({ media, video }) => {
        const prior = await video.findTaskByIdempotencyKey(input.projectId, input.requestId);
        if (prior !== null) {
          if (prior.shotId !== input.shotId) throw new Error('REQUEST_ID_REUSED');
          return prior;
        }
        const resolved = await resolveVideoGenerationInput(media, dependencies, shot);
        const inserted = await video.insertTask({
          batchId: input.batchId ?? null,
          candidateCount: dependencies.candidateCount,
          generationInputHash: resolved.generationInputHash,
          id: dependencies.newId(),
          idempotencyKey: input.requestId,
          projectId: input.projectId,
          shotId: input.shotId,
          shotVersionId: shot.version.id,
        });
        await video.insertCandidates({
          candidateIds: Array.from({ length: dependencies.candidateCount }, () =>
            dependencies.newId(),
          ),
          firstFrameCandidateId: resolved.firstFrameCandidateId,
          firstFrameFileSha256: resolved.firstFrameFileSha256,
          generationInputHash: resolved.generationInputHash,
          modelId: dependencies.modelId,
          projectId: input.projectId,
          requestedDurationSec: resolved.durationSec,
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
      if (marker === 'MEDIA_FIRST_FRAME_NOT_SELECTED') {
        return mediaFailure(
          'MEDIA_FIRST_FRAME_NOT_SELECTED',
          '镜头尚未选择首帧，请先在首帧候选中选定一帧再生成视频段',
          traceId,
        );
      }
      return mediaPersistenceFailure(traceId);
    }
  },

  propagateStaleForShotVersion: async (shotVersionId, traceId) => {
    try {
      const affected = await dependencies.mediaUnitOfWork.run(({ video }) =>
        video.markCandidatesStaleByShotVersion(shotVersionId),
      );
      return { data: affected, ok: true };
    } catch {
      return mediaPersistenceFailure(traceId);
    }
  },

  propagateStaleForFirstFrameChange: async (input, traceId) => {
    try {
      const affected = await dependencies.mediaUnitOfWork.run(({ video }) =>
        video.markVideoStaleByFirstFrameChange(input.shotId),
      );
      return { data: affected, ok: true };
    } catch {
      return mediaPersistenceFailure(traceId);
    }
  },

  selectCandidate: async (input, traceId) => {
    try {
      const updated = await dependencies.mediaUnitOfWork.run(async ({ video }) => {
        const candidate = await video.findCandidateById(input.projectId, input.candidateId);
        if (candidate === null) throw new Error('MEDIA_CANDIDATE_NOT_FOUND');
        await video.selectCandidate(candidate.shotId, input.candidateId);
        return video.listCandidates(candidate.shotId);
      });
      return { data: updated, ok: true };
    } catch (caught: unknown) {
      const marker = caught instanceof Error ? caught.message : '';
      if (marker === 'MEDIA_CANDIDATE_NOT_FOUND') {
        return mediaFailure('MEDIA_CANDIDATE_NOT_FOUND', '视频候选不存在或不在该项目中', traceId);
      }
      if (marker === 'MEDIA_CANDIDATE_NOT_SELECTABLE') {
        return mediaFailure(
          'MEDIA_CANDIDATE_NOT_SELECTABLE',
          '仅成功候选可设为当前视频段',
          traceId,
        );
      }
      return mediaPersistenceFailure(traceId);
    }
  },
});
