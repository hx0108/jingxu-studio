import type {
  AppResultDto,
  CreateVideoTimelineInputDto,
  GetVideoTimelineInputDto,
  ImportVideoBackgroundMusicInputDto,
  UpdateVideoTimelineInputDto,
  VideoAudioAssetSummaryDto,
  VideoTimelineItemDto,
  VideoTimelineSummaryDto,
  CancelVideoExportInputDto,
  GetVideoExportJobInputDto,
  StartVideoExportInputDto,
  VideoExportJobDto,
} from '@jingxu/contracts';

import type {
  MediaUnitOfWorkPort,
  VideoCandidateRecord,
  VideoAudioAssetRecord,
  VideoCompositionRepository,
  VideoExportJobRecord,
  VideoTimelineVersionRecord,
} from '../ports/media';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';

export interface VideoCompositionServiceDependencies {
  readonly composer: VideoComposerPort;
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly mediaUnitOfWork: MediaUnitOfWorkPort;
  readonly newId: () => string;
  readonly resolveFormatProfile: (
    projectId: string,
    formatProfileId: string,
  ) => Promise<Readonly<{ fps: number; height: number; width: number }> | null>;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export interface ImportedBackgroundMusic {
  readonly byteSize: number;
  readonly fileSha256: string;
  readonly id: string;
  readonly mimeType: VideoAudioAssetSummaryDto['mimeType'];
  readonly originalFileName: string;
  readonly storageRelPath: string;
}

export interface VideoComposerPort {
  compose(input: {
    readonly audioStorageRelPath: string | null;
    readonly clips: readonly Readonly<{
      storageRelPath: string;
      trimInMs: number;
      trimOutMs: number;
    }>[];
    readonly fps: number;
    readonly height: number;
    /** 仅用于 Main Adapter 命名导出；不得进入 Renderer 或持久化回执。 */
    readonly exportJobId: string;
    readonly projectId: string;
    readonly signal: AbortSignal;
    readonly width: number;
  }): Promise<Readonly<{ byteSize: number; fileSha256: string; storageRelPath: string }>>;
}

/**
 * Main-only media probe boundary. Application code receives normalized metadata
 * and never accepts a Renderer supplied filesystem path.
 */
export interface VideoMetadataProbePort {
  probe(input: { readonly storageRelPath: string }): Promise<
    Readonly<{
      durationMs: number;
      hasAudio: boolean;
      height: number;
      width: number;
    }>
  >;
}

export interface VideoCompositionService {
  createTimeline(
    input: CreateVideoTimelineInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoTimelineSummaryDto>>;
  getTimeline(
    input: GetVideoTimelineInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoTimelineSummaryDto>>;
  updateTimeline(
    input: UpdateVideoTimelineInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoTimelineSummaryDto>>;
  importBackgroundMusic(
    input: ImportVideoBackgroundMusicInputDto,
    file: ImportedBackgroundMusic,
    traceId: string,
  ): Promise<AppResultDto<VideoAudioAssetSummaryDto>>;
  startExport(
    input: StartVideoExportInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoExportJobDto>>;
  getExportJob(
    input: GetVideoExportJobInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoExportJobDto>>;
  cancelExport(
    input: CancelVideoExportInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoExportJobDto>>;
  recoverUnfinishedExports(projectId: string): Promise<void>;
}

const failure = <T>(
  code: string,
  traceId: string,
  message = '视频时间线操作失败。',
): AppResultDto<T> => ({
  error: {
    code: code as never,
    fieldErrors: null,
    message,
    retryable: false,
    traceId,
    userAction: '请修正输入后重试。',
  },
  ok: false,
});

const success = <T>(data: T): AppResultDto<T> => ({ data, ok: true });

const toTimelineDto = (record: VideoTimelineVersionRecord): VideoTimelineSummaryDto => ({
  audioAsset:
    record.audioAsset === null
      ? null
      : {
          byteSize: record.audioAsset.byteSize,
          fileSha256: record.audioAsset.fileSha256,
          id: record.audioAsset.id,
          mimeType: record.audioAsset.mimeType,
          originalFileName: record.audioAsset.originalFileName,
        },
  createdAt: record.createdAt,
  episodeId: record.episodeId,
  episodeVersionId: record.episodeVersionId,
  formatProfileId: record.formatProfileId,
  id: record.id,
  inputHash: record.inputHash,
  items: record.items,
  parentVersionId: record.parentVersionId,
  totalDurationMs: record.totalDurationMs,
  versionNo: record.versionNo,
});

const toExportJobDto = (record: VideoExportJobRecord): VideoExportJobDto => ({
  byteSize: record.byteSize,
  createdAt: record.createdAt,
  errorCode: record.errorCode,
  fileSha256: record.fileSha256,
  id: record.id,
  mediaUrl: record.mediaUrl,
  status: record.status,
  timelineVersionId: record.timelineVersionId,
  totalDurationMs: record.totalDurationMs,
  updatedAt: record.updatedAt,
});

const compositionOf = (
  mediaUnitOfWork: MediaUnitOfWorkPort,
): Promise<VideoCompositionRepository | null> =>
  mediaUnitOfWork.run(({ composition }) => Promise.resolve(composition?.composition ?? null));

const findSelectedCandidate = async (
  mediaUnitOfWork: MediaUnitOfWorkPort,
  shotId: string,
): Promise<VideoCandidateRecord | undefined> =>
  mediaUnitOfWork.run(async ({ video }) =>
    (await video.listCandidates(shotId)).find(
      (candidate) => candidate.status === 'SUCCEEDED' && candidate.selectedAt !== null,
    ),
  );

const validateItems = (items: readonly VideoTimelineItemDto[]): string | null => {
  if (items.length === 0 || items.every((item) => !item.enabled)) return 'VIDEO_TRIM_INVALID';
  const shots = new Set<string>();
  const positions = new Set<number>();
  for (const item of items) {
    if (shots.has(item.shotId) || positions.has(item.position)) return 'VIDEO_TRIM_INVALID';
    shots.add(item.shotId);
    positions.add(item.position);
    if (
      !Number.isInteger(item.trimInMs) ||
      !Number.isInteger(item.trimOutMs) ||
      item.trimInMs < 0 ||
      item.trimOutMs <= item.trimInMs
    )
      return 'VIDEO_TRIM_INVALID';
  }
  if (![...positions].every((position) => position >= 0 && position < items.length)) {
    return 'VIDEO_TRIM_INVALID';
  }
  return null;
};

export const createVideoCompositionService = (
  dependencies: VideoCompositionServiceDependencies,
): VideoCompositionService => {
  const abortControllers = new Map<string, AbortController>();
  const getWorkspace = async (projectId: string, episodeId: string) => {
    const workspace = await dependencies.workspaceQuery.getWorkspace(projectId);
    if (
      workspace === null ||
      workspace.episode?.id !== episodeId ||
      workspace.storyboard.current === null
    )
      return null;
    return workspace;
  };

  const createTimeline = async (
    input: CreateVideoTimelineInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoTimelineSummaryDto>> => {
    const workspace = await getWorkspace(input.projectId, input.episodeId);
    if (workspace === null) return failure('VIDEO_COMPOSITION_NOT_READY', traceId);
    const current = workspace.storyboard.current;
    if (current?.id !== input.expectedEpisodeVersionId)
      return failure('VIDEO_COMPOSITION_NOT_READY', traceId);
    if (current.status !== 'READY') return failure('VIDEO_COMPOSITION_NOT_READY', traceId);
    const items: VideoTimelineItemDto[] = [];
    for (const shot of workspace.storyboard.currentShots) {
      const candidate = await findSelectedCandidate(dependencies.mediaUnitOfWork, shot.shotId);
      if (candidate === undefined) return failure('VIDEO_SOURCE_MISSING', traceId);
      if (candidate.fileSha256 === null || candidate.actualDurationSec === null)
        return failure('VIDEO_SOURCE_MISSING', traceId);
      items.push({
        candidateId: candidate.id,
        enabled: true,
        fileSha256: candidate.fileSha256,
        generationInputHash: candidate.generationInputHash,
        position: shot.sequence - 1,
        shotId: shot.shotId,
        trimInMs: 0,
        trimOutMs: Math.max(1, Math.round(candidate.actualDurationSec * 1_000)),
      });
    }
    const inputHash = dependencies.hashPayload({ episodeVersionId: current.id, items });
    const composition = await compositionOf(dependencies.mediaUnitOfWork);
    if (composition === null) return failure('PROJECT_PERSISTENCE_FAILED', traceId);
    const created = await composition.createTimeline({
      episodeId: input.episodeId,
      episodeVersionId: current.id,
      formatProfileId: current.formatProfileId,
      id: dependencies.newId(),
      inputHash,
      items,
      projectId: input.projectId,
      totalDurationMs: items.reduce((sum, item) => sum + item.trimOutMs - item.trimInMs, 0),
    });
    return success(toTimelineDto(created));
  };

  const getTimeline = async (
    input: GetVideoTimelineInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoTimelineSummaryDto>> => {
    const composition = await compositionOf(dependencies.mediaUnitOfWork);
    const found =
      composition === null
        ? null
        : await composition.findTimelineVersion(
            input.projectId,
            input.episodeId,
            input.timelineVersionId,
          );
    return found === null
      ? failure('VIDEO_SOURCE_MISSING', traceId)
      : success(toTimelineDto(found));
  };

  const updateTimeline = async (
    input: UpdateVideoTimelineInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoTimelineSummaryDto>> => {
    const validation = validateItems(input.items);
    if (validation !== null) return failure(validation, traceId);
    const composition = await compositionOf(dependencies.mediaUnitOfWork);
    if (composition === null) return failure('PROJECT_PERSISTENCE_FAILED', traceId);
    const current = await composition.findTimelineVersion(
      input.projectId,
      input.episodeId,
      input.expectedVersionId,
    );
    if (current?.id !== input.expectedVersionId) return failure('VIDEO_SOURCE_STALE', traceId);
    for (const item of input.items) {
      const candidate = await findSelectedCandidate(dependencies.mediaUnitOfWork, item.shotId);
      if (candidate === undefined) return failure('VIDEO_SOURCE_STALE', traceId);
      if (
        candidate.id !== item.candidateId ||
        candidate.fileSha256 !== item.fileSha256 ||
        candidate.generationInputHash !== item.generationInputHash ||
        candidate.actualDurationSec === null
      )
        return failure('VIDEO_SOURCE_STALE', traceId);
      if (item.trimOutMs > Math.round(candidate.actualDurationSec * 1_000))
        return failure('VIDEO_TRIM_INVALID', traceId);
    }
    let audio: VideoAudioAssetRecord | null = null;
    if (input.audioAssetId !== null)
      audio = await composition.findAudioAsset(input.projectId, input.audioAssetId);
    if (input.audioAssetId !== null && audio === null)
      return failure('VIDEO_AUDIO_INVALID', traceId);
    const inputHash = dependencies.hashPayload({
      audioAssetId: input.audioAssetId,
      episodeVersionId: current.episodeVersionId,
      items: input.items,
    });
    return success(
      toTimelineDto(
        await composition.updateTimeline({
          audioAssetId: input.audioAssetId,
          expectedVersionId: input.expectedVersionId,
          id: dependencies.newId(),
          inputHash,
          items: input.items,
          projectId: input.projectId,
          totalDurationMs: input.items
            .filter((item) => item.enabled)
            .reduce((sum, item) => sum + item.trimOutMs - item.trimInMs, 0),
        }),
      ),
    );
  };

  const importBackgroundMusic = async (
    input: ImportVideoBackgroundMusicInputDto,
    file: ImportedBackgroundMusic,
    traceId: string,
  ): Promise<AppResultDto<VideoAudioAssetSummaryDto>> => {
    const composition = await compositionOf(dependencies.mediaUnitOfWork);
    if (composition === null) return failure('PROJECT_PERSISTENCE_FAILED', traceId);
    const existing = await composition.findAudioAssetByHash(input.projectId, file.fileSha256);
    const inserted =
      existing ?? (await composition.insertAudioAsset({ ...file, projectId: input.projectId }));
    return success({
      byteSize: inserted.byteSize,
      fileSha256: inserted.fileSha256,
      id: inserted.id,
      mimeType: inserted.mimeType,
      originalFileName: inserted.originalFileName,
    });
  };

  const getExportJob = async (
    input: GetVideoExportJobInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoExportJobDto>> => {
    const composition = await compositionOf(dependencies.mediaUnitOfWork);
    const job =
      composition === null
        ? null
        : await composition.findExportJob(input.projectId, input.exportJobId);
    return job === null ? failure('VIDEO_SOURCE_MISSING', traceId) : success(toExportJobDto(job));
  };

  const runExport = async (
    input: StartVideoExportInputDto,
    jobId: string,
    traceId: string,
  ): Promise<void> => {
    const controller = new AbortController();
    abortControllers.set(jobId, controller);
    const composition = await compositionOf(dependencies.mediaUnitOfWork);
    if (composition === null) return;
    try {
      const timeline = await composition.findTimelineVersion(
        input.projectId,
        input.episodeId,
        input.timelineVersionId,
      );
      if (timeline === null) throw new Error('VIDEO_SOURCE_MISSING');
      const profile = await dependencies.resolveFormatProfile(
        input.projectId,
        timeline.formatProfileId,
      );
      if (profile === null) throw new Error('VIDEO_OUTPUT_INVALID');
      await composition.updateExportStatus(jobId, 'RUNNING');
      const clips = await dependencies.mediaUnitOfWork.run(async ({ video }) => {
        const values = [] as { storageRelPath: string; trimInMs: number; trimOutMs: number }[];
        for (const item of timeline.items) {
          if (!item.enabled) continue;
          const candidate = await video.findCandidateById(input.projectId, item.candidateId);
          if (
            candidate?.status !== 'SUCCEEDED' ||
            candidate.fileSha256 !== item.fileSha256 ||
            candidate.generationInputHash !== item.generationInputHash ||
            candidate.actualDurationSec === null ||
            item.trimOutMs > Math.round(candidate.actualDurationSec * 1_000) ||
            candidate.storageRelPath === null
          )
            throw new Error('VIDEO_SOURCE_STALE');
          values.push({
            storageRelPath: candidate.storageRelPath,
            trimInMs: item.trimInMs,
            trimOutMs: item.trimOutMs,
          });
        }
        if (values.length === 0) throw new Error('VIDEO_TRIM_INVALID');
        return values;
      });
      const audio =
        timeline.audioAsset === null
          ? null
          : await composition.findAudioAsset(input.projectId, timeline.audioAsset.id);
      await composition.updateExportStatus(jobId, 'VALIDATING');
      const result = await dependencies.composer.compose({
        audioStorageRelPath: audio?.storageRelPath ?? null,
        clips,
        exportJobId: jobId,
        fps: profile.fps,
        height: profile.height,
        projectId: input.projectId,
        signal: controller.signal,
        width: profile.width,
      });
      await composition.completeExport(jobId, result);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'FFMPEG_FAILED';
      await composition.updateExportStatus(
        jobId,
        controller.signal.aborted || code === 'VIDEO_EXPORT_CANCELLED' ? 'CANCELLED' : 'FAILED',
        code,
      );
    } finally {
      abortControllers.delete(jobId);
    }
    void traceId;
  };

  const startExport = async (
    input: StartVideoExportInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoExportJobDto>> => {
    const composition = await compositionOf(dependencies.mediaUnitOfWork);
    if (composition === null) return failure('PROJECT_PERSISTENCE_FAILED', traceId);
    const existing = await composition.findExportJobByRequestId(input.projectId, input.requestId);
    if (existing !== null)
      return existing.timelineVersionId === input.timelineVersionId
        ? success(toExportJobDto(existing))
        : failure('REQUEST_ID_REUSED', traceId);
    const timeline = await composition.findTimelineVersion(
      input.projectId,
      input.episodeId,
      input.timelineVersionId,
    );
    if (timeline === null) return failure('VIDEO_SOURCE_MISSING', traceId);
    const job = await composition.createExportJob({
      episodeId: input.episodeId,
      id: dependencies.newId(),
      inputHash: timeline.inputHash,
      projectId: input.projectId,
      requestId: input.requestId,
      timelineVersionId: timeline.id,
      totalDurationMs: timeline.totalDurationMs,
    });
    void runExport(input, job.id, traceId);
    return success(toExportJobDto(job));
  };

  const cancelExport = async (
    input: CancelVideoExportInputDto,
    traceId: string,
  ): Promise<AppResultDto<VideoExportJobDto>> => {
    const composition = await compositionOf(dependencies.mediaUnitOfWork);
    if (composition === null) return failure('PROJECT_PERSISTENCE_FAILED', traceId);
    const job = await composition.findExportJob(input.projectId, input.exportJobId);
    if (job === null) return failure('VIDEO_SOURCE_MISSING', traceId);
    abortControllers.get(job.id)?.abort();
    return success(
      job.status === 'SUCCEEDED' || job.status === 'FAILED' || job.status === 'CANCELLED'
        ? toExportJobDto(job)
        : toExportJobDto(
            await composition.updateExportStatus(job.id, 'CANCELLED', 'VIDEO_EXPORT_CANCELLED'),
          ),
    );
  };

  const recoverUnfinishedExports = async (projectId: string): Promise<void> => {
    const composition = await compositionOf(dependencies.mediaUnitOfWork);
    if (composition === null) return;
    const unfinished = await composition.listUnfinishedExports(projectId);
    await Promise.all(
      unfinished.map((job) =>
        composition.updateExportStatus(
          job.id,
          'FAILED',
          'VIDEO_EXPORT_INTERRUPTED_UNKNOWN_OUTCOME',
        ),
      ),
    );
  };

  return {
    cancelExport,
    createTimeline,
    getExportJob,
    getTimeline,
    importBackgroundMusic,
    recoverUnfinishedExports,
    startExport,
    updateTimeline,
  };
};
