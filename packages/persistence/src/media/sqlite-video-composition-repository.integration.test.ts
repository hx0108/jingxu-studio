import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteMediaUnitOfWork } from './sqlite-media-unit-of-work';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-24T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const seedGraph = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
    (id,name,creation_mode,dialogue_render_mode,deployment_mode,data_root_rel,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      'project_1',
      'V2',
      'AI_ORIGINAL',
      'NARRATION_FIRST',
      'LOCAL_DEMO',
      'projects/project_1',
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO format_profiles
    (id,project_id,version_no,aspect_ratio,width,height,fps,language,subtitle_safe_area_json,is_current,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run('format_1', 'project_1', 1, '9:16', 1080, 1920, 24, 'zh-CN', '{}', 1, NOW);
  database
    .prepare(
      `INSERT INTO episodes (id,project_id,title,target_duration_sec,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`,
    )
    .run('episode_1', 'project_1', '第一集', 90, NOW, NOW);
  database
    .prepare(
      `INSERT INTO story_bible_versions
    (id,project_id,version_no,document_json,document_sha256,status,source,created_at)
    VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run('bible_1', 'project_1', 1, '{}', HASH, 'READY', 'USER', NOW);
  database
    .prepare(
      `INSERT INTO episode_versions
    (id,episode_id,version_no,story_bible_version_id,format_profile_id,target_duration_sec,shot_set_hash,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run('episode_v1', 'episode_1', 1, 'bible_1', 'format_1', 90, HASH, 'READY', NOW);
  database
    .prepare(
      `INSERT INTO shots (id,episode_id,lifecycle_status,created_at,updated_at)
    VALUES (?,?,?,?,?)`,
    )
    .run('shot_1', 'episode_1', 'ACTIVE', NOW, NOW);
  const document = JSON.stringify({
    contract_version: 1,
    dialogue: { dialogue_render_mode: 'NARRATION_FIRST' },
    format_profile_id: 'format_1',
    parent_version_id: null,
    sequence: 1,
    shot_id: 'shot_1',
    status: 'READY',
    target_duration_sec: 5,
    version_id: 'shot_v1',
  });
  database
    .prepare(
      `INSERT INTO shot_contract_versions
    (id,shot_id,version_no,lineage_resolution_status,sequence,version_status,format_profile_id,target_duration_sec,dialogue_render_mode,document_json,document_sha256,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'shot_v1',
      'shot_1',
      1,
      'ROOT',
      1,
      'READY',
      'format_1',
      5,
      'NARRATION_FIRST',
      document,
      HASH,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO image_candidates
    (id,project_id,shot_id,shot_version_id,round_no,index_in_round,generation_input_hash,status,model_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run('image_1', 'project_1', 'shot_1', 'shot_v1', 1, 0, HASH, 'PENDING', 'mock', NOW, NOW);
  database
    .prepare(
      `INSERT INTO video_candidates
    (id,project_id,shot_id,shot_version_id,round_no,index_in_round,generation_input_hash,status,file_sha256,byte_size,mime_type,width,height,storage_rel_path,model_id,invocation_evidence_ref,requested_duration_sec,actual_duration_sec,first_frame_candidate_id,first_frame_file_sha256,selected_at,selected_by_context,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'video_1',
      'project_1',
      'shot_1',
      'shot_v1',
      1,
      0,
      HASH,
      'SUCCEEDED',
      HASH,
      100,
      'video/mp4',
      48,
      48,
      `projects/project_1/videos/aa/${HASH}.mp4`,
      'mock',
      'invocation_1',
      5,
      5,
      'image_1',
      HASH,
      NOW,
      'USER',
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO voice_generation_jobs
    (id,project_id,episode_id,request_id,status,target_shot_ids_json,skipped_shots_json,evidence_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'vjob_1',
      'project_1',
      'episode_1',
      'request_v1',
      'COMPLETED',
      '["shot_1"]',
      '[]',
      '[]',
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO voice_candidates
    (id,project_id,shot_id,shot_version_id,job_id,round_no,index_in_round,speaker_id,spoken_text_sha256,voice_id,model_id,generation_input_hash,status,duration_ms,file_sha256,byte_size,mime_type,storage_rel_path,selected_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'vcan_1',
      'project_1',
      'shot_1',
      'shot_v1',
      'vjob_1',
      1,
      0,
      'narrator',
      HASH,
      'Neil',
      'qwen3-tts-instruct-flash',
      HASH,
      'SUCCEEDED',
      1_500,
      HASH,
      2_048,
      'audio/wav',
      `projects/project_1/audio/aa/${HASH}.wav`,
      NOW,
      NOW,
      NOW,
    );
};

const timelineItem = (trimOutMs = 5_000) => ({
  candidateId: 'video_1',
  enabled: true,
  fileSha256: HASH,
  generationInputHash: HASH,
  position: 0,
  shotId: 'shot_1',
  trimInMs: 0,
  trimOutMs,
});

const voiceTrackItem = (offsetMs = 0) => ({
  candidateId: 'vcan_1',
  enabled: true,
  fileSha256: HASH,
  generationInputHash: HASH,
  offsetMs,
  shotId: 'shot_1',
  trimInMs: 0,
  trimOutMs: 1_500,
  volume: 1,
});

const alignmentRow = {
  audioDurationMs: 1_500,
  category: 'SLIGHTLY_LONG' as const,
  dialogueComplete: true,
  extendedMs: 500,
  manualOverride: null,
  rulesVersion: 'jingxu-voice-alignment-rules/1',
  shotDurationMs: 5_000,
  shotId: 'shot_1',
  storyboardFallback: false,
  strategy: 'FREEZE_EXTEND' as const,
};

const alignmentFallbackRow = {
  ...alignmentRow,
  category: 'FAR_LONG' as const,
  dialogueComplete: false,
  extendedMs: 0,
  strategy: 'BLOCK_STORYBOARD_FALLBACK' as const,
  storyboardFallback: true,
};

const subtitleTrackItem = {
  enabled: true,
  safeAreaPct: 5,
  shotId: 'shot_1',
  spokenTextSha256: HASH,
  styleSnapshotJson: '{"styleVersion":1}',
};

const emptyTracks = {
  alignmentItems: [],
  audioVolume: 0.2,
  subtitleItems: [],
  voiceItems: [],
};

const requireValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined)
    throw new Error('VIDEO_COMPOSITION_REPOSITORY_MISSING');
  return value;
};

describe('SqliteVideoCompositionRepository/UoW', () => {
  it('时间线更新创建不可变子版本，旧版本与 current pointer 保持正确；两轨随版本冻结', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'composition.sqlite'));
      try {
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedGraph(database);
        const uow = new SqliteMediaUnitOfWork(database, () => NOW);
        const first = await uow.run(({ composition }) =>
          requireValue(composition).composition.createTimeline({
            audioVolume: 0.2,
            episodeId: 'episode_1',
            episodeVersionId: 'episode_v1',
            formatProfileId: 'format_1',
            id: 'timeline_v1',
            inputHash: HASH,
            items: [timelineItem()],
            projectId: 'project_1',
            subtitleItems: [subtitleTrackItem],
            totalDurationMs: 5_000,
            voiceItems: [voiceTrackItem()],
            alignmentItems: [alignmentRow],
          }),
        );
        const second = await uow.run(({ composition }) =>
          requireValue(composition).composition.updateTimeline({
            audioAssetId: null,
            audioVolume: 0.35,
            expectedVersionId: first.id,
            id: 'timeline_v2',
            inputHash: HASH_B,
            items: [timelineItem(4_000)],
            projectId: 'project_1',
            subtitleItems: [],
            totalDurationMs: 4_000,
            voiceItems: [voiceTrackItem(120)],
            alignmentItems: [alignmentFallbackRow],
          }),
        );
        const old = await uow.run(({ composition }) =>
          requireValue(composition).composition.findTimelineVersion(
            'project_1',
            'episode_1',
            'timeline_v1',
          ),
        );
        const current = await uow.run(({ composition }) =>
          requireValue(composition).composition.findTimelineVersion('project_1', 'episode_1', null),
        );
        expect(old).toMatchObject({
          alignmentItems: [
            expect.objectContaining({
              shotId: 'shot_1',
              strategy: 'FREEZE_EXTEND',
              extendedMs: 500,
            }),
          ],
          audioVolume: 0.2,
          id: 'timeline_v1',
          parentVersionId: null,
          subtitleItems: [
            { enabled: true, safeAreaPct: 5, shotId: 'shot_1', spokenTextSha256: HASH },
          ],
          totalDurationMs: 5_000,
          versionNo: 1,
          voiceItems: [voiceTrackItem()],
        });
        expect(second).toMatchObject({
          id: 'timeline_v2',
          parentVersionId: 'timeline_v1',
          totalDurationMs: 4_000,
          versionNo: 2,
        });
        // 子版本音量与偏移生效；旧版本轨道不被改写（不可变语义）。
        expect(current).toMatchObject({
          alignmentItems: [
            expect.objectContaining({
              storyboardFallback: true,
              strategy: 'BLOCK_STORYBOARD_FALLBACK',
            }),
          ],
          audioVolume: 0.35,
          id: 'timeline_v2',
          subtitleItems: [],
          voiceItems: [voiceTrackItem(120)],
        });
        expect(
          database
            .prepare(
              "SELECT count(*) AS count FROM video_timeline_voice_items WHERE timeline_version_id='timeline_v2'",
            )
            .get()?.count,
        ).toBe(1);
      } finally {
        database.close();
      }
    });
  });

  it('既有版本行（0020 前形状）兼容读取—音量默认 0.2 且两轨为空', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'legacy-timeline.sqlite'));
      try {
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedGraph(database);
        // 直插 0020 之前形状的行：不写 audio_volume（列默认生效）、无两轨行。
        database
          .prepare(
            `INSERT INTO video_timelines (id, project_id, episode_id, current_version_id, created_at, updated_at)
           VALUES ('timeline_l', 'project_1', 'episode_1', 'timeline_lv1', ?, ?)`,
          )
          .run(NOW, NOW);
        database
          .prepare(
            `INSERT INTO video_timeline_versions
           (id, timeline_id, episode_version_id, format_profile_id, version_no, parent_version_id,
            input_hash, audio_asset_id, total_duration_ms, created_at)
           VALUES ('timeline_lv1', 'timeline_l', 'episode_v1', 'format_1', 1, NULL, ?, NULL, 5000, ?)`,
          )
          .run(HASH, NOW);
        database
          .prepare(
            `INSERT INTO video_timeline_items
           (timeline_version_id, shot_id, candidate_id, file_sha256, generation_input_hash, position, enabled, trim_in_ms, trim_out_ms)
           VALUES ('timeline_lv1', 'shot_1', 'video_1', ?, ?, 0, 1, 0, 5000)`,
          )
          .run(HASH, HASH);
        const legacy = await new SqliteMediaUnitOfWork(database, () => NOW).run(({ composition }) =>
          requireValue(composition).composition.findTimelineVersion(
            'project_1',
            'episode_1',
            'timeline_lv1',
          ),
        );
        expect(legacy).toMatchObject({
          alignmentItems: [],
          audioVolume: 0.2,
          items: [timelineItem()],
          subtitleItems: [],
          voiceItems: [],
        });
      } finally {
        database.close();
      }
    });
  });

  it('同 requestId 由唯一约束保持单一 Job，UoW 异常整单回滚', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'rollback.sqlite'));
      try {
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedGraph(database);
        const uow = new SqliteMediaUnitOfWork(database, () => NOW);
        await uow.run(({ composition }) =>
          requireValue(composition).composition.createTimeline({
            ...emptyTracks,
            episodeId: 'episode_1',
            episodeVersionId: 'episode_v1',
            formatProfileId: 'format_1',
            id: 'timeline_v1',
            inputHash: HASH,
            items: [timelineItem()],
            projectId: 'project_1',
            totalDurationMs: 5_000,
          }),
        );
        await uow.run(({ composition }) =>
          requireValue(composition).composition.createExportJob({
            episodeId: 'episode_1',
            id: 'export_1',
            inputHash: HASH,
            projectId: 'project_1',
            requestId: 'request_1',
            timelineVersionId: 'timeline_v1',
            totalDurationMs: 5_000,
          }),
        );
        const cancelled = await uow.run(({ composition }) =>
          requireValue(composition).composition.updateExportStatus(
            'export_1',
            'CANCELLED',
            'VIDEO_EXPORT_CANCELLED',
          ),
        );
        const lateCallback = await uow.run(({ composition }) =>
          requireValue(composition).composition.updateExportStatus(
            'export_1',
            'CANCELLED',
            'AbortError',
          ),
        );
        expect(cancelled.errorCode).toBe('VIDEO_EXPORT_CANCELLED');
        expect(lateCallback).toMatchObject({
          errorCode: 'VIDEO_EXPORT_CANCELLED',
          status: 'CANCELLED',
        });
        await expect(
          uow.run(({ composition }) =>
            requireValue(composition).composition.createExportJob({
              episodeId: 'episode_1',
              id: 'export_2',
              inputHash: HASH,
              projectId: 'project_1',
              requestId: 'request_1',
              timelineVersionId: 'timeline_v1',
              totalDurationMs: 5_000,
            }),
          ),
        ).rejects.toBeDefined();
        await expect(
          uow.run(async ({ composition }) => {
            await requireValue(composition).composition.insertAudioAsset({
              byteSize: 10,
              fileSha256: HASH_B,
              id: 'audio_rollback',
              mimeType: 'audio/wav',
              originalFileName: 'rollback.wav',
              projectId: 'project_1',
              storageRelPath: `projects/project_1/audio/bb/${HASH_B}.wav`,
            });
            throw new Error('ROLLBACK_TEST');
          }),
        ).rejects.toThrow('ROLLBACK_TEST');
        expect(
          database.prepare('SELECT count(*) AS count FROM video_export_jobs').get()?.count,
        ).toBe(1);
        expect(
          database
            .prepare("SELECT count(*) AS count FROM video_audio_assets WHERE id='audio_rollback'")
            .get()?.count,
        ).toBe(0);
      } finally {
        database.close();
      }
    });
  });
});
