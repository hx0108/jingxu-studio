import { describe, expect, it } from 'vitest';

import { providerProfileSchema } from './job-provider-api';
import {
  VIDEO_IPC_CHANNELS,
  generateVideoCandidatesInputSchema,
  generateVideosForShotsInputSchema,
  startVideoExportInputSchema,
  storyboardVideoStatesSchema,
  updateVideoTimelineInputSchema,
  videoCandidateMediaUrl,
  videoCandidateViewSchema,
  videoTimelineSubtitleItemSchema,
  videoTimelineVoiceItemSchema,
  videoExportJobSchema,
  videoTimelineSummarySchema,
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

  it('IPC 通道—video 前缀方法与 API 接口一一对应', () => {
    expect(Object.keys(VIDEO_IPC_CHANNELS).sort()).toEqual([
      'cancelExport',
      'cancelVideoBatch',
      'createTimeline',
      'generateVideoCandidates',
      'generateVideosForShots',
      'getExportJob',
      'getTimeline',
      'getVideoTask',
      'importBackgroundMusic',
      'listStoryboardVideoStates',
      'listVideoCandidates',
      'selectVideoCandidate',
      'startExport',
      'updateTimeline',
    ]);
    for (const channel of Object.values(VIDEO_IPC_CHANNELS)) {
      expect(channel.startsWith('video.')).toBe(true);
    }
  });

  it('时间线与导出 DTO—仅包含脱敏摘要、裁剪与成功状态不变量可验证', () => {
    const item = {
      candidateId: id,
      enabled: true,
      fileSha256: hash,
      generationInputHash: hash,
      position: 0,
      shotId,
      trimInMs: 0,
      trimOutMs: 5000,
    };
    const timeline = {
      audioAsset: null,
      createdAt: iso,
      episodeId: 'episode_00001',
      episodeVersionId: 'epver_00000001',
      formatProfileId: 'format_0000001',
      id: 'timelinever_001',
      inputHash: hash,
      items: [item],
      parentVersionId: null,
      totalDurationMs: 5000,
      versionNo: 1,
    };
    expect(videoTimelineSummarySchema.safeParse(timeline).success).toBe(true);
    expect(
      updateVideoTimelineInputSchema.safeParse({
        audioAssetId: null,
        episodeId: timeline.episodeId,
        expectedVersionId: timeline.id,
        items: [{ ...item, trimInMs: 5000, trimOutMs: 5000 }],
        projectId,
        requestId,
      }).success,
    ).toBe(true);
    expect(
      startVideoExportInputSchema.safeParse({
        episodeId: timeline.episodeId,
        projectId,
        requestId,
        timelineVersionId: timeline.id,
      }).success,
    ).toBe(true);
    const successfulExport = {
      byteSize: 1234,
      createdAt: iso,
      errorCode: null,
      fileSha256: hash,
      id: 'exportjob_0001',
      mediaUrl: 'jingxu://media/video-export/exportjob_0001',
      status: 'SUCCEEDED' as const,
      timelineVersionId: timeline.id,
      totalDurationMs: 5000,
      updatedAt: iso,
    };
    expect(videoExportJobSchema.safeParse(successfulExport).success).toBe(true);
    expect(videoExportJobSchema.safeParse({ ...successfulExport, mediaUrl: null }).success).toBe(
      false,
    );
    expect(
      videoExportJobSchema.safeParse({
        ...successfulExport,
        status: 'FAILED',
        mediaUrl: 'jingxu://media/video-export/exportjob_0001',
      }).success,
    ).toBe(false);
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

  it('配音轨条目—合法输入通过、音量越界与负偏移拒绝', () => {
    const voiceItem = {
      candidateId: id,
      enabled: true,
      fileSha256: hash,
      generationInputHash: hash,
      offsetMs: 0,
      shotId,
      trimInMs: 0,
      trimOutMs: 3200,
      volume: 1,
    };
    expect(videoTimelineVoiceItemSchema.safeParse(voiceItem).success).toBe(true);
    expect(videoTimelineVoiceItemSchema.safeParse({ ...voiceItem, volume: 1.01 }).success).toBe(
      false,
    );
    expect(videoTimelineVoiceItemSchema.safeParse({ ...voiceItem, offsetMs: -1 }).success).toBe(
      false,
    );
  });

  it('字幕轨条目—安全区百分比整数 0–20 之外拒绝', () => {
    const subtitleItem = {
      enabled: true,
      safeAreaPct: 5,
      shotId,
      spokenTextSha256: hash,
    };
    expect(videoTimelineSubtitleItemSchema.safeParse(subtitleItem).success).toBe(true);
    expect(videoTimelineSubtitleItemSchema.safeParse({ ...subtitleItem, safeAreaPct: 21 }).success).toBe(false);
    expect(videoTimelineSubtitleItemSchema.safeParse({ ...subtitleItem, safeAreaPct: 5.5 }).success).toBe(false);
  });
});
