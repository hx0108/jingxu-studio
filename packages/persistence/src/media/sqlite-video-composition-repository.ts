import type {
  VideoAudioAssetRecord,
  VideoCompositionRepository,
  VideoExportJobRecord,
  VideoTimelineVersionRecord,
} from '@jingxu/application';
import type {
  VideoAudioAssetSummaryDto,
  VideoExportJobDto,
  VideoExportStatus,
  VideoTimelineItemDto,
} from '@jingxu/contracts';
import type { MediaStoredFileRef } from '@jingxu/application';

import type { SqliteDatabase, SqliteOutputValue } from '../runtime/sqlite-database';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { syncToPromise } from '../runtime/sync-to-promise';

type Row = Readonly<Record<string, SqliteOutputValue>>;

const requiredString = (row: Row, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string' || value.length === 0)
    throw new PersistenceRuntimeError('VIDEO_COMPOSITION_ROW_CORRUPT');
  return value;
};
const nullableString = (row: Row, column: string): string | null => {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== 'string') throw new PersistenceRuntimeError('VIDEO_COMPOSITION_ROW_CORRUPT');
  return value;
};
const requiredNumber = (row: Row, column: string): number => {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new PersistenceRuntimeError('VIDEO_COMPOSITION_ROW_CORRUPT');
  return value;
};
const parseItems = (rows: readonly Row[]): VideoTimelineItemDto[] =>
  rows.map((row) => ({
    candidateId: requiredString(row, 'candidate_id'),
    enabled: requiredNumber(row, 'enabled') === 1,
    fileSha256: requiredString(row, 'file_sha256'),
    generationInputHash: requiredString(row, 'generation_input_hash'),
    position: requiredNumber(row, 'position'),
    shotId: requiredString(row, 'shot_id'),
    trimInMs: requiredNumber(row, 'trim_in_ms'),
    trimOutMs: requiredNumber(row, 'trim_out_ms'),
  }));

const mapAudio = (row: Row): VideoAudioAssetRecord => ({
  byteSize: requiredNumber(row, 'byte_size'),
  fileSha256: requiredString(row, 'file_sha256'),
  id: requiredString(row, 'id'),
  mimeType: requiredString(row, 'mime_type') as VideoAudioAssetSummaryDto['mimeType'],
  originalFileName: requiredString(row, 'original_file_name'),
  projectId: requiredString(row, 'project_id'),
  storageRelPath: requiredString(row, 'storage_rel_path'),
});

const mapExport = (row: Row): VideoExportJobRecord => ({
  byteSize: row.byte_size === null ? null : requiredNumber(row, 'byte_size'),
  createdAt: requiredString(row, 'created_at'),
  episodeId: requiredString(row, 'episode_id'),
  errorCode: nullableString(row, 'error_code'),
  fileSha256: nullableString(row, 'file_sha256'),
  id: requiredString(row, 'id'),
  inputHash: requiredString(row, 'input_hash'),
  mediaUrl:
    row.status === 'SUCCEEDED' ? `jingxu://media/video-export/${requiredString(row, 'id')}` : null,
  projectId: requiredString(row, 'project_id'),
  status: requiredString(row, 'status') as VideoExportJobDto['status'],
  storageRelPath: nullableString(row, 'storage_rel_path'),
  timelineVersionId: requiredString(row, 'timeline_version_id'),
  totalDurationMs: row.total_duration_ms === null ? null : requiredNumber(row, 'total_duration_ms'),
  updatedAt: requiredString(row, 'updated_at'),
});

export class SqliteVideoCompositionRepository implements VideoCompositionRepository {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => string,
  ) {}

  public createTimeline(input: {
    readonly episodeId: string;
    readonly episodeVersionId: string;
    readonly formatProfileId: string;
    readonly id: string;
    readonly inputHash: string;
    readonly items: readonly VideoTimelineItemDto[];
    readonly projectId: string;
    readonly totalDurationMs: number;
  }): Promise<VideoTimelineVersionRecord> {
    return syncToPromise(() => {
      const now = this.clock();
      const timelineId = `timeline_${input.id}`;
      this.database
        .prepare(
          `INSERT INTO video_timelines (id, project_id, episode_id, current_version_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(timelineId, input.projectId, input.episodeId, input.id, now, now);
      this.database
        .prepare(
          `INSERT INTO video_timeline_versions
         (id, timeline_id, episode_version_id, format_profile_id, version_no, parent_version_id,
          input_hash, audio_asset_id, total_duration_ms, created_at)
         VALUES (?, ?, ?, ?, 1, NULL, ?, NULL, ?, ?)`,
        )
        .run(
          input.id,
          timelineId,
          input.episodeVersionId,
          input.formatProfileId,
          input.inputHash,
          input.totalDurationMs,
          now,
        );
      this.insertItems(input.id, input.items);
      return this.requireTimelineVersion(input.projectId, input.episodeId, input.id);
    });
  }

  public findTimelineVersion(
    projectId: string,
    episodeId: string,
    versionId: string | null,
  ): Promise<VideoTimelineVersionRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT v.id, v.timeline_id, v.episode_version_id, v.format_profile_id, v.version_no,
                v.parent_version_id, v.input_hash, v.audio_asset_id, v.total_duration_ms, v.created_at,
                t.project_id, t.episode_id
         FROM video_timeline_versions v JOIN video_timelines t ON t.id = v.timeline_id
         WHERE t.project_id = ? AND t.episode_id = ? AND v.id = COALESCE(?, t.current_version_id)`,
        )
        .get(projectId, episodeId, versionId);
      return row === undefined ? null : this.mapTimeline(row);
    });
  }

  public updateTimeline(input: {
    readonly audioAssetId: string | null;
    readonly expectedVersionId: string;
    readonly id: string;
    readonly inputHash: string;
    readonly items: readonly VideoTimelineItemDto[];
    readonly projectId: string;
    readonly totalDurationMs: number;
  }): Promise<VideoTimelineVersionRecord> {
    return syncToPromise(() => {
      const current = this.database
        .prepare(
          `SELECT t.id AS timeline_id, t.episode_id, v.episode_version_id, v.format_profile_id, v.version_no
         FROM video_timeline_versions v JOIN video_timelines t ON t.id = v.timeline_id
         WHERE t.project_id = ? AND v.id = ? AND t.current_version_id = v.id`,
        )
        .get(input.projectId, input.expectedVersionId);
      if (current === undefined)
        throw new PersistenceRuntimeError('VIDEO_TIMELINE_VERSION_CONFLICT');
      const row = current as Row;
      const now = this.clock();
      const nextNo = requiredNumber(row, 'version_no') + 1;
      this.database
        .prepare(
          `INSERT INTO video_timeline_versions
         (id, timeline_id, episode_version_id, format_profile_id, version_no, parent_version_id,
          input_hash, audio_asset_id, total_duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          requiredString(row, 'timeline_id'),
          requiredString(row, 'episode_version_id'),
          requiredString(row, 'format_profile_id'),
          nextNo,
          input.expectedVersionId,
          input.inputHash,
          input.audioAssetId,
          input.totalDurationMs,
          now,
        );
      this.insertItems(input.id, input.items);
      this.database
        .prepare('UPDATE video_timelines SET current_version_id = ?, updated_at = ? WHERE id = ?')
        .run(input.id, now, requiredString(row, 'timeline_id'));
      return this.requireTimelineVersion(
        input.projectId,
        requiredString(row, 'episode_id'),
        input.id,
      );
    });
  }

  public findAudioAsset(projectId: string, assetId: string): Promise<VideoAudioAssetRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          'SELECT id, project_id, original_file_name, file_sha256, byte_size, mime_type, storage_rel_path FROM video_audio_assets WHERE project_id = ? AND id = ?',
        )
        .get(projectId, assetId);
      return row === undefined ? null : mapAudio(row);
    });
  }

  public findAudioAssetByHash(
    projectId: string,
    fileSha256: string,
  ): Promise<VideoAudioAssetRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          'SELECT id, project_id, original_file_name, file_sha256, byte_size, mime_type, storage_rel_path FROM video_audio_assets WHERE project_id = ? AND file_sha256 = ?',
        )
        .get(projectId, fileSha256);
      return row === undefined ? null : mapAudio(row);
    });
  }

  public insertAudioAsset(input: {
    readonly byteSize: number;
    readonly fileSha256: string;
    readonly id: string;
    readonly mimeType: VideoAudioAssetSummaryDto['mimeType'];
    readonly originalFileName: string;
    readonly projectId: string;
    readonly storageRelPath: string;
  }): Promise<VideoAudioAssetRecord> {
    return syncToPromise(() => {
      const now = this.clock();
      this.database
        .prepare(
          `INSERT INTO video_audio_assets (id, project_id, original_file_name, file_sha256, byte_size, mime_type, storage_rel_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.originalFileName,
          input.fileSha256,
          input.byteSize,
          input.mimeType,
          input.storageRelPath,
          now,
        );
      return this.findAudioAssetSync(input.projectId, input.id);
    });
  }

  public createExportJob(input: {
    readonly episodeId: string;
    readonly id: string;
    readonly inputHash: string;
    readonly projectId: string;
    readonly requestId: string;
    readonly timelineVersionId: string;
    readonly totalDurationMs: number;
  }): Promise<VideoExportJobRecord> {
    return syncToPromise(() => {
      const now = this.clock();
      this.database
        .prepare(
          `INSERT INTO video_export_jobs
         (id, project_id, episode_id, timeline_version_id, request_id, status, input_hash, total_duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'PREPARING', ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.episodeId,
          input.timelineVersionId,
          input.requestId,
          input.inputHash,
          input.totalDurationMs,
          now,
          now,
        );
      return this.requireExport(input.projectId, input.id);
    });
  }

  public findExportJob(
    projectId: string,
    exportJobId: string,
  ): Promise<VideoExportJobRecord | null> {
    return syncToPromise(() => this.findExportSync(projectId, exportJobId));
  }

  public findExportJobByRequestId(
    projectId: string,
    requestId: string,
  ): Promise<VideoExportJobRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare('SELECT * FROM video_export_jobs WHERE project_id = ? AND request_id = ?')
        .get(projectId, requestId);
      return row === undefined ? null : mapExport(row);
    });
  }

  public updateExportStatus(
    exportJobId: string,
    status: VideoExportStatus,
    errorCode: string | null = null,
  ): Promise<VideoExportJobRecord> {
    return syncToPromise(() => {
      const existing = this.database
        .prepare('SELECT * FROM video_export_jobs WHERE id = ?')
        .get(exportJobId);
      if (existing === undefined) throw new PersistenceRuntimeError('VIDEO_EXPORT_NOT_FOUND');
      const existingRecord = mapExport(existing);
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(existingRecord.status)) {
        // 终态及其错误证据均不可变；迟到的 FFmpeg 回调连同状态的 errorCode 也不得覆盖。
        return existingRecord;
      }
      this.database
        .prepare(
          'UPDATE video_export_jobs SET status = ?, error_code = ?, updated_at = ? WHERE id = ?',
        )
        .run(status, errorCode, this.clock(), exportJobId);
      const row = this.database
        .prepare('SELECT * FROM video_export_jobs WHERE id = ?')
        .get(exportJobId);
      if (row === undefined) throw new PersistenceRuntimeError('VIDEO_EXPORT_NOT_FOUND');
      return mapExport(row);
    });
  }

  public completeExport(
    exportJobId: string,
    result: {
      readonly byteSize: number;
      readonly fileSha256: string;
      readonly storageRelPath: string;
    },
  ): Promise<VideoExportJobRecord> {
    return syncToPromise(() => {
      const outcome = this.database
        .prepare(
          "UPDATE video_export_jobs SET status = 'SUCCEEDED', file_sha256 = ?, byte_size = ?, storage_rel_path = ?, updated_at = ? WHERE id = ? AND status = 'VALIDATING'",
        )
        .run(result.fileSha256, result.byteSize, result.storageRelPath, this.clock(), exportJobId);
      if (
        typeof outcome !== 'object' ||
        outcome === null ||
        (outcome as { readonly changes?: unknown }).changes !== 1
      )
        throw new PersistenceRuntimeError('VIDEO_EXPORT_ALREADY_TERMINAL');
      const row = this.database
        .prepare('SELECT * FROM video_export_jobs WHERE id = ?')
        .get(exportJobId);
      if (row === undefined) throw new PersistenceRuntimeError('VIDEO_EXPORT_NOT_FOUND');
      return mapExport(row);
    });
  }

  public listUnfinishedExports(projectId: string): Promise<readonly VideoExportJobRecord[]> {
    return syncToPromise(() =>
      this.database
        .prepare(
          "SELECT * FROM video_export_jobs WHERE project_id = ? AND status IN ('PREPARING', 'RUNNING', 'VALIDATING') ORDER BY created_at, id",
        )
        .all(projectId)
        .map(mapExport),
    );
  }

  public findExportMediaById(exportJobId: string): Promise<MediaStoredFileRef | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          "SELECT byte_size, storage_rel_path FROM video_export_jobs WHERE id = ? AND status = 'SUCCEEDED'",
        )
        .get(exportJobId) as Row | undefined;
      if (row === undefined || row.storage_rel_path === null || row.byte_size === null) return null;
      return {
        byteSize: requiredNumber(row, 'byte_size'),
        mimeType: 'video/mp4',
        storageRelPath: requiredString(row, 'storage_rel_path'),
      };
    });
  }

  private insertItems(versionId: string, items: readonly VideoTimelineItemDto[]): void {
    const statement = this.database.prepare(
      `INSERT INTO video_timeline_items
       (timeline_version_id, shot_id, candidate_id, file_sha256, generation_input_hash, position, enabled, trim_in_ms, trim_out_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((item) =>
      statement.run(
        versionId,
        item.shotId,
        item.candidateId,
        item.fileSha256,
        item.generationInputHash,
        item.position,
        item.enabled ? 1 : 0,
        item.trimInMs,
        item.trimOutMs,
      ),
    );
  }

  private mapTimeline(row: Row): VideoTimelineVersionRecord {
    const id = requiredString(row, 'id');
    const items = this.database
      .prepare(
        'SELECT shot_id, candidate_id, file_sha256, generation_input_hash, position, enabled, trim_in_ms, trim_out_ms FROM video_timeline_items WHERE timeline_version_id = ? ORDER BY position',
      )
      .all(id) as Row[];
    const audioId = nullableString(row, 'audio_asset_id');
    const audioAsset =
      audioId === null ? null : this.findAudioAssetSync(requiredString(row, 'project_id'), audioId);
    return {
      audioAsset,
      createdAt: requiredString(row, 'created_at'),
      episodeId: requiredString(row, 'episode_id'),
      episodeVersionId: requiredString(row, 'episode_version_id'),
      formatProfileId: requiredString(row, 'format_profile_id'),
      id,
      inputHash: requiredString(row, 'input_hash'),
      items: parseItems(items),
      parentVersionId: nullableString(row, 'parent_version_id'),
      timelineId: requiredString(row, 'timeline_id'),
      totalDurationMs: requiredNumber(row, 'total_duration_ms'),
      versionNo: requiredNumber(row, 'version_no'),
    };
  }

  private requireTimelineVersion(
    projectId: string,
    episodeId: string,
    versionId: string,
  ): VideoTimelineVersionRecord {
    const row = this.database
      .prepare(
        `SELECT v.id, v.timeline_id, v.episode_version_id, v.format_profile_id, v.version_no,
              v.parent_version_id, v.input_hash, v.audio_asset_id, v.total_duration_ms, v.created_at,
              t.project_id, t.episode_id
       FROM video_timeline_versions v JOIN video_timelines t ON t.id = v.timeline_id
       WHERE t.project_id = ? AND t.episode_id = ? AND v.id = ?`,
      )
      .get(projectId, episodeId, versionId);
    if (row === undefined) throw new PersistenceRuntimeError('VIDEO_TIMELINE_NOT_FOUND');
    return this.mapTimeline(row);
  }

  private findAudioAssetSync(projectId: string, assetId: string): VideoAudioAssetRecord {
    const row = this.database
      .prepare(
        'SELECT id, project_id, original_file_name, file_sha256, byte_size, mime_type, storage_rel_path FROM video_audio_assets WHERE project_id = ? AND id = ?',
      )
      .get(projectId, assetId);
    if (row === undefined) throw new PersistenceRuntimeError('VIDEO_AUDIO_ASSET_NOT_FOUND');
    return mapAudio(row);
  }

  private findExportSync(projectId: string, exportJobId: string): VideoExportJobRecord | null {
    const row = this.database
      .prepare('SELECT * FROM video_export_jobs WHERE project_id = ? AND id = ?')
      .get(projectId, exportJobId);
    return row === undefined ? null : mapExport(row);
  }

  private requireExport(projectId: string, exportJobId: string): VideoExportJobRecord {
    const row = this.database
      .prepare('SELECT * FROM video_export_jobs WHERE project_id = ? AND id = ?')
      .get(projectId, exportJobId);
    if (row === undefined) throw new PersistenceRuntimeError('VIDEO_EXPORT_NOT_FOUND');
    return mapExport(row);
  }
}
