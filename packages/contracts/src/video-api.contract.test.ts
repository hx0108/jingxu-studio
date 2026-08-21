import { describe, expect, it } from 'vitest';

import { providerProfileSchema } from './job-provider-api';
import {
  VIDEO_IPC_CHANNELS,
  generateVideoCandidatesInputSchema,
  generateVideosForShotsInputSchema,
  storyboardVideoStatesSchema,
  videoCandidateMediaUrl,
  videoCandidateViewSchema,
} from './video-api';

const id = 'vcand_00000001';
const shotId = 'shot_00000001';
const projectId = 'proj_00000001';
const requestId = 'req_000000001';
const hash = 'a'.repeat(64);
const iso = '2026-08-20T00:00:00.000Z';

const succeededCandidate = {
  actualDurationSec: 5,
  byteSize: 2048,
  continuationSegmentCount: 0,
  createdAt: iso,
  errorCode: null,
  firstFrameCandidateId: 'cand_00000001',
  generationInputHash: hash,
  height: 1280,
  id,
  indexInRound: 0,
  mediaUrl: videoCandidateMediaUrl(id),
  mimeType: 'video/mp4',
  requestedDurationSec: 5,
  roundNo: 1,
  selectedAt: null,
  shotId,
  shotVersionId: 'shver_0000001',
  status: 'SUCCEEDED',
  trimRange: null,
  width: 720,
} as const;

describe('video-api contracts', () => {
  it('SUCCEEDED 视频候选—video-candidate 受限协议 URL 与时长口径字段', () => {
    expect(videoCandidateViewSchema.safeParse(succeededCandidate).success).toBe(true);
    // Provider 未回报实际时长：actualDurationSec null 如实记录。
    expect(
      videoCandidateViewSchema.safeParse({ ...succeededCandidate, actualDurationSec: null })
        .success,
    ).toBe(true);
    // 时长口径恒量：续写段数只接受 0、裁剪区间只接受 null（本切片不续写不裁剪）。
    expect(
      videoCandidateViewSchema.safeParse({
        ...succeededCandidate,
        continuationSegmentCount: 1,
      }).success,
    ).toBe(false);
    expect(
      videoCandidateViewSchema.safeParse({ ...succeededCandidate, trimRange: { from: 0 } }).success,
    ).toBe(false);
  });

  it('非 SUCCEEDED 候选—不得携带 mediaUrl；errorCode 只在 FAILED 携带', () => {
    const pending = {
      ...succeededCandidate,
      byteSize: null,
      mediaUrl: null,
      mimeType: null,
      status: 'PENDING' as const,
    };
    expect(videoCandidateViewSchema.safeParse(pending).success).toBe(true);

    const pendingWithUrl = { ...pending, mediaUrl: videoCandidateMediaUrl(id) };
    expect(videoCandidateViewSchema.safeParse(pendingWithUrl).success).toBe(false);

    const failed = {
      ...pending,
      errorCode: 'MODEL_RATE_LIMITED',
      status: 'FAILED' as const,
    };
    expect(videoCandidateViewSchema.safeParse(failed).success).toBe(true);

    const staleWithCode = {
      ...pending,
      errorCode: 'MODEL_UNKNOWN',
      status: 'STALE_INPUT' as const,
    };
    expect(videoCandidateViewSchema.safeParse(staleWithCode).success).toBe(false);
  });

  it('mediaUrl—外部协议与旁路 mime 拒绝；文件系统路径不进候选（脱敏面）', () => {
    expect(
      videoCandidateViewSchema.safeParse({
        ...succeededCandidate,
        mediaUrl: 'https://evil.example/x.mp4',
      }).success,
    ).toBe(false);
    expect(
      videoCandidateViewSchema.safeParse({
        ...succeededCandidate,
        mimeType: 'video/webm',
      }).success,
    ).toBe(false);
    expect(
      videoCandidateViewSchema.safeParse({
        ...succeededCandidate,
        storageRelPath: 'C:\\media\\videos\\secret',
      }).success,
    ).toBe(false);
  });

  it('IPC 通道—video 前缀七方法与 API 接口一一对应', () => {
    expect(Object.keys(VIDEO_IPC_CHANNELS).sort()).toEqual([
      'cancelVideoBatch',
      'generateVideoCandidates',
      'generateVideosForShots',
      'getVideoTask',
      'listStoryboardVideoStates',
      'listVideoCandidates',
      'selectVideoCandidate',
    ]);
    for (const channel of Object.values(VIDEO_IPC_CHANNELS)) {
      expect(channel.startsWith('video.')).toBe(true);
    }
  });

  it('generateVideoCandidates 输入—projectId/shotId/requestId 必填且 strict', () => {
    expect(
      generateVideoCandidatesInputSchema.safeParse({ projectId, requestId, shotId }).success,
    ).toBe(true);
    expect(generateVideoCandidatesInputSchema.safeParse({ projectId, shotId }).success).toBe(false);
    expect(
      generateVideoCandidatesInputSchema.safeParse({
        extra: 1,
        projectId,
        requestId,
        shotId,
      }).success,
    ).toBe(false);
  });

  it('generateVideosForShots 输入—shotIds 1..20 去重且 strict', () => {
    expect(
      generateVideosForShotsInputSchema.safeParse({
        projectId,
        requestId,
        shotIds: [shotId],
      }).success,
    ).toBe(true);
    expect(
      generateVideosForShotsInputSchema.safeParse({
        projectId,
        requestId,
        shotIds: [shotId, shotId],
      }).success,
    ).toBe(false);
    expect(
      generateVideosForShotsInputSchema.safeParse({ projectId, requestId, shotIds: [] }).success,
    ).toBe(false);
    expect(
      generateVideosForShotsInputSchema.safeParse({
        projectId,
        requestId,
        shotIds: Array.from({ length: 21 }, (_, index) => `shot_${String(index).padStart(6, '0')}`),
      }).success,
    ).toBe(false);
  });

  it('Provider 枚举—VOLCARK_SEEDANCE 视频档 round-trip、未知 provider 拒绝', () => {
    const view = {
      configured: true,
      enabled: true,
      last4: 'AB12',
      modelId: 'seedance-1-0-pro',
      provider: 'VOLCARK_SEEDANCE',
      region: 'cn-beijing',
      validated: true,
      versionId: 'pver_0000001',
      workspaceId: 'ws-123',
    } as const;
    expect(providerProfileSchema.parse(view).provider).toBe('VOLCARK_SEEDANCE');
    expect(providerProfileSchema.safeParse({ ...view, provider: 'DOUBAO' }).success).toBe(false);
  });

  it('storyboardVideoStates—视频状态底座与共享批次视图', () => {
    const batch = {
      batchId: 'batch_00000001',
      createdAt: iso,
      errorCode: null,
      members: [{ errorCode: null, phase: 'POLLING', shotId, taskId: 'task_0000001' }],
      skippedShotIds: ['shot_0000002'],
      status: 'RUNNING',
      updatedAt: iso,
    } as const;
    const states = {
      batches: [batch],
      shots: [
        {
          activeTaskPhase: 'POLLING',
          currentGenSucceededCount: 1,
          latestTaskErrorCode: null,
          queuedInBatchId: null,
          shotId,
        },
      ],
    };
    expect(storyboardVideoStatesSchema.safeParse(states).success).toBe(true);
    expect(
      storyboardVideoStatesSchema.safeParse({
        ...states,
        shots: [{ ...states.shots[0], activeTaskPhase: 'RUNNING' }],
      }).success,
    ).toBe(false);
  });
});
