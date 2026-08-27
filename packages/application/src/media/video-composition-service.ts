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
  VideoTimelineAlignmentItemDto,
  VideoTimelineSubtitleItemInput,
  VideoTimelineVersionRecord,
} from '../ports/media';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import { alignVoiceToShot, extractVoiceShotFields } from '../voice';
import type { VideoTimelineVoiceItemDto } from '@jingxu/contracts';

/**
 * 字幕默认样式快照（design D5：默认字体 + 安全区；样式编辑器为非目标）。
 * 随时间线版本冻结进 style_snapshot_json——常量演进时旧版本行保持原快照。
 */
export const DEFAULT_SUBTITLE_STYLE_SNAPSHOT_JSON = JSON.stringify({
  fontFamily: 'Noto Sans SC',
  fontWeight: 'Bold',
  styleVersion: 1,
});

/** 字幕默认安全区（百分比整数；0020 CHECK 上限 20）。 */
export const DEFAULT_SUBTITLE_SAFE_AREA_PCT = 5;

/** BGM 默认音量：与 0020 迁移列默认一致（= 旧硬编码现状等效）。 */
export const DEFAULT_BACKGROUND_MUSIC_VOLUME = 0.2;

export interface VideoCompositionServiceDependencies {
  readonly composer: VideoComposerPort;
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly hashText: (text: string) => string;
  readonly mediaUnitOfWork: MediaUnitOfWorkPort;
  readonly newId: () => string;
  readonly resolveEffectiveVoiceMappings: (
    projectId: string,
  ) => Promise<ReadonlyMap<string, string>>;
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

/** 启用中的配音轨（混音层输入）；storageRelPath 仅存于 Main 边界内，不出 Renderer。 */
export interface VideoComposerVoiceInput {
  readonly offsetMs: number;
  readonly storageRelPath: string;
  readonly trimInMs: number;
  readonly trimOutMs: number;
  readonly volume: number;
}

/** 启用中的字幕条（烧录层输入）；spokenText 明文仅存于 Main 边界内，不入日志/审计行。 */
export interface VideoComposerSubtitleInput {
  readonly endMs: number;
  readonly safeAreaPct: number;
  readonly spokenText: string;
  readonly startMs: number;
}

export interface VideoComposerPort {
  compose(input: {
    readonly audioStorageRelPath: string | null;
    /** BGM 音量数据化；缺省沿用旧硬编码 0.20（无配音回归锁的现状值）。 */
    readonly backgroundMusicVolume?: number | undefined;
    readonly clips: readonly Readonly<{
      /** FREEZE_EXTEND 的冻末帧静帧延展；缺省 0 → 现状 concat 合成路径。 */
      extendedMs?: number | undefined;
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
    /** 非空即走滤镜图合成路径并烧录字幕（v2-voice-audio-timeline §6.2）。 */
    readonly subtitles?: readonly VideoComposerSubtitleInput[] | undefined;
    /** 非空即走滤镜图合成路径（v2-voice-audio-timeline §6.1）。 */
    readonly voices?: readonly VideoComposerVoiceInput[] | undefined;
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
  alignmentItems: record.alignmentItems,
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
  audioVolume: record.audioVolume,
  createdAt: record.createdAt,
  episodeId: record.episodeId,
  episodeVersionId: record.episodeVersionId,
  formatProfileId: record.formatProfileId,
  id: record.id,
  inputHash: record.inputHash,
  items: record.items,
  parentVersionId: record.parentVersionId,
  subtitleItems: record.subtitleItems,
  totalDurationMs: record.totalDurationMs,
  versionNo: record.versionNo,
  voiceItems: record.voiceItems,
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

/** 音色映射快照的规范形状：字母序键值对数组（inputHash 输入集确定性）。 */
const mappingSnapshotOf = (
  effective: ReadonlyMap<string, string>,
): readonly { readonly speakerId: string; readonly voiceId: string }[] =>
  [...effective.entries()]
    .map(([speakerId, voiceId]) => ({ speakerId, voiceId }))
    .sort((left, right) => (left.speakerId < right.speakerId ? -1 : 1));

/**
 * 对齐记录计算（v2 D4）：逐条启用配音 × 同镜头视频裁剪，按"混音有效占用"
 * （trim_out − trim_in）分类。产出随版本冻结的四要素行 + extendedMs；
 * 覆盖与类别错配在此显式拒绝（稳定码），不静默改类。
 */
const computeAlignmentItems = (
  items: readonly VideoTimelineItemDto[],
  voiceItems: readonly VideoTimelineVoiceItemDto[],
):
  | { readonly error: null; readonly rows: readonly VideoTimelineAlignmentItemDto[] }
  | {
      readonly error: 'VOICE_ALIGNMENT_INPUT_INVALID' | 'VOICE_ALIGNMENT_OVERRIDE_INVALID';
      readonly rows: readonly [];
    } => {
  const rows: VideoTimelineAlignmentItemDto[] = [];
  for (const voiceItem of voiceItems) {
    if (!voiceItem.enabled) continue;
    const shot = items.find((item) => item.shotId === voiceItem.shotId);
    if (!shot?.enabled) continue;
    let result;
    try {
      result = alignVoiceToShot({
        audioDurationMs: voiceItem.trimOutMs - voiceItem.trimInMs,
        manualOverride: voiceItem.alignmentOverride ?? null,
        shotDurationMs: shot.trimOutMs - shot.trimInMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return {
        error: message.startsWith('VOICE_ALIGNMENT_OVERRIDE_INVALID')
          ? 'VOICE_ALIGNMENT_OVERRIDE_INVALID'
          : 'VOICE_ALIGNMENT_INPUT_INVALID',
        rows: [],
      };
    }
    rows.push({
      audioDurationMs: result.audioDurationMs,
      category: result.category,
      dialogueComplete: result.dialogueComplete,
      extendedMs: result.extendedMs,
      manualOverride: result.manualOverride,
      rulesVersion: result.rulesVersion,
      shotDurationMs: result.shotDurationMs,
      shotId: voiceItem.shotId,
      storyboardFallback: result.storyboardFallback,
      strategy: result.strategy,
    });
  }
  return { error: null, rows };
};

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
    // 配音轨与字幕轨从当前工作区派生（spec：字幕从镜头 spoken_text 派生且默认启用；
    // 配音仅收录当前选中的 SUCCEEDED 候选，人工未选择=空轨道）。
    const voiceItems: VideoTimelineSummaryDto['voiceItems'] = [];
    const subtitleItems: VideoTimelineSubtitleItemInput[] = [];
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
      const selectedVoice = await dependencies.mediaUnitOfWork.run(async ({ voice }) => {
        if (voice === undefined) return null;
        const rows = await voice.generation.listCandidatesByShot(shot.shotId);
        return rows.find((row) => row.status === 'SUCCEEDED' && row.selectedAt !== null) ?? null;
      });
      if (selectedVoice?.durationMs != null && selectedVoice.fileSha256 != null) {
        voiceItems.push({
          candidateId: selectedVoice.id,
          enabled: true,
          fileSha256: selectedVoice.fileSha256,
          generationInputHash: selectedVoice.generationInputHash,
          offsetMs: 0,
          shotId: shot.shotId,
          trimInMs: 0,
          trimOutMs: selectedVoice.durationMs,
          volume: 1,
        });
      }
      const fields = extractVoiceShotFields(shot.version.document);
      if (fields !== null && fields.spokenText !== null) {
        subtitleItems.push({
          enabled: true,
          safeAreaPct: DEFAULT_SUBTITLE_SAFE_AREA_PCT,
          shotId: shot.shotId,
          spokenTextSha256: dependencies.hashText(fields.spokenText),
          styleSnapshotJson: DEFAULT_SUBTITLE_STYLE_SNAPSHOT_JSON,
        });
      }
    }
    const alignment = computeAlignmentItems(items, voiceItems);
    if (alignment.error !== null) return failure(alignment.error, traceId);
    const mappingSnapshot = mappingSnapshotOf(
      await dependencies.resolveEffectiveVoiceMappings(input.projectId),
    );
    const inputHash = dependencies.hashPayload({
      episodeVersionId: current.id,
      items,
      mappingSnapshot,
      subtitleItems,
      voiceItems,
    });
    const composition = await compositionOf(dependencies.mediaUnitOfWork);
    if (composition === null) return failure('PROJECT_PERSISTENCE_FAILED', traceId);
    const created = await composition.createTimeline({
      alignmentItems: alignment.rows,
      audioVolume: DEFAULT_BACKGROUND_MUSIC_VOLUME,
      episodeId: input.episodeId,
      episodeVersionId: current.id,
      formatProfileId: current.formatProfileId,
      id: dependencies.newId(),
      inputHash,
      items,
      projectId: input.projectId,
      subtitleItems,
      totalDurationMs: items.reduce((sum, item) => sum + item.trimOutMs - item.trimInMs, 0),
      voiceItems,
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
    // 配音轨校验：候选三元组漂移（改文 STALE/换候选/哈希不符）稳定拒绝；
    // 音色映射漂移（候选冻结音色 ≠ 当前生效映射）单独稳定码，指引重新生成。
    const effective = await dependencies.resolveEffectiveVoiceMappings(input.projectId);
    if (input.voiceItems.length > 0) {
      const voiceRepositories = await dependencies.mediaUnitOfWork.run(({ voice }) =>
        Promise.resolve(voice === undefined ? null : voice.generation),
      );
      if (voiceRepositories === null) return failure('PROJECT_PERSISTENCE_FAILED', traceId);
      for (const item of input.voiceItems) {
        const candidate = await voiceRepositories.findCandidate(input.projectId, item.candidateId);
        const staleCandidate =
          candidate?.status !== 'SUCCEEDED' ||
          candidate.fileSha256 !== item.fileSha256 ||
          candidate.generationInputHash !== item.generationInputHash ||
          candidate.durationMs == null;
        if (candidate === null || staleCandidate)
          return failure('VIDEO_SOURCE_STALE', traceId, '配音候选已过期，请重新选择候选。');
        if (item.trimOutMs > candidate.durationMs || item.trimInMs >= item.trimOutMs)
          return failure('VIDEO_TRIM_INVALID', traceId);
        if (effective.get(candidate.speakerId) !== candidate.voiceId)
          return failure(
            'VIDEO_VOICE_MAPPING_STALE',
            traceId,
            '音色映射已变更，请重新生成或调整映射后再次提交。',
          );
      }
    }
    // 字幕轨锚定校验：spokenTextSha256 必须仍锚定当前镜头文档（镜头改文即拒绝）。
    if (input.subtitleItems.length > 0) {
      const workspace = await getWorkspace(input.projectId, input.episodeId);
      if (workspace === null) return failure('VIDEO_COMPOSITION_NOT_READY', traceId);
      for (const item of input.subtitleItems) {
        const snapshot = workspace.storyboard.currentShots.find(
          (entry) => entry.shotId === item.shotId,
        );
        const fields =
          snapshot === undefined ? null : extractVoiceShotFields(snapshot.version.document);
        const spokenText = fields?.spokenText ?? null;
        if (spokenText === null)
          return failure('VIDEO_SOURCE_STALE', traceId, '镜头台词已变更，请重新生成字幕轨。');
        if (dependencies.hashText(spokenText) !== item.spokenTextSha256)
          return failure('VIDEO_SOURCE_STALE', traceId, '镜头台词已变更，请重新生成字幕轨。');
      }
    }
    const alignment = computeAlignmentItems(input.items, input.voiceItems);
    if (alignment.error !== null)
      return failure(alignment.error, traceId, '人工覆盖与当前配音偏差类别不匹配，请调整后重试。');
    let audio: VideoAudioAssetRecord | null = null;
    if (input.audioAssetId !== null)
      audio = await composition.findAudioAsset(input.projectId, input.audioAssetId);
    if (input.audioAssetId !== null && audio === null)
      return failure('VIDEO_AUDIO_INVALID', traceId);
    const subtitleItems: VideoTimelineSubtitleItemInput[] = input.subtitleItems.map((item) => ({
      ...item,
      styleSnapshotJson: DEFAULT_SUBTITLE_STYLE_SNAPSHOT_JSON,
    }));
    const mappingSnapshot = mappingSnapshotOf(effective);
    const inputHash = dependencies.hashPayload({
      audioAssetId: input.audioAssetId,
      audioVolume: input.audioVolume,
      episodeVersionId: current.episodeVersionId,
      items: input.items,
      mappingSnapshot,
      subtitleItems,
      voiceItems: input.voiceItems,
    });
    return success(
      toTimelineDto(
        await composition.updateTimeline({
          alignmentItems: alignment.rows,
          audioAssetId: input.audioAssetId,
          audioVolume: input.audioVolume,
          expectedVersionId: input.expectedVersionId,
          id: dependencies.newId(),
          inputHash,
          items: input.items,
          projectId: input.projectId,
          subtitleItems,
          totalDurationMs: input.items
            .filter((item) => item.enabled)
            .reduce((sum, item) => sum + item.trimOutMs - item.trimInMs, 0),
          voiceItems: input.voiceItems,
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
      // 对齐记录随版本冻结（§6.1）：FREEZE_EXTEND 的 extendedMs 逐镜头接到导出片段上。
      const extendedByShot = new Map(
        timeline.alignmentItems.map((row) => [row.shotId, row.extendedMs]),
      );
      // 镜头在成片时间轴上的窗口（含延展）与合成片段序一致；字幕条按此窗口落位。
      const clipSpans = new Map<string, { readonly endMs: number; readonly startMs: number }>();
      const clips = await dependencies.mediaUnitOfWork.run(async ({ video }) => {
        const values = [] as {
          extendedMs: number;
          storageRelPath: string;
          trimInMs: number;
          trimOutMs: number;
        }[];
        let cursorMs = 0;
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
          const extendedMs = extendedByShot.get(item.shotId) ?? 0;
          clipSpans.set(item.shotId, {
            endMs: cursorMs + (item.trimOutMs - item.trimInMs) + extendedMs,
            startMs: cursorMs,
          });
          cursorMs += item.trimOutMs - item.trimInMs + extendedMs;
          values.push({
            extendedMs,
            storageRelPath: candidate.storageRelPath,
            trimInMs: item.trimInMs,
            trimOutMs: item.trimOutMs,
          });
        }
        if (values.length === 0) throw new Error('VIDEO_TRIM_INVALID');
        return values;
      });
      // 配音候选在导出边界二次核验必须走配音域仓储（voice_candidates 表），
      // 不能误用视频媒体仓储（video_candidates 表）——否则恒判 STALE（§8.1 E2E 实录）。
      const voiceRepositories = await dependencies.mediaUnitOfWork.run(({ voice }) =>
        Promise.resolve(voice === undefined ? null : voice.generation),
      );
      if (voiceRepositories === null) throw new Error('PROJECT_PERSISTENCE_FAILED');
      const voices = [] as VideoComposerVoiceInput[];
      for (const voiceItem of timeline.voiceItems) {
        if (!voiceItem.enabled) continue;
        const candidate = await voiceRepositories.findCandidate(
          input.projectId,
          voiceItem.candidateId,
        );
        if (
          candidate?.status !== 'SUCCEEDED' ||
          candidate.fileSha256 !== voiceItem.fileSha256 ||
          candidate.generationInputHash !== voiceItem.generationInputHash ||
          candidate.storageRelPath === null
        )
          throw new Error('VOICE_CANDIDATE_STALE');
        voices.push({
          offsetMs: voiceItem.offsetMs,
          storageRelPath: candidate.storageRelPath,
          trimInMs: voiceItem.trimInMs,
          trimOutMs: voiceItem.trimOutMs,
          volume: voiceItem.volume,
        });
      }
      const audio =
        timeline.audioAsset === null
          ? null
          : await composition.findAudioAsset(input.projectId, timeline.audioAsset.id);
      // 字幕装配（§6.2）：导出时从当前工作区重新读取台词明文并核对冻结哈希，
      // 漂移即稳定码终止（不烧录过期字幕）。明文仅在本边界内传给 Main Adapter。
      const subtitles: VideoComposerSubtitleInput[] = [];
      if (timeline.subtitleItems.some((sub) => sub.enabled)) {
        const workspace = await getWorkspace(input.projectId, input.episodeId);
        if (workspace === null) throw new Error('SUBTITLE_SOURCE_STALE');
        for (const sub of timeline.subtitleItems) {
          if (!sub.enabled) continue;
          const span = clipSpans.get(sub.shotId);
          const shot = workspace.storyboard.currentShots.find(
            (entry) => entry.shotId === sub.shotId,
          );
          const text =
            shot === undefined
              ? null
              : (extractVoiceShotFields(shot.version.document)?.spokenText ?? null);
          if (
            span === undefined ||
            text === null ||
            dependencies.hashText(text) !== sub.spokenTextSha256
          )
            throw new Error('SUBTITLE_SOURCE_STALE');
          subtitles.push({
            endMs: span.endMs,
            safeAreaPct: sub.safeAreaPct,
            spokenText: text,
            startMs: span.startMs,
          });
        }
      }
      await composition.updateExportStatus(jobId, 'VALIDATING');
      const result = await dependencies.composer.compose({
        audioStorageRelPath: audio?.storageRelPath ?? null,
        backgroundMusicVolume: timeline.audioVolume,
        clips,
        exportJobId: jobId,
        fps: profile.fps,
        height: profile.height,
        projectId: input.projectId,
        signal: controller.signal,
        subtitles,
        voices,
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
    // 对齐阻断（v2 D4）：任一冻结记录仍为分镜层回退（FAR_LONG 未处置）即拒绝建 Job。
    if (timeline.alignmentItems.some((row) => row.storyboardFallback))
      return failure(
        'VOICE_ALIGNMENT_BLOCKED',
        traceId,
        '存在配音远长于镜头的镜头，请回分镜层调整，或对该镜头选择强制裁剪（对白将不完整）。',
      );
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
