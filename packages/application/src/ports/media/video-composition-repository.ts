import type {
  VideoAudioAssetSummaryDto,
  VideoExportJobDto,
  VideoExportStatus,
  VideoTimelineAlignmentItemDto,
  VideoTimelineItemDto,
  VideoTimelineSubtitleItemDto,
  VideoTimelineSummaryDto,
  VideoTimelineVoiceItemDto,
} from '@jingxu/contracts';
import type { MediaStoredFileRef } from './media-repository';

// 端口面透传的纯契约类型（packages/application 顶层经此统一出口）。
export type { VideoTimelineAlignmentItemDto } from '@jingxu/contracts';

export interface VideoTimelineVersionRecord extends VideoTimelineSummaryDto {
  readonly timelineId: string;
}

/**
 * 字幕轨的持久化形状：DTO 之外携带随版本冻结的样式快照 JSON（样式编辑器为
 * 非目标，恒为应用层默认样式常量；Renderer 只见 DTO 面）。
 */
export interface VideoTimelineSubtitleItemInput extends VideoTimelineSubtitleItemDto {
  readonly styleSnapshotJson: string;
}

export interface VideoTimelineWriteTracks {
  /** 对齐记录随版本冻结（v2 D4）；由服务层按有效占用逐镜头计算，调用方不手填。 */
  readonly alignmentItems: readonly VideoTimelineAlignmentItemDto[];
  readonly audioVolume: number;
  readonly subtitleItems: readonly VideoTimelineSubtitleItemInput[];
  readonly voiceItems: readonly VideoTimelineVoiceItemDto[];
}

export interface VideoAudioAssetRecord extends VideoAudioAssetSummaryDto {
  readonly projectId: string;
  readonly storageRelPath: string;
}

export interface VideoExportJobRecord extends VideoExportJobDto {
  readonly episodeId: string;
  readonly inputHash: string;
  readonly projectId: string;
  readonly storageRelPath: string | null;
}

export interface VideoCompositionRepository {
  createTimeline(
    input: {
      readonly episodeId: string;
      readonly episodeVersionId: string;
      readonly formatProfileId: string;
      readonly id: string;
      readonly inputHash: string;
      readonly items: readonly VideoTimelineItemDto[];
      readonly projectId: string;
      readonly totalDurationMs: number;
    } & VideoTimelineWriteTracks,
  ): Promise<VideoTimelineVersionRecord>;
  findTimelineVersion(
    projectId: string,
    episodeId: string,
    versionId: string | null,
  ): Promise<VideoTimelineVersionRecord | null>;
  updateTimeline(
    input: {
      readonly audioAssetId: string | null;
      readonly expectedVersionId: string;
      readonly id: string;
      readonly inputHash: string;
      readonly items: readonly VideoTimelineItemDto[];
      readonly projectId: string;
      readonly totalDurationMs: number;
    } & VideoTimelineWriteTracks,
  ): Promise<VideoTimelineVersionRecord>;
  findAudioAsset(projectId: string, assetId: string): Promise<VideoAudioAssetRecord | null>;
  findAudioAssetByHash(
    projectId: string,
    fileSha256: string,
  ): Promise<VideoAudioAssetRecord | null>;
  insertAudioAsset(input: {
    readonly byteSize: number;
    readonly fileSha256: string;
    readonly id: string;
    readonly mimeType: VideoAudioAssetSummaryDto['mimeType'];
    readonly originalFileName: string;
    readonly projectId: string;
    readonly storageRelPath: string;
  }): Promise<VideoAudioAssetRecord>;
  createExportJob(input: {
    readonly episodeId: string;
    readonly id: string;
    readonly inputHash: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly timelineVersionId: string;
    readonly totalDurationMs: number;
  }): Promise<VideoExportJobRecord>;
  findExportJob(projectId: string, exportJobId: string): Promise<VideoExportJobRecord | null>;
  findExportJobByRequestId(
    projectId: string,
    requestId: string,
  ): Promise<VideoExportJobRecord | null>;
  updateExportStatus(
    exportJobId: string,
    status: VideoExportStatus,
    errorCode?: string | null,
  ): Promise<VideoExportJobRecord>;
  completeExport(
    exportJobId: string,
    result: {
      readonly byteSize: number;
      readonly fileSha256: string;
      readonly storageRelPath: string;
    },
  ): Promise<VideoExportJobRecord>;
  listUnfinishedExports(projectId: string): Promise<readonly VideoExportJobRecord[]>;
  findExportMediaById(exportJobId: string): Promise<MediaStoredFileRef | null>;
}

export interface VideoCompositionRepositories {
  readonly composition: VideoCompositionRepository;
}
