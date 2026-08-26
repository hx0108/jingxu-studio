import { describe, expect, it, vi } from 'vitest';

import type { VideoCompositionRepository, VideoExportJobRecord } from '../ports/media';
import {
  createVideoCompositionService,
  DEFAULT_SUBTITLE_STYLE_SNAPSHOT_JSON,
  type VideoComposerPort,
} from './video-composition-service';

const HASH = 'a'.repeat(64);
const NOW = '2026-08-24T00:00:00.000Z';
type CreateExportInput = Parameters<VideoCompositionRepository['createExportJob']>[0];
type CreateTimelineInput = Parameters<VideoCompositionRepository['createTimeline']>[0];
type UpdateTimelineInput = Parameters<VideoCompositionRepository['updateTimeline']>[0];

const item = (overrides: Record<string, unknown> = {}) => ({
  candidateId: 'candidate_0001',
  enabled: true,
  fileSha256: HASH,
  generationInputHash: HASH,
  position: 0,
  shotId: 'shot_0001',
  trimInMs: 0,
  trimOutMs: 1_000,
  ...overrides,
});

const timeline = (overrides: Record<string, unknown> = {}) => ({
  audioAsset: null,
  audioVolume: 0.2,
  createdAt: NOW,
  episodeId: 'episode_0001',
  episodeVersionId: 'episode_version_0001',
  formatProfileId: 'profile_0001',
  id: 'timeline_version_0001',
  inputHash: HASH,
  items: [item()],
  parentVersionId: null,
  subtitleItems: [],
  timelineId: 'timeline_0001',
  totalDurationMs: 1_000,
  versionNo: 1,
  voiceItems: [],
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}) => ({
  actualDurationSec: 1,
  fileSha256: HASH,
  generationInputHash: HASH,
  id: 'candidate_0001',
  selectedAt: NOW,
  status: 'SUCCEEDED',
  storageRelPath: 'projects/project_0001/videos/aa/' + HASH + '.mp4',
  ...overrides,
});

const SPOKEN_TEXT = '雨巷深处传来脚步声。';
const shotDocument = (spokenText: string | null) =>
  JSON.stringify({
    content: { action: '旁白铺陈', spoken_text: spokenText },
    dialogue: {
      audio_required: spokenText !== null,
      speaker_id: spokenText === null ? null : 'narrator',
    },
  });

const voiceCandidate = (overrides: Record<string, unknown> = {}) => ({
  byteSize: 2_048,
  createdAt: NOW,
  durationMs: 1_500,
  errorCode: null,
  fileSha256: HASH,
  generationInputHash: HASH,
  id: 'vcan_0001',
  indexInRound: 0,
  jobId: 'vjob_0001',
  mimeType: 'audio/wav',
  modelId: 'qwen3-tts-instruct-flash',
  projectId: 'project_0001',
  roundNo: 1,
  selectedAt: NOW,
  shotId: 'shot_0001',
  shotVersionId: 'scv_0001',
  speakerId: 'narrator',
  spokenTextSha256: HASH,
  status: 'SUCCEEDED',
  storageRelPath: 'projects/project_0001/audio/aa/' + HASH + '.wav',
  updatedAt: NOW,
  voiceId: 'Neil',
  ...overrides,
});

const workspace = (status: 'READY' | 'DRAFT' = 'READY', spokenText: string | null = SPOKEN_TEXT) =>
  ({
    episode: { id: 'episode_0001' },
    storyboard: {
      current: { formatProfileId: 'profile_0001', id: 'episode_version_0001', status },
      currentShots: [
        {
          sequence: 1,
          shotId: 'shot_0001',
          version: { id: 'scv_0001', document: shotDocument(spokenText) },
        },
      ],
    },
  }) as never;

interface BuildOptions {
  readonly candidate?: Record<string, unknown>;
  readonly existingExport?: Record<string, unknown> | null;
  readonly mapping?: ReadonlyMap<string, string>;
  readonly status?: 'READY' | 'DRAFT';
  readonly voiceCandidate?: Record<string, unknown> | null;
  readonly workspaceSpokenText?: string | null;
}

const buildService = (options: BuildOptions = {}) => {
  const composition = {
    createExportJob: vi.fn((input: CreateExportInput) =>
      Promise.resolve({
        byteSize: null,
        createdAt: NOW,
        episodeId: input.episodeId,
        errorCode: null,
        fileSha256: null,
        id: input.id,
        inputHash: input.inputHash,
        mediaUrl: null,
        projectId: input.projectId,
        status: 'PREPARING',
        storageRelPath: null,
        timelineVersionId: input.timelineVersionId,
        totalDurationMs: input.totalDurationMs,
        updatedAt: NOW,
      } as unknown as VideoExportJobRecord),
    ),
    createTimeline: vi.fn((input: CreateTimelineInput) =>
      Promise.resolve(timeline({ id: input.id, items: input.items })),
    ),
    findAudioAsset: vi.fn(() => Promise.resolve(null)),
    findAudioAssetByHash: vi.fn(() => Promise.resolve(null)),
    findExportJob: vi.fn(() => Promise.resolve(null)),
    findExportJobByRequestId: vi.fn(() => Promise.resolve(options.existingExport ?? null)),
    findTimelineVersion: vi.fn(() => Promise.resolve(timeline())),
    insertAudioAsset: vi.fn(),
    listUnfinishedExports: vi.fn(() => Promise.resolve([])),
    updateExportStatus: vi.fn(),
    updateTimeline: vi.fn((input: UpdateTimelineInput) =>
      Promise.resolve(timeline({ id: input.id, items: input.items })),
    ),
  };
  const voiceRow =
    options.voiceCandidate === null ? null : voiceCandidate(options.voiceCandidate ?? {});
  const mediaUnitOfWork = {
    run: async (work: (repositories: never) => Promise<unknown>) =>
      work({
        composition: { composition },
        video: {
          findCandidateById: () => Promise.resolve(candidate(options.candidate)),
          listCandidates: () => Promise.resolve([candidate(options.candidate)]),
        },
        voice: {
          generation: {
            findCandidate: () => Promise.resolve(voiceRow),
            listCandidatesByShot: () => Promise.resolve(voiceRow === null ? [] : [voiceRow]),
          },
          mapping: {
            listByProject: () => Promise.resolve([]),
            replaceAll: () => Promise.resolve([]),
          },
        },
      } as never),
  };
  const composer: VideoComposerPort = { compose: vi.fn() };
  const hashPayload = vi.fn(() => HASH);
  const hashText = vi.fn((text: string) => `sha:${text}`);
  const service = createVideoCompositionService({
    composer,
    hashPayload,
    hashText,
    mediaUnitOfWork: mediaUnitOfWork as never,
    newId: vi.fn(() => 'timeline_version_0002'),
    resolveEffectiveVoiceMappings: vi.fn(() =>
      Promise.resolve(options.mapping ?? new Map([['narrator', 'Neil']])),
    ),
    resolveFormatProfile: vi.fn(() => Promise.resolve({ fps: 24, height: 1080, width: 1920 })),
    workspaceQuery: {
      getVersionDocument: vi.fn(),
      getWorkspace: vi.fn(() =>
        Promise.resolve(workspace(options.status, options.workspaceSpokenText ?? SPOKEN_TEXT)),
      ),
    },
  });
  return { composition, hashPayload, service };
};

const voiceItem = (overrides: Record<string, unknown> = {}) => ({
  candidateId: 'vcan_0001',
  enabled: true,
  fileSha256: HASH,
  generationInputHash: HASH,
  offsetMs: 0,
  shotId: 'shot_0001',
  trimInMs: 0,
  trimOutMs: 1_500,
  volume: 1,
  ...overrides,
});

describe('VideoCompositionService', () => {
  it('非 READY 单集创建时间线—拒绝且不写入', async () => {
    const { composition, service } = buildService({ status: 'DRAFT' });
    const result = await service.createTimeline(
      {
        episodeId: 'episode_0001',
        expectedEpisodeVersionId: 'episode_version_0001',
        projectId: 'project_0001',
        requestId: 'request_0001',
      },
      'trace_1',
    );
    expect(result).toMatchObject({ error: { code: 'VIDEO_COMPOSITION_NOT_READY' }, ok: false });
    expect(composition.createTimeline).not.toHaveBeenCalled();
  });

  it('READY 单集创建时间线—按镜头 sequence 固化选中候选哈希并派生两轨', async () => {
    const { composition, hashPayload, service } = buildService();
    const result = await service.createTimeline(
      {
        episodeId: 'episode_0001',
        expectedEpisodeVersionId: 'episode_version_0001',
        projectId: 'project_0001',
        requestId: 'request_0002',
      },
      'trace_2',
    );
    expect(result).toMatchObject({ data: { items: [item()] }, ok: true });
    expect(composition.createTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        audioVolume: 0.2,
        subtitleItems: [
          expect.objectContaining({
            enabled: true,
            safeAreaPct: 5,
            shotId: 'shot_0001',
            spokenTextSha256: `sha:${SPOKEN_TEXT}`,
          }),
        ],
        totalDurationMs: 1_000,
        voiceItems: [voiceItem()],
      }),
    );
    // inputHash 纳入两轨与映射快照（spec：V2 inputHash 包含配音/字幕/映射）。
    expect(hashPayload).toHaveBeenCalledWith({
      episodeVersionId: 'episode_version_0001',
      items: [item()],
      mappingSnapshot: [{ speakerId: 'narrator', voiceId: 'Neil' }],
      subtitleItems: [
        expect.objectContaining({
          spokenTextSha256: `sha:${SPOKEN_TEXT}`,
          styleSnapshotJson: DEFAULT_SUBTITLE_STYLE_SNAPSHOT_JSON,
        }),
      ],
      voiceItems: [voiceItem()],
    });
  });

  it('无选中配音候选—创建时间线—配音轨为空字幕轨仍派生', async () => {
    const { composition, service } = buildService({ voiceCandidate: null });
    await service.createTimeline(
      {
        episodeId: 'episode_0001',
        expectedEpisodeVersionId: 'episode_version_0001',
        projectId: 'project_0001',
        requestId: 'request_0002b',
      },
      'trace_2b',
    );
    expect(composition.createTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ voiceItems: [] }),
    );
  });

  it('非连续排序或越界裁剪—拒绝且不创建新版本', async () => {
    const { composition, service } = buildService();
    const result = await service.updateTimeline(
      {
        audioAssetId: null,
        audioVolume: 0.2,
        episodeId: 'episode_0001',
        expectedVersionId: 'timeline_version_0001',
        items: [item({ position: 1, trimOutMs: 1_001 })],
        projectId: 'project_0001',
        requestId: 'request_0003',
        subtitleItems: [],
        voiceItems: [],
      },
      'trace_3',
    );
    expect(result).toMatchObject({ error: { code: 'VIDEO_TRIM_INVALID' }, ok: false });
    expect(composition.updateTimeline).not.toHaveBeenCalled();
  });

  it('候选世代变化—保存时间线前返回 STALE_INPUT 语义且零写入', async () => {
    const { composition, service } = buildService({
      candidate: { generationInputHash: 'b'.repeat(64) },
    });
    const result = await service.updateTimeline(
      {
        audioAssetId: null,
        audioVolume: 0.2,
        episodeId: 'episode_0001',
        expectedVersionId: 'timeline_version_0001',
        items: [item()],
        projectId: 'project_0001',
        requestId: 'request_0004',
        subtitleItems: [],
        voiceItems: [],
      },
      'trace_4',
    );
    expect(result).toMatchObject({ error: { code: 'VIDEO_SOURCE_STALE' }, ok: false });
    expect(composition.updateTimeline).not.toHaveBeenCalled();
  });

  it('配音候选三元组漂移（STALE/换候选）—稳定拒绝且零写入', async () => {
    const { composition, service } = buildService({
      voiceCandidate: { status: 'STALE_INPUT' },
    });
    const result = await service.updateTimeline(
      {
        audioAssetId: null,
        audioVolume: 0.2,
        episodeId: 'episode_0001',
        expectedVersionId: 'timeline_version_0001',
        items: [item()],
        projectId: 'project_0001',
        requestId: 'request_0006',
        subtitleItems: [],
        voiceItems: [voiceItem()],
      },
      'trace_6',
    );
    expect(result).toMatchObject({ error: { code: 'VIDEO_SOURCE_STALE' }, ok: false });
    expect(composition.updateTimeline).not.toHaveBeenCalled();
  });

  it('配音候选哈希不符—稳定拒绝', async () => {
    const { service } = buildService({ voiceCandidate: { fileSha256: 'b'.repeat(64) } });
    const result = await service.updateTimeline(
      {
        audioAssetId: null,
        audioVolume: 0.2,
        episodeId: 'episode_0001',
        expectedVersionId: 'timeline_version_0001',
        items: [item()],
        projectId: 'project_0001',
        requestId: 'request_0007',
        subtitleItems: [],
        voiceItems: [voiceItem()],
      },
      'trace_7',
    );
    expect(result).toMatchObject({ error: { code: 'VIDEO_SOURCE_STALE' }, ok: false });
  });

  it('配音裁剪越界候选实测时长—VIDEO_TRIM_INVALID', async () => {
    const { service } = buildService();
    const result = await service.updateTimeline(
      {
        audioAssetId: null,
        audioVolume: 0.2,
        episodeId: 'episode_0001',
        expectedVersionId: 'timeline_version_0001',
        items: [item()],
        projectId: 'project_0001',
        requestId: 'request_0008',
        subtitleItems: [],
        voiceItems: [voiceItem({ trimOutMs: 1_501 })],
      },
      'trace_8',
    );
    expect(result).toMatchObject({ error: { code: 'VIDEO_TRIM_INVALID' }, ok: false });
  });

  it('音色映射漂移（候选冻结音色 ≠ 当前生效映射）—VIDEO_VOICE_MAPPING_STALE', async () => {
    const { composition, service } = buildService({
      mapping: new Map([['narrator', 'Cherry']]),
    });
    const result = await service.updateTimeline(
      {
        audioAssetId: null,
        audioVolume: 0.2,
        episodeId: 'episode_0001',
        expectedVersionId: 'timeline_version_0001',
        items: [item()],
        projectId: 'project_0001',
        requestId: 'request_0009',
        subtitleItems: [],
        voiceItems: [voiceItem()],
      },
      'trace_9',
    );
    expect(result).toMatchObject({ error: { code: 'VIDEO_VOICE_MAPPING_STALE' }, ok: false });
    expect(composition.updateTimeline).not.toHaveBeenCalled();
  });

  it('字幕哈希与镜头当前台词不符—稳定拒绝且零写入', async () => {
    const { composition, service } = buildService({
      workspaceSpokenText: '镜头已改文的新台词。',
    });
    const result = await service.updateTimeline(
      {
        audioAssetId: null,
        audioVolume: 0.2,
        episodeId: 'episode_0001',
        expectedVersionId: 'timeline_version_0001',
        items: [item()],
        projectId: 'project_0001',
        requestId: 'request_0010',
        subtitleItems: [
          {
            enabled: true,
            safeAreaPct: 5,
            shotId: 'shot_0001',
            spokenTextSha256: `sha:${SPOKEN_TEXT}`,
          },
        ],
        voiceItems: [],
      },
      'trace_10',
    );
    expect(result).toMatchObject({ error: { code: 'VIDEO_SOURCE_STALE' }, ok: false });
    expect(composition.updateTimeline).not.toHaveBeenCalled();
  });

  it('合法两轨提交—落库携带三新字段且 inputHash 纳入映射快照', async () => {
    const { composition, hashPayload, service } = buildService();
    const subtitleItem = {
      enabled: true,
      safeAreaPct: 5,
      shotId: 'shot_0001',
      spokenTextSha256: `sha:${SPOKEN_TEXT}`,
    };
    const result = await service.updateTimeline(
      {
        audioAssetId: null,
        audioVolume: 0.35,
        episodeId: 'episode_0001',
        expectedVersionId: 'timeline_version_0001',
        items: [item()],
        projectId: 'project_0001',
        requestId: 'request_0011',
        subtitleItems: [subtitleItem],
        voiceItems: [voiceItem({ offsetMs: 120 })],
      },
      'trace_11',
    );
    expect(result).toMatchObject({ ok: true });
    expect(composition.updateTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        audioVolume: 0.35,
        subtitleItems: [
          expect.objectContaining({ styleSnapshotJson: DEFAULT_SUBTITLE_STYLE_SNAPSHOT_JSON }),
        ],
        voiceItems: [voiceItem({ offsetMs: 120 })],
      }),
    );
    expect(hashPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        audioVolume: 0.35,
        mappingSnapshot: [{ speakerId: 'narrator', voiceId: 'Neil' }],
        voiceItems: [voiceItem({ offsetMs: 120 })],
      }),
    );
  });

  it('相同 requestId 改变时间线—拒绝复用且不创建第二个导出 Job', async () => {
    const { composition, service } = buildService({
      existingExport: {
        byteSize: null,
        createdAt: NOW,
        errorCode: null,
        fileSha256: null,
        id: 'export_0001',
        mediaUrl: null,
        status: 'PREPARING',
        timelineVersionId: 'timeline_version_old',
        totalDurationMs: 1_000,
        updatedAt: NOW,
      },
    });
    const result = await service.startExport(
      {
        episodeId: 'episode_0001',
        projectId: 'project_0001',
        requestId: 'request_0005',
        timelineVersionId: 'timeline_version_0001',
      },
      'trace_5',
    );
    expect(result).toMatchObject({ error: { code: 'REQUEST_ID_REUSED' }, ok: false });
    expect(composition.createExportJob).not.toHaveBeenCalled();
  });
});
