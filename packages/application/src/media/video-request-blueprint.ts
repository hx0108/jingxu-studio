/**
 * 视频段生成请求蓝图（shot-video-generation 任务 3.3，design A2/A4）。
 *
 * 调度器驱动视频 PENDING 候选前，按冻结任务行重建 Provider 请求的公共部分：
 * 首帧字节（建档时固化的 first_frame_candidate_id → 选中首帧行，内容寻址读取，
 * 与图片参考图同通道——路径由持久化层按 sha+mime 派生，域无关）、分辨率档位
 * （首帧尺寸短边就近派生）、档位时长（候选行 requested_duration_sec 冻结值）、
 * 提示词（镜头文档确定性派生，纯函数零 I/O）。与建档同源：first_frame_file_sha256
 * 与选中首帧 sha 的一致性由 STALE 双触发保证（改选即 STALE，不达本层）。
 *
 * 输入不完整时抛 MEDIA_BLUEPRINT_* 稳定 message 标记，由调度器归一为任务级
 * MEDIA_REQUEST_BUILD_FAILED——不在本层决定任务命运（沿图片蓝图口径）。
 */

import type { MediaTaskRecord, MediaUnitOfWorkPort } from '../ports/media/media-repository';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import type { VideoGenerationRequest } from '../ports/video-model/video-model-types';
import type { MediaReferenceImageReader, MediaRequestBlueprint } from './media-request-blueprint';
import {
  buildVideoPrompt,
  extractVideoShotFields,
  resolveVideoSize,
} from './video-generation-input';

export interface VideoRequestBlueprintBuilder {
  readonly build: (task: MediaTaskRecord) => Promise<MediaRequestBlueprint<VideoGenerationRequest>>;
}

export interface VideoRequestBlueprintBuilderDependencies {
  readonly firstFrameReader: MediaReferenceImageReader;
  readonly mediaUnitOfWork: MediaUnitOfWorkPort;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export const createVideoRequestBlueprintBuilder = (
  dependencies: VideoRequestBlueprintBuilderDependencies,
): VideoRequestBlueprintBuilder => ({
  build: async (task) => {
    const workspace = await dependencies.workspaceQuery.getWorkspace(task.projectId);
    if (workspace === null) throw new Error('MEDIA_BLUEPRINT_WORKSPACE_MISSING');
    const shot = workspace.storyboard.currentShots.find((entry) => entry.shotId === task.shotId);
    if (shot?.version.id !== task.shotVersionId) {
      // 分镜已前进——正常路径下候选已被 STALE 传播标记；到达这里说明数据不一致。
      throw new Error('MEDIA_BLUEPRINT_SHOT_VERSION_MISMATCH');
    }
    // 冻结锚点：任务轮的候选行携带首帧候选 id / 首帧 sha / 档位时长 / 模型 id。
    const videoCandidates = await dependencies.mediaUnitOfWork.run(({ video }) =>
      video.listCandidates(task.shotId),
    );
    const anchor = videoCandidates.find((candidate) => candidate.roundNo === task.roundNo);
    if (anchor === undefined) throw new Error('MEDIA_BLUEPRINT_CANDIDATES_MISSING');
    // 分辨率档位从选中首帧行尺寸派生（与建档 resolveVideoGenerationInput 同一纯函数）。
    const imageCandidates = await dependencies.mediaUnitOfWork.run(({ media }) =>
      media.listCandidates(task.shotId),
    );
    const firstFrame = imageCandidates.find(
      (candidate) => candidate.id === anchor.firstFrameCandidateId,
    );
    const firstFrameMimeType = firstFrame?.mimeType ?? null;
    const size =
      firstFrame === undefined
        ? null
        : resolveVideoSize({ height: firstFrame.height, width: firstFrame.width });
    if (size === null || firstFrameMimeType === null) {
      throw new Error('MEDIA_BLUEPRINT_FIRST_FRAME_INVALID');
    }
    const fields = extractVideoShotFields(shot.version.document);
    if (fields === null) throw new Error('MEDIA_BLUEPRINT_SHOT_INVALID');
    const bytes = await dependencies.firstFrameReader.readReference({
      fileSha256: anchor.firstFrameFileSha256,
      mimeType: firstFrameMimeType,
      projectId: task.projectId,
    });
    const prompt = buildVideoPrompt(fields);
    return {
      buildRequest: (invocationId) => ({
        durationSec: anchor.requestedDurationSec,
        firstFrame: { bytes, mimeType: firstFrameMimeType },
        invocationId,
        modelId: anchor.modelId,
        prompt,
        resolution: size,
      }),
      modelId: anchor.modelId,
      // 字段序冻结（requestSha256 稳定性）：时长/首帧锚点对/模型/提示词/分辨率，
      // 不含首帧字节与凭据。
      submitSnapshotJson: JSON.stringify({
        durationSec: anchor.requestedDurationSec,
        firstFrameCandidateId: anchor.firstFrameCandidateId,
        firstFrameFileSha256: anchor.firstFrameFileSha256,
        modelId: anchor.modelId,
        prompt,
        resolution: size,
      }),
    };
  },
});
