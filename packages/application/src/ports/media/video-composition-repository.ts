import type {
  VideoAudioAssetSummaryDto,
  VideoExportJobDto,
  VideoExportStatus,
  VideoTimelineItemDto,
  VideoTimelineSummaryDto,
} from '@jingxu/contracts';
import type { MediaStoredFileRef } from './media-repository';

export interface VideoTimelineVersionRecord extends VideoTimelineSummaryDto {
  readonly timelineId: string;
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
  createTimeline(input: {
    readonly episodeId: string;
    readonly episodeVersionId: string;
    readonly formatProfileId: string;
    readonly id: string;
    readonly inputHash: string;
    readonly items: readonly VideoTimelineItemDto[];
    readonly projectId: string;
    readonly totalDurationMs: number;
  }): Promise<VideoTimelineVersionRecord>;
  findTimelineVersion(
    projectId: string,
    episodeId: string,
    versionId: string | null,
  ): Promise<VideoTimelineVersionRecord | null>;
  updateTimeline(input: {
    readonly audioAssetId: string | null;
    readonly expectedVersionId: string;
    readonly id: string;
    readonly inputHash: string;
    readonly items: readonly VideoTimelineItemDto[];
    readonly projectId: string;
    readonly totalDurationMs: number;
  }): Promise<VideoTimelineVersionRecord>;
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
