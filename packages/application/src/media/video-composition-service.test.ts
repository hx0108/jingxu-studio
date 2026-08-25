import { describe, expect, it, vi } from 'vitest';

import type { VideoCompositionRepository, VideoExportJobRecord } from '../ports/media';
import { createVideoCompositionService, type VideoComposerPort } from './video-composition-service';

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
  createdAt: NOW,
  episodeId: 'episode_0001',
  episodeVersionId: 'episode_version_0001',
  formatProfileId: 'profile_0001',
  id: 'timeline_version_0001',
  inputHash: HASH,
  items: [item()],
  parentVersionId: null,
  timelineId: 'timeline_0001',
  totalDurationMs: 1_000,
  versionNo: 1,
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

const workspace = (status: 'READY' | 'DRAFT' = 'READY') =>
  ({
    episode: { id: 'episode_0001' },
    storyboard: {
      current: { formatProfileId: 'profile_0001', id: 'episode_version_0001', status },
      currentShots: [{ sequence: 1, shotId: 'shot_0001' }],
    },
  }) as never;

const buildService = (
  options: {
    readonly candidate?: Record<string, unknown>;
    readonly existingExport?: Record<string, unknown> | null;
    readonly status?: 'READY' | 'DRAFT';
  } = {},
) => {
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
  const mediaUnitOfWork = {
    run: async (work: (repositories: never) => Promise<unknown>) =>
      work({
        composition: { composition },
        video: {
          findCandidateById: () => Promise.resolve(candidate(options.candidate)),
          listCandidates: () => Promise.resolve([candidate(options.candidate)]),
        },
      } as never),
  };
  const composer: VideoComposerPort = { compose: vi.fn() };
  const hashPayload = vi.fn(() => HASH);
  const service = createVideoCompositionService({
    composer,
    hashPayload,
    mediaUnitOfWork: mediaUnitOfWork as never,
    newId: vi.fn(() => 'timeline_version_0002'),
    resolveFormatProfile: vi.fn(() => Promise.resolve({ fps: 24, height: 1080, width: 1920 })),
    workspaceQuery: {
      getVersionDocument: vi.fn(),
      getWorkspace: vi.fn(() => Promise.resolve(workspace(options.status))),
    },
  });
  return { composition, hashPayload, service };
};

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

  it('READY 单集创建时间线—按镜头 sequence 固化选中候选哈希', async () => {
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
      expect.objectContaining({ totalDurationMs: 1_000 }),
    );
    expect(hashPayload).toHaveBeenCalledWith({
      episodeVersionId: 'episode_version_0001',
      items: [item()],
    });
  });

  it('非连续排序或越界裁剪—拒绝且不创建新版本', async () => {
    const { composition, service } = buildService();
    const result = await service.updateTimeline(
      {
        audioAssetId: null,
        episodeId: 'episode_0001',
        expectedVersionId: 'timeline_version_0001',
        items: [item({ position: 1, trimOutMs: 1_001 })],
        projectId: 'project_0001',
        requestId: 'request_0003',
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
        episodeId: 'episode_0001',
        expectedVersionId: 'timeline_version_0001',
        items: [item()],
        projectId: 'project_0001',
        requestId: 'request_0004',
      },
      'trace_4',
    );
    expect(result).toMatchObject({ error: { code: 'VIDEO_SOURCE_STALE' }, ok: false });
    expect(composition.updateTimeline).not.toHaveBeenCalled();
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
