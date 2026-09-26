import type {
  VideoAudioAssetRecord,
  VideoCompositionRepository,
  VideoExportJobRecord,
  VideoTimelineSubtitleItemInput,
  VideoTimelineUpdateReceiptRecord,
  VideoTimelineVersionRecord,
  VideoTimelineWriteTracks,
} from '@jingxu/application';
import type {
  VideoAudioAssetSummaryDto,
  VideoExportJobDto,
  VideoExportStatus,
  VideoTimelineAlignmentItemDto,
  VideoTimelineItemDto,
  VideoTimelineSubtitleItemDto,
  VideoTimelineVoiceItemDto,
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
const parseItems = (rows: readonly Row[]): VideoTimelineItemDto[] => {
  let nextStartMs = 0;
  return rows.map((row) => {
    const startMs = nextStartMs;
    nextStartMs += requiredNumber(row, 'trim_out_ms') - requiredNumber(row, 'trim_in_ms');
    return {
      candidateId: requiredString(row, 'candidate_id'),
      clipId:
        typeof row.clip_id === 'string' ? row.clip_id : `clip_${requiredString(row, 'shot_id')}`,
      enabled: requiredNumber(row, 'enabled') === 1,
      fileSha256: requiredString(row, 'file_sha256'),
      generationInputHash: requiredString(row, 'generation_input_hash'),
      isMock: null,
      providerKind: null,
      position: requiredNumber(row, 'position'),
      shotId: requiredString(row, 'shot_id'),
      targetStartMs: typeof row.target_start_ms === 'number' ? row.target_start_ms : startMs,
      trimInMs: requiredNumber(row, 'trim_in_ms'),
      trimOutMs: requiredNumber(row, 'trim_out_ms'),
    };
  });
};

/** 配音轨行 → DTO（shot_id 字母序确定性返回；既有版本行无轨道=空数组）。 */
const parseVoiceItems = (rows: readonly Row[]): VideoTimelineVoiceItemDto[] =>
  rows.map((row) => ({
    candidateId: requiredString(row, 'candidate_id'),
    clipId:
      typeof row.clip_id === 'string' ? row.clip_id : `voice_${requiredString(row, 'shot_id')}`,
    enabled: requiredNumber(row, 'enabled') === 1,
    fileSha256: requiredString(row, 'file_sha256'),
    generationInputHash: requiredString(row, 'generation_input_hash'),
    offsetMs: requiredNumber(row, 'offset_ms'),
    shotId: requiredString(row, 'shot_id'),
    targetStartMs:
      typeof row.target_start_ms === 'number'
        ? row.target_start_ms
        : requiredNumber(row, 'offset_ms'),
    trimInMs: requiredNumber(row, 'trim_in_ms'),
    trimOutMs: requiredNumber(row, 'trim_out_ms'),
    volume: requiredNumber(row, 'volume'),
  }));

/** 字幕轨行 → DTO（style_snapshot_json 留在库内作版本冻结锚点，不出 DTO 面）。 */
const parseSubtitleItems = (rows: readonly Row[]): VideoTimelineSubtitleItemDto[] =>
  rows.map((row) => ({
    enabled: requiredNumber(row, 'enabled') === 1,
    safeAreaPct: requiredNumber(row, 'safe_area_pct'),
    shotId: requiredString(row, 'shot_id'),
    spokenTextSha256: requiredString(row, 'spoken_text_sha256'),
  }));

/** 对齐记录行 → DTO（rules_version 随行冻结，供导出报告回放口径）。 */
const parseAlignmentItems = (rows: readonly Row[]): VideoTimelineAlignmentItemDto[] =>
  rows.map((row) => ({
    audioDurationMs: requiredNumber(row, 'audio_duration_ms'),
    category: requiredString(row, 'category') as VideoTimelineAlignmentItemDto['category'],
    dialogueComplete: requiredNumber(row, 'dialogue_complete') === 1,
    extendedMs: requiredNumber(row, 'extended_ms'),
    manualOverride:
      row.manual_override === null
        ? null
        : (requiredString(row, 'manual_override') as NonNullable<
            VideoTimelineAlignmentItemDto['manualOverride']
          >),
    rulesVersion: requiredString(row, 'rules_version'),
    shotDurationMs: requiredNumber(row, 'shot_duration_ms'),
    shotId: requiredString(row, 'shot_id'),
    storyboardFallback: requiredNumber(row, 'storyboard_fallback') === 1,
    strategy: requiredString(row, 'strategy') as VideoTimelineAlignmentItemDto['strategy'],
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

  public createTimeline(
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
  ): Promise<VideoTimelineVersionRecord> {
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
          input_hash, audio_asset_id, total_duration_ms, audio_volume, voice_track_muted,
          bgm_start_ms, bgm_trim_in_ms, bgm_trim_out_ms, bgm_muted, bgm_fade_in_ms, bgm_fade_out_ms, created_at)
         VALUES (?, ?, ?, ?, 1, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          timelineId,
          input.episodeVersionId,
          input.formatProfileId,
          input.inputHash,
          input.totalDurationMs,
          input.audioVolume,
          Number(input.voiceTrackMuted),
          input.bgmStartMs,
          input.bgmTrimInMs,
          input.bgmTrimOutMs,
          Number(input.bgmMuted),
          input.bgmFadeInMs,
          input.bgmFadeOutMs,
          now,
        );
      this.insertItems(input.id, input.items);
      this.insertVoiceItems(input.id, input.voiceItems);
      this.insertSubtitleItems(input.id, input.subtitleItems);
      this.insertAlignmentItems(input.id, input.alignmentItems);
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
                v.parent_version_id, v.input_hash, v.audio_asset_id, v.total_duration_ms, v.audio_volume,
                v.voice_track_muted, v.bgm_start_ms, v.bgm_trim_in_ms, v.bgm_trim_out_ms,
                v.bgm_muted, v.bgm_fade_in_ms, v.bgm_fade_out_ms, v.created_at,
                t.project_id, t.episode_id
         FROM video_timeline_versions v JOIN video_timelines t ON t.id = v.timeline_id
         WHERE t.project_id = ? AND t.episode_id = ? AND v.id = COALESCE(?, t.current_version_id)`,
        )
        .get(projectId, episodeId, versionId);
      return row === undefined ? null : this.mapTimeline(row);
    });
  }

  public findTimelineUpdateReceipt(
    requestId: string,
  ): Promise<VideoTimelineUpdateReceiptRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          `SELECT payload_sha256, project_id, result_ref_json
           FROM command_receipts
           WHERE request_id = ? AND command_name = 'UPDATE_VIDEO_TIMELINE'`,
        )
        .get(requestId);
      if (row === undefined) return null;
      const value = row as Row;
      let result: unknown;
      try {
        result = JSON.parse(requiredString(value, 'result_ref_json'));
      } catch {
        throw new PersistenceRuntimeError('VIDEO_COMPOSITION_ROW_CORRUPT');
      }
      const timelineVersionId =
        typeof result === 'object' && result !== null && 'timelineVersionId' in result
          ? (result as { readonly timelineVersionId?: unknown }).timelineVersionId
          : null;
      if (typeof timelineVersionId !== 'string' || timelineVersionId.length === 0)
        throw new PersistenceRuntimeError('VIDEO_COMPOSITION_ROW_CORRUPT');
      return {
        payloadSha256: requiredString(value, 'payload_sha256'),
        projectId: requiredString(value, 'project_id'),
        timelineVersionId,
      };
    });
  }

  public updateTimeline(
    input: {
      readonly audioAssetId: string | null;
      readonly expectedVersionId: string;
      readonly id: string;
      readonly inputHash: string;
      readonly items: readonly VideoTimelineItemDto[];
      readonly payloadSha256: string;
      readonly projectId: string;
      readonly requestId: string;
      readonly traceId: string;
      readonly totalDurationMs: number;
    } & VideoTimelineWriteTracks,
  ): Promise<VideoTimelineVersionRecord> {
    return syncToPromise(() => {
      const current = this.database
        .prepare(
          `SELECT t.id AS timeline_id, t.episode_id, v.episode_version_id, v.format_profile_id,
                  v.version_no, v.input_hash
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
          input_hash, audio_asset_id, total_duration_ms, audio_volume, voice_track_muted,
          bgm_start_ms, bgm_trim_in_ms, bgm_trim_out_ms, bgm_muted, bgm_fade_in_ms, bgm_fade_out_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.audioVolume,
          Number(input.voiceTrackMuted),
          input.bgmStartMs,
          input.bgmTrimInMs,
          input.bgmTrimOutMs,
          Number(input.bgmMuted),
          input.bgmFadeInMs,
          input.bgmFadeOutMs,
          now,
        );
      this.insertItems(input.id, input.items);
      this.insertVoiceItems(input.id, input.voiceItems);
      this.insertSubtitleItems(input.id, input.subtitleItems);
      this.insertAlignmentItems(input.id, input.alignmentItems);
      this.database
        .prepare(
          `INSERT INTO audit_events
           (id, project_id, actor, action, object_type, object_id, object_version_id,
            before_sha256, after_sha256, metadata_json, trace_id, created_at)
           VALUES (?, ?, 'USER', 'VIDEO_TIMELINE_UPDATED', 'VIDEO_TIMELINE', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `audit_${input.id}`,
          input.projectId,
          requiredString(row, 'timeline_id'),
          input.id,
          requiredString(row, 'input_hash'),
          input.inputHash,
          JSON.stringify({
            itemCount: input.items.length,
            voiceItemCount: input.voiceItems.length,
          }),
          input.traceId,
          now,
        );
      this.database
        .prepare(
          `INSERT INTO command_receipts
           (request_id, command_name, payload_sha256, project_id, result_ref_json, trace_id, committed_at)
           VALUES (?, 'UPDATE_VIDEO_TIMELINE', ?, ?, ?, ?, ?)`,
        )
        .run(
          input.requestId,
          input.payloadSha256,
          input.projectId,
          JSON.stringify({ timelineVersionId: input.id }),
          input.traceId,
          now,
        );
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

  public findAudioAssetById(assetId: string): Promise<VideoAudioAssetRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          'SELECT id, project_id, original_file_name, file_sha256, byte_size, mime_type, storage_rel_path FROM video_audio_assets WHERE id = ?',
        )
        .get(assetId);
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

  public findLatestSucceededExport(
    projectId: string,
    episodeId: string,
  ): Promise<VideoExportJobRecord | null> {
    return syncToPromise(() => {
      const row = this.database
        .prepare(
          "SELECT * FROM video_export_jobs WHERE project_id = ? AND episode_id = ? AND status = 'SUCCEEDED' ORDER BY updated_at DESC, id ASC LIMIT 1",
        )
        .get(projectId, episodeId);
      return row === undefined ? null : mapExport(row);
    });
  }

  public listExports(
    projectId: string,
    episodeId: string,
    limit: number,
  ): Promise<readonly VideoExportJobRecord[]> {
    return syncToPromise(() =>
      this.database
        .prepare(
          'SELECT * FROM video_export_jobs WHERE project_id = ? AND episode_id = ? ORDER BY updated_at DESC, id ASC LIMIT ?',
        )
        .all(projectId, episodeId, limit)
        .map(mapExport),
    );
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
       (timeline_version_id, clip_id, shot_id, candidate_id, file_sha256, generation_input_hash, position, target_start_ms, enabled, trim_in_ms, trim_out_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((item) =>
      statement.run(
        versionId,
        item.clipId,
        item.shotId,
        item.candidateId,
        item.fileSha256,
        item.generationInputHash,
        item.position,
        item.targetStartMs,
        item.enabled ? 1 : 0,
        item.trimInMs,
        item.trimOutMs,
      ),
    );
  }

  private insertVoiceItems(versionId: string, items: readonly VideoTimelineVoiceItemDto[]): void {
    const statement = this.database.prepare(
      `INSERT INTO video_timeline_voice_items
       (timeline_version_id, clip_id, shot_id, candidate_id, file_sha256, generation_input_hash, offset_ms, target_start_ms, volume, trim_in_ms, trim_out_ms, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((item) =>
      statement.run(
        versionId,
        item.clipId,
        item.shotId,
        item.candidateId,
        item.fileSha256,
        item.generationInputHash,
        item.offsetMs,
        item.targetStartMs,
        item.volume,
        item.trimInMs,
        item.trimOutMs,
        item.enabled ? 1 : 0,
      ),
    );
  }

  private insertSubtitleItems(
    versionId: string,
    items: readonly VideoTimelineSubtitleItemInput[],
  ): void {
    const statement = this.database.prepare(
      `INSERT INTO video_timeline_subtitle_items
       (timeline_version_id, shot_id, enabled, spoken_text_sha256, safe_area_pct, style_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((item) =>
      statement.run(
        versionId,
        item.shotId,
        item.enabled ? 1 : 0,
        item.spokenTextSha256,
        item.safeAreaPct,
        item.styleSnapshotJson,
      ),
    );
  }

  private insertAlignmentItems(
    versionId: string,
    items: readonly VideoTimelineAlignmentItemDto[],
  ): void {
    const statement = this.database.prepare(
      `INSERT INTO video_timeline_alignment_items
       (timeline_version_id, shot_id, category, strategy, manual_override,
        audio_duration_ms, shot_duration_ms, extended_ms, dialogue_complete, storyboard_fallback, rules_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((item) =>
      statement.run(
        versionId,
        item.shotId,
        item.category,
        item.strategy,
        item.manualOverride,
        item.audioDurationMs,
        item.shotDurationMs,
        item.extendedMs,
        item.dialogueComplete ? 1 : 0,
        item.storyboardFallback ? 1 : 0,
        item.rulesVersion,
      ),
    );
  }

  private mapTimeline(row: Row): VideoTimelineVersionRecord {
    const id = requiredString(row, 'id');
    const items = this.database
      .prepare(
        'SELECT clip_id, shot_id, candidate_id, file_sha256, generation_input_hash, position, target_start_ms, enabled, trim_in_ms, trim_out_ms FROM video_timeline_items WHERE timeline_version_id = ? ORDER BY position',
      )
      .all(id) as Row[];
    const voiceItems = this.database
      .prepare(
        'SELECT clip_id, shot_id, candidate_id, file_sha256, generation_input_hash, offset_ms, target_start_ms, volume, trim_in_ms, trim_out_ms, enabled FROM video_timeline_voice_items WHERE timeline_version_id = ? ORDER BY target_start_ms, clip_id',
      )
      .all(id) as Row[];
    const subtitleItems = this.database
      .prepare(
        'SELECT shot_id, enabled, spoken_text_sha256, safe_area_pct FROM video_timeline_subtitle_items WHERE timeline_version_id = ? ORDER BY shot_id',
      )
      .all(id) as Row[];
    const alignmentItems = this.database
      .prepare(
        'SELECT shot_id, category, strategy, manual_override, audio_duration_ms, shot_duration_ms, extended_ms, dialogue_complete, storyboard_fallback, rules_version FROM video_timeline_alignment_items WHERE timeline_version_id = ? ORDER BY shot_id',
      )
      .all(id) as Row[];
    const audioId = nullableString(row, 'audio_asset_id');
    const audioAsset =
      audioId === null ? null : this.findAudioAssetSync(requiredString(row, 'project_id'), audioId);
    return {
      alignmentItems: parseAlignmentItems(alignmentItems),
      audioAsset,
      audioVolume: requiredNumber(row, 'audio_volume'),
      bgmFadeInMs: requiredNumber(row, 'bgm_fade_in_ms'),
      bgmFadeOutMs: requiredNumber(row, 'bgm_fade_out_ms'),
      bgmMuted: requiredNumber(row, 'bgm_muted') === 1,
      bgmStartMs: requiredNumber(row, 'bgm_start_ms'),
      bgmTrimInMs: requiredNumber(row, 'bgm_trim_in_ms'),
      bgmTrimOutMs: row.bgm_trim_out_ms === null ? null : requiredNumber(row, 'bgm_trim_out_ms'),
      createdAt: requiredString(row, 'created_at'),
      episodeId: requiredString(row, 'episode_id'),
      episodeVersionId: requiredString(row, 'episode_version_id'),
      formatProfileId: requiredString(row, 'format_profile_id'),
      id,
      inputHash: requiredString(row, 'input_hash'),
      items: parseItems(items),
      parentVersionId: nullableString(row, 'parent_version_id'),
      subtitleItems: parseSubtitleItems(subtitleItems),
      timelineId: requiredString(row, 'timeline_id'),
      totalDurationMs: requiredNumber(row, 'total_duration_ms'),
      versionNo: requiredNumber(row, 'version_no'),
      voiceItems: parseVoiceItems(voiceItems),
      voiceTrackMuted: requiredNumber(row, 'voice_track_muted') === 1,
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
              v.parent_version_id, v.input_hash, v.audio_asset_id, v.total_duration_ms, v.audio_volume,
              v.voice_track_muted, v.bgm_start_ms, v.bgm_trim_in_ms, v.bgm_trim_out_ms,
              v.bgm_muted, v.bgm_fade_in_ms, v.bgm_fade_out_ms, v.created_at,
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
